// 在线检查 (docs/programmable-hongbao-design.md §5): the sender's judge.js and
// tests.json, run here by the kit's rules (kit/runtime/testing.mjs, which
// npm test and npm run check share) in the same Dynamic Worker the claims
// will use. A 红包 opens only with code and tests that passed.
import type {
  JudgeCheck,
  JudgeCheckInput,
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
import { textDigest } from "./storage";

/** Sandboxes a check may move to after timeouts (4 Dynamic Workers a request). */
const SANDBOXES = 4;

/** May this person send 代码判定红包: the switch, and 🐟额 PLUS (or 站长). */
export async function codeHongbaoAccess(env: ApiBindings, userId: string) {
  const [settings, access] = await Promise.all([
    readBalanceSettings(env),
    transferAccess(env, userId),
  ]);
  return {
    enabled: settings.codeHongbaoEnabled,
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
 * (PLUS, its switch and 🐟额红包's), and 在线检查 left today. Null otherwise.
 */
export async function codeHongbaoOffer(env: ApiBindings, userId: string) {
  const access = await codeHongbaoAccess(env, userId);
  if (!access.allowed || !access.enabled || !access.settings.hongbaoEnabled)
    return null;
  return {
    checksLeft: Math.max(
      0,
      access.settings.codeCheckDailyLimit - (await checksToday(env, userId)),
    ),
  };
}

async function checksToday(env: ApiBindings, userId: string) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM judge_checks WHERE user_id = ? AND created_at >= ?",
  )
    .bind(userId, startOfBeijingDay())
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** Whether this code and these tests passed a check by this sender. */
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

export async function checkJudge(
  env: ApiBindings,
  userId: string,
  input: JudgeCheckInput,
): Promise<JudgeCheck> {
  const settings = await requireCodeHongbao(env, userId);
  const used = await checksToday(env, userId);
  if (used >= settings.codeCheckDailyLimit)
    throw new ActivityError(
      429,
      "JUDGE_CHECK_LIMIT",
      `今天的 ${settings.codeCheckDailyLimit} 次在线检查用完了，明天再来。`,
    );
  const [fingerprint, testsDigest] = await Promise.all([
    textDigest(input.code),
    textDigest(input.tests),
  ]);
  const problems = checkSource(input.code);
  const read = readTests(input.tests);
  const testsProblem = "problem" in read ? read.problem : undefined;
  const tests: JudgeTestOutcome[] = [];
  const unstable: string[] = [];
  let loadProblem: string | undefined;
  let slowestMs: number | null = null;
  if (problems.length === 0 && "tests" in read) {
    let sandbox = 0;
    const run = async (
      submission: Parameters<typeof runJudge>[1]["submission"],
      seeds: { submission: string; user: string },
    ): Promise<SandboxOutcome> => {
      const started = Date.now();
      const outcome = await runJudge(
        env,
        { code: input.code, fingerprint, submission, seeds, fresh: sandbox },
        true,
      );
      if ("failure" in outcome && outcome.failure === "timeout") sandbox += 1;
      else slowestMs = Math.max(slowestMs ?? 0, Date.now() - started);
      return outcome;
    };
    for (const test of read.tests) {
      if (sandbox >= SANDBOXES) {
        tests.push({
          name: test.name,
          passed: false,
          problem: "前面超时太多，这条没跑",
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
      if (failure?.kind === "unavailable")
        throw new ActivityError(
          503,
          "JUDGE_UNAVAILABLE",
          "沙箱暂时不可用，这次不算次数，请稍后再试。",
        );
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
  await env.DB.prepare(`INSERT INTO judge_checks (id, user_id, protocol, fingerprint, tests_digest, passed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ${databaseNow})`)
    .bind(
      crypto.randomUUID(),
      userId,
      JUDGE_PROTOCOL,
      fingerprint,
      testsDigest,
      Number(passed),
    )
    .run();
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
    remainingToday: Math.max(0, settings.codeCheckDailyLimit - used - 1),
  };
}
