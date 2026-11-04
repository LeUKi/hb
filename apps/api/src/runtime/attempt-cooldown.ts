import type { AttemptCooldown } from "@hb/contracts";
import { ActivityError, activityConflict } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import type { ApiBindings } from "../env";

export type AttemptOrigin = "home" | "activity";

export class AttemptCooldownError extends ActivityError {
  readonly retryAfter: number;

  constructor(
    public readonly attemptCooldown: AttemptCooldown,
    origin: AttemptOrigin,
  ) {
    super(
      429,
      origin === "home"
        ? "GLOBAL_REDEMPTION_RATE_LIMITED"
        : "CLAIM_RATE_LIMITED",
      "提交过于频繁，请稍后再试",
    );
    this.retryAfter = Math.max(
      1,
      Math.ceil(
        (attemptCooldown.nextAllowedAt - attemptCooldown.serverTime) / 1000,
      ),
    );
  }
}

const cooldownOf = (row: AttemptCooldown): AttemptCooldown => ({
  revision: row.revision,
  serverTime: row.serverTime,
  nextAllowedAt: row.nextAllowedAt,
});

export async function readAttemptCooldown(
  env: ApiBindings,
  userId: string,
): Promise<AttemptCooldown> {
  const row = await attemptStatement(env, userId).first<AttemptCooldown>();
  if (!row) throw new Error("Could not read password attempt cooldown");
  return cooldownOf(row);
}

/** readAttemptCooldown for several people at once, by their ids. */
export async function readAttemptCooldowns(
  env: ApiBindings,
  userIds: string[],
): Promise<Map<string, AttemptCooldown>> {
  const { results } = await env.DB.prepare(`SELECT people.value AS userId,
      COALESCE(c.revision, 0) AS revision,
      COALESCE(c.next_allowed_at, 0) AS nextAllowedAt, ${databaseNow} AS serverTime
    FROM json_each(?) people
    LEFT JOIN account_attempt_cooldowns c ON c.user_id = people.value`)
    .bind(JSON.stringify([...new Set(userIds)]))
    .all<AttemptCooldown & { userId: string }>();
  return new Map(results.map((row) => [row.userId, cooldownOf(row)]));
}

export type ActivityAttempt = {
  activityId: string;
  submissionId: string;
  passwordDigest: string;
  discoveryId?: string;
};

/**
 * What an attempt's check reads (attemptStatement): the cooldown and, for
 * a 口令 found from the start page (a continuation), that find.
 */
export type AttemptRow = AttemptCooldown & {
  origin?: AttemptOrigin | null;
  attemptId?: string | null;
  discoveryId?: string | null;
  passwordDigest?: string | null;
  selectedActivityId?: string | null;
  claimSubmissionId?: string | null;
  candidate?: number;
};

/** The read behind assertAttemptAllowed, to be made alone or in a batch. */
export function attemptStatement(
  env: ApiBindings,
  userId: string,
  continuation?: ActivityAttempt,
) {
  if (!continuation)
    return env.DB.prepare(`SELECT COALESCE(c.revision, 0) AS revision,
      COALESCE(c.next_allowed_at, 0) AS nextAllowedAt, ${databaseNow} AS serverTime
    FROM (SELECT ? AS user_id) actor
    LEFT JOIN account_attempt_cooldowns c ON c.user_id = actor.user_id`).bind(
      userId,
    );
  return env.DB.prepare(`SELECT COALESCE(c.revision, 0) AS revision,
      COALESCE(c.next_allowed_at, 0) AS nextAllowedAt, ${databaseNow} AS serverTime,
      c.origin, c.attempt_id AS attemptId, g.id AS discoveryId,
      g.password_digest AS passwordDigest, g.selected_activity_id AS selectedActivityId,
      g.claim_submission_id AS claimSubmissionId,
      EXISTS (SELECT 1 FROM json_each(g.candidate_ids) WHERE value = ?) AS candidate
    FROM (SELECT ? AS user_id) actor
    LEFT JOIN account_attempt_cooldowns c ON c.user_id = actor.user_id
    LEFT JOIN global_redemptions g ON g.user_id = actor.user_id
      AND g.id = COALESCE(?, CASE WHEN c.origin = 'home' THEN c.attempt_id END)`).bind(
    continuation.activityId,
    userId,
    continuation.discoveryId ?? null,
  );
}

/** Read checks improve errors; the write below independently enforces every guard. */
export async function assertAttemptAllowed(
  env: ApiBindings,
  userId: string,
  origin: AttemptOrigin,
  continuation?: ActivityAttempt,
  options: { checkCooldown?: boolean } = {},
) {
  checkAttempt(
    await attemptStatement(env, userId, continuation).first<AttemptRow>(),
    origin,
    continuation,
    options,
  );
}

/** assertAttemptAllowed on what attemptStatement read. */
export function checkAttempt(
  row: AttemptRow | null | undefined,
  origin: AttemptOrigin,
  continuation?: ActivityAttempt,
  options: { checkCooldown?: boolean } = {},
) {
  if (!row)
    throw new Error(
      continuation
        ? "Could not read password attempt context"
        : "Could not read password attempt cooldown",
    );
  if (continuation) {
    const matches =
      row.discoveryId != null &&
      row.passwordDigest === continuation.passwordDigest &&
      row.candidate === 1;
    const alreadyBound =
      row.selectedActivityId === continuation.activityId &&
      row.claimSubmissionId === continuation.submissionId;
    if (
      continuation.discoveryId &&
      (!matches || (row.selectedActivityId != null && !alreadyBound))
    )
      activityConflict("查找结果与目标红包、口令或提交标识不匹配");
    if (
      matches &&
      row.origin === "home" &&
      row.attemptId === row.discoveryId &&
      (row.selectedActivityId == null || alreadyBound)
    )
      return;
  }
  if (options.checkCooldown !== false && row.nextAllowedAt > row.serverTime)
    throw new AttemptCooldownError(cooldownOf(row), origin);
}

/** Bind the latest home attempt in the same transaction as its child submission. */
export function bindDiscoveryStatement(
  env: ApiBindings,
  userId: string,
  continuation: ActivityAttempt,
): D1PreparedStatement {
  return env.DB.prepare(`UPDATE global_redemptions
    SET selected_activity_id = ?, claim_submission_id = ?
    WHERE user_id = ? AND selected_activity_id IS NULL AND password_digest = ?
      AND EXISTS (SELECT 1 FROM json_each(candidate_ids) WHERE value = ?)
      AND (? IS NULL OR id = ?)
      AND EXISTS (SELECT 1 FROM activities WHERE id = ? AND reward_type='ldc' AND deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM account_attempt_cooldowns c
        WHERE c.user_id = global_redemptions.user_id AND c.origin = 'home'
          AND c.attempt_id = global_redemptions.id)`).bind(
    continuation.activityId,
    continuation.submissionId,
    userId,
    continuation.passwordDigest,
    continuation.activityId,
    continuation.discoveryId ?? null,
    continuation.discoveryId ?? null,
    continuation.activityId,
  );
}

/** A guarded non-null write rejects a raced change of an explicit discovery binding. */
export function discoveryBindingGuard(
  userId: string,
  continuation?: ActivityAttempt,
): { sql: string; bindings: string[] } {
  if (!continuation?.discoveryId) return { sql: "1", bindings: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM global_redemptions g
      WHERE g.id = ? AND g.user_id = ? AND g.password_digest = ?
        AND EXISTS (SELECT 1 FROM json_each(g.candidate_ids) WHERE value = ?)
        AND (g.selected_activity_id IS NULL OR
          (g.selected_activity_id = ? AND g.claim_submission_id = ?)))`,
    bindings: [
      continuation.discoveryId,
      userId,
      continuation.passwordDigest,
      continuation.activityId,
      continuation.activityId,
      continuation.submissionId,
    ],
  };
}

/** Must be included in the same D1 batch as the durable submission. */
export function attemptWriteStatements(
  env: ApiBindings,
  userId: string,
  origin: AttemptOrigin,
  attemptId: string,
  continuation?: ActivityAttempt,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  let continued = "0";
  let continuedBindings: (string | null)[] = [];
  const { sql: validDiscovery, bindings: validDiscoveryBindings } =
    discoveryBindingGuard(userId, continuation);
  if (continuation) {
    statements.push(bindDiscoveryStatement(env, userId, continuation));
    continued = `EXISTS (SELECT 1 FROM global_redemptions g
      WHERE g.user_id = account_attempt_cooldowns.user_id
        AND account_attempt_cooldowns.origin = 'home'
        AND g.id = account_attempt_cooldowns.attempt_id
        AND g.password_digest = ? AND g.selected_activity_id = ? AND g.claim_submission_id = ?
        AND EXISTS (SELECT 1 FROM json_each(g.candidate_ids) WHERE value = ?)
        AND (? IS NULL OR g.id = ?))`;
    continuedBindings = [
      continuation.passwordDigest,
      continuation.activityId,
      continuation.submissionId,
      continuation.activityId,
      continuation.discoveryId ?? null,
      continuation.discoveryId ?? null,
    ];
  }
  const intervalColumn =
    origin === "home" ? "home_interval_seconds" : "activity_interval_seconds";
  const defaultSeconds = origin === "home" ? 5 : 2;
  const nextAllowed = `${databaseNow} + 1000 * COALESCE((SELECT ${intervalColumn}
    FROM attempt_rate_limits WHERE id = 'global'), ${defaultSeconds})`;
  statements.push(
    env.DB.prepare(`INSERT INTO account_attempt_cooldowns
        (user_id, revision, origin, attempt_id, accepted_at, next_allowed_at)
      VALUES (?, CASE WHEN ${validDiscovery} THEN 1 ELSE NULL END, ?, ?, ${databaseNow}, ${nextAllowed})
      ON CONFLICT(user_id) DO UPDATE SET
        revision = CASE WHEN NOT (${validDiscovery}) THEN NULL WHEN ${continued} THEN revision
          WHEN next_allowed_at <= ${databaseNow} THEN revision + 1 ELSE NULL END,
        origin = CASE WHEN ${continued} THEN origin ELSE excluded.origin END,
        attempt_id = CASE WHEN ${continued} THEN attempt_id ELSE excluded.attempt_id END,
        accepted_at = CASE WHEN ${continued} THEN accepted_at ELSE excluded.accepted_at END,
        next_allowed_at = CASE WHEN ${continued} THEN next_allowed_at ELSE excluded.next_allowed_at END`).bind(
      userId,
      ...validDiscoveryBindings,
      origin,
      attemptId,
      ...validDiscoveryBindings,
      ...continuedBindings,
      ...continuedBindings,
      ...continuedBindings,
      ...continuedBindings,
      ...continuedBindings,
    ),
  );
  return statements;
}
