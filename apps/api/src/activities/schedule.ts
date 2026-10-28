// 定时开放 (docs/scheduled-opening-design.md): a draft timed to open, a
// 🐟额红包's 🐟 locked then; its ActivityDO opens it at its time (or the
// first claim after it does), and a timing that cannot open gives its 🐟
// back and says why.
import {
  type LdcActivityInput,
  type LdcOpeningBlockedReason,
  ldcTotalMinor,
  type ManagedActivity,
  SCHEDULE_MAX_LEAD_MS,
  SCHEDULE_MIN_LEAD_MS,
  type ScheduleActivityInput,
} from "@hb/contracts";
import {
  balanceOpeningBlocked,
  insufficientMessage,
  lockStatements,
  releaseStatement,
} from "../balance/hongbao";
import type { ApiBindings } from "../env";
import { codeOpeningBlocked } from "../judge/opening";
import { paramsRejected, paramsRejectedError } from "../judge/params";
import { findJudgeRow } from "../judge/storage";
import { ownedMerchant } from "../payments/merchants";
import {
  publicationEligibility,
  publicationMessages,
} from "../payments/publication";
import { allowsRealOpening, readPlatformControls } from "../runtime/controls";
import { timedDrawMoney } from "./draw-storage";
import { ActivityError, activityConflict } from "./errors";
import { databaseNow } from "./lifecycle";
import {
  configuration,
  getManagedActivity,
  holdsBalance,
  openActivity,
  prepareActivityOpening,
} from "./service";
import {
  type ActivityRow,
  activityWriteGuard,
  findActivity,
  ownedActivity,
} from "./storage";

/** A request's way: the page counts its 5 minutes from the press. */
const LEAD_GRACE_MS = 60_000;
/** A site paused (发布) or a credential check not back: tried until then (§5). */
export const SCHEDULE_RETRY_MS = 10 * 60_000;
/** The merchant's credential is checked this long before its time (§3). */
export const SCHEDULE_PRECHECK_MS = 5 * 60_000;
/** Reasons that pass by themselves: tried again within the window. */
const PASSING = new Set([
  "REAL_LDC_NOT_ENABLED",
  "MERCHANT_CREDENTIALS_CHECKING",
  "MERCHANT_CREDENTIALS_UNAVAILABLE",
]);

/** Times a draft, or takes its timing back (`at` null). */
export async function scheduleActivity(
  env: ApiBindings,
  id: string,
  authorId: string,
  input: ScheduleActivityInput,
): Promise<ManagedActivity> {
  const row = await ownedActivity(env, id, authorId);
  if (row.openedAt !== null)
    throw new ActivityError(409, "ACTIVITY_OPENED", "红包已经开放了。");
  if (row.version !== input.version) activityConflict();
  if (input.at === null) return takeBack(env, row);
  const now = Date.now();
  // To the minute, as it is chosen and shown.
  const at = Math.floor(Date.parse(input.at) / 60_000) * 60_000;
  if (at < now + SCHEDULE_MIN_LEAD_MS - LEAD_GRACE_MS)
    throw new ActivityError(
      400,
      "SCHEDULE_TOO_SOON",
      "开放时间要在 5 分钟以后。",
    );
  if (at > now + SCHEDULE_MAX_LEAD_MS + LEAD_GRACE_MS)
    throw new ActivityError(400, "SCHEDULE_TOO_LATE", "最晚定到 30 天以后。");
  const config = configuration(row);
  if (config.deadline.mode === "at" && Date.parse(config.deadline.at) <= at)
    throw new ActivityError(
      400,
      "SCHEDULE_AFTER_DEADLINE",
      "截止时间要晚于开放时间。",
    );
  const balance = row.funding === "balance";
  const held = balance && (await holdsBalance(env, id));
  const blocked = await scheduleBlocked(env, row, held);
  if (blocked)
    throw new ActivityError(
      409,
      blocked,
      blocked === "BALANCE_INSUFFICIENT"
        ? await insufficientMessage(env, authorId)
        : publicationMessages[blocked],
    );
  // 判定器's params past its check() too, as opening will ask (judge-square §3).
  if (row.participationMode === "code") {
    const judge = await findJudgeRow(env, id);
    const rejected =
      judge &&
      (await paramsRejected(env, row, judge, config as LdcActivityInput));
    if (rejected) throw paramsRejectedError(rejected);
  }
  try {
    await env.DB.batch([
      activityWriteGuard(env.DB, id, authorId, input.version),
      env.DB.prepare(`UPDATE activities SET
        version = CASE WHEN version = ? AND opened_at IS NULL THEN version + 1 ELSE NULL END,
        scheduled_open_at = ?, schedule_failed_at = NULL, schedule_failure = NULL, updated_at = ${databaseNow}
        WHERE id = ?`).bind(input.version, at, id),
      // Its 🐟 is held from now (§3); timed again, it holds it still.
      ...(balance && !held
        ? lockStatements(
            env,
            id,
            authorId,
            ldcTotalMinor(config as LdcActivityInput),
            now,
          )
        : []),
    ]);
  } catch (error) {
    const current = await ownedActivity(env, id, authorId);
    if (current.version !== input.version) activityConflict();
    if (balance && !held && String(error).includes("BALANCE_INSUFFICIENT"))
      throw new ActivityError(
        409,
        "BALANCE_INSUFFICIENT",
        await insufficientMessage(env, authorId),
      );
    throw error;
  }
  return getManagedActivity(env, id, authorId);
}

/**
 * What opening would refuse that can be known now (§1): not the merchant's
 * credential, checked before its time (§3), nor today's 代码判定 openings,
 * counted on the day it opens (§4).
 */
async function scheduleBlocked(
  env: ApiBindings,
  row: ActivityRow,
  held: boolean,
): Promise<LdcOpeningBlockedReason | undefined> {
  if (timedDrawMoney(row) && env.LDC_TIMED_DRAW_ENABLED !== "true")
    return "TIMED_DRAW_NOT_ENABLED";
  if (
    row.paymentMode === "real" &&
    !allowsRealOpening(env, await readPlatformControls(env))
  )
    return "REAL_LDC_NOT_ENABLED";
  if (row.funding === "balance") {
    const blocked = await balanceOpeningBlocked(
      env,
      row.authorId,
      configuration(row),
      held,
    );
    if (blocked) return blocked;
  } else if (row.merchantId) {
    const merchant = await ownedMerchant(env, row.merchantId, row.authorId);
    const { reason } = await publicationEligibility(env, merchant);
    if (reason === "MERCHANT_LEGACY" || reason === "REAL_LDC_NOT_ENABLED")
      return reason;
  }
  if (row.participationMode === "code") {
    const blocked = await codeOpeningBlocked(env, row);
    if (blocked && blocked !== "CODE_HONGBAO_DAILY_LIMIT") return blocked;
  }
  return undefined;
}

/** 取消定时 (§1): back to a draft, a 🐟额红包's 🐟 back to 可用. */
async function takeBack(env: ApiBindings, row: ActivityRow) {
  if (row.scheduledOpenAt !== null) {
    try {
      await env.DB.batch([
        activityWriteGuard(env.DB, row.id, row.authorId, row.version),
        env.DB.prepare(`UPDATE activities SET
          version = CASE WHEN version = ? AND opened_at IS NULL THEN version + 1 ELSE NULL END,
          scheduled_open_at = NULL, updated_at = ${databaseNow} WHERE id = ?`).bind(
          row.version,
          row.id,
        ),
        releaseStatement(env, row.id),
      ]);
    } catch (error) {
      const current = await ownedActivity(env, row.id, row.authorId);
      if (current.version !== row.version) activityConflict();
      throw error;
    }
  }
  return getManagedActivity(env, row.id, row.authorId);
}

/** An opening's message as a reason (§5): without its “草稿已保存”. */
export function scheduleFailureReason(message: string) {
  return (
    message
      .replace(/[，,]?\s*草稿已(保存|保留)[^。]*。?$/u, "")
      .replace(/。$/u, "") || "开放没有成功"
  );
}

export type ScheduledOutcome =
  | { kind: "none" }
  | { kind: "early"; at: number }
  | { kind: "opened" }
  | { kind: "retry"; at: number }
  | { kind: "failed" };

/**
 * Its time has come (§4): opened as 保存并开放 opens it, its credential
 * checked first when it is not fresh. A site paused or a check not back is
 * tried again for a while; anything else ends the timing (§5).
 */
export async function openScheduled(
  env: ApiBindings,
  id: string,
): Promise<ScheduledOutcome> {
  const row = await findActivity(env, id);
  if (!row || row.openedAt !== null || row.scheduledOpenAt === null)
    return { kind: "none" };
  const now = Date.now();
  if (row.scheduledOpenAt > now)
    return { kind: "early", at: row.scheduledOpenAt };
  const window = now < row.scheduledOpenAt + SCHEDULE_RETRY_MS;
  try {
    const check = await prepareActivityOpening(env, id, row.authorId);
    if (check) await check();
    await openActivity(env, id, row.authorId, row.version);
    return { kind: "opened" };
  } catch (error) {
    if (error instanceof ActivityError) {
      // Changed meanwhile (a 说明 edited): read again at once.
      if (error.code === "ACTIVITY_VERSION_CONFLICT")
        return { kind: "retry", at: now + 1_000 };
      if (PASSING.has(error.code) && window)
        return {
          kind: "retry",
          at: now + (error.code === "REAL_LDC_NOT_ENABLED" ? 60_000 : 15_000),
        };
      await failSchedule(env, row, scheduleFailureReason(error.message));
      return { kind: "failed" };
    }
    console.error("activity_scheduled_open_failed", {
      activityId: id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    if (window) return { kind: "retry", at: now + 15_000 };
    await failSchedule(env, row, "网络或服务出了问题");
    return { kind: "failed" };
  }
}

/** The timing ends unopened: back to a draft, with why (§5). */
async function failSchedule(
  env: ApiBindings,
  row: ActivityRow,
  reason: string,
) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE activities SET version = version + 1,
      scheduled_open_at = NULL, schedule_failed_at = ${databaseNow}, schedule_failure = ?, updated_at = ${databaseNow}
      WHERE id = ? AND opened_at IS NULL AND scheduled_open_at IS NOT NULL`).bind(
      reason.slice(0, 200),
      row.id,
    ),
    releaseStatement(env, row.id),
  ]);
}

/** A few minutes before (§3): its merchant's credential, checked now. */
export async function precheckScheduled(env: ApiBindings, id: string) {
  const row = await findActivity(env, id);
  if (!row || row.openedAt !== null || row.scheduledOpenAt === null) return;
  const check = await prepareActivityOpening(env, id, row.authorId);
  if (check) await check();
}
