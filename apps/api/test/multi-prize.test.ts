import { env } from "cloudflare:test";
import type { ActivityInput, ClaimResult, MyJudgmentList } from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { listPublicRecipients } from "../src/activities/claim-queries";
import { claimActivity } from "../src/activities/claim-service";
import {
  endActivity,
  refreshActivityLifecycle,
} from "../src/activities/lifecycle";
import {
  createActivity,
  getPublicActivity,
  openActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import { readAccount } from "../src/balance/ledger";
import { judgeTimeline } from "../src/judge/record-views";
import { stopCodeActivity } from "../src/judge/stop";
import { createMerchant } from "../src/payments/merchants";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import {
  type Actor,
  actor,
  bindings,
  check,
  coded,
  give,
  judgeSettings,
  origin,
  plus,
  rejects,
  settings,
} from "./code-fixtures";

// 能赢好几次的代码判定红包 (docs/multi-prize-design.md), protocol 5: each
// person's pending moves with each judgment and is settled once — by the
// code, or as the 红包 ends (结算中) — and only then does the rest go back.

const GAME = `export function judge(s) {
  const [verb, arg] = s.input.split(" ");
  const n = Number(arg ?? 0);
  if (verb === "add")
    return { add: n, message: "加了", player: { state: { last: n }, view: { summary: "我加了 " + n } } };
  if (verb === "take") return { add: -n };
  if (verb === "cash") return { settle: true, message: "收手" };
  if (verb === "seat") {
    const waiting = s.state?.waiting;
    if (!waiting) return { add: n, state: { waiting: s.user.id } };
    return { add: n, settle: true, state: null, others: [{ id: waiting, add: 5, settle: true, message: "开桌了" }] };
  }
  if (verb === "poke") return { others: [{ id: n }] };
  if (verb === "mine") return { message: JSON.stringify(s.player) };
  return {};
}`;
const TESTS = JSON.stringify({
  tests: [{ name: "加", input: "add 10", expect: { pending: 10 } }],
});

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1 });
  await judgeSettings({ enabled: 1 });
  await plus(author);
  await give(admin, author, "5.00");
});

async function open(extra: Partial<ActivityInput> = {}, sender = author) {
  const input = { ...coded({}, { code: GAME, tests: TESTS }), ...extra };
  expect(
    (await check(sender, input.judge?.code, input.judge?.tests)).body.check,
  ).toMatchObject({ passed: true, protocol: 5 });
  const saved = await createActivity(bindings, sender.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return openActivity(bindings, saved.id, sender.id, saved.version);
}

async function submit(
  activityId: string,
  user: Actor,
  input: string,
  submissionId: string = crypto.randomUUID(),
) {
  const result = await claimActivity(bindings, activityId, user.id, {
    submissionId,
    participationMode: "code",
    input,
  });
  await advanceAttemptCooldown(env.DB, user.id);
  return result;
}

const part = (activityId: string, user: Actor) =>
  env.DB.prepare(
    `SELECT pending_minor AS pending, settled_minor AS settled, claim_id IS NOT NULL AS claimed
      FROM code_judge_people WHERE activity_id = ? AND user_id = ?`,
  )
    .bind(activityId, user.id)
    .first<{ pending: number; settled: number | null; claimed: number }>();

const settledAll = (activityId: string) =>
  env.DB.prepare(
    "SELECT settled_at AS settledAt, pending_minor AS pending FROM activity_code WHERE activity_id = ?",
  )
    .bind(activityId)
    .first<{ settledAt: number | null; pending: number }>();

describe("能赢好几次 (protocol 5)", () => {
  it("adds to each one's pending, takes off down to 0, keeps their own state, and pays it once settled", async () => {
    const opened = await open();
    const player = await actor();
    expect(await submit(opened.id, player, "add 30")).toEqual({
      result: "judged",
      message: "加了",
      moved: { added: "0.30", pending: "0.30" },
    });
    expect(await submit(opened.id, player, "take 50")).toMatchObject({
      moved: { added: "-0.30", pending: "0.00" },
    });
    expect(await submit(opened.id, player, "add 20")).toMatchObject({
      moved: { added: "0.20", pending: "0.20" },
    });
    // 判定记录 reads a judgment that took off (2026-10-31: it answered 500).
    const timeline = await judgeTimeline(
      bindings,
      opened.id,
      author.id,
      "all",
      null,
    );
    expect(
      timeline?.items.map((row) => row.kind === "judged" && row.moved),
    ).toEqual([
      { added: "0.20", pending: "0.20", settled: false },
      { added: "-0.30", pending: "0.00", settled: false },
      { added: "0.30", pending: "0.30", settled: false },
    ]);
    // The code is given their pending and their own state and view back.
    const mine = (await submit(opened.id, player, "mine")) as Extract<
      ClaimResult,
      { result: "judged" }
    >;
    expect(JSON.parse(mine.message ?? "")).toEqual({
      pending: 20,
      state: { last: 20 },
      view: { summary: "我加了 20" },
    });
    const page = await getPublicActivity(bindings, opened.id);
    expect(page.quantity).toEqual({ mode: "pool", left: "0.80" });
    expect(page.judge?.unclaimed).toBe("0.80");
    // Settled: their pending, once, into their 🐟额.
    expect(await submit(opened.id, player, "cash")).toMatchObject({
      result: "judged",
      message: "收手",
      settled: { claim: { amount: "0.20" } },
    });
    expect((await readAccount(bindings, player.id)).availableMinor).toBe(20);
    expect(await part(opened.id, player)).toEqual({
      pending: 0,
      settled: 20,
      claimed: 1,
    });
    expect((await submit(opened.id, player, "add 1")).result).toBe(
      "already_claimed",
    );
    // No 手速王: most are settled as it ends (§4.5).
    const roster = await listPublicRecipients(bindings, opened.id);
    expect(roster.items).toHaveLength(1);
    expect(roster.items[0]?.speedTitle).toBeUndefined();
  });

  it("answers the same submission sent again with the same judgment", async () => {
    const opened = await open();
    const player = await actor();
    const id = crypto.randomUUID();
    const first = await submit(opened.id, player, "add 10", id);
    expect(await submit(opened.id, player, "add 10", id)).toEqual(first);
    expect(await part(opened.id, player)).toMatchObject({ pending: 10 });
  });

  it("settles someone with nothing, once, and turns them away after", async () => {
    const opened = await open();
    const player = await actor();
    expect(await submit(opened.id, player, "cash")).toMatchObject({
      result: "judged",
      settled: { claim: null },
    });
    await rejects(submit(opened.id, player, "add 10"), "CODE_SETTLED");
    expect(await part(opened.id, player)).toEqual({
      pending: 0,
      settled: 0,
      claimed: 0,
    });
  });

  it("moves the others at the same table, and calls naming a stranger the code's error", async () => {
    const opened = await open();
    const [first, second, stranger] = [
      await actor(),
      await actor(),
      await actor(),
    ];
    await submit(opened.id, first, "seat 10");
    expect(await submit(opened.id, second, "seat 20")).toMatchObject({
      result: "judged",
      settled: { claim: { amount: "0.20" } },
    });
    // The first, by the second's judgment: 0.10 + 0.05, settled.
    expect(await part(opened.id, first)).toEqual({
      pending: 0,
      settled: 15,
      claimed: 1,
    });
    expect((await readAccount(bindings, first.id)).availableMinor).toBe(15);
    const moves = await env.DB.prepare(
      `SELECT position, user_id AS userId, add_minor AS added, before_minor AS before, after_minor AS after,
        settles, message FROM code_judgment_moves WHERE activity_id = ? ORDER BY created_at, position`,
    )
      .bind(opened.id)
      .all();
    expect(moves.results).toEqual([
      {
        position: 0,
        userId: first.id,
        added: 10,
        before: 0,
        after: 10,
        settles: 0,
        message: null,
      },
      {
        position: 0,
        userId: second.id,
        added: 20,
        before: 0,
        after: 20,
        settles: 1,
        message: null,
      },
      {
        position: 1,
        userId: first.id,
        added: 5,
        before: 10,
        after: 15,
        settles: 1,
        message: "开桌了",
      },
    ]);
    // 我的记录: the first sees the second's judgment that moved them, whose
    // and what it told them, never what the second typed.
    const response = await app.request(
      `${origin}/api/activities/${opened.id}/judgments`,
      { headers: { Cookie: first.cookie } },
      bindings,
    );
    const mine = (await response.json()) as MyJudgmentList;
    expect(mine).toMatchObject({ total: 2, attempts: 1 });
    expect(mine.items).toEqual([
      {
        attempt: 1,
        at: expect.any(String),
        by: { name: expect.any(String) },
        message: "开桌了",
        moved: { added: "0.05", pending: "0.15", settled: true },
        amount: "0.15",
      },
      {
        attempt: 1,
        at: expect.any(String),
        input: "seat 10",
        moved: { added: "0.10", pending: "0.10", settled: false },
      },
    ]);
    await rejects(submit(opened.id, stranger, "poke 123"), "JUDGE_FAILED");
    expect(
      await env.DB.prepare(
        "SELECT detail FROM code_failures WHERE activity_id = ?",
      )
        .bind(opened.id)
        .first<string>("detail"),
    ).toBe("others 第 1 项（123）没有在这个红包里被判定过");
  });

  it("ends as the pool is taken, settles everyone (结算中), then gives back", async () => {
    const opened = await open();
    const [a, b, c] = [await actor(), await actor(), await actor()];
    await submit(opened.id, a, "add 30");
    await submit(opened.id, b, "add 0");
    // 1.00 less 0.30: only 0.70 can be added, and then it is taken.
    expect(await submit(opened.id, c, "add 100")).toMatchObject({
      result: "judged",
      moved: { added: "0.70", pending: "0.70" },
      settled: { claim: { amount: "0.70" } },
    });
    expect(await part(opened.id, a)).toEqual({
      pending: 0,
      settled: 30,
      claimed: 1,
    });
    expect(await part(opened.id, b)).toEqual({
      pending: 0,
      settled: 0,
      claimed: 0,
    });
    expect(await settledAll(opened.id)).toMatchObject({ pending: 0 });
    expect((await settledAll(opened.id))?.settledAt).not.toBeNull();
    const page = await getPublicActivity(bindings, opened.id);
    expect(page.status).toBe("ended");
    expect(page.judge?.settling).toBeUndefined();
    expect(page.quantity).toEqual({ mode: "pool", left: "0.00" });
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 400,
      lockedMinor: 0,
    });
    expect((await submit(opened.id, await actor(), "add 1")).result).toBe(
      "ended",
    );
  });

  it("settles everyone at the deadline, and gives back the rest only then", async () => {
    const opened = await open();
    const player = await actor();
    await submit(opened.id, player, "add 30");
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - 1000, opened.id)
      .run();
    expect(await refreshActivityLifecycle(bindings, opened.id)).toBe(true);
    expect(await part(opened.id, player)).toEqual({
      pending: 0,
      settled: 30,
      claimed: 1,
    });
    expect((await readAccount(bindings, player.id)).availableMinor).toBe(30);
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 470,
      lockedMinor: 0,
    });
  });

  it("lets the 站长 stop one, settling everyone first", async () => {
    const opened = await open();
    const player = await actor();
    await submit(opened.id, player, "add 40");
    await stopCodeActivity(bindings, opened.id, admin.id);
    expect(await part(opened.id, player)).toMatchObject({ settled: 40 });
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 460,
      lockedMinor: 0,
    });
  });

  it("may not end early once someone has won some", async () => {
    const opened = await open();
    await submit(opened.id, await actor(), "add 10");
    await expect(
      endActivity(bindings, opened.id, author.id, opened.version),
    ).rejects.toMatchObject({ message: "已经有人赢到钱了，不能提前结束。" });
  });

  it("pays each one a 商户 settles as it ends, its sender's own play with no payment", async () => {
    const sender = await actor();
    const merchant = await createMerchant(bindings, sender.id, {
      requestId: crypto.randomUUID(),
      clientId: `multi_${crypto.randomUUID().replaceAll("-", "")}`,
      label: "多次领奖商户",
      secret: "virtual-only-secret",
    });
    const opened = await open(
      { funding: "merchant", merchantId: merchant.id },
      sender,
    );
    const player = await actor();
    await submit(opened.id, player, "add 30");
    await submit(opened.id, sender, "add 20");
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - 1000, opened.id)
      .run();
    await refreshActivityLifecycle(bindings, opened.id);
    const paid = await env.DB.prepare(
      `SELECT c.user_id AS userId, r.amount_minor AS amount, t.id IS NOT NULL AS payment
        FROM claims c JOIN reward_inventory r ON r.activity_id = c.activity_id AND r.id = c.inventory_id
        LEFT JOIN payment_tasks t ON t.claim_id = c.id WHERE c.activity_id = ? ORDER BY r.position`,
    )
      .bind(opened.id)
      .all();
    expect(paid.results).toEqual([
      { userId: player.id, amount: 30, payment: 1 },
      { userId: sender.id, amount: 20, payment: 0 },
    ]);
    expect((await settledAll(opened.id))?.settledAt).not.toBeNull();
  });
});
