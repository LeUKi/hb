import { ARCHIVE_DELAY_MS } from "@hb/contracts";
import { refundStatement } from "../balance/hongbao";
import type { ApiBindings } from "../env";
import { settleEnded } from "../judge/ledger";
import { activityObject } from "../runtime/objects";
import { refreshTimedDraw } from "./draw-service";
import { activityConflict, invalidActivity } from "./errors";
import { activityStatus, getManagedActivity } from "./service";
import { activityWriteGuard, ownedActivity } from "./storage";

export const databaseNow =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

/** A protocol 5 红包 still settling (结算中) gives nothing back, nor archives. */
const settled = (activity: string) =>
  `NOT EXISTS(SELECT 1 FROM activity_code WHERE activity_id = ${activity} AND protocol >= 5 AND settled_at IS NULL)`;

/**
 * Rechecks the current deadline; a Cron candidate is never an authority to
 * end. A 代码判定红包 one of whose judgments ended it (docs/judge-page-
 * design.md §2 end) ends once no claim is still going in: that judgment's
 * own share is paid first. A protocol 5 one that has ended settles
 * everyone left (docs/multi-prize-design.md §2, 结算中), then gives back.
 * True once there is nothing left to settle.
 */
export async function refreshActivityLifecycle(
  env: ApiBindings,
  activityId: string,
) {
  await refreshTimedDraw(env, activityId);
  await env.DB.batch([
    env.DB.prepare(`UPDATE activities SET ended_at = deadline, end_reason = 'expired', version = version + 1, updated_at = ${databaseNow}
      WHERE id = ? AND reward_type = 'ldc' AND deleted_at IS NULL AND opened_at IS NOT NULL AND ended_at IS NULL AND draw_state IS NULL AND deadline <= ${databaseNow}`).bind(
      activityId,
    ),
    env.DB.prepare(`UPDATE activities SET ended_at = ${databaseNow}, end_reason = 'judge', version = version + 1, updated_at = ${databaseNow}
      WHERE id = ? AND participation_mode = 'code' AND deleted_at IS NULL AND opened_at IS NOT NULL AND ended_at IS NULL
        AND EXISTS(SELECT 1 FROM code_judgments WHERE activity_id = activities.id AND ends = 1)
        AND NOT EXISTS(SELECT 1 FROM redemption_submissions WHERE activity_id = activities.id AND purpose = 'claim'
          AND outcome = 'pending')`).bind(activityId),
    // A 🐟额红包 that has ended gives back what nobody took.
    refundStatement(env, activityId),
    env.DB.prepare(`UPDATE activities SET archived_at = ended_at + ?, version = version + 1, updated_at = ${databaseNow}
      WHERE id = ? AND reward_type = 'ldc' AND deleted_at IS NULL AND ended_at IS NOT NULL AND archived_at IS NULL AND (draw_state IS NULL OR draw_state IN ('completed','empty'))
        AND ${settled("activities.id")} AND ended_at + ? <= ${databaseNow}`).bind(
      ARCHIVE_DELAY_MS,
      activityId,
      ARCHIVE_DELAY_MS,
    ),
  ]);
  return settleEnded(env, activityId);
}

export async function endActivity(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  version: number,
) {
  const row = await ownedActivity(env, activityId, authorId);
  if (row.openedAt === null) invalidActivity("草稿尚未开放，不能提前结束");
  if (activityStatus(row) !== "active") {
    await refreshActivityLifecycle(env, activityId);
    return getManagedActivity(env, activityId, authorId);
  }
  if (row.version !== version) activityConflict();
  // A 代码判定红包 its code paused may end with claims in (docs/
  // programmable-hongbao-design.md §3); the rest gives back. From protocol
  // 5 someone with pending counts as having won (docs/multi-prize-
  // design.md §4.2): everyone is settled as it ends.
  const code =
    row.participationMode === "code"
      ? await env.DB.prepare(
          "SELECT paused_at AS pausedAt, pending_minor AS pending FROM activity_code WHERE activity_id = ?",
        )
          .bind(activityId)
          .first<{ pausedAt: number | null; pending: number }>()
      : null;
  const paused = (code?.pausedAt ?? null) !== null;
  if (!paused && (row.claimedCount !== 0 || row.registeredCount !== 0))
    invalidActivity("已有人领取或报名，不能提前结束");
  if (!paused && (code?.pending ?? 0) !== 0)
    invalidActivity("已经有人赢到钱了，不能提前结束。");
  try {
    await env.DB.batch([
      activityWriteGuard(env.DB, activityId, authorId, version),
      env.DB.prepare(`UPDATE activities SET
      version = CASE WHEN author_id = ? AND version = ? AND reward_type = 'ldc' AND deleted_at IS NULL
        AND ((claimed_count = 0 AND registered_count = 0
            AND NOT EXISTS(SELECT 1 FROM activity_code WHERE activity_id = activities.id AND pending_minor != 0))
          OR EXISTS(SELECT 1 FROM activity_code WHERE activity_id = activities.id AND paused_at IS NOT NULL))
        AND opened_at IS NOT NULL AND ended_at IS NULL AND deadline > ${databaseNow}
        THEN version + 1 ELSE NULL END,
      ended_at = ${databaseNow}, end_reason = 'manual', updated_at = ${databaseNow}
      WHERE id = ?`).bind(authorId, version, activityId),
    ]);
  } catch (error) {
    const current = await ownedActivity(env, activityId, authorId);
    if (activityStatus(current) !== "active") {
      await refreshActivityLifecycle(env, activityId);
      return getManagedActivity(env, activityId, authorId);
    }
    if (
      !paused &&
      (current.claimedCount !== 0 || current.registeredCount !== 0)
    )
      invalidActivity("已有人领取或报名，不能提前结束");
    if (current.version !== version) activityConflict();
    throw error;
  }
  await refreshActivityLifecycle(env, activityId);
  return getManagedActivity(env, activityId, authorId);
}

export async function sweepActivityLifecycle(env: ApiBindings) {
  let cursor = "";
  let processed = 0;
  for (;;) {
    const page =
      await env.DB.prepare(`SELECT id FROM activities WHERE id > ? AND reward_type = 'ldc' AND deleted_at IS NULL AND opened_at IS NOT NULL AND
      ((ended_at IS NULL AND deadline <= ${databaseNow}) OR (ended_at IS NOT NULL AND archived_at IS NULL AND ended_at + ? <= ${databaseNow})
        OR draw_state='settling'
        OR id IN (SELECT activity_id FROM redemption_submissions WHERE outcome = 'pending' AND purpose = 'claim')
        OR (ended_at IS NULL AND id IN (SELECT activity_id FROM code_judgments WHERE ends = 1))
        OR (ended_at IS NOT NULL AND id IN (SELECT activity_id FROM balance_locks WHERE purpose = 'activity' AND status = 'active'))
        OR (ended_at IS NOT NULL AND id IN (SELECT activity_id FROM activity_code WHERE protocol >= 5 AND settled_at IS NULL)))
      ORDER BY id LIMIT 50`)
        .bind(cursor, ARCHIVE_DELAY_MS)
        .all<{ id: string }>();
    if (!page.results.length) break;
    // Bounded fan-out avoids turning an overdue batch into an unbounded subrequest burst.
    for (let start = 0; start < page.results.length; start += 5) {
      const batch = page.results.slice(start, start + 5);
      await Promise.all(
        batch.map(async ({ id }) => {
          try {
            const object = activityObject(env, id);
            const response = await object.fetch(
              `https://activity.internal/internal/activities/${id}/refresh`,
              { method: "POST" },
            );
            await response.arrayBuffer();
            if (!response.ok)
              throw new Error("Activity lifecycle refresh failed");
            processed++;
          } catch {
            console.error("activity_lifecycle_refresh_failed", {
              activityId: id,
            });
          }
        }),
      );
    }
    cursor = page.results.at(-1)?.id ?? cursor;
  }
  return processed;
}
