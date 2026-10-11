/** Model elapsed time between independent business actions without touching saved replays. */
export async function advanceAttemptCooldown(
  db: D1Database,
  userId: string,
  submissionId?: string,
) {
  await db
    .prepare(`UPDATE account_attempt_cooldowns SET next_allowed_at=0 WHERE user_id=?
      AND NOT EXISTS (SELECT 1 FROM redemption_submissions WHERE user_id=? AND submission_id=?)
      AND NOT EXISTS (SELECT 1 FROM global_redemptions WHERE user_id=? AND submission_id=?)`)
    .bind(userId, userId, submissionId ?? "", userId, submissionId ?? "")
    .run();
}
