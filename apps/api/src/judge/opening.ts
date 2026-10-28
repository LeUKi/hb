// Opening a 代码判定红包 (docs/programmable-hongbao-design.md §1, §5): the
// switch is on, its sender's openings today are not used up
// and this very code, deployed, passed these very tests. The SQL below
// holds the same inside the opening write.
import { JUDGE_PROTOCOL, type LdcOpeningBlockedReason } from "@hb/contracts";
import type { ActivityRow } from "../activities/storage";
import { startOfBeijingDay } from "../balance/day";
import type { ApiBindings } from "../env";
import { codeHongbaoAccess, passedCheck, testsChanged } from "./check";
import { openingParams } from "./params";
import { judgeAuthorOf } from "./square";
import { findJudgeRow } from "./storage";

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
  const runBy = (await judgeAuthorOf(env, judge.judgeId)) ?? row.authorId;
  const { fingerprint, testsDigest } = judge;
  if (!(await passedCheck(env, runBy, fingerprint, testsDigest)))
    return (await testsChanged(env, runBy, fingerprint, testsDigest))
      ? "JUDGE_RERUN_REQUIRED"
      : "JUDGE_CHECK_REQUIRED";
  // 联网 (§9.7): code that goes online opens only while it is on.
  if (
    !access.settings.networkEnabled &&
    (await env.DB.prepare(
      `SELECT 1 FROM judge_checks WHERE user_id = ? AND protocol = ? AND fingerprint = ? AND tests_digest = ?
        AND passed = 1 AND network IS NOT NULL LIMIT 1`,
    )
      .bind(runBy, JUDGE_PROTOCOL, fingerprint, testsDigest)
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
