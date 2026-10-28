import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { activities } from "../db/schema";
import type { ApiBindings } from "../env";
import {
  ActivityError,
  activityConflict,
  activityNotFound,
  invalidActivity,
} from "./errors";
import { databaseNow } from "./lifecycle";
import { type ActivityRow, activityWriteGuard } from "./storage";

function deletionResult(row: ActivityRow) {
  if (row.deletedAt === null)
    throw new Error("Activity deletion did not persist");
  return {
    id: row.id,
    deleted: true as const,
    deletedAt: new Date(row.deletedAt).toISOString(),
    version: row.version,
  };
}

/** Keep the creation identity and submission fingerprints after private cleanup. */
export async function deleteActivity(
  env: ApiBindings,
  authorId: string,
  id: string,
  version: number,
) {
  const read = () =>
    createDb(env.DB)
      .select()
      .from(activities)
      .where(and(eq(activities.id, id), eq(activities.rewardType, "ldc")))
      .get();
  const row = await read();
  if (!row || row.authorId !== authorId) activityNotFound();
  if (row.deletedAt !== null) {
    if (version !== row.version && version !== row.version - 1)
      activityConflict();
    return deletionResult(row);
  }
  if (row.version !== version) activityConflict();
  if (row.openedAt !== null || row.claimedCount !== 0)
    invalidActivity("只能删除从未开放且没有领取记录的草稿");
  // 定时开放: its timing (and a 🐟额红包's lock) goes first (scheduled-opening §1).
  if (row.scheduledOpenAt !== null)
    throw new ActivityError(
      409,
      "ACTIVITY_SCHEDULED",
      "定时开放的草稿要先取消定时，才能删除。",
    );
  try {
    await env.DB.batch([
      activityWriteGuard(env.DB, id, authorId, version),
      env.DB.prepare(`UPDATE activities SET
        version = CASE WHEN author_id = ? AND version = ? AND reward_type = 'ldc' AND deleted_at IS NULL
          AND opened_at IS NULL AND claimed_count = 0
          AND NOT EXISTS (SELECT 1 FROM claims WHERE activity_id = activities.id)
          AND NOT EXISTS (SELECT 1 FROM payment_tasks p JOIN claims c ON c.id = p.claim_id WHERE c.activity_id = activities.id)
          AND NOT EXISTS (SELECT 1 FROM attempt_events WHERE activity_id = activities.id)
          AND NOT EXISTS (SELECT 1 FROM redemption_submissions WHERE activity_id = activities.id
            AND (outcome != 'draft' OR matched_password_id IS NOT NULL OR claim_id IS NOT NULL OR validated_at IS NOT NULL))
          THEN version + 1 ELSE NULL END,
        deleted_at = ${databaseNow}, updated_at = ${databaseNow},
        title = '', config = '{}', topic_id = NULL, post_number = 1, join_square = 0, total_count = 0
        WHERE id = ?`).bind(authorId, version, id),
      env.DB.prepare(
        "DELETE FROM activity_passwords WHERE activity_id = ?",
      ).bind(id),
      env.DB.prepare("DELETE FROM reward_inventory WHERE activity_id = ?").bind(
        id,
      ),
    ]);
  } catch (error) {
    const current = await read();
    if (!current || current.authorId !== authorId) activityNotFound();
    if (current.deletedAt !== null) {
      if (version !== current.version && version !== current.version - 1)
        activityConflict();
      return deletionResult(current);
    }
    if (current.version !== version) activityConflict();
    if (current.openedAt !== null || current.claimedCount !== 0)
      invalidActivity("只能删除从未开放且没有领取记录的草稿");
    throw error;
  }
  const deleted = await read();
  if (!deleted || deleted.authorId !== authorId) activityNotFound();
  return deletionResult(deleted);
}
