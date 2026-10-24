// Opening a 代码判定红包 (docs/programmable-hongbao-design.md §1, §5): its
// sender has 🐟额 PLUS, the switch is on, today's openings are not used up
// and this very code passed 在线检查. The SQL below holds the same inside
// the opening write.
import type { LdcOpeningBlockedReason } from "@hb/contracts";
import type { ActivityRow } from "../activities/storage";
import { startOfBeijingDay } from "../balance/day";
import type { ApiBindings } from "../env";
import { codeHongbaoAccess, passedCheck } from "./check";
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
  if (!access.allowed) return "CODE_HONGBAO_NOT_ALLOWED";
  if (!access.enabled) return "CODE_HONGBAO_PAUSED";
  const judge = await findJudgeRow(env, row.id);
  if (
    !judge ||
    !(await passedCheck(
      env,
      row.authorId,
      judge.fingerprint,
      judge.testsDigest,
    ))
  )
    return "JUDGE_CHECK_REQUIRED";
  if (
    (await openedToday(env, row.authorId)) >=
    access.settings.codeHongbaoDailyLimit
  )
    return "CODE_HONGBAO_DAILY_LIMIT";
  return undefined;
}

/**
 * Inside the opening UPDATE's CASE: one `?`, the start of today (北京时间).
 * Other kinds of 红包 pass.
 */
export const CODE_OPENING_ALLOWED = `(participation_mode != 'code' OR (
  EXISTS(SELECT 1 FROM balance_settings WHERE id='global' AND code_hongbao_enabled=1)
  AND (EXISTS(SELECT 1 FROM balance_members WHERE user_id=activities.author_id)
    OR EXISTS(SELECT 1 FROM merchants WHERE kind='platform' AND usage_status='current' AND author_id=activities.author_id))
  AND (SELECT COUNT(*) FROM activities o WHERE o.author_id=activities.author_id AND o.participation_mode='code'
    AND o.opened_at>=?) < (SELECT code_hongbao_daily_limit FROM balance_settings WHERE id='global')))`;

export const codeOpeningDay = () => startOfBeijingDay();
