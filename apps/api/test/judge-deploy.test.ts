import { env } from "cloudflare:test";
import { type JudgeVersions, judgeVersionsSchema } from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import {
  createActivity,
  getManagedActivity,
  openActivity,
  updateActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import type { ApiBindings } from "../src/env";
import { checkJudge } from "../src/judge/check";
import { sandboxId } from "../src/judge/sandbox";
import { usageDay, usageStatement } from "../src/judge/usage";
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
  origin,
  plus,
  rejects,
  settings,
  TESTS,
  unique,
} from "./code-fixtures";

// 部署 (docs/programmable-hongbao-design.md §5, §7): only a new version
// counts toward the day's deploys, its tests again are free, an unshown
// cap holds all runs, a deploy moves past a timeout once, the month's 份
// hold new versions but never claims, and each 判定器 is one 份 a day.

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1 });
  await judgeSettings({
    enabled: 1,
    daily_open_limit: 3,
    daily_deploy_limit: 10,
    monthly_limit: 1000,
  });
  await plus(author);
  await give(admin, author, "5.00");
});

/** Other tests on the same code: a rerun on the version deployed. */
const WRONG_ONLY = JSON.stringify({
  tests: [{ name: "答错", input: "x", expect: { ok: false } }],
});

function usageOf(fingerprint: string, fresh = 0) {
  return env.DB.prepare(
    "SELECT * FROM judge_usage WHERE day = ? AND sandbox_id = ?",
  )
    .bind(usageDay(), sandboxId(fingerprint, fresh))
    .first<Record<string, unknown>>();
}

/** A run as one written before, today or earlier. */
async function earlierRun(
  user: Actor,
  code: string,
  kind: "deploy" | "rerun",
  at = Date.now(),
) {
  return env.DB.prepare(
    "INSERT INTO judge_checks (id, user_id, protocol, fingerprint, tests_digest, passed, kind, created_at, finished_at) VALUES (?, ?, 1, ?, ?, 1, ?, ?, ?)",
  ).bind(
    crypto.randomUUID(),
    user.id,
    await sha256Hex(code),
    await sha256Hex(TESTS),
    kind,
    at,
    at,
  );
}

/** The person's runs, oldest first. */
async function runsOf(user: Actor) {
  return (
    await env.DB.prepare(
      "SELECT kind, passed, finished_at AS finishedAt FROM judge_checks WHERE user_id = ? ORDER BY rowid",
    )
      .bind(user.id)
      .all<{ kind: string; passed: number; finishedAt: number | null }>()
  ).results;
}

async function open(code: string) {
  expect((await check(author, code)).body.check.passed).toBe(true);
  const saved = await createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: coded({}, { code }),
  });
  return openActivity(bindings, saved.id, author.id, saved.version);
}

async function submit(
  activityId: string,
  user: Actor,
  input: string,
  on: ApiBindings = bindings,
) {
  const result = await claimActivity(on, activityId, user.id, {
    submissionId: crypto.randomUUID(),
    participationMode: "code",
    input,
  });
  await advanceAttemptCooldown(env.DB, user.id);
  return result;
}

/** A sandbox that never answers, as one stuck in a loop would not. */
const stuck: ApiBindings = {
  ...bindings,
  LOADER: {
    get: () => ({
      getEntrypoint: () => ({
        fetch: () => new Promise<Response>(() => {}),
      }),
    }),
  } as unknown as ApiBindings["LOADER"],
};

describe("代码判定红包: 部署", () => {
  it("counts only new versions as deploys: their tests again are free, and someone else's run is theirs", async () => {
    const code = unique();
    expect((await check(author, code)).body.check).toMatchObject({
      passed: true,
      kind: "deploy",
      deploysLeft: 9,
    });
    // tests.json changed: the same 判定器 runs it, no deploy.
    expect((await check(author, code, WRONG_ONLY)).body.check).toMatchObject({
      passed: true,
      kind: "rerun",
      deploysLeft: 9,
    });
    expect(
      (await check(author, `${code}// 改了一行\n`)).body.check,
    ).toMatchObject({ kind: "deploy", deploysLeft: 8 });
    // A version deployed before, pasted back, is no new one either.
    expect((await check(author, code)).body.check).toMatchObject({
      kind: "rerun",
      deploysLeft: 8,
    });
    const someone = await actor();
    await plus(someone);
    expect((await check(someone, code)).body.check).toMatchObject({
      kind: "deploy",
      deploysLeft: 9,
    });
    const kinds = await env.DB.prepare(
      "SELECT kind FROM judge_checks WHERE user_id = ? ORDER BY rowid",
    )
      .bind(author.id)
      .all<{ kind: string }>();
    expect(kinds.results.map((row) => row.kind)).toEqual([
      "deploy",
      "rerun",
      "deploy",
      "rerun",
    ]);
    // The database holds each run to the runs before it.
    await expect(
      (await earlierRun(author, code, "deploy")).run(),
    ).rejects.toThrow(/invalid_judge_check/);
    await expect(
      (await earlierRun(author, unique(), "rerun")).run(),
    ).rejects.toThrow(/invalid_judge_check/);
    // The form reads what is left with 🐟额's offer.
    const offer = await app.request(
      `${origin}/api/me/balance/hongbao`,
      { headers: { Cookie: author.cookie } },
      bindings,
    );
    expect(await offer.json()).toMatchObject({
      code: { deploysLeft: 8, deployLimit: 10 },
    });
  });

  it("stops new versions once today's deploys are used, never a version deployed before", async () => {
    await judgeSettings({ daily_deploy_limit: 2 });
    const code = unique();
    await check(author, code);
    expect((await check(author, unique())).body.check.deploysLeft).toBe(0);
    const refused = await check(author, unique());
    expect(refused.status).toBe(429);
    expect(refused.body.error).toEqual({
      code: "JUDGE_DEPLOY_LIMIT",
      message: "今天的 2 次部署用完了，明天再来。",
    });
    expect((await check(author, code, WRONG_ONLY)).body.check).toMatchObject({
      passed: true,
      kind: "rerun",
      deploysLeft: 0,
    });
    // Opening uses a 判定器 deployed before.
    const saved = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: coded({}, { code }),
    });
    expect(saved.openingBlockedReason).toBeUndefined();
  });

  it("asks a draft whose tests changed since its deploy for a rerun, and one that failed them for a pass", async () => {
    const code = unique();
    // Its deploy failed other tests: these were never run on it.
    const failing = JSON.stringify({
      tests: [{ name: "答错当答对", input: "x", expect: { ok: true } }],
    });
    expect((await check(author, code, failing)).body.check.passed).toBe(false);
    const changed = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: coded({}, { code }),
    });
    expect(changed.openingBlockedReason).toBe("JUDGE_RERUN_REQUIRED");
    const failed = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: coded({}, { code, tests: failing }),
    });
    expect(failed.openingBlockedReason).toBe("JUDGE_CHECK_REQUIRED");
    await check(author, code);
    expect(
      (await getManagedActivity(bindings, changed.id, author.id))
        .openingBlockedReason,
    ).toBeUndefined();
  });

  it("runs a person's checks one at a time: a burst at the last deploy makes one", async () => {
    await judgeSettings({ daily_deploy_limit: 1 });
    const codes = Array.from({ length: 4 }, () => unique());
    const burst = await Promise.all(codes.map((code) => check(author, code)));
    const done = burst.findIndex((one) => one.status === 200);
    expect(burst[done]?.body.check).toMatchObject({
      kind: "deploy",
      deploysLeft: 0,
    });
    for (const [index, busy] of burst.entries())
      if (index !== done) {
        expect(busy.status).toBe(429);
        expect(busy.body.error).toEqual({
          code: "JUDGE_RUN_BUSY",
          message: "上一次测试还在跑，等它跑完再试。",
        });
      }
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM judge_checks WHERE user_id = ?",
      )
        .bind(author.id)
        .first<number>("n"),
    ).toBe(1);
    // The run let go of its lease, refused or not.
    expect((await check(author, unique())).body.error?.code).toBe(
      "JUDGE_DEPLOY_LIMIT",
    );
    // One left by a run that died holds until it runs out.
    const lease = env.DB.prepare(
      "INSERT INTO judge_run_leases (user_id, token, lease_until) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET lease_until = excluded.lease_until",
    );
    await lease.bind(author.id, crypto.randomUUID(), Date.now() + 60_000).run();
    expect((await check(author, codes[done])).body.error?.code).toBe(
      "JUDGE_RUN_BUSY",
    );
    await lease.bind(author.id, crypto.randomUUID(), Date.now() - 1).run();
    expect((await check(author, codes[done], WRONG_ONLY)).status).toBe(200);
  });

  it("holds every run past fifty a day, deploys and reruns alike", async () => {
    const code = unique();
    await check(author, code);
    await env.DB.batch(
      await Promise.all(
        Array.from({ length: 48 }, () => earlierRun(author, code, "rerun")),
      ),
    );
    expect((await check(author, code)).status).toBe(200);
    const capped = await check(author, code);
    expect(capped.status).toBe(429);
    expect(capped.body.error).toEqual({
      code: "JUDGE_RUN_LIMIT",
      message: "今天跑测试的次数太多了，明天再来。",
    });
    expect((await check(author, unique())).body.error?.code).toBe(
      "JUDGE_RUN_LIMIT",
    );
  });

  it("moves to a fresh 判定器 after a late answer once, then leaves the rest: 2 份 at most", async () => {
    const code = unique(`export async function judge(s) {
  if (s.input === "slow") await new Promise((done) => setTimeout(done, 1000));
  return { ok: false, message: "不对" };
}
`);
    const tests = JSON.stringify({
      tests: [
        { name: "太慢", input: "slow", expect: { ok: false } },
        { name: "换了实例", input: "x", expect: { ok: false } },
        { name: "又太慢", input: "slow", expect: { ok: false } },
        { name: "没跑", input: "x", expect: { ok: false } },
      ],
    });
    const { check: result } = (await check(author, code, tests)).body;
    expect(result.passed).toBe(false);
    expect(
      result.tests.map(({ name, passed, problem }) => ({
        name,
        passed,
        problem,
      })),
    ).toEqual([
      { name: "太慢", passed: false, problem: "超时：超过 300 毫秒没有判定完" },
      { name: "换了实例", passed: true, problem: undefined },
      {
        name: "又太慢",
        passed: false,
        problem: "超时：超过 300 毫秒没有判定完",
      },
      { name: "没跑", passed: false, problem: "前面超时，这条没跑" },
    ]);
    expect(await usageOf(result.fingerprint, 0)).toMatchObject({
      user_id: author.id,
      activity_id: null,
      deploys: 1,
      reruns: 0,
      timeouts: 1,
      switches: 1,
    });
    const second = await usageOf(result.fingerprint, 1);
    expect(second).toMatchObject({
      deploys: 0,
      timeouts: 1,
      switches: 0,
    });
    expect(await usageOf(result.fingerprint, 2)).toBeNull();
    // Each from its own first use: the second once the first timed out.
    const first = await usageOf(result.fingerprint, 0);
    expect(Number(second?.first_at)).toBeGreaterThan(Number(first?.first_at));
    expect(second?.last_at).toBe(first?.last_at);
  });

  // The runtime cancels a judgment nothing is left to answer at once: its
  // sandbox holds nothing, so the run stays in it, as the kit's does.
  it("stays in its 判定器 after a judgment the runtime cut short, and still stops at the second timeout", async () => {
    const code = unique(`export async function judge(s) {
  if (s.input === "hang") await new Promise(() => {});
  return { ok: false, message: "不对" };
}
`);
    const tests = JSON.stringify({
      tests: [
        { name: "卡住", input: "hang", expect: { ok: false } },
        { name: "还在这个实例", input: "x", expect: { ok: false } },
        { name: "又卡住", input: "hang", expect: { ok: false } },
        { name: "没跑", input: "x", expect: { ok: false } },
      ],
    });
    const { check: result } = (await check(author, code, tests)).body;
    const hung = "超时：代码一直没有返回（在等一个永远不会完成的 Promise）";
    expect(
      result.tests.map(({ name, passed, problem }) => ({
        name,
        passed,
        problem,
      })),
    ).toEqual([
      { name: "卡住", passed: false, problem: hung },
      { name: "还在这个实例", passed: true, problem: undefined },
      { name: "又卡住", passed: false, problem: hung },
      { name: "没跑", passed: false, problem: "前面超时，这条没跑" },
    ]);
    expect(await usageOf(result.fingerprint, 0)).toMatchObject({
      deploys: 1,
      timeouts: 2,
      switches: 0,
    });
    expect(await usageOf(result.fingerprint, 1)).toBeNull();
  });

  it("has a run and its 判定器 on record before it runs, so one cut off midway still counts", async () => {
    let inside = () => {};
    const reached = new Promise<void>((resolve) => {
      inside = resolve;
    });
    // A sandbox that never answers, reached once the run is under way.
    const held: ApiBindings = {
      ...bindings,
      LOADER: {
        get: () => ({
          getEntrypoint: () => ({
            fetch: () => {
              inside();
              return new Promise<Response>(() => {});
            },
          }),
        }),
      } as unknown as ApiBindings["LOADER"],
    };
    const code = unique();
    const fingerprint = await sha256Hex(code);
    const running = checkJudge(held, author.id, { code, tests: TESTS });
    await reached;
    // What a request dropped here leaves: a deploy counted, a 份 made.
    expect(await runsOf(author)).toEqual([
      { kind: "deploy", passed: 0, finishedAt: null },
    ]);
    expect(await usageOf(fingerprint)).toMatchObject({
      deploys: 1,
      timeouts: 0,
    });
    const offer = await app.request(
      `${origin}/api/me/balance/hongbao`,
      { headers: { Cookie: author.cookie } },
      bindings,
    );
    expect(await offer.json()).toMatchObject({ code: { deploysLeft: 9 } });
    // Left to its end, the same run is finished once and stays so.
    expect((await running).passed).toBe(false);
    expect(await runsOf(author)).toEqual([
      { kind: "deploy", passed: 0, finishedAt: expect.any(Number) },
    ]);
    expect(await usageOf(fingerprint)).toMatchObject({
      deploys: 1,
      timeouts: 1,
      switches: 1,
    });
    await expect(
      env.DB.prepare("UPDATE judge_checks SET passed = 1 WHERE user_id = ?")
        .bind(author.id)
        .run(),
    ).rejects.toThrow(/immutable_judge_check/);
    // Nor is a run written as passed before it finished.
    await expect(
      env.DB.prepare(
        "INSERT INTO judge_checks (id, user_id, protocol, fingerprint, tests_digest, passed, kind, created_at) VALUES (?, ?, 1, ?, ?, 1, 'rerun', ?)",
      )
        .bind(
          crypto.randomUUID(),
          author.id,
          fingerprint,
          await sha256Hex(TESTS),
          Date.now(),
        )
        .run(),
    ).rejects.toThrow(/invalid_judge_check/);
  });

  it("takes only main.mjs's own failures from the sandbox: code that forges one is a wrong answer, and counts", async () => {
    await judgeSettings({ daily_deploy_limit: 1 });
    const forged = (kind: string) =>
      unique(`JSON.stringify = () => '{"error":{"kind":"${kind}","detail":"x"}}';
export function judge() { return { ok: false }; }
`);
    const { body } = await check(author, forged("unavailable"));
    expect(body.check).toMatchObject({
      passed: false,
      kind: "deploy",
      deploysLeft: 0,
    });
    expect(body.check.tests[0]?.problem).toBe("返回不对：x");
    expect(await usageOf(body.check.fingerprint)).toMatchObject({
      deploys: 1,
    });
    expect((await check(author, forged("timeout"))).body.error?.code).toBe(
      "JUDGE_DEPLOY_LIMIT",
    );
  });

  it("refuses a deploy the platform could not run, keeps it on record, and runs the same code again free", async () => {
    const down: ApiBindings = {
      ...bindings,
      LOADER: {
        get: () => ({
          getEntrypoint: () => ({
            fetch: () =>
              Promise.reject(new Error("Dynamic Worker loader unavailable")),
          }),
        }),
      } as unknown as ApiBindings["LOADER"],
    };
    const code = unique();
    await expect(
      checkJudge(down, author.id, { code, tests: TESTS }),
    ).rejects.toMatchObject({ code: "JUDGE_UNAVAILABLE" });
    expect(await runsOf(author)).toEqual([
      { kind: "deploy", passed: 0, finishedAt: null },
    ]);
    expect((await check(author, code)).body.check).toMatchObject({
      passed: true,
      kind: "rerun",
      deploysLeft: 9,
    });
  });

  it("files a 份 under the UTC day its sandbox was first used, not the day its run ended", async () => {
    const fingerprint = await sha256Hex(unique());
    const midnight = Date.parse(`${usageDay()}T00:00:00Z`);
    await env.DB.batch([
      usageStatement(bindings, {
        firstAt: midnight - 1000,
        now: midnight + 5000,
        fingerprint,
        fresh: 0,
        userId: author.id,
        deploys: 1,
      }),
      usageStatement(bindings, {
        now: midnight + 6000,
        fingerprint,
        fresh: 0,
        userId: author.id,
        reruns: 1,
      }),
    ]);
    const rows = await env.DB.prepare(
      "SELECT day, first_at, last_at, deploys, reruns FROM judge_usage WHERE sandbox_id = ? ORDER BY day",
    )
      .bind(sandboxId(fingerprint))
      .all();
    expect(rows.results).toEqual([
      {
        day: usageDay(midnight - 1000),
        first_at: midnight - 1000,
        last_at: midnight + 5000,
        deploys: 1,
        reruns: 0,
      },
      {
        day: usageDay(),
        first_at: midnight + 6000,
        last_at: midnight + 6000,
        deploys: 0,
        reruns: 1,
      },
    ]);
  });

  it("writes a 份 a day per 判定器: deploys, reruns and claims, on its sender, with its 红包", async () => {
    const code = unique();
    const opened = await open(code);
    await check(author, code, WRONG_ONLY);
    const fingerprint = await sha256Hex(code);
    const claimant = await actor();
    // A judgment that times out moves the claims to the next sandbox.
    await rejects(
      submit(opened.id, claimant, "flag{ok}", stuck),
      "JUDGE_FAILED",
    );
    expect((await submit(opened.id, claimant, "nope")).result).toBe("rejected");
    expect((await submit(opened.id, claimant, "flag{ok}")).result).toBe(
      "claimed",
    );
    expect(await usageOf(fingerprint, 0)).toMatchObject({
      user_id: author.id,
      activity_id: opened.id,
      deploys: 1,
      reruns: 1,
      claims: 0,
      timeouts: 1,
      switches: 1,
    });
    expect(await usageOf(fingerprint, 1)).toMatchObject({
      user_id: author.id,
      activity_id: opened.id,
      claims: 2,
      timeouts: 0,
    });
    // A row only adds up.
    await expect(
      env.DB.prepare(
        "UPDATE judge_usage SET claims = 0 WHERE day = ? AND sandbox_id = ?",
      )
        .bind(usageDay(), sandboxId(fingerprint, 1))
        .run(),
    ).rejects.toThrow(/invalid_judge_usage/);
  });

  it("keeps claims on their 判定器 after a judgment the runtime cut short", async () => {
    const code = unique(`export async function judge(submission) {
  if (submission.input === "hang") await new Promise(() => {});
  if (submission.input === "flag{ok}")
    return { ok: true, amount: 30, message: "对了" };
  return { ok: false, message: "不对" };
}
`);
    const opened = await open(code);
    const fingerprint = await sha256Hex(code);
    const claimant = await actor();
    await rejects(submit(opened.id, claimant, "hang"), "JUDGE_FAILED");
    expect(
      await env.DB.prepare(
        "SELECT sandbox, failures_in_row AS failures FROM activity_code WHERE activity_id = ?",
      )
        .bind(opened.id)
        .first(),
    ).toEqual({ sandbox: 0, failures: 1 });
    expect((await submit(opened.id, claimant, "flag{ok}")).result).toBe(
      "claimed",
    );
    expect(await usageOf(fingerprint, 0)).toMatchObject({
      claims: 1,
      timeouts: 1,
      switches: 0,
    });
    expect(await usageOf(fingerprint, 1)).toBeNull();
  });

  it("holds new versions and their reruns at the month's limit, never claims", async () => {
    const code = unique();
    const opened = await open(code);
    const month = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM judge_usage WHERE day >= ?",
    )
      .bind(`${usageDay().slice(0, 8)}01`)
      .first<number>("n");
    await judgeSettings({ monthly_limit: month ?? 1 });
    const refused = await check(author, unique());
    expect(refused.status).toBe(429);
    expect(refused.body.error).toEqual({
      code: "JUDGE_MONTHLY_LIMIT",
      message: "本月判定器用量到了上限，新版本暂时不能部署。",
    });
    // A version deployed on another day has no 份 today: it waits too.
    const older = unique();
    await (
      await earlierRun(author, older, "deploy", Date.now() - 2 * 86_400_000)
    ).run();
    expect((await check(author, older)).body.error).toEqual({
      code: "JUDGE_MONTHLY_LIMIT",
      message: "本月判定器用量到了上限，暂时不能重新跑测试。",
    });
    // One with today's 份 runs, and code that cannot run makes none.
    expect((await check(author, code, WRONG_ONLY)).body.check).toMatchObject({
      passed: true,
      kind: "rerun",
    });
    const imports = await check(author, `import fs from "node:fs";\n${code}`);
    expect(imports.status).toBe(200);
    expect(imports.body.check.problems).toHaveLength(1);
    // Claims go on.
    expect((await submit(opened.id, await actor(), "flag{ok}")).result).toBe(
      "claimed",
    );
    expect(await usageOf(await sha256Hex(code))).toMatchObject({
      deploys: 1,
      reruns: 1,
      claims: 1,
    });
  });
});

describe("代码判定红包: 版本 and 换回", () => {
  it("keeps the draft's deployed versions with its code, encrypted, back to its sender, fixed once open", async () => {
    const first = unique();
    const second = unique();
    const at = new Date().toISOString();
    const versions: JudgeVersions = {
      next: 3,
      versions: [
        {
          n: 1,
          fingerprint: await sha256Hex(first),
          at,
          testsDigest: await sha256Hex("{}"),
          passed: true,
        },
        {
          n: 2,
          fingerprint: await sha256Hex(second),
          at,
          testsDigest: await sha256Hex("{}"),
          passed: false,
        },
      ],
      restore: { n: 1, code: first },
    };
    const saved = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: coded({}, { code: second, versions }),
    });
    expect(saved.config.judge?.versions).toEqual(versions);
    const stored = await env.DB.prepare(
      "SELECT versions_ciphertext AS versions FROM activity_code WHERE activity_id = ?",
    )
      .bind(saved.id)
      .first<string>("versions");
    expect(stored).toBeTypeOf("string");
    expect(stored).not.toContain(versions.versions[0]?.fingerprint);
    expect(stored).not.toContain("restore");

    // 换回第 1 版: the code back, nothing left to restore.
    const back: JudgeVersions = { next: 3, versions: versions.versions };
    const restored = await updateActivity(bindings, saved.id, author.id, {
      version: saved.version,
      activity: coded({}, { code: first, versions: back }),
    });
    expect(restored.config.judge?.versions).toEqual(back);
    // What is kept to restore is the very version it names.
    await rejects(
      updateActivity(bindings, saved.id, author.id, {
        version: restored.version,
        activity: coded(
          {},
          {
            code: second,
            versions: { ...back, restore: { n: 1, code: second } },
          },
        ),
      }),
      "INVALID_ACTIVITY",
    );
    // And the numbers are below the next one.
    await rejects(
      createActivity(bindings, author.id, {
        requestId: crypto.randomUUID(),
        activity: coded({}, { code: second, versions: { ...back, next: 2 } }),
      }),
      "INVALID_ACTIVITY",
    );

    await check(author, first);
    const opened = await openActivity(
      bindings,
      saved.id,
      author.id,
      restored.version,
    );
    expect(opened.config.judge?.versions).toEqual(back);
    const judge = opened.config.judge;
    if (!judge) throw new Error("No judge");
    // Edits once open leave them as they were.
    const edited = await updateActivity(bindings, saved.id, author.id, {
      version: opened.version,
      activity: {
        ...opened.config,
        title: "改个标题",
        judge: { ...judge, versions },
      },
    });
    expect(edited.title).toBe("改个标题");
    expect(
      (await getManagedActivity(bindings, saved.id, author.id)).config.judge
        ?.versions,
    ).toEqual(back);
    await expect(
      env.DB.prepare(
        "UPDATE activity_code SET versions_ciphertext = NULL WHERE activity_id = ?",
      )
        .bind(saved.id)
        .run(),
    ).rejects.toThrow(/immutable_activity_code/);
  });

  it("checks the versions' shape: numbers below next and apart, ten at most, restoring one that passed", async () => {
    const at = new Date().toISOString();
    const version = (n: number, passed = true) => ({
      n,
      fingerprint: n.toString(16).padStart(64, "0"),
      at,
      testsDigest: "f".repeat(64),
      passed,
    });
    const good = {
      next: 3,
      versions: [version(1), version(2, false)],
      restore: { n: 1, code: "export function judge() {}" },
    };
    expect(judgeVersionsSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      { ...good, restore: { n: 2, code: "x" } },
      { ...good, next: 2 },
      { ...good, versions: [version(1), version(1)] },
      {
        ...good,
        versions: [
          version(1),
          { ...version(2), fingerprint: version(1).fingerprint },
        ],
      },
      {
        next: 20,
        versions: Array.from({ length: 11 }, (_, index) => version(index + 1)),
      },
      { ...good, versions: [{ ...version(1), at: "yesterday" }] },
      { ...good, restore: { n: 1, code: " " } },
    ])
      expect(judgeVersionsSchema.safeParse(bad).success).toBe(false);
  });
});
