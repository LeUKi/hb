// 部署 (docs/programmable-hongbao-design.md §5): the sender's judge.js made
// into a 判定器 — the same Dynamic Worker the claims will use — and
// tests.json run in it by the kit's rules (kit/runtime/testing.mjs, which
// npm test and npm run check share), its requests answered from what the
// tests wrote, never the network (§9.6). A sender's first run of a code
// deploys it, on whichever protocol; later runs rerun its tests. A 红包
// opens only with code and tests that passed, on the newest protocol they
// passed on from JUDGE_OLDEST_PROTOCOL.
import {
  JUDGE_OLDEST_PROTOCOL,
  type JudgeCheck,
  type JudgeCheckInput,
  type JudgeDeclarations,
  type JudgeSettings,
  type JudgeTestOutcome,
} from "@hb/contracts";
import type { FetchAnswer } from "../../../../kit/judge";
import {
  checkSource,
  type RunCheck,
  readCheckAnswer,
  readDeclarations,
  readNetwork,
  readTests,
  runTest,
} from "../../../../kit/runtime/index.mjs";
import { ActivityError } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import { startOfBeijingDay } from "../balance/day";
import { transferAccess } from "../balance/transfers";
import type { ApiBindings } from "../env";
import {
  checkParamsInJudge,
  describeJudge,
  JUDGE_PROTOCOL,
  runJudge,
  type SandboxOutcome,
  warmJudge,
} from "./sandbox";
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

/**
 * 代码判定红包 for anyone signed in while its switch is on (§1, 2026-10-28):
 * 🐟额 PLUS and the 站长 only deploy more a day (§5 次数).
 */
export async function codeHongbaoAccess(env: ApiBindings, userId: string) {
  const [settings, access] = await Promise.all([
    readJudgeSettings(env),
    transferAccess(env, userId),
  ]);
  return {
    enabled: settings.enabled,
    deployLimit: access.allowed
      ? settings.dailyDeployLimitPlus
      : settings.dailyDeployLimit,
    settings,
  };
}

export async function requireCodeHongbao(env: ApiBindings, userId: string) {
  const access = await codeHongbaoAccess(env, userId);
  if (!access.enabled)
    throw new ActivityError(
      409,
      "CODE_HONGBAO_PAUSED",
      "代码判定红包暂时关闭。",
    );
  return access;
}

/**
 * What the 发红包 form needs: whether 代码判定红包 can be sent now (its
 * switch), and new versions left to deploy today. Null otherwise.
 */
export async function codeHongbaoOffer(env: ApiBindings, userId: string) {
  const access = await codeHongbaoAccess(env, userId);
  if (!access.enabled) return null;
  const limit = access.deployLimit;
  return {
    deploysLeft: Math.max(0, limit - (await runsToday(env, userId)).deploys),
    /** 每人每天部署几次: “今天的 2 次部署用完了”. */
    deployLimit: limit,
  };
}

/**
 * Today's runs (北京时间) by this person — check() and 试一试 among them
 * (docs/judge-square-design.md §3, §6) — and how many were deploys.
 */
export async function runsToday(env: ApiBindings, userId: string) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM judge_checks WHERE user_id = ?1 AND created_at >= ?2)
        + (SELECT COUNT(*) FROM judge_tries WHERE user_id = ?1 AND created_at >= ?2) AS runs,
      (SELECT COUNT(*) FROM judge_checks WHERE user_id = ?1 AND created_at >= ?2 AND kind = 'deploy') AS deploys`,
  )
    .bind(userId, startOfBeijingDay())
    .first<{ runs: number; deploys: number }>();
  return { runs: row?.runs ?? 0, deploys: row?.deploys ?? 0 };
}

/**
 * Whether this sender ran this code before, on any protocol: then it is no
 * new version (§9.1: a version deployed on v1 runs again on v2 for free).
 */
async function deployedBefore(
  env: ApiBindings,
  userId: string,
  fingerprint: string,
) {
  return Boolean(
    await env.DB.prepare(
      "SELECT 1 FROM judge_checks WHERE user_id = ? AND fingerprint = ? LIMIT 1",
    )
      .bind(userId, fingerprint)
      .first(),
  );
}

/**
 * The protocol a 红包 with this code and these tests opens on (docs/judge-
 * page-design.md §11.1): the newest a passing run of them by this sender
 * was on, from JUDGE_OLDEST_PROTOCOL — so a 判定器 tested on v3 opens on
 * v3's runtime, as it was tested. Null when none passed.
 */
export async function openingProtocol(
  env: ApiBindings,
  userId: string,
  fingerprint: string,
  testsDigest: string,
) {
  return env.DB.prepare(
    `SELECT MAX(protocol) AS protocol FROM judge_checks WHERE user_id = ? AND protocol >= ? AND fingerprint = ?
      AND tests_digest = ? AND passed = 1`,
  )
    .bind(userId, JUDGE_OLDEST_PROTOCOL, fingerprint, testsDigest)
    .first<number | null>("protocol");
}

/** Whether this code and these tests passed a run by this sender. */
export async function passedCheck(
  env: ApiBindings,
  userId: string,
  fingerprint: string,
  testsDigest: string,
) {
  return (
    (await openingProtocol(env, userId, fingerprint, testsDigest)) !== null
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
      `SELECT EXISTS(SELECT 1 FROM judge_checks WHERE user_id = ?1 AND protocol >= ?2 AND fingerprint = ?3
          AND finished_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM judge_checks WHERE user_id = ?1 AND protocol >= ?2 AND fingerprint = ?3
          AND tests_digest = ?4 AND finished_at IS NOT NULL) AS changed`,
    )
      .bind(userId, JUDGE_OLDEST_PROTOCOL, fingerprint, testsDigest)
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
  const { settings, deployLimit } = await requireCodeHongbao(env, userId);
  const lease = await leaseRun(env, userId);
  try {
    return await runChecks(env, userId, input, settings, deployLimit);
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
  /** This person's a day: PLUS's or everyone's (§5 次数). */
  deployLimit: number,
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
  if (!rerun && used.deploys >= deployLimit)
    throw new ActivityError(
      429,
      "JUDGE_DEPLOY_LIMIT",
      `今天的 ${deployLimit} 次部署用完了，明天再来。`,
    );
  const problems = checkSource(input.code);
  const read = readTests(input.tests, { protocol: JUDGE_PROTOCOL });
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
      WHERE user_id = ?2 AND fingerprint = ?4) THEN 'rerun' ELSE 'deploy' END, ${databaseNow}
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
  // 联网 (§9.2): what judge.js exports, read once it is loaded.
  let network: string[] | null = null;
  const networkProblems: string[] = [];
  // 协议第三版: meta, params, hongbao and check, read with it.
  let declarations: JudgeDeclarations = {
    meta: null,
    params: [],
    hongbao: null,
    check: false,
  };
  const declarationProblems: string[] = [];
  /**
   * A sandbox's first use: its 份 on record before the 判定器 is made (§7:
   * 每月上限 and 用量 see it even if the run goes no further; the run
   * counts on the first sandbox, as its judge_checks row says), then warmed
   * as the kit warms its own, so neither the write nor the start is timed
   * as a judgment (最慢).
   */
  const prepare = async (fresh: number) => {
    const usage = { firstAt: Date.now(), timeouts: 0, switches: 0 };
    sandboxes.set(fresh, usage);
    await usageStatement(env, {
      now: usage.firstAt,
      fingerprint,
      fresh,
      userId,
      ...(fresh === 0 ? { checkId } : {}),
    }).run();
    await warmJudge(env, { code: input.code, fingerprint, fresh });
    return usage;
  };
  if (problems.length === 0 && "tests" in read && read.tests.length > 0) {
    await prepare(0);
    const described = await describeJudge(env, {
      code: input.code,
      fingerprint,
      fresh: 0,
    });
    // Code that will not load says so in its first test.
    if (described) {
      const unreadable = Array.isArray(described.unreadable)
        ? described.unreadable
        : [];
      const declared = unreadable.includes("network")
        ? { problems: ["network 要是字符串数组"] }
        : readNetwork(described.network);
      if ("problems" in declared) networkProblems.push(...declared.problems);
      else network = declared.list;
      if (network && !settings.networkEnabled)
        networkProblems.push("代码判定暂时不能联网。");
      const { problems: wrong, ...read } = readDeclarations(described);
      declarations = read;
      declarationProblems.push(...wrong);
    }
    const run = async (
      submission: Parameters<typeof runJudge>[1]["submission"],
      seeds: { submission: string; user: string },
      answers: readonly FetchAnswer[] = [],
    ): Promise<SandboxOutcome> => {
      if (timeouts >= SANDBOXES)
        return { failure: "timeout", detail: "前面超时，这条没跑" };
      // A fresh sandbox after a timeout is made when it is first needed.
      const usage = sandboxes.get(sandbox) ?? (await prepare(sandbox));
      const started = Date.now();
      const outcome = await runJudge(
        env,
        {
          code: input.code,
          fingerprint,
          submission,
          seeds,
          fresh: sandbox,
          network: { mode: "mock", list: network, answers },
        },
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
    // check(params, hongbao), once for the same params and numbers, in the
    // sandbox in use: its timeouts count as a judgment's do.
    const checked = new Map<string, Awaited<ReturnType<RunCheck>>>();
    const check: RunCheck = async (params, hongbao) => {
      const key = JSON.stringify([params, hongbao]);
      const known = checked.get(key);
      if (known) return known;
      let answer: Awaited<ReturnType<RunCheck>>;
      if (timeouts >= SANDBOXES)
        answer = { failure: "timeout", detail: "前面超时，这条没跑" };
      else {
        const usage = sandboxes.get(sandbox) ?? (await prepare(sandbox));
        const outcome = await checkParamsInJudge(
          env,
          { code: input.code, fingerprint, fresh: sandbox },
          { params, hongbao },
        );
        if ("failure" in outcome) {
          if (outcome.failure === "timeout") {
            timeouts += 1;
            usage.timeouts += 1;
            if (!outcome.hung && timeouts < SANDBOXES) {
              usage.switches += 1;
              sandbox += 1;
            }
          }
          answer = { failure: outcome.failure, detail: outcome.detail };
        } else answer = readCheckAnswer(outcome.answer, declarations.params);
      }
      checked.set(key, answer);
      return answer;
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
      // true randomness, not replayable. Its params held to the declared
      // ones and to check() (协议第三版); none to check while those are wrong.
      if (declarationProblems.length > 0) break;
      const result = await runTest(test, run, {
        protocol: JUDGE_PROTOCOL,
        twice: true,
        params: declarations.params,
        ...(declarations.check ? { check } : {}),
      });
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
    networkProblems.length === 0 &&
    declarationProblems.length === 0 &&
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
      `UPDATE judge_checks SET passed = ?, finished_at = ${databaseNow}, network = ? WHERE id = ?`,
    ).bind(
      Number(passed),
      network && networkProblems.length === 0 ? JSON.stringify(network) : null,
      checkId,
    ),
    ...usage,
  ]);
  return {
    fingerprint,
    testsDigest,
    protocol: JUDGE_PROTOCOL,
    passed,
    network,
    ...(networkProblems.length > 0 ? { networkProblems } : {}),
    declarations,
    ...(declarationProblems.length > 0 ? { declarationProblems } : {}),
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
      deployLimit - used.deploys - Number(kind === "deploy"),
    ),
  };
}
