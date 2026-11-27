import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  drawPlanV2,
  queueAmountsV2,
  queueSeed,
} from "../../packages/contracts/src/draw-proof";
import type {
  RandomLdcMoney,
  TimedDrawMoney,
} from "../../packages/contracts/src/index";
import vectors from "../../packages/contracts/test/fixtures/draw-proof-v2.json";

// The verification script 🎲 offers (复制验证脚本) redoes 开奖证明 v2 on its
// own, with Node's built-ins only: the same vectors as the shared code.
const script = new URL(
  "../../apps/web/src/lib/verify-draw.mjs",
  import.meta.url,
).pathname;
const user = { username: "u", displayName: "u", avatarUrl: null };
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function run(data: unknown, node = vectors.draws[0]?.drand) {
  const directory = mkdtempSync(join(tmpdir(), "verify-draw-"));
  temporary.push(directory);
  const file = join(directory, "数据.json");
  writeFileSync(file, JSON.stringify(data));
  // drand's own node, answering from here.
  const preload = `data:text/javascript,globalThis.fetch=async()=>new Response(${encodeURIComponent(
    JSON.stringify(JSON.stringify(node)),
  )})`;
  const result = spawnSync(
    process.execPath.endsWith("node") ? process.execPath : "node",
    ["--import", preload, script, file],
    { encoding: "utf8" },
  );
  return { code: result.status, output: result.stdout + result.stderr };
}

const draws = vectors.draws.map((vector) => ({
  kind: "draw",
  version: 2,
  activity: {
    id: vector.activityId,
    title: "t",
    author: user,
    closedAt: "2025-07-18T01:49:21.000Z",
    money: vector.money,
  },
  drand: { chainHash: "52db9ba7", roundAt: "", ...vector.drand },
  roster: {
    hash: vector.rosterHash,
    entries: vector.roster.map((entry) => ({
      ...entry,
      registeredAt: "",
      user,
    })),
  },
  seed: vector.seed,
  result: {
    picked: vector.picked,
    amounts: vector.amounts,
    winners: vector.winners,
  },
}));
const queues = vectors.queues.map((vector) => ({
  kind: "queue",
  version: 2,
  activity: {
    id: vector.activityId,
    title: "t",
    author: user,
    openedAt: "",
    endedAt: "",
    money: vector.money,
  },
  commitment: vector.commitment,
  secret: vector.secret,
  queue: vector.queue.map((amountMinor, position) => ({
    position,
    amountMinor,
    claim: position < 2 ? { user, claimedAt: "" } : null,
  })),
}));

// 每人上限 (docs/payout-cap-design.md §1): the same vectors with a cap
// tight enough to bind, worked out by the shared code; the script agrees.
const cappedDraws = vectors.draws
  .filter((vector) => vector.roster.length > 0)
  .map((vector, index) => {
    const base = draws[vectors.draws.indexOf(vector)];
    if (!base) throw new Error("No vector");
    const money = {
      ...(vector.money as TimedDrawMoney),
      maxEach: index === 0 ? "3.50" : "0.80",
    };
    const plan = drawPlanV2({
      seed: vector.seed,
      registered: vector.roster.length,
      money,
    });
    return {
      ...base,
      activity: { ...base.activity, money },
      result: {
        picked: plan.picked,
        amounts: plan.amounts,
        winners: plan.winners,
      },
    };
  });
const cappedQueues = vectors.queues
  .filter((vector) => vector.money.mode === "random")
  .map((vector) => {
    const base = queues[vectors.queues.indexOf(vector)];
    if (!base) throw new Error("No vector");
    const random = vector.money as RandomLdcMoney;
    const money = {
      ...random,
      maxEach: random.totalAmount === "8.88" ? "1.60" : "26.00",
    };
    const amounts = queueAmountsV2({
      seed: queueSeed(vector.activityId, vector.secret),
      money,
    });
    return {
      ...base,
      activity: { ...base.activity, money },
      queue: amounts.map((amountMinor, position) => ({
        position,
        amountMinor,
        claim: position < 2 ? { user, claimedAt: "" } : null,
      })),
    };
  });

describe("verify-draw.mjs", () => {
  it.each(
    [...cappedDraws, ...cappedQueues].map((data, index) => [index, data]),
  )("redoes capped vector %i, no share above the cap", (_index, data) => {
    const cap = Math.round(
      Number((data.activity.money as { maxEach: string }).maxEach) * 100,
    );
    const amounts =
      "queue" in data && Array.isArray(data.queue)
        ? data.queue.map((item) => item.amountMinor)
        : (data as (typeof cappedDraws)[number]).result.amounts;
    expect(Math.max(...amounts)).toBeLessThanOrEqual(cap);
    const { code, output } = run(data);
    expect(output).not.toContain("✗");
    expect(output).toContain("全部一致。");
    expect(code).toBe(0);
  });

  it.each([...draws, ...queues].map((data, index) => [index, data]))(
    "finds vector %i all consistent",
    (_index, data) => {
      const { code, output } = run(data);
      expect(output).not.toContain("✗");
      expect(output).toContain("全部一致。");
      expect(code).toBe(0);
    },
  );

  it("fails on a changed amount, roster, claim order or round", () => {
    const [draw] = draws;
    const [queue] = queues;
    if (!draw || !queue) throw new Error("No vectors");
    const changed = [
      {
        ...draw,
        result: { ...draw.result, amounts: [...draw.result.amounts].reverse() },
      },
      {
        ...draw,
        roster: { ...draw.roster, entries: draw.roster.entries.slice(1) },
      },
      {
        ...queue,
        queue: queue.queue.map((item, position) => ({
          ...item,
          claim:
            position === 3 ? (item.claim ?? { user, claimedAt: "" }) : null,
        })),
      },
    ];
    for (const data of changed) {
      const { code, output } = run(data);
      expect(output).toContain("✗");
      expect(code).toBe(1);
    }
    for (const early of [
      { ...draw, stage: "waiting", seed: null, result: null },
      { ...queue, stage: "running", secret: null },
    ]) {
      const { code, output } = run(early);
      expect(output).toContain("还没到能验证的时候");
      expect(code).toBe(1);
    }
    const other = { ...draw.drand, randomness: "0".repeat(64) };
    expect(run(draw, other).output).toContain(
      "✗ drand 第 20000000 轮：官方节点给的一样",
    );
  });
});
