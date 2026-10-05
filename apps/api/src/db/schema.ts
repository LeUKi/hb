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
  ],
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
    passwordId: text("password_id")
      .notNull()
      .references(() => activityPasswords.id),
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
    passwordId: text("password_id")
      .notNull()
      .references(() => activityPasswords.id),
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
      .where(sql`${table.usageStatus} = 'current'`),
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
