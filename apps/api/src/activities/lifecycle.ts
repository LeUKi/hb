import { ARCHIVE_DELAY_MS } from "@hb/contracts";
import type { ApiBindings } from "../env";
import { refreshTimedDraw } from "./draw-service";
import { activityConflict, invalidActivity } from "./errors";
import { activityStatus, getManagedActivity } from "./service";
import { activityWriteGuard, ownedActivity } from "./storage";

export const databaseNow =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

/** Rechecks the current deadline; a Cron candidate is never an authority to end. */
export async function refreshActivityLifecycle(
  env: ApiBindings,
  activityId: string,
) {
  await refreshTimedDraw(env, activityId);
  await env.DB.batch([
    env.DB.prepare(`UPDATE activities SET ended_at = deadline, end_reason = 'expired', version = version + 1, updated_at = ${databaseNow}
      WHERE id = ? AND deleted_at IS NULL AND opened_at IS NOT NULL AND ended_at IS NULL AND draw_state IS NULL AND deadline <= ${databaseNow}`).bind(
      activityId,
    ),
    env.DB.prepare(`UPDATE activities SET archived_at = ended_at + ?, version = version + 1, updated_at = ${databaseNow}
      WHERE id = ? AND deleted_at IS NULL AND ended_at IS NOT NULL AND archived_at IS NULL AND (draw_state IS NULL OR draw_state IN ('completed','empty')) AND ended_at + ? <= ${databaseNow}`).bind(
      ARCHIVE_DELAY_MS,
      activityId,
      ARCHIVE_DELAY_MS,
    ),
  ]);
}

export async function endActivity(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  version: number,
) {
  const row = await ownedActivity(env, activityId, authorId);
  if (row.openedAt === null)
    invalidActivity("准备中的活动尚未开放，不能提前结束");
  if (activityStatus(row) !== "active") {
    await refreshActivityLifecycle(env, activityId);
    return getManagedActivity(env, activityId, authorId);
  }
  if (row.version !== version) activityConflict();
  if (row.claimedCount !== 0 || row.registeredCount !== 0)
    invalidActivity("已有用户领取或报名，不能提前结束活动");
  try {
    await env.DB.batch([
      activityWriteGuard(env.DB, activityId, authorId, version),
      env.DB.prepare(`UPDATE activities SET
      version = CASE WHEN author_id = ? AND version = ? AND deleted_at IS NULL AND claimed_count = 0 AND registered_count = 0 AND opened_at IS NOT NULL AND ended_at IS NULL AND deadline > ${databaseNow}
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
    if (current.claimedCount !== 0 || current.registeredCount !== 0)
      invalidActivity("已有用户领取或报名，不能提前结束活动");
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
      await env.DB.prepare(`SELECT id FROM activities WHERE id > ? AND deleted_at IS NULL AND opened_at IS NOT NULL AND
      ((ended_at IS NULL AND deadline <= ${databaseNow}) OR (ended_at IS NOT NULL AND archived_at IS NULL AND ended_at + ? <= ${databaseNow})
        OR draw_state='settling'
        OR EXISTS (SELECT 1 FROM redemption_submissions WHERE activity_id = activities.id AND purpose='claim' AND outcome = 'pending'))
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
            const object = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(id));
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
