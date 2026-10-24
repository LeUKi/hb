// 停用 (docs/programmable-hongbao-design.md §1, redesign/07 §10): the 站长
// stops one 代码判定红包. Claims stop, the rest goes back to its sender's
// 🐟额, and who stopped it and when stay on it. Its own Durable Object runs
// this, after any claim it is judging.
import { ActivityError } from "../activities/errors";
import { databaseNow, refreshActivityLifecycle } from "../activities/lifecycle";
import { activityStatus } from "../activities/service";
import { findActivity } from "../activities/storage";
import type { ApiBindings } from "../env";
import { findJudgeRow } from "./storage";

export async function stopCodeActivity(
  env: ApiBindings,
  activityId: string,
  adminId: string,
) {
  const activity = await findActivity(env, activityId);
  if (activity?.participationMode !== "code" || activity.openedAt === null)
    throw new ActivityError(
      404,
      "NOT_CODE_HONGBAO",
      "只有开放了的代码判定红包能停用。",
    );
  const judge = await findJudgeRow(env, activityId);
  // Twice is once.
  if (judge?.stoppedAt != null) return;
  if (activityStatus(activity) !== "active")
    throw new ActivityError(409, "ACTIVITY_NOT_ACTIVE", "红包已经结束了。");
  await env.DB.batch([
    env.DB.prepare(`UPDATE activity_code SET stopped_at = ${databaseNow}, stopped_by_user_id = ?, updated_at = ${databaseNow}
      WHERE activity_id = ? AND stopped_at IS NULL`).bind(adminId, activityId),
    env.DB.prepare(`UPDATE activities SET
      version = CASE WHEN ended_at IS NULL AND opened_at IS NOT NULL AND participation_mode = 'code' THEN version + 1 ELSE NULL END,
      ended_at = ${databaseNow}, end_reason = 'manual', updated_at = ${databaseNow}
      WHERE id = ?`).bind(activityId),
  ]);
  // What nobody took goes back, and a claim judged but not yet in ends.
  await refreshActivityLifecycle(env, activityId);
}
