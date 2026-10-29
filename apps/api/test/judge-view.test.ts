import { env } from "cloudflare:test";
import type { ClaimResult, JudgeInput } from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import {
  createActivity,
  getPublicActivity,
  openActivity,
} from "../src/activities/service";
import { judgeRecords } from "../src/judge/records";
import { findJudgeRow } from "../src/judge/storage";
import { sha256Hex } from "../src/security/crypto";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import {
  type Actor,
  actor,
  bindings,
  check,
  coded,
  give,
  judgeSettings,
  plus,
  settings,
  unique,
} from "./code-fixtures";

// 判定器的公开数据 (docs/judge-page-design.md §2, protocol 4): setup() at
// opening, what everyone sees and 动态 with each judgment, and a 判定器
// that ends its 红包; code tested on v3 still opens on v3 as it was.

/** Counts its judgments in state; "win" pays, the second one ends it, "stop" ends it unpaid. */
const COUNTER = `export function setup(params, hongbao) {
  return {
    state: { n: 0, salt: Math.random() },
    view: { summary: \`开局：\${hongbao.count} 份\`, data: { n: 0 } },
  };
}
export function judge({ input, state, user }) {
  const n = state.n + 1;
  const next = { ...state, n };
  if (input === "stop")
    return { ok: false, message: "停", state: next, view: null, announce: \`@\${user.username} 结束了\`, end: true };
  if (input === "win")
    return {
      ok: true,
      amount: 10,
      state: next,
      view: { summary: \`第 \${n} 次：有人领到\`, data: { n } },
      announce: \`@\${user.username} 领到了\`,
      end: n >= 2,
    };
  return { ok: false, message: "继续", state: next, view: { summary: \`第 \${n} 次\`, data: { n } }, announce: \`@\${user.username} 试了一次\` };
}
`;
const COUNTER_TESTS = JSON.stringify({
  tests: [
    {
      name: "继续",
      state: { n: 0 },
      input: "x",
      expect: {
        ok: false,
        view: { summary: "第 1 次", data: { n: 1 } },
        announce: "@tester 试了一次",
        end: false,
      },
    },
    {
      name: "第二次领到就结束",
      state: { n: 1 },
      input: "win",
      expect: { ok: true, end: true },
    },
  ],
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

async function draft(judge: Partial<JudgeInput>) {
  return createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: coded({}, judge),
  });
}

async function open(code: string, tests = COUNTER_TESTS) {
  const passed = await check(author, code, tests);
  expect(passed.body.check).toMatchObject({ passed: true, protocol: 4 });
  const saved = await draft({ code, tests });
  return openActivity(bindings, saved.id, author.id, saved.version);
}

async function submit(activityId: string, user: Actor, input: string) {
  const result: ClaimResult = await claimActivity(
    bindings,
    activityId,
    user.id,
    { submissionId: crypto.randomUUID(), participationMode: "code", input },
  );
  await advanceAttemptCooldown(env.DB, user.id);
  return result;
}

const lines = (activityId: string) =>
  env.DB.prepare(
    "SELECT n, user_id AS userId, text FROM activity_announcements WHERE activity_id = ? ORDER BY n",
  )
    .bind(activityId)
    .all<{ n: number; userId: string; text: string }>()
    .then((rows) => rows.results);

const ending = (activityId: string) =>
  env.DB.prepare(
    "SELECT ended_at AS endedAt, end_reason AS reason FROM activities WHERE id = ?",
  )
    .bind(activityId)
    .first<{ endedAt: number | null; reason: string | null }>();

describe("判定器的公开数据 (protocol 4)", () => {
  it("opens with setup()'s state and view, and keeps each judgment's view and line in 动态", async () => {
    const opened = await open(unique(COUNTER));
    const row = await findJudgeRow(bindings, opened.id);
    expect(row).toMatchObject({
      protocol: 4,
      viewSummary: "开局：3 份",
      viewData: '{"n":0}',
    });
    expect(row?.stateCiphertext).not.toBeNull();
    expect(row?.setupCiphertext).not.toBeNull();

    const first = await actor();
    expect((await submit(opened.id, first, "x")).result).toBe("rejected");
    const after = await findJudgeRow(bindings, opened.id);
    expect(after).toMatchObject({
      viewSummary: "第 1 次",
      viewData: '{"n":1}',
    });
    const judged = await env.DB.prepare(
      "SELECT view, ends FROM code_judgments WHERE activity_id = ?",
    )
      .bind(opened.id)
      .first<{ view: string; ends: number }>();
    expect(judged).toEqual({
      view: '{"summary":"第 1 次","data":{"n":1}}',
      ends: 0,
    });
    const [line] = await lines(opened.id);
    expect(line).toMatchObject({ n: 0, userId: first.id });
    expect(line?.text).toMatch(/^@code_\w+ 试了一次$/);
    // Only ever added to.
    await expect(
      env.DB.prepare(
        "UPDATE activity_announcements SET text = '改了' WHERE activity_id = ?",
      )
        .bind(opened.id)
        .run(),
    ).rejects.toThrow(/immutable_activity_announcement/);

    // The records give setup()'s answer and each judgment's.
    const records = await judgeRecords(bindings, opened.id, author.id);
    expect(records.protocol).toBe(4);
    expect(records.setup).toMatchObject({
      title: "代码判定 · 3 份",
      state: { n: 0 },
      view: { summary: "开局：3 份", data: { n: 0 } },
    });
    expect(records.judgments[0]?.verdict).toMatchObject({
      ok: false,
      view: { summary: "第 1 次", data: { n: 1 } },
      announce: line?.text,
    });
    expect(records.judgments[0]?.verdict).not.toHaveProperty("end");
  });

  it("ends the 红包 after paying the share of the judgment that ends it, and gives back the rest", async () => {
    const opened = await open(unique(COUNTER));
    expect((await submit(opened.id, await actor(), "x")).result).toBe(
      "rejected",
    );
    const winner = await actor();
    const won = await submit(opened.id, winner, "win");
    expect(won.result).toBe("claimed");
    expect(await ending(opened.id)).toMatchObject({ reason: "judge" });
    expect((await getPublicActivity(bindings, opened.id)).status).toBe("ended");
    // 1.00 locked, 0.10 paid: the rest is no longer held.
    const lock = await env.DB.prepare(
      "SELECT status, remaining_minor AS remaining FROM balance_locks WHERE activity_id = ? AND purpose = 'activity'",
    )
      .bind(opened.id)
      .first<{ status: string; remaining: number }>();
    expect(lock?.status).not.toBe("active");
    expect((await submit(opened.id, await actor(), "x")).result).toBe("ended");
    const records = await judgeRecords(bindings, opened.id, author.id);
    expect(records.judgments.at(-1)?.verdict).toMatchObject({
      ok: true,
      end: true,
    });
  });

  it("ends it on a turn-down too, with nothing paid", async () => {
    const opened = await open(unique(COUNTER));
    expect((await submit(opened.id, await actor(), "stop")).result).toBe(
      "rejected",
    );
    expect(await ending(opened.id)).toMatchObject({ reason: "judge" });
    // view: null cleared what everyone saw.
    const row = await findJudgeRow(bindings, opened.id);
    expect(row).toMatchObject({ viewSummary: null, viewData: null });
    expect(row?.viewAt).not.toBeNull();
  });

  it("does not open when setup() fails, and says why", async () => {
    const code = unique(`export function setup() { throw new Error("坏了"); }
export function judge() { return { ok: false }; }
`);
    const tests = JSON.stringify({
      tests: [{ name: "一条", input: "x", expect: { ok: false } }],
    });
    expect((await check(author, code, tests)).body.check.passed).toBe(true);
    const saved = await draft({ code, tests });
    await expect(
      openActivity(bindings, saved.id, author.id, saved.version),
    ).rejects.toMatchObject({
      code: "JUDGE_SETUP_FAILED",
      message: "判定器开放时出错：Error: 坏了，草稿已保存。",
    });
  });

  it("opens code tested on v3 on v3's runtime, where view, announce and end are no part of it", async () => {
    const code = unique(`export function judge({ user }) {
  return { ok: false, message: "继续", view: { summary: "看得到吗" }, announce: \`@\${user.username} 试了一次\`, end: true };
}
`);
    const tests = JSON.stringify({
      tests: [{ name: "一条", input: "x", expect: { ok: false } }],
    });
    const at = Date.now();
    await env.DB.prepare(
      "INSERT INTO judge_checks (id, user_id, protocol, fingerprint, tests_digest, passed, kind, created_at, finished_at) VALUES (?, ?, 3, ?, ?, 1, 'deploy', ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        author.id,
        await sha256Hex(code),
        await sha256Hex(tests),
        at,
        at,
      )
      .run();
    const saved = await draft({ code, tests });
    const opened = await openActivity(
      bindings,
      saved.id,
      author.id,
      saved.version,
    );
    const row = await findJudgeRow(bindings, opened.id);
    expect(row).toMatchObject({ protocol: 3, viewSummary: null });
    expect((await submit(opened.id, await actor(), "x")).result).toBe(
      "rejected",
    );
    expect(await ending(opened.id)).toMatchObject({
      endedAt: null,
      reason: null,
    });
    expect(await lines(opened.id)).toEqual([]);
    expect(await findJudgeRow(bindings, opened.id)).toMatchObject({
      viewSummary: null,
      viewAt: null,
    });
  });
});
