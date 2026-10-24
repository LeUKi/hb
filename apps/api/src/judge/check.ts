// 部署 (docs/programmable-hongbao-design.md §5): the sender's judge.js made
// into a 判定器 — the same Dynamic Worker the claims will use — and
// tests.json run in it by the kit's rules (kit/runtime/testing.mjs, which
// npm test and npm run check share). A sender's first run of a code deploys
// it; later runs rerun its tests. A 红包 opens only with code and tests
// that passed.
import type {
  JudgeCheck,
  JudgeCheckInput,
  JudgeSettings,
  JudgeTestOutcome,
} from "@hb/contracts";
import {
  checkSource,
  readTests,
  runTest,
} from "../../../../kit/runtime/index.mjs";
import { ActivityError } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import { startOfBeijingDay } from "../balance/day";
import { readBalanceSettings } from "../balance/settings";
import { transferAccess } from "../balance/transfers";
import type { ApiBindings } from "../env";
import { JUDGE_PROTOCOL, runJudge, type SandboxOutcome } from "./sandbox";
import { readJudgeSettings } from "./settings";
import { textDigest } from "./storage";
import { overMonthlyLimit, usageStatement } from "./usage";

/**
 * Timeouts one run goes past: the first moves to a fresh sandbox, so a
 * deploy is at most 2 份 (§5 费用); the second leaves the rest unrun.
 */
const SANDBOXES = 2;
/** Runs a day per person, deploys and reruns alike: unshown, against abuse. */
export const RUNS_PER_DAY = 50;
/** Longer than the longest run: 200 judgments twice, each given up at 300 ms. */
const RUN_LEASE_MS = 3 * 60_000;

/** May this person send 代码判定红包: the switch, and 🐟额 PLUS (or 站长). */
export async function codeHongbaoAccess(env: ApiBindings, userId: string) {
  const [settings, access] = await Promise.all([
    readJudgeSettings(env),
    transferAccess(env, userId),
  ]);
  return {
    enabled: settings.enabled,
    allowed: access.allowed,
    settings,
  };
}

export async function requireCodeHongbao(env: ApiBindings, userId: string) {
  const access = await codeHongbaoAccess(env, userId);
  if (!access.allowed)
    throw new ActivityError(
      403,
      "CODE_HONGBAO_NOT_ALLOWED",
      "开通🐟额 PLUS 才能发代码判定红包。",
    );
  if (!access.enabled)
    throw new ActivityError(
      409,
      "CODE_HONGBAO_PAUSED",
      "代码判定红包暂时关闭。",
    );
  return access.settings;
}

/**
 * What the 发红包 form needs: whether this person may send 代码判定红包 now
 * (PLUS, its switch and 🐟额红包's), and new versions left to deploy today.
 * Null otherwise.
 */
export async function codeHongbaoOffer(env: ApiBindings, userId: string) {
  const [access, balance] = await Promise.all([
    codeHongbaoAccess(env, userId),
    readBalanceSettings(env),
  ]);
  if (!access.allowed || !access.enabled || !balance.hongbaoEnabled)
    return null;
  const limit = access.settings.dailyDeployLimit;
  return {
    deploysLeft: Math.max(0, limit - (await runsToday(env, userId)).deploys),
    /** 每人每天部署几次: “今天的 10 次部署用完了”. */
    deployLimit: limit,
  };
}

/** Today's runs (北京时间) by this person, and how many were deploys. */
async function runsToday(env: ApiBindings, userId: string) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS runs, COALESCE(SUM(kind = 'deploy'), 0) AS deploys FROM judge_checks WHERE user_id = ? AND created_at >= ?",
  )
    .bind(userId, startOfBeijingDay())
    .first<{ runs: number; deploys: number }>();
  return { runs: row?.runs ?? 0, deploys: row?.deploys ?? 0 };
}

/** Whether this sender ran this code before: then it is no new version. */
async function deployedBefore(
  env: ApiBindings,
  userId: string,
  fingerprint: string,
) {
  return Boolean(
    await env.DB.prepare(
      "SELECT 1 FROM judge_checks WHERE user_id = ? AND protocol = ? AND fingerprint = ? LIMIT 1",
    )
      .bind(userId, JUDGE_PROTOCOL, fingerprint)
      .first(),
  );
}

/** Whether this code and these tests passed a run by this sender. */
export async function passedCheck(
  env: ApiBindings,
  userId: string,
  fingerprint: string,
  testsDigest: string,
) {
  return Boolean(
    await env.DB.prepare(
      "SELECT 1 FROM judge_checks WHERE user_id = ? AND protocol = ? AND fingerprint = ? AND tests_digest = ? AND passed = 1 LIMIT 1",
    )
      .bind(userId, JUDGE_PROTOCOL, fingerprint, testsDigest)
      .first(),
  );
}

/**
 * Whether this sender deployed this code but never ran these tests on it:
 * tests.json changed since, and a rerun is what it waits for (redesign/07
 * §5 “测试改过了，要重新跑一遍”). A run cut off before its end ran nothing.
 */
export async function testsChanged(
  env: ApiBindings,
  userId: string,
  fingerprint: string,
  testsDigest: string,
) {
  return (
    (await env.DB.prepare(
      `SELECT EXISTS(SELECT 1 FROM judge_checks WHERE user_id = ?1 AND protocol = ?2 AND fingerprint = ?3
          AND finished_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM judge_checks WHERE user_id = ?1 AND protocol = ?2 AND fingerprint = ?3
          AND tests_digest = ?4 AND finished_at IS NOT NULL) AS changed`,
    )
      .bind(userId, JUDGE_PROTOCOL, fingerprint, testsDigest)
      .first<number>("changed")) === 1
  );
}

/**
 * A person's runs go one at a time (judge_run_leases): each reads the day's
 * counts and 每月上限 before it writes itself, so two at once would both
 * pass them. A run that died lets the next start once its lease is out.
 */
async function leaseRun(env: ApiBindings, userId: string) {
  const token = crypto.randomUUID();
  const now = Date.now();
  const taken =
    await env.DB.prepare(`INSERT INTO judge_run_leases (user_id, token, lease_until) VALUES (?1, ?2, ?3)
    ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, lease_until = excluded.lease_until
    WHERE judge_run_leases.lease_until <= ?4`)
      .bind(userId, token, now + RUN_LEASE_MS, now)
      .run();
  if (!taken.meta.changes)
    throw new ActivityError(
      429,
      "JUDGE_RUN_BUSY",
      "上一次测试还在跑，等它跑完再试。",
    );
  return token;
}

export async function checkJudge(
  env: ApiBindings,
  userId: string,
  input: JudgeCheckInput,
): Promise<JudgeCheck> {
  const settings = await requireCodeHongbao(env, userId);
  const lease = await leaseRun(env, userId);
  try {
    return await runChecks(env, userId, input, settings);
  } finally {
    // One left behind runs out by itself.
    await env.DB.prepare(
      "DELETE FROM judge_run_leases WHERE user_id = ? AND token = ?",
    )
      .bind(userId, lease)
      .run()
      .catch(() => {});
  }
}

async function runChecks(
  env: ApiBindings,
  userId: string,
  input: JudgeCheckInput,
  settings: JudgeSettings,
): Promise<JudgeCheck> {
  const [fingerprint, testsDigest] = await Promise.all([
    textDigest(input.code),
    textDigest(input.tests),
  ]);
  const [used, rerun] = await Promise.all([
    runsToday(env, userId),
    deployedBefore(env, userId, fingerprint),
  ]);
  if (used.runs >= RUNS_PER_DAY)
    throw new ActivityError(
      429,
      "JUDGE_RUN_LIMIT",
      "今天跑测试的次数太多了，明天再来。",
    );
  // Only a new version counts; its tests again, or a version deployed
  // before, do not (§5 次数).
  if (!rerun && used.deploys >= settings.dailyDeployLimit)
    throw new ActivityError(
      429,
      "JUDGE_DEPLOY_LIMIT",
      `今天的 ${settings.dailyDeployLimit} 次部署用完了，明天再来。`,
    );
  const problems = checkSource(input.code);
  const read = readTests(input.tests);
  const testsProblem = "problem" in read ? read.problem : undefined;
  // 每月上限 (§7) holds whatever would make another 份 today.
  if (
    problems.length === 0 &&
    "tests" in read &&
    read.tests.length > 0 &&
    (await overMonthlyLimit(env, settings, fingerprint))
  )
    throw new ActivityError(
      429,
      "JUDGE_MONTHLY_LIMIT",
      rerun
        ? "本月判定器用量到了上限，暂时不能重新跑测试。"
        : "本月判定器用量到了上限，新版本暂时不能部署。",
    );
  const checkId = crypto.randomUUID();
  // The run is on record before anything runs, so one cut off midway (the
  // request dropped) still counts (§5 次数); it is finished at its end.
  // Whether it deploys is the database's to say: a run of the same code
  // just before makes it a rerun.
  const recorded =
    await env.DB.prepare(`INSERT INTO judge_checks (id, user_id, protocol, fingerprint, tests_digest, passed, kind, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, 0, CASE WHEN EXISTS(SELECT 1 FROM judge_checks
      WHERE user_id = ?2 AND protocol = ?3 AND fingerprint = ?4) THEN 'rerun' ELSE 'deploy' END, ${databaseNow}
    RETURNING kind`)
      .bind(checkId, userId, JUDGE_PROTOCOL, fingerprint, testsDigest)
      .first<{ kind: JudgeCheck["kind"] }>();
  const kind = recorded?.kind ?? (rerun ? "rerun" : "deploy");
  const tests: JudgeTestOutcome[] = [];
  const unstable: string[] = [];
  let loadProblem: string | undefined;
  let unavailable = false;
  let slowestMs: number | null = null;
  // What each sandbox used went through, from its first use, for its 用量
  // row.
  const sandboxes = new Map<
    number,
    { firstAt: number; timeouts: number; switches: number }
  >();
  let sandbox = 0;
  let timeouts = 0;
  if (problems.length === 0 && "tests" in read) {
    const run = async (
      submission: Parameters<typeof runJudge>[1]["submission"],
      seeds: { submission: string; user: string },
    ): Promise<SandboxOutcome> => {
      if (timeouts >= SANDBOXES)
        return { failure: "timeout", detail: "前面超时，这条没跑" };
      const started = Date.now();
      let usage = sandboxes.get(sandbox);
      if (!usage) {
        usage = { firstAt: started, timeouts: 0, switches: 0 };
        sandboxes.set(sandbox, usage);
        // Its 份 is on record before the 判定器 is made (§7): 每月上限 and
        // 用量 see it even if the run goes no further. The run counts on
        // the first sandbox, as its judge_checks row says.
        await usageStatement(env, {
          now: started,
          fingerprint,
          fresh: sandbox,
          userId,
          ...(sandbox === 0 ? { checkId } : {}),
        }).run();
      }
      const outcome = await runJudge(
        env,
        { code: input.code, fingerprint, submission, seeds, fresh: sandbox },
        true,
      );
      if ("failure" in outcome && outcome.failure === "timeout") {
        timeouts += 1;
        usage.timeouts += 1;
        // The next run goes past a sandbox that may still be stuck; one
        // the runtime cut short holds nothing.
        if (!outcome.hung && timeouts < SANDBOXES) {
          usage.switches += 1;
          sandbox += 1;
        }
      } else slowestMs = Math.max(slowestMs ?? 0, Date.now() - started);
      return outcome;
    };
    for (const test of read.tests) {
      if (timeouts >= SANDBOXES) {
        tests.push({
          name: test.name,
          passed: false,
          problem: "前面超时，这条没跑",
        });
        continue;
      }
      // Twice, a multi-step test as a whole: an answer that changes is
      // true randomness, not replayable.
      const result = await runTest(test, run, { twice: true });
      const { failure } = result;
      if (failure?.kind === "load" || failure?.kind === "no-judge") {
        loadProblem =
          failure.kind === "load"
            ? `代码加载不了：${failure.detail}`
            : failure.detail;
        break;
      }
      if (failure?.kind === "unavailable") {
        unavailable = true;
        break;
      }
      tests.push({
        name: test.name,
        passed: result.passed,
        ...(result.problem ? { problem: result.problem } : {}),
        ...(result.actual ? { actual: result.actual } : {}),
        ms: result.ms,
      });
      if (result.unstable) unstable.push(test.name);
    }
  }
  const passed =
    problems.length === 0 &&
    !testsProblem &&
    !loadProblem &&
    tests.length > 0 &&
    tests.every((test) => test.passed);
  const checkedAt = Date.now();
  // What each sandbox went through, on the row its first use made.
  const usage = [...sandboxes].map(([fresh, went]) =>
    usageStatement(env, {
      now: checkedAt,
      fingerprint,
      fresh,
      userId,
      ...went,
    }),
  );
  if (unavailable) {
    // The run stays unfinished: its tests never ran.
    if (usage.length > 0) await env.DB.batch(usage);
    throw new ActivityError(
      503,
      "JUDGE_UNAVAILABLE",
      // Counted all the same (code can make this happen): the same code
      // again is a rerun.
      "判定器的运行环境暂时不可用，请稍后再试；这一版再跑不另算次数。",
    );
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE judge_checks SET passed = ?, finished_at = ${databaseNow} WHERE id = ?`,
    ).bind(Number(passed), checkId),
    ...usage,
  ]);
  return {
    fingerprint,
    testsDigest,
    passed,
    problems,
    ...(testsProblem ? { testsProblem } : {}),
    ...(loadProblem ? { loadProblem } : {}),
    tests,
    unstable,
    slowestMs,
    checkedAt: new Date(checkedAt).toISOString(),
    kind,
    deploysLeft: Math.max(
      0,
      settings.dailyDeployLimit - used.deploys - Number(kind === "deploy"),
    ),
  };
}
