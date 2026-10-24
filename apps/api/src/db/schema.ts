import { relations, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull().default("linux_do"),
    externalId: text("external_id").notNull(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    emailCiphertext: text("email_ciphertext"),
    avatarUrl: text("avatar_url"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    /**
     * From LINUX DO Connect at each sign-in (docs/claim-scope-design.md
     * §2): 信任等级 0–4 and 禁言, as of profileSeenAt. Null until the first
     * sign-in that read them.
     */
    trustLevel: integer("trust_level"),
    silenced: integer("silenced", { mode: "boolean" }),
    profileSeenAt: integer("profile_seen_at", { mode: "timestamp_ms" }),
    /**
     * 排行榜 (docs/leaderboard-design.md §2): shown by name on each board,
     * as this person chose. Null is the default: 发出 shown, 领到 匿名.
     */
    rankSentVisible: integer("rank_sent_visible", { mode: "boolean" }),
    rankReceivedVisible: integer("rank_received_visible", { mode: "boolean" }),
  },
  (table) => [
    uniqueIndex("users_provider_external_id_unique").on(
      table.provider,
      table.externalId,
    ),
    index("users_username_idx").on(table.username),
    index("users_created_idx").on(
      sql`${table.createdAt} DESC`,
      sql`${table.id} DESC`,
    ),
  ],
);

/**
 * 排行榜's snapshots (docs/leaderboard-design.md §3): each board's full
 * order as of `computedAt`, read for 5 minutes, worked out again when
 * someone opens it later. `entries` is JSON: [userId, amountMinor,
 * activities, claims][], best first.
 */
export const rankSnapshots = sqliteTable(
  "rank_snapshots",
  {
    board: text("board", { enum: ["sent", "received"] }).notNull(),
    range: text("range", { enum: ["week", "all"] }).notNull(),
    computedAt: integer("computed_at").notNull(),
    entries: text("entries").notNull(),
  },
  (table) => [primaryKey({ columns: [table.board, table.range] })],
);

export const attemptRateLimits = sqliteTable("attempt_rate_limits", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  homeIntervalSeconds: integer("home_interval_seconds").notNull(),
  activityIntervalSeconds: integer("activity_interval_seconds").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedByUserId: text("updated_by_user_id"),
});

export const attemptRateLimitChanges = sqliteTable(
  "attempt_rate_limit_changes",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").notNull(),
    previousVersion: integer("previous_version").notNull(),
    nextVersion: integer("next_version").notNull(),
    previousHomeIntervalSeconds: integer(
      "previous_home_interval_seconds",
    ).notNull(),
    homeIntervalSeconds: integer("home_interval_seconds").notNull(),
    previousActivityIntervalSeconds: integer(
      "previous_activity_interval_seconds",
    ).notNull(),
    activityIntervalSeconds: integer("activity_interval_seconds").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("attempt_rate_limit_changes_time_idx").on(table.createdAt, table.id),
  ],
);

export const accountAttemptCooldowns = sqliteTable(
  "account_attempt_cooldowns",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    origin: text("origin", { enum: ["home", "activity"] }).notNull(),
    attemptId: text("attempt_id").notNull(),
    acceptedAt: integer("accepted_at").notNull(),
    nextAllowedAt: integer("next_allowed_at").notNull(),
  },
);

export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const oauthAttempts = sqliteTable(
  "oauth_attempts",
  {
    stateHash: text("state_hash").primaryKey(),
    cookieHash: text("cookie_hash").notNull(),
    returnTo: text("return_to").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("oauth_attempts_expires_at_idx").on(table.expiresAt)],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const activities = sqliteTable(
  "activities",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id),
    creationRequestId: text("creation_request_id").notNull(),
    creationDigest: text("creation_digest").notNull(),
    version: integer("version").notNull().default(1),
    title: text("title").notNull(),
    merchantId: text("merchant_id").references(() => merchants.id),
    paymentMode: text("payment_mode", { enum: ["simulation", "real"] }),
    /**
     * 商户直发 (merchant_id pays each claim) or 🐟额红包 (the author's 🐟额,
     * locked at opening; no merchant). docs/balance-design.md §14.
     */
    funding: text("funding", { enum: ["merchant", "balance"] })
      .notNull()
      .default("merchant"),
    rewardType: text("reward_type", { enum: ["text", "ldc"] })
      .notNull()
      .default("text"),
    forceDedicated: integer("force_dedicated", { mode: "boolean" }).notNull(),
    /** 代码判定: the sender's code judges each submission (activity_code). */
    participationMode: text("participation_mode", {
      enum: ["password", "direct", "code"],
    })
      .notNull()
      .default("password"),
    joinSquare: integer("join_square", { mode: "boolean" })
      .notNull()
      .default(false),
    topicId: text("topic_id"),
    postNumber: integer("post_number").notNull().default(1),
    deletedAt: integer("deleted_at"),
    allocation: text("allocation", {
      enum: ["sequential", "random"],
    }).notNull(),
    config: text("config").notNull(),
    totalCount: integer("total_count").notNull(),
    claimedCount: integer("claimed_count").notNull().default(0),
    registeredCount: integer("registered_count").notNull().default(0),
    drawState: text("draw_state", {
      enum: ["waiting", "settling", "completed", "empty"],
    }),
    drawClosedAt: integer("draw_closed_at"),
    drawReason: text("draw_reason", { enum: ["full", "deadline", "manual"] }),
    drawPublishedAt: integer("draw_published_at"),
    /**
     * 开奖证明 (docs/draw-proof-design.md): 2 when the random parts follow
     * v2, set at opening; null for fixed money and anything opened before.
     */
    randomVersion: integer("random_version"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    openedAt: integer("opened_at"),
    deadline: integer("deadline"),
    endedAt: integer("ended_at"),
    endReason: text("end_reason", { enum: ["expired", "exhausted", "manual"] }),
    archivedAt: integer("archived_at"),
  },
  (table) => [
    uniqueIndex("activities_author_request_unique").on(
      table.authorId,
      table.creationRequestId,
    ),
    index("activities_author_created_idx").on(
      table.authorId,
      table.createdAt,
      table.id,
    ),
    index("activities_deadline_idx").on(table.deadline),
    index("activities_topic_idx").on(table.topicId),
    index("activities_admin_created_idx")
      .on(sql`${table.createdAt} DESC`, sql`${table.id} DESC`)
      .where(sql`${table.deletedAt} IS NULL`),
    index("activities_reply_opened_idx")
      .on(
        table.topicId,
        table.postNumber,
        sql`${table.openedAt} DESC`,
        sql`${table.id} DESC`,
      )
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.archivedAt} IS NULL AND ${table.openedAt} IS NOT NULL`,
      ),
    index("activities_square_opened_idx")
      .on(table.joinSquare, sql`${table.openedAt} DESC`, sql`${table.id} DESC`)
      .where(
        sql`${table.archivedAt} IS NULL AND ${table.openedAt} IS NOT NULL`,
      ),
    index("activities_topic_opened_idx")
      .on(table.topicId, sql`${table.openedAt} DESC`, sql`${table.id} DESC`)
      .where(
        sql`${table.archivedAt} IS NULL AND ${table.openedAt} IS NOT NULL`,
      ),
    check(
      "activities_payment_mode_valid",
      sql`${table.paymentMode} IS NULL OR ${table.paymentMode} IN ('simulation','real')`,
    ),
    check(
      "activities_ldc_payment_mode",
      sql`${table.rewardType} != 'ldc' OR ${table.paymentMode} IS NOT NULL`,
    ),
  ],
);

export const globalRedemptions = sqliteTable(
  "global_redemptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    submissionId: text("submission_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    passwordDigest: text("password_digest").notNull(),
    candidateIds: text("candidate_ids").notNull(),
    claimSubmissionId: text("claim_submission_id").notNull(),
    selectedActivityId: text("selected_activity_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("global_redemptions_user_submission_unique").on(
      table.userId,
      table.submissionId,
    ),
    index("global_redemptions_user_time_idx").on(table.userId, table.createdAt),
  ],
);

export const activityPasswords = sqliteTable(
  "activity_passwords",
  {
    id: text("id").primaryKey(),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id),
    digest: text("digest").notNull(),
    ciphertext: text("ciphertext").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("activity_passwords_activity_digest_unique").on(
      table.activityId,
      table.digest,
    ),
    index("activity_passwords_digest_idx").on(table.digest),
  ],
);

export const rewardInventory = sqliteTable(
  "reward_inventory",
  {
    id: text("id").notNull(),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id),
    position: integer("position").notNull(),
    kind: text("kind", { enum: ["text", "ldc"] })
      .notNull()
      .default("text"),
    ciphertext: text("ciphertext"),
    amountMinor: integer("amount_minor"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check(
      "reward_inventory_content",
      sql`(${table.kind} = 'text' AND ${table.ciphertext} IS NOT NULL AND ${table.amountMinor} IS NULL) OR (${table.kind} = 'ldc' AND ${table.ciphertext} IS NULL AND ${table.amountMinor} IS NOT NULL AND typeof(${table.amountMinor}) = 'integer' AND ${table.amountMinor} > 0 AND ${table.amountMinor} <= 9007199254740991)`,
    ),
    primaryKey({ columns: [table.activityId, table.id] }),
    uniqueIndex("text_inventory_activity_position_unique").on(
      table.activityId,
      table.position,
    ),
  ],
);

export const claims = sqliteTable(
  "claims",
  {
    id: text("id").primaryKey(),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    inventoryId: text("inventory_id").notNull(),
    passwordId: text("password_id").references(() => activityPasswords.id),
    claimedAt: integer("claimed_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.activityId, table.inventoryId],
      foreignColumns: [rewardInventory.activityId, rewardInventory.id],
    }),
    uniqueIndex("claims_activity_user_unique").on(
      table.activityId,
      table.userId,
    ),
    uniqueIndex("claims_activity_inventory_unique").on(
      table.activityId,
      table.inventoryId,
    ),
    index("claims_user_time_idx").on(table.userId, table.claimedAt, table.id),
    index("claims_activity_time_idx").on(
      table.activityId,
      table.claimedAt,
      table.id,
    ),
  ],
);

export const redemptionSubmissions = sqliteTable(
  "redemption_submissions",
  {
    id: text("id").primaryKey(),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    submissionId: text("submission_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    participationMode: text("participation_mode", {
      enum: ["password", "direct", "code"],
    })
      .notNull()
      .default("password"),
    outcome: text("outcome", {
      enum: [
        "pending",
        "incorrect",
        "draft",
        "ended",
        "archived",
        "claimed",
        "already_claimed",
        "solved",
        "registered",
        "already_registered",
      ],
    }).notNull(),
    purpose: text("purpose", { enum: ["claim", "solve", "register"] })
      .notNull()
      .default("claim"),
    matchedPasswordId: text("matched_password_id").references(
      () => activityPasswords.id,
    ),
    claimId: text("claim_id").references(() => claims.id),
    registrationId: text("registration_id").references(
      () => activityRegistrations.id,
    ),
    createdAt: integer("created_at").notNull(),
    validatedAt: integer("validated_at"),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    uniqueIndex("redemption_submissions_user_key_unique").on(
      table.userId,
      table.submissionId,
    ),
    index("redemption_submissions_rate_idx").on(
      table.activityId,
      table.userId,
      table.validatedAt,
    ),
    index("redemption_submissions_pending_idx").on(
      table.outcome,
      table.activityId,
      table.createdAt,
      table.id,
    ),
    index("redemption_submissions_solved_idx").on(
      table.activityId,
      table.userId,
      table.purpose,
      table.outcome,
      table.matchedPasswordId,
    ),
  ],
);

/** Participation is not a claim: losing entries never require a reward or payment. */
export const activityRegistrations = sqliteTable(
  "activity_registrations",
  {
    id: text("id").primaryKey(),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    passwordId: text("password_id").references(() => activityPasswords.id),
    ordinal: integer("ordinal").notNull(),
    recipientId: text("recipient_id").notNull(),
    registeredAt: integer("registered_at").notNull(),
  },
  (table) => [
    uniqueIndex("activity_registrations_user_unique").on(
      table.activityId,
      table.userId,
    ),
    uniqueIndex("activity_registrations_ordinal_unique").on(
      table.activityId,
      table.ordinal,
    ),
    index("activity_registrations_user_time_idx").on(
      table.userId,
      table.registeredAt,
      table.id,
    ),
    check(
      "activity_registrations_ordinal_positive",
      sql`typeof(${table.ordinal})='integer' AND ${table.ordinal}>0 AND ${table.ordinal}<=9007199254740991`,
    ),
  ],
);

/** A saved plan survives restarts and cannot be redrawn after publication failures. */
export const activityDrawPlans = sqliteTable(
  "activity_draw_plans",
  {
    activityId: text("activity_id")
      .primaryKey()
      .references(() => activities.id),
    participantCount: integer("participant_count").notNull(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check(
      "activity_draw_plans_count_valid",
      sql`typeof(${table.participantCount})='integer' AND ${table.participantCount}>=0 AND ${table.participantCount}<=9007199254740991`,
    ),
  ],
);

/**
 * 开奖证明 v2: what a 限时开奖 was drawn from (a drand round after closing and
 * the frozen roster), or a 拼手气's sealed secret. Written once, never deleted.
 */
export const activityRandomProofs = sqliteTable(
  "activity_random_proofs",
  {
    activityId: text("activity_id")
      .primaryKey()
      .references(() => activities.id),
    kind: text("kind", { enum: ["draw", "queue"] }).notNull(),
    version: integer("version").notNull(),
    round: integer("round"),
    roundAt: integer("round_at"),
    rosterHash: text("roster_hash"),
    rosterCount: integer("roster_count"),
    randomness: text("randomness"),
    signature: text("signature"),
    seed: text("seed"),
    fetchedAt: integer("fetched_at"),
    commitment: text("commitment"),
    secretCiphertext: text("secret_ciphertext"),
    secret: text("secret"),
    revealedAt: integer("revealed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check(
      "activity_random_proofs_shape",
      sql`${table.version} = 2 AND ((${table.kind} = 'draw' AND typeof(${table.round}) = 'integer' AND ${table.round} > 0
        AND typeof(${table.roundAt}) = 'integer' AND length(${table.rosterHash}) = 64
        AND typeof(${table.rosterCount}) = 'integer' AND ${table.rosterCount} >= 0
        AND ${table.commitment} IS NULL AND ${table.secretCiphertext} IS NULL AND ${table.secret} IS NULL AND ${table.revealedAt} IS NULL
        AND ((${table.randomness} IS NULL AND ${table.signature} IS NULL AND ${table.seed} IS NULL AND ${table.fetchedAt} IS NULL)
          OR (length(${table.randomness}) = 64 AND length(${table.signature}) = 96 AND length(${table.seed}) = 64 AND ${table.fetchedAt} IS NOT NULL)))
      OR (${table.kind} = 'queue' AND length(${table.commitment}) = 64 AND ${table.secretCiphertext} IS NOT NULL
        AND ${table.round} IS NULL AND ${table.roundAt} IS NULL AND ${table.rosterHash} IS NULL AND ${table.rosterCount} IS NULL
        AND ${table.randomness} IS NULL AND ${table.signature} IS NULL AND ${table.seed} IS NULL AND ${table.fetchedAt} IS NULL
        AND ((${table.secret} IS NULL AND ${table.revealedAt} IS NULL) OR (length(${table.secret}) = 64 AND ${table.revealedAt} IS NOT NULL))))`,
    ),
  ],
);

export const attemptEvents = sqliteTable(
  "attempt_events",
  {
    id: text("id").primaryKey(),
    submissionRowId: text("submission_row_id")
      .notNull()
      .references(() => redemptionSubmissions.id),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    ciphertext: text("ciphertext").notNull(),
    digest: text("digest").notNull(),
    matched: integer("matched", { mode: "boolean" }).notNull(),
    matchedPasswordId: text("matched_password_id").references(
      () => activityPasswords.id,
    ),
    validatedAt: integer("validated_at").notNull(),
    claimId: text("claim_id").references(() => claims.id),
  },
  (table) => [
    uniqueIndex("attempt_events_submission_unique").on(table.submissionRowId),
    uniqueIndex("attempt_events_claim_unique").on(table.claimId),
    index("attempt_events_activity_digest_idx").on(
      table.activityId,
      table.digest,
    ),
    index("attempt_events_activity_user_idx").on(
      table.activityId,
      table.userId,
    ),
  ],
);

export const merchants = sqliteTable(
  "merchants",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id),
    requestId: text("request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    clientId: text("client_id").notNull(),
    label: text("label").notNull(),
    usageStatus: text("usage_status", { enum: ["current", "legacy"] })
      .notNull()
      .default("current"),
    mode: text("mode", { enum: ["simulation", "real"] })
      .notNull()
      .default("simulation"),
    /** An author's own app, or the 🐟额 platform app (balance/platform-app.ts). */
    kind: text("kind", { enum: ["author", "platform"] })
      .notNull()
      .default("author"),
    version: integer("version").notNull().default(1),
    credentialVersion: integer("credential_version").notNull().default(1),
    pausedReason: text("paused_reason"),
    recoveryScannedAt: integer("recovery_scanned_at").notNull().default(0),
    manualCheckAt: integer("manual_check_at"),
    activeTaskId: text("active_task_id"),
    leaseToken: text("lease_token"),
    leaseUntil: integer("lease_until"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("merchants_client_unique").on(table.clientId),
    uniqueIndex("merchants_author_current_unique")
      .on(table.authorId)
      .where(
        sql`${table.usageStatus} = 'current' AND ${table.kind} = 'author'`,
      ),
    uniqueIndex("merchants_platform_current_unique")
      .on(table.kind)
      .where(
        sql`${table.usageStatus} = 'current' AND ${table.kind} = 'platform'`,
      ),
    uniqueIndex("merchants_author_request_unique").on(
      table.authorId,
      table.requestId,
    ),
    index("merchants_author_created_idx").on(
      table.authorId,
      table.createdAt,
      table.id,
    ),
    check("merchants_mode_valid", sql`${table.mode} IN ('simulation','real')`),
    check(
      "merchants_usage_valid",
      sql`${table.usageStatus} IN ('current','legacy')`,
    ),
  ],
);

export const merchantCredentials = sqliteTable(
  "merchant_credentials",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    clientId: text("client_id").notNull().default(""),
    version: integer("version").notNull(),
    ciphertext: text("ciphertext").notNull(),
    verificationStatus: text("verification_status", {
      enum: ["unverified", "checking", "passed", "rejected", "unavailable"],
    })
      .notNull()
      .default("unverified"),
    verificationToken: text("verification_token"),
    verificationStartedAt: integer("verification_started_at"),
    verificationCheckedAt: integer("verification_checked_at"),
    verificationNextAt: integer("verification_next_at"),
    verificationReason: text("verification_reason"),
    verificationHttpStatus: integer("verification_http_status"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("merchant_credentials_version_unique").on(
      table.merchantId,
      table.version,
    ),
  ],
);

export const paymentAcceptances = sqliteTable(
  "payment_acceptances",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    clientId: text("client_id").notNull(),
    businessNo: text("business_no").notNull(),
    recipientId: text("recipient_id").notNull(),
    recipientUsername: text("recipient_username").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    sendConsumedAt: integer("send_consumed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("payment_acceptances_business_unique").on(
      table.clientId,
      table.businessNo,
    ),
    check(
      "payment_acceptances_amount_positive",
      sql`typeof(${table.amountMinor}) = 'integer' AND ${table.amountMinor} > 0 AND ${table.amountMinor} <= 9007199254740991`,
    ),
  ],
);

export const paymentTasks = sqliteTable(
  "payment_tasks",
  {
    id: text("id").primaryKey(),
    claimId: text("claim_id").references(() => claims.id),
    source: text("source", { enum: ["claim", "acceptance", "withdrawal"] })
      .notNull()
      .default("claim"),
    acceptanceId: text("acceptance_id").references(() => paymentAcceptances.id),
    /** A 🐟额 转出, sent by the platform app (docs/balance-design.md §5). */
    withdrawalId: text("withdrawal_id").references(
      (): AnySQLiteColumn => balanceWithdrawals.id,
    ),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    clientId: text("client_id").notNull(),
    businessNo: text("business_no").notNull(),
    recipientId: text("recipient_id").notNull(),
    recipientUsername: text("recipient_username"),
    amountMinor: integer("amount_minor").notNull(),
    mode: text("mode", { enum: ["simulation", "real"] }).notNull(),
    status: text("status", {
      enum: [
        "pending",
        "sending",
        "reconciling",
        "waiting",
        "confirmed",
        "attention",
        // 未发出: a 转出 Credit turned down for good, with no order made.
        "failed",
      ],
    })
      .notNull()
      .default("pending"),
    reason: text("reason"),
    externalOrderId: text("external_order_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    reconciliationCount: integer("reconciliation_count").notNull().default(0),
    unknownOutcome: integer("unknown_outcome", { mode: "boolean" })
      .notNull()
      .default(false),
    nextRunAt: integer("next_run_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    confirmedAt: integer("confirmed_at"),
    sendAcknowledgedAt: integer("send_acknowledged_at"),
    recoveryPolicy: text("recovery_policy", {
      enum: ["claim_same_order_v1", "withdrawal_same_order_v1"],
    }),
    parameterDigest: text("parameter_digest"),
    firstSendAt: integer("first_send_at"),
    nextAction: text("next_action", { enum: ["query", "send", "none"] })
      .notNull()
      .default("query"),
    nextSendAt: integer("next_send_at"),
    nextQueryAt: integer("next_query_at"),
    sendBackoffCount: integer("send_backoff_count").notNull().default(0),
    queryBackoffCount: integer("query_backoff_count").notNull().default(0),
    sendBlockReason: text("send_block_reason"),
    orderObservedAt: integer("order_observed_at"),
    orderEvidence: text("order_evidence", {
      enum: ["receipt", "query", "duplicate"],
    }),
    queriedSendCount: integer("queried_send_count"),
    recoveryVersion: integer("recovery_version").notNull().default(0),
    queriedRecoveryVersion: integer("queried_recovery_version"),
    queryRetryAfterAt: integer("query_retry_after_at"),
  },
  (table) => [
    uniqueIndex("payment_tasks_claim_unique").on(table.claimId),
    uniqueIndex("payment_tasks_acceptance_unique").on(table.acceptanceId),
    uniqueIndex("payment_tasks_withdrawal_unique").on(table.withdrawalId),
    check(
      "payment_tasks_source_valid",
      sql`(${table.source} = 'claim' AND ${table.claimId} IS NOT NULL AND ${table.acceptanceId} IS NULL AND ${table.withdrawalId} IS NULL) OR (${table.source} = 'acceptance' AND ${table.claimId} IS NULL AND ${table.acceptanceId} IS NOT NULL AND ${table.withdrawalId} IS NULL AND ${table.mode} = 'real') OR (${table.source} = 'withdrawal' AND ${table.claimId} IS NULL AND ${table.acceptanceId} IS NULL AND ${table.withdrawalId} IS NOT NULL AND ${table.mode} = 'real')`,
    ),
    uniqueIndex("payment_tasks_business_unique").on(
      table.clientId,
      table.businessNo,
    ),
    index("payment_tasks_due_idx").on(table.status, table.nextRunAt),
    index("payment_tasks_merchant_active_order_idx")
      .on(table.merchantId, table.createdAt, table.id)
      .where(
        sql`${table.status} IN ('pending','waiting','reconciling','sending')`,
      ),
    index("payment_tasks_merchant_time_idx").on(
      table.merchantId,
      table.createdAt,
      table.id,
    ),
    index("payment_tasks_admin_time_idx").on(
      sql`${table.createdAt} DESC`,
      sql`${table.id} DESC`,
    ),
    index("payment_tasks_admin_status_time_idx").on(
      table.status,
      sql`${table.createdAt} DESC`,
      sql`${table.id} DESC`,
    ),
    index("payment_tasks_admin_mode_status_time_idx").on(
      table.mode,
      table.status,
      sql`${table.createdAt} DESC`,
      sql`${table.id} DESC`,
    ),
    check(
      "payment_tasks_mode_valid",
      sql`${table.mode} IN ('simulation','real')`,
    ),
    check(
      "payment_tasks_recipient_snapshot",
      sql`(${table.mode} = 'simulation' AND ${table.recipientId} LIKE 'simulation:%') OR (${table.mode} = 'real' AND ${table.recipientUsername} IS NOT NULL AND length(${table.recipientUsername}) > 0 AND ${table.recipientId} GLOB '[1-9]*' AND ${table.recipientId} NOT GLOB '*[^0-9]*' AND length(${table.recipientId}) <= 20)`,
    ),
    check(
      "payment_tasks_amount_positive",
      sql`typeof(${table.amountMinor}) = 'integer' AND ${table.amountMinor} > 0 AND ${table.amountMinor} <= 9007199254740991`,
    ),
  ],
);

export const paymentAttempts = sqliteTable(
  "payment_attempts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => paymentTasks.id),
    token: text("token").notNull(),
    operation: text("operation", { enum: ["send", "query"] }).notNull(),
    outcome: text("outcome", {
      enum: ["started", "succeeded", "rejected", "unknown"],
    }).notNull(),
    reason: text("reason"),
    clientId: text("client_id"),
    identityCorrectionVersion: integer("identity_correction_version")
      .notNull()
      .default(0),
    noOrderEvidence: text("no_order_evidence", {
      enum: ["protocol_rejection_v1"],
    }),
    credentialVersion: integer("credential_version").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    httpStatus: integer("http_status"),
    purpose: text("purpose", { enum: ["recovery", "probe"] })
      .notNull()
      .default("recovery"),
    diagnosticCiphertext: text("diagnostic_ciphertext"),
    recipientUsername: text("recipient_username"),
    parameterDigest: text("parameter_digest"),
  },
  (table) => [
    index("payment_attempts_task_time_idx").on(table.taskId, table.startedAt),
  ],
);

export const paymentRetryGrants = sqliteTable(
  "payment_retry_grants",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => paymentTasks.id),
    policy: text("policy", { enum: ["same_order_v1"] })
      .notNull()
      .default("same_order_v1"),
    parameterDigest: text("parameter_digest").notNull(),
    maxAdditionalSends: integer("max_additional_sends").notNull().default(5),
    usedAdditionalSends: integer("used_additional_sends").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check(
      "payment_retry_grants_policy_valid",
      sql`${table.policy} = 'same_order_v1'`,
    ),
    check(
      "payment_retry_grants_budget_valid",
      sql`${table.maxAdditionalSends} BETWEEN 1 AND 5 AND ${table.usedAdditionalSends} BETWEEN 0 AND ${table.maxAdditionalSends}`,
    ),
    check(
      "payment_retry_grants_expiry_valid",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + 86400000`,
    ),
  ],
);

export const paymentUsernameCorrections = sqliteTable(
  "payment_username_corrections",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => paymentTasks.id),
    originalUsername: text("original_username").notNull(),
    correctedUsername: text("corrected_username").notNull(),
    originalParameterDigest: text("original_parameter_digest").notNull(),
    correctedParameterDigest: text("corrected_parameter_digest").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check(
      "payment_username_corrections_case_only",
      sql`${table.originalUsername} != ${table.correctedUsername} AND lower(${table.originalUsername}) = lower(${table.correctedUsername}) AND length(${table.correctedUsername}) BETWEEN 1 AND 255 AND ${table.correctedUsername} NOT GLOB '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "payment_username_corrections_digest_valid",
      sql`length(${table.originalParameterDigest}) = 64 AND ${table.originalParameterDigest} NOT GLOB '*[^0-9a-f]*' AND length(${table.correctedParameterDigest}) = 64 AND ${table.correctedParameterDigest} NOT GLOB '*[^0-9a-f]*' AND ${table.originalParameterDigest} != ${table.correctedParameterDigest}`,
    ),
  ],
);

export const paymentDuplicateProbes = sqliteTable(
  "payment_duplicate_probes",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => paymentTasks.id),
    baselineExternalOrderId: text("baseline_external_order_id").notNull(),
    parameterDigest: text("parameter_digest").notNull(),
    status: text("status", {
      enum: [
        "pending",
        "sending",
        "reconciling",
        "awaiting_evidence",
        "passed",
        "inconclusive",
        "conflict",
      ],
    })
      .notNull()
      .default("pending"),
    permitConsumedAt: integer("permit_consumed_at"),
    nextRunAt: integer("next_run_at").notNull(),
    queryCount: integer("query_count").notNull().default(0),
    reason: text("reason"),
    httpStatus: integer("http_status"),
    protocolVerifiedAt: integer("protocol_verified_at"),
    backendVerifiedAt: integer("backend_verified_at"),
    backendEvidenceDigest: text("backend_evidence_digest"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("payment_duplicate_probes_due_idx").on(table.status, table.nextRunAt),
    check(
      "payment_duplicate_probes_status_valid",
      sql`${table.status} IN ('pending','sending','reconciling','awaiting_evidence','passed','inconclusive','conflict')`,
    ),
    check(
      "payment_duplicate_probes_pass_evidence",
      sql`${table.status} != 'passed' OR (${table.protocolVerifiedAt} IS NOT NULL AND ${table.backendVerifiedAt} IS NOT NULL AND ${table.permitConsumedAt} IS NOT NULL)`,
    ),
  ],
);

export const paymentOutbox = sqliteTable(
  "payment_outbox",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => paymentTasks.id),
    createdAt: integer("created_at").notNull(),
    deliveredAt: integer("delivered_at"),
  },
  (table) => [
    uniqueIndex("payment_outbox_task_unique").on(table.taskId),
    index("payment_outbox_delivery_idx").on(table.deliveredAt, table.createdAt),
  ],
);

export const simulationControls = sqliteTable("simulation_controls", {
  merchantId: text("merchant_id")
    .primaryKey()
    .references(() => merchants.id),
  scenario: text("scenario", {
    enum: [
      "normal",
      "response_lost",
      "query_delayed",
      "query_unavailable",
      "insufficient_funds",
      "daily_limit",
      "invalid_credentials",
      "conflict",
    ],
  })
    .notNull()
    .default("normal"),
  updatedAt: integer("updated_at").notNull(),
});

export const simulationOrders = sqliteTable(
  "simulation_orders",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    businessNo: text("business_no").notNull(),
    recipientId: text("recipient_id").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    visibleAt: integer("visible_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("simulation_orders_business_unique").on(
      table.clientId,
      table.businessNo,
    ),
  ],
);

export const platformControls = sqliteTable(
  "platform_controls",
  {
    id: text("id").primaryKey(),
    version: integer("version").notNull().default(1),
    allowRealOpen: integer("allow_real_open", { mode: "boolean" })
      .notNull()
      .default(false),
    allowRealClaim: integer("allow_real_claim", { mode: "boolean" })
      .notNull()
      .default(false),
    allowRealSend: integer("allow_real_send", { mode: "boolean" })
      .notNull()
      .default(false),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check("platform_controls_singleton", sql`${table.id} = 'global'`),
    check(
      "platform_controls_flags",
      sql`${table.allowRealOpen} IN (0,1) AND ${table.allowRealClaim} IN (0,1) AND ${table.allowRealSend} IN (0,1)`,
    ),
  ],
);

export const queueProbes = sqliteTable("queue_probes", {
  id: text("id").primaryKey(),
  requestedAt: integer("requested_at").notNull(),
  consumedAt: integer("consumed_at"),
  lastSeenAt: integer("last_seen_at"),
  deliveryCount: integer("delivery_count").notNull().default(0),
});

export const maintenanceRuns = sqliteTable(
  "maintenance_runs",
  {
    job: text("job").primaryKey(),
    scheduledAt: integer("scheduled_at").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    status: text("status", {
      enum: ["running", "succeeded", "failed"],
    }).notNull(),
    reason: text("reason"),
  },
  (table) => [
    check(
      "maintenance_runs_status",
      sql`${table.status} IN ('running','succeeded','failed')`,
    ),
  ],
);

export const merchantClientIds = sqliteTable(
  "merchant_client_ids",
  {
    clientId: text("client_id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("merchant_client_ids_merchant_idx").on(table.merchantId)],
);

export const merchantConfigChanges = sqliteTable(
  "merchant_config_changes",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    requestId: text("request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultVersion: integer("result_version").notNull(),
    credentialVersion: integer("credential_version").notNull(),
    clientId: text("client_id").notNull(),
    purpose: text("purpose", { enum: ["current", "repair"] }).notNull(),
    taskId: text("task_id").references(() => paymentTasks.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("merchant_config_changes_request_unique").on(
      table.merchantId,
      table.requestId,
    ),
  ],
);

export const paymentIdentityCorrections = sqliteTable(
  "payment_identity_corrections",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => paymentTasks.id),
    version: integer("version").notNull(),
    originalClientId: text("original_client_id").notNull(),
    correctedClientId: text("corrected_client_id").notNull(),
    originalParameterDigest: text("original_parameter_digest").notNull(),
    correctedParameterDigest: text("corrected_parameter_digest").notNull(),
    merchantVersion: integer("merchant_version").notNull(),
    credentialVersion: integer("credential_version").notNull(),
    evidence: text("evidence", {
      enum: ["never_sent", "rejected_no_order"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("payment_identity_corrections_version_unique").on(
      table.taskId,
      table.version,
    ),
  ],
);

// 🐟额 (docs/balance-design.md). Every change to someone's 🐟额 is an
// entry; triggers (migration 0029) keep balance_accounts equal to their sum.

export const balanceSettings = sqliteTable(
  "balance_settings",
  {
    id: text("id").primaryKey(),
    version: integer("version").notNull(),
    topupEnabled: integer("topup_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    withdrawEnabled: integer("withdraw_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    topupFeePercent: integer("topup_fee_percent").notNull().default(12),
    withdrawFeePercent: integer("withdraw_fee_percent").notNull().default(12),
    withdrawMaxMinor: integer("withdraw_max_minor").notNull().default(100000),
    /** 🐟额红包 may be made and opened (docs/balance-design.md §14). */
    hongbaoEnabled: integer("hongbao_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 转账 may be made, on the page and the open API (balance-design §16). */
    transferEnabled: integer("transfer_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * 代码判定红包 may be made and opened, how many each person may open a
     * day, and how many 在线检查 each may run a day (balance-design §14).
     */
    codeHongbaoEnabled: integer("code_hongbao_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    codeHongbaoDailyLimit: integer("code_hongbao_daily_limit")
      .notNull()
      .default(3),
    codeCheckDailyLimit: integer("code_check_daily_limit")
      .notNull()
      .default(10),
    updatedAt: integer("updated_at").notNull(),
    updatedByUserId: text("updated_by_user_id"),
  },
  (table) => [
    check("balance_settings_singleton", sql`${table.id} = 'global'`),
    check(
      "balance_settings_fees_valid",
      sql`${table.topupFeePercent} BETWEEN 0 AND 50 AND ${table.withdrawFeePercent} BETWEEN 0 AND 50`,
    ),
    check(
      "balance_settings_withdraw_max_valid",
      sql`${table.withdrawMaxMinor} >= 100`,
    ),
  ],
);

/**
 * An invitation to 转入 (docs/balance-design.md §13): for one LINUX DO
 * username, good for a day and for one use — or an admin's 通用链接, for
 * whoever has it, up to `maxUses` people until it expires or is stopped.
 * Only the link's digest is kept.
 */
export const balanceInvites = sqliteTable(
  "balance_invites",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    inviterUserId: text("inviter_user_id")
      .notNull()
      .references(() => users.id),
    /** The username it is for, in lower case; null for a 通用链接. */
    inviteeUsername: text("invitee_username"),
    createdAt: integer("created_at").notNull(),
    /** Null for a 通用链接 good for good. */
    expiresAt: integer("expires_at"),
    acceptedAt: integer("accepted_at"),
    acceptedUserId: text("accepted_user_id").references(() => users.id),
    /** A 通用链接's cap (null: any number), and how many have accepted it. */
    maxUses: integer("max_uses"),
    useCount: integer("use_count").notNull().default(0),
    stoppedAt: integer("stopped_at"),
    stoppedByUserId: text("stopped_by_user_id").references(() => users.id),
    /** A 通用链接's 附言, under the accept page's title. */
    note: text("note"),
  },
  (table) => [
    uniqueIndex("balance_invites_token_unique").on(table.tokenHash),
    index("balance_invites_inviter_time_idx").on(
      table.inviterUserId,
      table.createdAt,
      table.id,
    ),
    index("balance_invites_time_idx").on(table.createdAt, table.id),
    check(
      "balance_invites_valid",
      sql`(${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}) AND length(${table.tokenHash}) = 64
        AND (${table.inviteeUsername} IS NULL OR (${table.inviteeUsername} = lower(${table.inviteeUsername}) AND length(${table.inviteeUsername}) BETWEEN 1 AND 60
          AND ${table.expiresAt} IS NOT NULL AND ${table.maxUses} IS NULL AND ${table.useCount} = 0 AND ${table.stoppedAt} IS NULL AND ${table.note} IS NULL))
        AND (${table.acceptedAt} IS NULL) = (${table.acceptedUserId} IS NULL)
        AND (${table.inviteeUsername} IS NOT NULL OR ${table.acceptedAt} IS NULL)
        AND (${table.maxUses} IS NULL OR ${table.maxUses} BETWEEN 1 AND 1000)
        AND ${table.useCount} >= 0 AND (${table.maxUses} IS NULL OR ${table.useCount} <= ${table.maxUses})
        AND (${table.stoppedAt} IS NULL) = (${table.stoppedByUserId} IS NULL)
        AND (${table.note} IS NULL OR length(${table.note}) BETWEEN 1 AND 100)`,
    ),
  ],
);

/**
 * Who may 转入 (and so invite): for good once in, with who invited them
 * and through which invitation (a 通用链接 brings in several).
 */
export const balanceMembers = sqliteTable(
  "balance_members",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id),
    invitedByUserId: text("invited_by_user_id").references(() => users.id),
    inviteId: text("invite_id").references(() => balanceInvites.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("balance_members_invite_idx").on(table.inviteId),
    index("balance_members_inviter_idx").on(table.invitedByUserId),
  ],
);

export const balanceSettingChanges = sqliteTable(
  "balance_setting_changes",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").notNull(),
    previousVersion: integer("previous_version").notNull(),
    nextVersion: integer("next_version").notNull(),
    /** The settings before and after, as JSON. */
    previous: text("previous").notNull(),
    next: text("next").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("balance_setting_changes_version_unique").on(table.nextVersion),
    index("balance_setting_changes_time_idx").on(table.createdAt, table.id),
  ],
);

export const balanceAccounts = sqliteTable(
  "balance_accounts",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id),
    /** May go below 0, only by an admin's 扣回. */
    availableMinor: integer("available_minor").notNull().default(0),
    lockedMinor: integer("locked_minor").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check("balance_accounts_locked_valid", sql`${table.lockedMinor} >= 0`),
  ],
);

export const balanceTopups = sqliteTable(
  "balance_topups",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    clientId: text("client_id").notNull(),
    credentialVersion: integer("credential_version").notNull(),
    businessNo: text("business_no").notNull(),
    debitMinor: integer("debit_minor").notNull(),
    feeMinor: integer("fee_minor").notNull(),
    creditMinor: integer("credit_minor").notNull(),
    feePercent: integer("fee_percent").notNull(),
    settingsVersion: integer("settings_version").notNull(),
    orderName: text("order_name").notNull(),
    returnUrl: text("return_url").notNull(),
    status: text("status", { enum: ["pending", "unpaid", "credited"] })
      .notNull()
      .default("pending"),
    flag: text("flag", { enum: ["mismatch", "reversed"] }),
    externalOrderId: text("external_order_id"),
    requestId: text("request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    createdAt: integer("created_at").notNull(),
    /** First time Credit gave back its cashier: “去 Credit 站确认” lasts 10 minutes from here. */
    submittedAt: integer("submitted_at"),
    creditedAt: integer("credited_at"),
    creditedBy: text("credited_by", { enum: ["auto", "admin"] }),
    creditedByUserId: text("credited_by_user_id"),
    creditReason: text("credit_reason"),
    lastCheckedAt: integer("last_checked_at"),
    lastCheckResult: text("last_check_result"),
    /** Claimed before each real check, so one 转入 is checked at most every 3 s. */
    checkClaimedAt: integer("check_claimed_at").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("balance_topups_business_no_unique").on(table.businessNo),
    uniqueIndex("balance_topups_request_unique").on(
      table.userId,
      table.requestId,
    ),
    index("balance_topups_user_time_idx").on(
      table.userId,
      table.createdAt,
      table.id,
    ),
    index("balance_topups_status_time_idx").on(table.status, table.createdAt),
    check(
      "balance_topups_amounts_valid",
      sql`${table.debitMinor} BETWEEN 100 AND 200000 AND ${table.feeMinor} >= 0 AND ${table.creditMinor} > 0 AND ${table.debitMinor} = ${table.creditMinor} + ${table.feeMinor} AND ${table.feePercent} BETWEEN 0 AND 50`,
    ),
    check(
      "balance_topups_status_valid",
      sql`${table.status} IN ('pending','unpaid','credited') AND (${table.flag} IS NULL OR ${table.flag} IN ('mismatch','reversed'))`,
    ),
    check(
      "balance_topups_credited_valid",
      sql`(${table.status} = 'credited') = (${table.creditedAt} IS NOT NULL AND ${table.creditedBy} IN ('auto','admin'))`,
    ),
  ],
);

/**
 * 转账 through 对方的收银台 (docs/balance-design.md §16): an order made with
 * the recipient's LDC 商户, paid at Credit 站 from the payer's own Credit
 * account. Nothing passes 🐟额; this only says how the order stands.
 */
export const balanceCheckouts = sqliteTable(
  "balance_checkouts",
  {
    id: text("id").primaryKey(),
    fromUserId: text("from_user_id")
      .notNull()
      .references(() => users.id),
    toUserId: text("to_user_id")
      .notNull()
      .references(() => users.id),
    /** The recipient as named when it was made. */
    toUsername: text("to_username").notNull(),
    toLinuxDoId: text("to_linux_do_id").notNull(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    clientId: text("client_id").notNull(),
    credentialVersion: integer("credential_version").notNull(),
    businessNo: text("business_no").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    remark: text("remark"),
    orderName: text("order_name").notNull(),
    returnUrl: text("return_url").notNull(),
    status: text("status", { enum: ["pending", "unpaid", "paid"] })
      .notNull()
      .default("pending"),
    flag: text("flag", { enum: ["mismatch", "reversed"] }),
    externalOrderId: text("external_order_id"),
    requestId: text("request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    createdAt: integer("created_at").notNull(),
    /** First time Credit gave back its cashier: “去 Credit 站确认” lasts 10 minutes from here. */
    submittedAt: integer("submitted_at"),
    paidAt: integer("paid_at"),
    lastCheckedAt: integer("last_checked_at"),
    lastCheckResult: text("last_check_result"),
    /** Claimed before each real check, so one is checked at most every 3 s. */
    checkClaimedAt: integer("check_claimed_at").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("balance_checkouts_business_no_unique").on(table.businessNo),
    uniqueIndex("balance_checkouts_request_unique").on(
      table.fromUserId,
      table.requestId,
    ),
    index("balance_checkouts_from_time_idx").on(
      table.fromUserId,
      table.createdAt,
      table.id,
    ),
    index("balance_checkouts_to_status_time_idx").on(
      table.toUserId,
      table.status,
      table.createdAt,
      table.id,
    ),
    check(
      "balance_checkouts_valid",
      sql`${table.amountMinor} BETWEEN 100 AND 200000 AND ${table.fromUserId} <> ${table.toUserId}
        AND ${table.status} IN ('pending','unpaid','paid') AND (${table.flag} IS NULL OR ${table.flag} IN ('mismatch','reversed'))
        AND (${table.status} = 'paid') = (${table.paidAt} IS NOT NULL)
        AND (${table.remark} IS NULL OR length(${table.remark}) BETWEEN 1 AND 64)`,
    ),
  ],
);

export const balanceTopupChecks = sqliteTable(
  "balance_topup_checks",
  {
    id: text("id").primaryKey(),
    topupId: text("topup_id")
      .notNull()
      .references(() => balanceTopups.id),
    trigger: text("trigger", {
      enum: ["user", "page", "admin", "submit"],
    }).notNull(),
    /** paid, unpaid, not_found, credentials, unavailable or mismatch. */
    result: text("result").notNull(),
    httpStatus: integer("http_status"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("balance_topup_checks_topup_idx").on(table.topupId, table.createdAt),
  ],
);

export const balanceAdjustments = sqliteTable(
  "balance_adjustments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    direction: text("direction", { enum: ["add", "deduct"] }).notNull(),
    amountMinor: integer("amount_minor").notNull(),
    reason: text("reason").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    requestId: text("request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("balance_adjustments_request_unique").on(table.requestId),
    index("balance_adjustments_user_time_idx").on(
      table.userId,
      table.createdAt,
    ),
    index("balance_adjustments_time_idx").on(table.createdAt, table.id),
    check(
      "balance_adjustments_valid",
      sql`${table.direction} IN ('add','deduct') AND ${table.amountMinor} > 0 AND length(${table.reason}) BETWEEN 1 AND 200`,
    ),
  ],
);

export const balanceEntries = sqliteTable(
  "balance_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /**
     * hongbao: a 🐟额红包's share, into its claimant's 可用; transfer_out and
     * transfer_in: a 转账 to the other's 🐟额, out of one and into the other.
     */
    kind: text("kind", {
      enum: [
        "topup",
        "adjustment",
        "lock",
        "unlock",
        "deduct",
        "hongbao",
        "transfer_out",
        "transfer_in",
      ],
    }).notNull(),
    availableDeltaMinor: integer("available_delta_minor").notNull(),
    lockedDeltaMinor: integer("locked_delta_minor").notNull().default(0),
    topupId: text("topup_id").references(() => balanceTopups.id),
    adjustmentId: text("adjustment_id").references(() => balanceAdjustments.id),
    /** A lock (转出, 🐟额红包): balance_locks, checked by trigger. */
    lockId: text("lock_id"),
    /** A 🐟额红包's claim: its share's deduct and its hongbao. */
    claimId: text("claim_id").references(() => claims.id),
    /** A 转账 to the other's 🐟额: its two entries. */
    transferId: text("transfer_id").references(() => balanceTransfers.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("balance_entries_topup_unique")
      .on(table.topupId)
      .where(sql`${table.kind} = 'topup'`),
    uniqueIndex("balance_entries_adjustment_unique")
      .on(table.adjustmentId)
      .where(sql`${table.kind} = 'adjustment'`),
    // A lock is made once and given back at most once.
    uniqueIndex("balance_entries_lock_unique")
      .on(table.lockId)
      .where(sql`${table.kind} = 'lock'`),
    uniqueIndex("balance_entries_unlock_unique")
      .on(table.lockId)
      .where(sql`${table.kind} = 'unlock'`),
    // A claim's share leaves the lock once and arrives once.
    uniqueIndex("balance_entries_claim_deduct_unique")
      .on(table.claimId)
      .where(sql`${table.kind} = 'deduct' AND ${table.claimId} IS NOT NULL`),
    uniqueIndex("balance_entries_claim_hongbao_unique")
      .on(table.claimId)
      .where(sql`${table.kind} = 'hongbao'`),
    // A 转账 leaves once and arrives once.
    uniqueIndex("balance_entries_transfer_out_unique")
      .on(table.transferId)
      .where(sql`${table.kind} = 'transfer_out'`),
    uniqueIndex("balance_entries_transfer_in_unique")
      .on(table.transferId)
      .where(sql`${table.kind} = 'transfer_in'`),
    index("balance_entries_user_time_idx").on(
      table.userId,
      table.createdAt,
      table.id,
    ),
    check(
      "balance_entries_shape_valid",
      sql`(${table.kind} = 'topup' AND ${table.topupId} IS NOT NULL AND ${table.availableDeltaMinor} > 0 AND ${table.lockedDeltaMinor} = 0 AND ${table.claimId} IS NULL)
        OR (${table.kind} = 'adjustment' AND ${table.adjustmentId} IS NOT NULL AND ${table.availableDeltaMinor} != 0 AND ${table.lockedDeltaMinor} = 0 AND ${table.claimId} IS NULL)
        OR (${table.kind} = 'lock' AND ${table.lockId} IS NOT NULL AND ${table.availableDeltaMinor} < 0 AND ${table.lockedDeltaMinor} = -${table.availableDeltaMinor} AND ${table.claimId} IS NULL)
        OR (${table.kind} = 'unlock' AND ${table.lockId} IS NOT NULL AND ${table.availableDeltaMinor} > 0 AND ${table.lockedDeltaMinor} = -${table.availableDeltaMinor} AND ${table.claimId} IS NULL)
        OR (${table.kind} = 'deduct' AND ${table.lockId} IS NOT NULL AND ${table.availableDeltaMinor} = 0 AND ${table.lockedDeltaMinor} < 0)
        OR (${table.kind} = 'hongbao' AND ${table.lockId} IS NOT NULL AND ${table.claimId} IS NOT NULL AND ${table.availableDeltaMinor} > 0 AND ${table.lockedDeltaMinor} = 0)
        OR (${table.kind} = 'transfer_out' AND ${table.transferId} IS NOT NULL AND ${table.availableDeltaMinor} < 0 AND ${table.lockedDeltaMinor} = 0 AND ${table.claimId} IS NULL)
        OR (${table.kind} = 'transfer_in' AND ${table.transferId} IS NOT NULL AND ${table.availableDeltaMinor} > 0 AND ${table.lockedDeltaMinor} = 0 AND ${table.claimId} IS NULL)`,
    ),
  ],
);

/**
 * A 转出 (docs/balance-design.md §5): its 🐟 locked when asked for, sent by
 * the platform app through the payment queue (payment_tasks.withdrawal_id),
 * then 已发放 (taken) or 未发出 (given back). Fixed once made.
 */
export const balanceWithdrawals = sqliteTable(
  "balance_withdrawals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    clientId: text("client_id").notNull(),
    businessNo: text("business_no").notNull(),
    /** The Credit account it goes to, as it was asked for. */
    recipientId: text("recipient_id").notNull(),
    recipientUsername: text("recipient_username").notNull(),
    debitMinor: integer("debit_minor").notNull(),
    feeMinor: integer("fee_minor").notNull(),
    creditMinor: integer("credit_minor").notNull(),
    feePercent: integer("fee_percent").notNull(),
    settingsVersion: integer("settings_version").notNull(),
    status: text("status", { enum: ["sending", "sent", "failed"] })
      .notNull()
      .default("sending"),
    failureReason: text("failure_reason", {
      enum: ["recipient", "self_payment", "configuration", "validation"],
    }),
    requestId: text("request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
    failedAt: integer("failed_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("balance_withdrawals_business_no_unique").on(table.businessNo),
    uniqueIndex("balance_withdrawals_request_unique").on(
      table.userId,
      table.requestId,
    ),
    index("balance_withdrawals_user_time_idx").on(
      table.userId,
      table.createdAt,
      table.id,
    ),
    index("balance_withdrawals_status_time_idx").on(
      table.status,
      table.createdAt,
    ),
    index("balance_withdrawals_time_idx").on(table.createdAt, table.id),
    check(
      "balance_withdrawals_amounts_valid",
      sql`${table.debitMinor} >= 100 AND ${table.feeMinor} >= 0 AND ${table.creditMinor} > 0 AND ${table.debitMinor} = ${table.creditMinor} + ${table.feeMinor} AND ${table.feePercent} BETWEEN 0 AND 50`,
    ),
    check(
      "balance_withdrawals_status_valid",
      sql`(${table.status} = 'sending' AND ${table.sentAt} IS NULL AND ${table.failedAt} IS NULL AND ${table.failureReason} IS NULL)
        OR (${table.status} = 'sent' AND ${table.sentAt} IS NOT NULL AND ${table.failedAt} IS NULL AND ${table.failureReason} IS NULL)
        OR (${table.status} = 'failed' AND ${table.sentAt} IS NULL AND ${table.failedAt} IS NOT NULL AND ${table.failureReason} IN ('recipient','self_payment','configuration','validation'))`,
    ),
  ],
);

/**
 * 开放接口密钥 (docs/balance-design.md §16): a 🐟额 PLUS member's key for
 * the open API, only its digest kept. Stopped by its owner or an admin and
 * never started again; its last 转账 and running totals ride in each
 * 转账's batch.
 */
export const balanceApiKeys = sqliteTable(
  "balance_api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** The key's last 4 characters, to tell keys apart in the list. */
    lastFour: text("last_four").notNull(),
    dailyLimitMinor: integer("daily_limit_minor"),
    createdAt: integer("created_at").notNull(),
    lastTransferAt: integer("last_transfer_at"),
    lastTransferIp: text("last_transfer_ip"),
    transferCount: integer("transfer_count").notNull().default(0),
    transferTotalMinor: integer("transfer_total_minor").notNull().default(0),
    revokedAt: integer("revoked_at"),
    /** An admin's stop: who, and why (the owner's own leaves both empty). */
    revokedByUserId: text("revoked_by_user_id").references(() => users.id),
    revokeReason: text("revoke_reason"),
  },
  (table) => [
    uniqueIndex("balance_api_keys_token_unique").on(table.tokenHash),
    index("balance_api_keys_user_idx").on(table.userId, table.createdAt),
    check(
      "balance_api_keys_valid",
      sql`length(${table.name}) BETWEEN 1 AND 20 AND length(${table.lastFour}) = 4
        AND (${table.dailyLimitMinor} IS NULL OR ${table.dailyLimitMinor} >= 1)
        AND ${table.transferCount} >= 0 AND ${table.transferTotalMinor} >= 0
        AND (${table.revokedAt} IS NOT NULL OR (${table.revokedByUserId} IS NULL AND ${table.revokeReason} IS NULL))
        AND (${table.revokedByUserId} IS NULL OR length(${table.revokeReason}) BETWEEN 1 AND 200)`,
    ),
  ],
);

/**
 * A 转账 (docs/balance-design.md §16): 🐟 from one person to another's 🐟额
 * (its two entries, at once), or to their Credit account (a 转出 to them,
 * balance_withdrawals). Made from the page (request_id) or an open API key
 * (out_transfer_no, the caller's own); fixed once made.
 */
export const balanceTransfers = sqliteTable(
  "balance_transfers",
  {
    id: text("id").primaryKey(),
    fromUserId: text("from_user_id")
      .notNull()
      .references(() => users.id),
    toUserId: text("to_user_id")
      .notNull()
      .references(() => users.id),
    destination: text("destination", {
      enum: ["balance", "credit"],
    }).notNull(),
    withdrawalId: text("withdrawal_id").references(() => balanceWithdrawals.id),
    amountMinor: integer("amount_minor").notNull(),
    apiKeyId: text("api_key_id").references(() => balanceApiKeys.id),
    outTransferNo: text("out_transfer_no"),
    requestId: text("request_id"),
    requestDigest: text("request_digest").notNull(),
    remark: text("remark"),
    /** The recipient as it was made: LINUX DO ID and username. */
    recipientExternalId: text("recipient_external_id").notNull(),
    recipientUsername: text("recipient_username").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("balance_transfers_out_no_unique")
      .on(table.apiKeyId, table.outTransferNo)
      .where(sql`${table.apiKeyId} IS NOT NULL`),
    uniqueIndex("balance_transfers_request_unique")
      .on(table.fromUserId, table.requestId)
      .where(sql`${table.requestId} IS NOT NULL`),
    uniqueIndex("balance_transfers_withdrawal_unique")
      .on(table.withdrawalId)
      .where(sql`${table.withdrawalId} IS NOT NULL`),
    index("balance_transfers_from_time_idx").on(
      table.fromUserId,
      table.createdAt,
      table.id,
    ),
    index("balance_transfers_to_time_idx").on(
      table.toUserId,
      table.createdAt,
      table.id,
    ),
    index("balance_transfers_key_time_idx").on(table.apiKeyId, table.createdAt),
    index("balance_transfers_time_idx").on(table.createdAt, table.id),
    check(
      "balance_transfers_valid",
      sql`${table.amountMinor} > 0 AND ${table.fromUserId} != ${table.toUserId}
        AND ((${table.destination} = 'balance' AND ${table.withdrawalId} IS NULL)
          OR (${table.destination} = 'credit' AND ${table.withdrawalId} IS NOT NULL AND ${table.amountMinor} >= 100))
        AND ((${table.apiKeyId} IS NULL AND ${table.outTransferNo} IS NULL AND ${table.requestId} IS NOT NULL)
          OR (${table.apiKeyId} IS NOT NULL AND length(${table.outTransferNo}) BETWEEN 1 AND 64 AND ${table.requestId} IS NULL))
        AND (${table.remark} IS NULL OR length(${table.remark}) BETWEEN 1 AND 64)`,
    ),
  ],
);

/**
 * 🐟 held for something (docs/balance-design.md §4): a 转出 now, a 🐟 红包
 * later. Locked once, then given back (released) or taken (spent); its
 * entries move it (triggers in migration 0030).
 */
export const balanceLocks = sqliteTable(
  "balance_locks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    purpose: text("purpose", { enum: ["withdrawal", "activity"] }).notNull(),
    withdrawalId: text("withdrawal_id").references(() => balanceWithdrawals.id),
    /** A 🐟额红包's: one lock each (checked by trigger). */
    activityId: text("activity_id"),
    amountMinor: integer("amount_minor").notNull(),
    remainingMinor: integer("remaining_minor").notNull(),
    status: text("status", { enum: ["active", "released", "spent"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("balance_locks_withdrawal_unique").on(table.withdrawalId),
    uniqueIndex("balance_locks_activity_unique").on(table.activityId),
    index("balance_locks_user_status_idx").on(table.userId, table.status),
    check(
      "balance_locks_purpose_valid",
      sql`(${table.purpose} = 'withdrawal' AND ${table.withdrawalId} IS NOT NULL AND ${table.activityId} IS NULL)
        OR (${table.purpose} = 'activity' AND ${table.activityId} IS NOT NULL AND ${table.withdrawalId} IS NULL)`,
    ),
    check(
      "balance_locks_amounts_valid",
      sql`${table.amountMinor} > 0 AND ${table.remainingMinor} BETWEEN 0 AND ${table.amountMinor}
        AND (${table.status} = 'active' OR ${table.remainingMinor} = 0)
        AND ${table.status} IN ('active','released','spent')`,
    ),
  ],
);

/**
 * 代码判定红包 (docs/programmable-hongbao-design.md): its judge.js and
 * tests.json (encrypted, like 口令), the prompt and 每份至少; from opening
 * its sealed seed, the code's state and how its judgments go. The code and
 * the seed are kept in the clear once it is over, never changed after.
 */
export const activityCode = sqliteTable(
  "activity_code",
  {
    activityId: text("activity_id")
      .primaryKey()
      .references(() => activities.id),
    protocol: integer("protocol").notNull(),
    prompt: text("prompt").notNull(),
    /** judge.js's SHA-256: published at opening. */
    fingerprint: text("fingerprint").notNull(),
    codeCiphertext: text("code_ciphertext").notNull(),
    testsCiphertext: text("tests_ciphertext").notNull(),
    testsDigest: text("tests_digest").notNull(),
    minEachMinor: integer("min_each_minor").notNull(),
    seedCommitment: text("seed_commitment"),
    seedCiphertext: text("seed_ciphertext"),
    /** What the code last kept (encrypted JSON); null until it keeps one. */
    stateCiphertext: text("state_ciphertext"),
    /** Judgments in a row the code failed; five pause claims. */
    failuresInRow: integer("failures_in_row").notNull().default(0),
    /** Which of four sandboxes it runs in: moved on after a timeout. */
    sandbox: integer("sandbox").notNull().default(0),
    pausedAt: integer("paused_at"),
    /** 站长's 停用. */
    stoppedAt: integer("stopped_at"),
    stoppedByUserId: text("stopped_by_user_id").references(() => users.id),
    code: text("code"),
    seed: text("seed"),
    revealedAt: integer("revealed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check(
      "activity_code_shape",
      sql`${table.protocol} = 1 AND length(${table.fingerprint}) = 64 AND length(${table.testsDigest}) = 64
        AND length(${table.prompt}) <= 40
        AND typeof(${table.minEachMinor}) = 'integer' AND ${table.minEachMinor} > 0
        AND (${table.seedCommitment} IS NULL) = (${table.seedCiphertext} IS NULL)
        AND (${table.seedCommitment} IS NULL OR length(${table.seedCommitment}) = 64)
        AND typeof(${table.failuresInRow}) = 'integer' AND ${table.failuresInRow} BETWEEN 0 AND 5
        AND typeof(${table.sandbox}) = 'integer' AND ${table.sandbox} BETWEEN 0 AND 3
        AND (${table.stoppedAt} IS NULL) = (${table.stoppedByUserId} IS NULL)
        AND (${table.code} IS NULL) = (${table.revealedAt} IS NULL)
        AND (${table.seed} IS NULL) = (${table.revealedAt} IS NULL)
        AND (${table.seed} IS NULL OR length(${table.seed}) = 64)`,
    ),
  ],
);

/**
 * One judgment: a claimant's submission and what the code answered. Inputs
 * are in attempt_events, as for 口令. Written once.
 */
export const codeJudgments = sqliteTable(
  "code_judgments",
  {
    submissionRowId: text("submission_row_id")
      .primaryKey()
      .references(() => redemptionSubmissions.id),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** Times this person was judged before (Submission.user.attempts). */
    attempt: integer("attempt").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    /** What the code asked, what is paid (pulled into the share's range). */
    askedMinor: integer("asked_minor"),
    paidMinor: integer("paid_minor"),
    note: text("note", { enum: ["floor", "cap", "last"] }),
    message: text("message"),
    /** The state it set, if it set one (encrypted JSON). */
    stateCiphertext: text("state_ciphertext"),
    /** Submission.now. */
    judgedAt: integer("judged_at").notNull(),
  },
  (table) => [
    uniqueIndex("code_judgments_attempt_unique").on(
      table.activityId,
      table.userId,
      table.attempt,
    ),
    index("code_judgments_activity_time_idx").on(
      table.activityId,
      table.judgedAt,
    ),
    check(
      "code_judgments_shape",
      sql`typeof(${table.attempt}) = 'integer' AND ${table.attempt} >= 0
        AND (${table.message} IS NULL OR length(${table.message}) BETWEEN 1 AND 100)
        AND ((${table.ok} = 1 AND typeof(${table.askedMinor}) = 'integer'
            AND typeof(${table.paidMinor}) = 'integer' AND ${table.paidMinor} > 0
            AND (${table.note} IS NULL OR ${table.note} IN ('floor','cap','last')))
          OR (${table.ok} = 0 AND ${table.askedMinor} IS NULL AND ${table.paidMinor} IS NULL AND ${table.note} IS NULL))`,
    ),
  ],
);

/** A judgment the code failed: for its sender, who is told after five in a row. */
export const codeFailures = sqliteTable(
  "code_failures",
  {
    id: text("id").primaryKey(),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind", {
      enum: ["threw", "timeout", "invalid", "memory"],
    }).notNull(),
    detail: text("detail").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("code_failures_activity_time_idx").on(
      table.activityId,
      table.createdAt,
    ),
  ],
);

/** 在线检查: one run of a sender's code and tests, counted per day. */
export const judgeChecks = sqliteTable(
  "judge_checks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    protocol: integer("protocol").notNull(),
    fingerprint: text("fingerprint").notNull(),
    testsDigest: text("tests_digest").notNull(),
    passed: integer("passed", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("judge_checks_user_time_idx").on(table.userId, table.createdAt),
    index("judge_checks_user_code_idx").on(
      table.userId,
      table.fingerprint,
      table.testsDigest,
    ),
  ],
);
