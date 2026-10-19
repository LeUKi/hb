import { relations, sql } from "drizzle-orm";
import {
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
    rewardType: text("reward_type", { enum: ["text", "ldc"] })
      .notNull()
      .default("text"),
    forceDedicated: integer("force_dedicated", { mode: "boolean" }).notNull(),
    participationMode: text("participation_mode", {
      enum: ["password", "direct"],
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
      enum: ["password", "direct"],
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
    source: text("source", { enum: ["claim", "acceptance"] })
      .notNull()
      .default("claim"),
    acceptanceId: text("acceptance_id").references(() => paymentAcceptances.id),
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
    recoveryPolicy: text("recovery_policy", { enum: ["claim_same_order_v1"] }),
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
    check(
      "payment_tasks_source_valid",
      sql`(${table.source} = 'claim' AND ${table.claimId} IS NOT NULL AND ${table.acceptanceId} IS NULL) OR (${table.source} = 'acceptance' AND ${table.claimId} IS NULL AND ${table.acceptanceId} IS NOT NULL AND ${table.mode} = 'real')`,
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

// 站内🐟额 (docs/balance-design.md). Every change to someone's 🐟额 is an
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
    allowlistEnabled: integer("allowlist_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    /** Community IDs, a JSON array of strings. */
    allowlist: text("allowlist").notNull().default("[]"),
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
    check(
      "balance_settings_allowlist_valid",
      sql`json_valid(${table.allowlist}) AND json_type(${table.allowlist}) = 'array'`,
    ),
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
    /** First time Credit gave back its cashier: “去 Credit 确认” lasts 10 minutes from here. */
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
    kind: text("kind", {
      enum: ["topup", "adjustment", "lock", "unlock", "deduct"],
    }).notNull(),
    availableDeltaMinor: integer("available_delta_minor").notNull(),
    lockedDeltaMinor: integer("locked_delta_minor").notNull().default(0),
    topupId: text("topup_id").references(() => balanceTopups.id),
    adjustmentId: text("adjustment_id").references(() => balanceAdjustments.id),
    /** A lock (转出, later 🐟 红包); its table comes with 转出. */
    lockId: text("lock_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("balance_entries_topup_unique")
      .on(table.topupId)
      .where(sql`${table.kind} = 'topup'`),
    uniqueIndex("balance_entries_adjustment_unique")
      .on(table.adjustmentId)
      .where(sql`${table.kind} = 'adjustment'`),
    index("balance_entries_user_time_idx").on(
      table.userId,
      table.createdAt,
      table.id,
    ),
    check(
      "balance_entries_shape_valid",
      sql`(${table.kind} = 'topup' AND ${table.topupId} IS NOT NULL AND ${table.availableDeltaMinor} > 0 AND ${table.lockedDeltaMinor} = 0)
        OR (${table.kind} = 'adjustment' AND ${table.adjustmentId} IS NOT NULL AND ${table.availableDeltaMinor} != 0 AND ${table.lockedDeltaMinor} = 0)
        OR (${table.kind} = 'lock' AND ${table.lockId} IS NOT NULL AND ${table.availableDeltaMinor} < 0 AND ${table.lockedDeltaMinor} = -${table.availableDeltaMinor})
        OR (${table.kind} = 'unlock' AND ${table.lockId} IS NOT NULL AND ${table.availableDeltaMinor} > 0 AND ${table.lockedDeltaMinor} = -${table.availableDeltaMinor})
        OR (${table.kind} = 'deduct' AND ${table.lockId} IS NOT NULL AND ${table.availableDeltaMinor} = 0 AND ${table.lockedDeltaMinor} < 0)`,
    ),
  ],
);
