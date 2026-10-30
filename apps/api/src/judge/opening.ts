// Opening a 代码判定红包 (docs/programmable-hongbao-design.md §1, §5): the
// switch is on, its sender's openings today are not used up
// and this very code, deployed, passed these very tests. The SQL below
// holds the same inside the opening write.
import {
  type JudgeDeclarations,
  type JudgeParams,
  type LdcActivityInput,
  type LdcOpeningBlockedReason,
  ldcTotalMinor,
} from "@hb/contracts";
import {
  defaultCount,
  LEDGER_PROTOCOL,
  readSetup,
  setupSeed,
  VIEW_PROTOCOL,
} from "../../../../kit/runtime/index.mjs";
import { ActivityError } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import type { ActivityRow } from "../activities/storage";
import { startOfBeijingDay } from "../balance/day";
import type { ApiBindings } from "../env";
import { decryptString, encryptString } from "../security/crypto";
import {
  codeHongbaoAccess,
  openingProtocol,
  passedBefore,
  testsChanged,
} from "./check";
import { openingParams } from "./params";
import { setupInJudge } from "./sandbox";
import { judgeAuthorOf } from "./square";
import { findJudgeRow, type JudgeRow, judgeData } from "./storage";
import { usageStatement } from "./usage";

/**
 * Whose run a 红包's code opens with — its own sender's, or for another's
 * 判定器 its author's (judge-square §15.3) — and the protocol it opens on
 * (check.ts openingProtocol); null when no run of it passed.
 */
export async function codeOpeningRun(
  env: ApiBindings,
  authorId: string,
  judge: JudgeRow,
) {
  const runBy = (await judgeAuthorOf(env, judge.judgeId)) ?? authorId;
  return {
    runBy,
    protocol: await openingProtocol(
      env,
      runBy,
      judge.fingerprint,
      judge.testsDigest,
    ),
  };
}

async function openedToday(env: ApiBindings, authorId: string) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM activities WHERE author_id = ? AND participation_mode = 'code' AND opened_at >= ?",
  )
    .bind(authorId, startOfBeijingDay())
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function codeOpeningBlocked(
  env: ApiBindings,
  row: ActivityRow,
): Promise<LdcOpeningBlockedReason | undefined> {
  const access = await codeHongbaoAccess(env, row.authorId);
  if (!access.enabled) return "CODE_HONGBAO_PAUSED";
  const judge = await findJudgeRow(env, row.id);
  if (!judge) return "JUDGE_CHECK_REQUIRED";
  // Another's 判定器 (judge-square §15.3): not once the 站长 took it
  // down; it opens with its author's run.
  if (
    judge.judgeId &&
    (await env.DB.prepare(
      "SELECT 1 FROM judges WHERE id = ? AND taken_down_at IS NOT NULL",
    )
      .bind(judge.judgeId)
      .first())
  )
    return "JUDGE_TAKEN_DOWN";
  const { runBy, protocol } = await codeOpeningRun(env, row.authorId, judge);
  const { fingerprint, testsDigest } = judge;
  if (protocol === null) {
    // A 旧判定器 (docs/multi-prize-design.md §3.6): passed, but only on a
    // protocol new 红包 no longer open on.
    if (await passedBefore(env, runBy, fingerprint, testsDigest))
      return "JUDGE_OLD_PROTOCOL";
    return (await testsChanged(env, runBy, fingerprint, testsDigest))
      ? "JUDGE_RERUN_REQUIRED"
      : "JUDGE_CHECK_REQUIRED";
  }
  // 联网 (§9.7): code that goes online opens only while it is on.
  if (
    !access.settings.networkEnabled &&
    (await env.DB.prepare(
      `SELECT 1 FROM judge_checks WHERE user_id = ? AND protocol = ? AND fingerprint = ? AND tests_digest = ?
        AND passed = 1 AND network IS NOT NULL LIMIT 1`,
    )
      .bind(runBy, protocol, fingerprint, testsDigest)
      .first())
  )
    return "CODE_NETWORK_PAUSED";
  // Its params as its version declares them (judge-square §3); check()
  // runs as it opens (service.ts), not on every read.
  if ("problems" in (await openingParams(env, row.authorId, judge)).read)
    return "JUDGE_PARAMS_INVALID";
  if ((await openedToday(env, row.authorId)) >= access.settings.dailyOpenLimit)
    return "CODE_HONGBAO_DAILY_LIMIT";
  return undefined;
}

/**
 * Inside the opening UPDATE's CASE: one `?`, the start of today (北京时间).
 * Other kinds of 红包 pass.
 */
export const CODE_OPENING_ALLOWED = `(participation_mode != 'code' OR (
  EXISTS(SELECT 1 FROM judge_settings WHERE id='global' AND enabled=1)
  AND (NOT EXISTS(SELECT 1 FROM activity_code c WHERE c.activity_id=activities.id AND c.network IS NOT NULL)
    OR EXISTS(SELECT 1 FROM judge_settings WHERE id='global' AND network_enabled=1))
  AND (SELECT COUNT(*) FROM activities o WHERE o.author_id=activities.author_id AND o.participation_mode='code'
    AND o.opened_at>=?) < (SELECT daily_open_limit FROM judge_settings WHERE id='global')))`;

export const codeOpeningDay = () => startOfBeijingDay();

/** Opening refused for setup()'s failure (docs/judge-page-design.md §2). */
export function setupFailedError(detail: string) {
  return new ActivityError(
    409,
    "JUDGE_SETUP_FAILED",
    `判定器开放时出错：${detail}，草稿已保存。`,
  );
}

/**
 * setup(params, hongbao) as a 红包 on protocol 4 opens (docs/judge-page-
 * design.md §2): once, a sandbox use as check() is, at `now`, Math.random()
 * drawn from its seed, so a replay draws the same. What it answered goes
 * in after the opening's UPDATE, the seed sealed as `commitment`: the
 * first state, what everyone sees and, for the records, setup()'s answer
 * itself. Null for code without setup() or an earlier protocol. Code not
 * deployed into a 判定器 has no declarations: the sandbox is asked, and
 * says nothing (null) when there is no setup().
 */
export async function openingSetup(
  env: ApiBindings,
  activity: ActivityRow,
  judge: JudgeRow,
  input: {
    protocol: number;
    declarations: JudgeDeclarations | null;
    params: JudgeParams;
    config: LdcActivityInput;
    secret: string;
    commitment: string;
    now: number;
  },
) {
  const { protocol, now, declarations } = input;
  if (protocol < VIEW_PROTOCOL || (declarations && !declarations.setup))
    return null;
  const code = await decryptString(
    judge.codeCiphertext,
    env,
    judgeData(activity.id, "code"),
  );
  await usageStatement(env, {
    now,
    fingerprint: judge.fingerprint,
    fresh: 0,
    protocol,
    userId: activity.authorId,
    tries: 1,
  }).run();
  const outcome = await setupInJudge(
    env,
    { code, fingerprint: judge.fingerprint, fresh: 0, protocol },
    {
      params: input.params,
      // Protocol 5 has no shares: the compatible n and 0.01 (§3.5).
      hongbao: {
        title: activity.title,
        total: ldcTotalMinor(input.config),
        count:
          protocol >= LEDGER_PROTOCOL
            ? defaultCount(ldcTotalMinor(input.config))
            : activity.totalCount,
        minEach: protocol >= LEDGER_PROTOCOL ? 1 : judge.minEachMinor,
      },
      now,
      seed: setupSeed(activity.id, input.secret),
    },
  );
  if ("failure" in outcome) throw setupFailedError(outcome.detail);
  if (outcome.answer === null && !declarations) return null;
  const read = readSetup(outcome.answer);
  if ("error" in read) throw setupFailedError(read.error.detail);
  const view = read.view.keep ? undefined : read.view.value;
  const record = {
    at: now,
    title: activity.title,
    ...(read.state.keep ? {} : { state: read.state.value }),
    ...(read.view.keep ? {} : { view: read.view.value }),
  };
  return env.DB.prepare(`UPDATE activity_code SET state_ciphertext = ?1, view_summary = ?2, view_data = ?3,
      view_at = ?4, setup_ciphertext = ?5, updated_at = ${databaseNow}
    WHERE activity_id = ?6 AND seed_commitment = ?7`).bind(
    read.state.keep
      ? null
      : await encryptString(
          JSON.stringify(read.state.value),
          env,
          judgeData(activity.id, "state"),
        ),
    view?.summary ?? null,
    view?.data === undefined ? null : JSON.stringify(view.data),
    view === undefined ? null : now,
    await encryptString(
      JSON.stringify(record),
      env,
      judgeData(activity.id, "setup"),
    ),
    activity.id,
    input.commitment,
  );
}
