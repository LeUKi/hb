import {
  type AdminActivityDetail,
  type AdminActivityListItem,
  type AdminAuditEntry,
  type AdminCursorList,
  type AdminOverview,
  type AdminPaymentAttempt,
  type AdminPaymentDetail,
  type AdminPaymentListItem,
  type AdminUserDetail,
  type AdminUserListItem,
  type AttemptRateLimitChange,
  type AttemptRateLimits,
  type AttemptRateLimitsResponse,
  adminActivitiesQuerySchema,
  adminActivityStatusSchema,
  adminAuditQuerySchema,
  adminAuditTypeSchema,
  adminPageSize,
  adminPaymentDetailQuerySchema,
  adminPaymentModeSchema,
  adminPaymentStatusSchema,
  adminPaymentsQuerySchema,
  adminRewardTypeSchema,
  adminUserStateSchema,
  adminUsersQuerySchema,
  adminUserTierSchema,
  decodeActivityEmoji,
  formatAmount,
  normalizeActivityUuid,
  normalizeTopicLink,
  updateAttemptRateLimitsSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type { z } from "zod";
import { ActivityError } from "../activities/errors";
import { activityListStatusCaseSql } from "../activities/history-query";
import { databaseNow } from "../activities/lifecycle";
import { ActivityValidationError } from "../activities/routes";
import { assertCsrf, requireAdmin } from "../auth/session";
import type { ApiBindings, ApiContext } from "../env";
import {
  allowsRealClaim,
  allowsRealOpening,
  allowsRealSending,
  readPlatformControls,
} from "../runtime/controls";
import {
  ADMIN_DIAGNOSTIC_THRESHOLDS,
  ADMIN_RUNTIME_BLOCKERS,
  isAdminMaintenanceStale,
} from "./diagnostics";

type BindValue = string | number | null;
type Cursor = { createdAt: number; id: string };
type AuditCursor = Cursor & { type: AdminAuditEntry["type"] };

function asInt(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function firstBatchRow(
  result: { results?: unknown[] } | undefined,
  name: string,
): Record<string, unknown> {
  const row = result?.results?.[0];
  if (!row || typeof row !== "object")
    throw new Error(`Missing admin overview response: ${name}`);
  return row as Record<string, unknown>;
}

function encodeCursor(row: Cursor | undefined) {
  return row ? `${row.createdAt}:${row.id}` : null;
}

function parseCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  const match =
    /^(\d{1,16}):([A-Za-z0-9_-][A-Za-z0-9_-]{0,100}|[a-f0-9-]{36})$/i.exec(
      value,
    );
  if (!match) throw new ActivityError(400, "INVALID_CURSOR", "分页游标无效。");
  const createdAt = Number(match[1]);
  if (!Number.isSafeInteger(createdAt))
    throw new ActivityError(400, "INVALID_CURSOR", "分页游标无效。");
  return { createdAt, id: match[2] ?? "" };
}

function encodeAuditCursor(row: AuditCursor | undefined) {
  return row ? `${row.createdAt}:${row.type}:${row.id}` : null;
}

function parseAuditCursor(value: string | undefined): AuditCursor | null {
  if (!value) return null;
  const match =
    /^(\d{1,16}):(login_settings|attempt_rate_limits):([A-Za-z0-9_-][A-Za-z0-9_-]{0,100}|[a-f0-9-]{36})$/.exec(
      value,
    );
  if (!match) throw new ActivityError(400, "INVALID_CURSOR", "分页游标无效。");
  const createdAt = Number(match[1]);
  if (!Number.isSafeInteger(createdAt))
    throw new ActivityError(400, "INVALID_CURSOR", "分页游标无效。");
  return {
    createdAt,
    type: match[2] as AdminAuditEntry["type"],
    id: match[3] ?? "",
  };
}

function parseAdminQuery<T extends z.ZodType>(
  schema: T,
  query: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(query);
  if (parsed.success) return parsed.data;
  throw new ActivityValidationError(
    parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}

function parseFilter<T extends z.ZodType>(
  schema: T,
  value: unknown,
  path: string,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ActivityValidationError([
    { path, message: parsed.error.issues[0]?.message ?? "筛选条件无效" },
  ]);
}

function parseOptionalSafeInt(
  value: string | number | undefined,
  path: string,
) {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new ActivityValidationError([{ path, message: "日期筛选无效" }]);
  return number;
}

function like(value: string) {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function parseActivitySearch(value: string, origin?: string) {
  const q = value.trim();
  if (!q) return { kind: "empty" as const };
  const uuid = normalizeActivityUuid(q) ?? decodeActivityEmoji(q);
  if (uuid) return { kind: "activity" as const, id: uuid };
  const topic = normalizeTopicLink(q);
  if (topic) return { kind: "topic" as const, ...topic };
  try {
    const url = new URL(q);
    if (
      origin &&
      url.origin === new URL(origin).origin &&
      !url.username &&
      !url.password
    ) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "activities" && parts.length === 2) {
        const id = normalizeActivityUuid(parts[1] ?? "");
        if (id) return { kind: "activity" as const, id };
      }
      if (parts[0] === "e" && parts.length === 2) {
        const id = decodeActivityEmoji(decodeURIComponent(parts[1] ?? ""));
        if (id) return { kind: "activity" as const, id };
      }
    }
  } catch {
    // Plain names fall through to substring search.
  }
  return { kind: "title" as const, title: q };
}

function appendCursor(
  where: string[],
  values: BindValue[],
  cursor: Cursor | null,
  alias = "",
) {
  if (!cursor) return;
  const prefix = alias ? `${alias}.` : "";
  where.push(
    `(${prefix}created_at < ? OR (${prefix}created_at = ? AND ${prefix}id < ?))`,
  );
  values.push(cursor.createdAt, cursor.createdAt, cursor.id);
}

function nextCursor<T extends Cursor>(items: T[]) {
  return items.length > adminPageSize
    ? encodeCursor(items[adminPageSize - 1])
    : null;
}

function page<T>(items: T[]) {
  return items.slice(0, adminPageSize);
}

// Match SQLite's fixed BINARY order when merging two audit sources.
function compareDescending(left: string, right: string) {
  return left === right ? 0 : left > right ? -1 : 1;
}

function readConfig(env: ApiBindings): Promise<AttemptRateLimitsResponse> {
  return env.DB.batch([
    env.DB.prepare(`SELECT version, home_interval_seconds AS homeIntervalSeconds,
      activity_interval_seconds AS activityIntervalSeconds, updated_at AS updatedAt,
      updated_by_user_id AS updatedByUserId FROM attempt_rate_limits WHERE id='global'`),
    env.DB.prepare(`SELECT c.id, c.actor_user_id AS actorUserId,
      COALESCE(u.display_name,c.actor_user_id) AS actorDisplayName,
      c.previous_version AS previousVersion, c.next_version AS nextVersion,
      c.previous_home_interval_seconds AS previousHomeIntervalSeconds,
      c.home_interval_seconds AS homeIntervalSeconds,
      c.previous_activity_interval_seconds AS previousActivityIntervalSeconds,
      c.activity_interval_seconds AS activityIntervalSeconds, c.created_at AS createdAt
      FROM attempt_rate_limit_changes c LEFT JOIN users u ON u.id=c.actor_user_id
      ORDER BY c.created_at DESC,c.id DESC LIMIT 20`),
  ]).then(([configResult, changesResult]) => {
    if (!configResult || !changesResult)
      throw new Error("Missing rate configuration response");
    const config = configResult.results[0] as AttemptRateLimits | undefined;
    if (!config) throw new Error("Missing attempt rate configuration");
    return {
      config,
      recentChanges: changesResult.results as AttemptRateLimitChange[],
    };
  });
}

async function overview(env: ApiBindings): Promise<AdminOverview> {
  const now = Date.now();
  const controls = await readPlatformControls(env);
  const [
    counts,
    stalePayments,
    unknownPayments,
    attentionPayments,
    drawBacklog,
    outboxOverdue,
    outboxTotal,
    byMode,
    maintenance,
  ] = await env.DB.batch([
    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM activities WHERE reward_type='ldc' AND deleted_at IS NULL) AS activities,
      (SELECT COUNT(*) FROM payment_tasks) AS payments,
      (SELECT COUNT(*) FROM payment_tasks WHERE status!='confirmed') AS unconfirmedPayments`),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM payment_tasks WHERE status!='confirmed' AND created_at<=?",
    ).bind(now - ADMIN_DIAGNOSTIC_THRESHOLDS.paymentWaitMs - 1),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM payment_tasks WHERE unknown_outcome=1",
    ),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM payment_tasks WHERE status='attention'",
    ),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM activities
      WHERE reward_type='ldc' AND deleted_at IS NULL AND draw_state IN ('waiting','settling')
        AND COALESCE(draw_closed_at,deadline,created_at)<=?`).bind(
      now - ADMIN_DIAGNOSTIC_THRESHOLDS.drawWaitMs - 1,
    ),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM payment_outbox WHERE delivered_at IS NULL AND created_at<=?",
    ).bind(now - ADMIN_DIAGNOSTIC_THRESHOLDS.outboxWaitMs - 1),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM payment_outbox WHERE delivered_at IS NULL",
    ),
    env.DB.prepare(`SELECT mode,status,COUNT(*) AS count,
      MAX(CAST((? - created_at)/1000 AS INTEGER)) AS oldestAgeSeconds
      FROM payment_tasks WHERE status!='confirmed'
      GROUP BY mode,status ORDER BY mode,status`).bind(now),
    env.DB.prepare(
      "SELECT job,scheduled_at,started_at,finished_at,status,reason FROM maintenance_runs ORDER BY job",
    ),
  ]);
  const countRow = firstBatchRow(counts, "counts");
  const stalePaymentRow = firstBatchRow(stalePayments, "stalePayments");
  const unknownPaymentRow = firstBatchRow(unknownPayments, "unknownPayments");
  const attentionPaymentRow = firstBatchRow(
    attentionPayments,
    "attentionPayments",
  );
  const drawBacklogRow = firstBatchRow(drawBacklog, "drawBacklog");
  const outboxOverdueRow = firstBatchRow(outboxOverdue, "outboxOverdue");
  const outboxTotalRow = firstBatchRow(outboxTotal, "outboxTotal");
  const maintenanceRows = (maintenance?.results ?? []) as Array<{
    job: string;
    scheduled_at: number;
    started_at: number;
    finished_at: number | null;
    status: "running" | "succeeded" | "failed";
    reason: string | null;
  }>;
  const staleMaintenance = maintenanceRows.filter((row) =>
    isAdminMaintenanceStale(row, now),
  ).length;
  const liveBlockers = [
    ...(env.APP_ENV === "production" ? [] : [ADMIN_RUNTIME_BLOCKERS.appEnv]),
    ...(env.LDC_NETWORK_MODE === "live"
      ? []
      : [ADMIN_RUNTIME_BLOCKERS.ldcNetworkMode]),
  ];
  const sendBlockers = [
    ...liveBlockers,
    ...(env.LDC_STOP_SENDS === "true"
      ? [ADMIN_RUNTIME_BLOCKERS.stopSends]
      : []),
    ...(controls.allowRealSend ? [] : [ADMIN_RUNTIME_BLOCKERS.platformControl]),
  ];
  const openBlockers = [
    ...liveBlockers,
    ...(env.LDC_STOP_NEW_OPENINGS === "true"
      ? [ADMIN_RUNTIME_BLOCKERS.stopOpenings]
      : []),
    ...(controls.allowRealOpen ? [] : [ADMIN_RUNTIME_BLOCKERS.platformControl]),
  ];
  const claimBlockers = [
    ...liveBlockers,
    ...(env.LDC_STOP_NEW_CLAIMS === "true"
      ? [ADMIN_RUNTIME_BLOCKERS.stopClaims]
      : []),
    ...(controls.allowRealClaim
      ? []
      : [ADMIN_RUNTIME_BLOCKERS.platformControl]),
  ];
  const drawBlockers =
    env.LDC_TIMED_DRAW_ENABLED === "true"
      ? []
      : [ADMIN_RUNTIME_BLOCKERS.timedDraw];
  return {
    readAt: now,
    counts: {
      users: asInt(countRow?.users),
      activities: asInt(countRow?.activities),
      payments: {
        total: asInt(countRow?.payments),
        unconfirmed: asInt(countRow?.unconfirmedPayments),
      },
    },
    runtime: {
      environment: env.APP_ENV ?? "unknown",
      realPayments: {
        allowed: allowsRealSending(env, controls),
        blockers: sendBlockers,
      },
      realActivityOpening: {
        allowed: allowsRealOpening(env, controls),
        blockers: openBlockers,
      },
      realClaims: {
        allowed: allowsRealClaim(env, controls),
        blockers: claimBlockers,
      },
      timedDraw: { allowed: !drawBlockers.length, blockers: drawBlockers },
    },
    paymentQueue: {
      backlog: "未接入",
      note: "首版未接入 Cloudflare 队列指标。",
    },
    warnings: {
      stalePayments: asInt(stalePaymentRow.count),
      unknownPayments: asInt(unknownPaymentRow.count),
      attentionPayments: asInt(attentionPaymentRow.count),
      drawBacklog: asInt(drawBacklogRow.count),
      undeliveredPaymentTasks: asInt(outboxTotalRow.count),
      undeliveredPaymentTasksOverdue: asInt(outboxOverdueRow.count),
      staleMaintenance,
    },
    paymentsByMode: (
      (byMode?.results ?? []) as Array<Record<string, unknown>>
    ).map((row) => ({
      mode: row.mode as "simulation" | "real",
      status: String(row.status),
      count: asInt(row.count),
      oldestAgeSeconds:
        row.oldestAgeSeconds === null ? null : asInt(row.oldestAgeSeconds),
    })),
    maintenance: maintenanceRows.map((row) => ({
      job: row.job,
      scheduledAt: row.scheduled_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      reason: row.reason,
      stale: isAdminMaintenanceStale(row, now),
    })),
  };
}

async function listActivities(
  env: ApiBindings,
  query: Record<string, string | undefined>,
): Promise<AdminCursorList<AdminActivityListItem>> {
  const status = parseFilter(
    adminActivityStatusSchema,
    query.status ?? "all",
    "status",
  );
  parseFilter(adminRewardTypeSchema, query.rewardType ?? "all", "rewardType");
  const drawException = query.drawException === "1";
  const cursor = parseCursor(query.cursor);
  const values: BindValue[] = [];
  const where = ["a.reward_type='ldc'", "a.deleted_at IS NULL"];
  const lifecycleSql = activityListStatusCaseSql(Date.now(), "a");
  const search = parseActivitySearch(query.q ?? "", env.APP_ORIGIN);
  if (search.kind === "activity") {
    where.push("a.id=?");
    values.push(search.id);
  } else if (search.kind === "topic") {
    where.push("a.topic_id=? AND a.post_number=?");
    values.push(search.topicId, search.postNumber);
  } else if (search.kind === "title") {
    where.push("a.title LIKE ? ESCAPE '\\'");
    values.push(like(search.title));
  }
  const authorId = (query.authorId ?? "").trim();
  if (authorId) {
    where.push("a.author_id=?");
    values.push(authorId);
  }
  if (status !== "all") {
    where.push(`(${lifecycleSql})=?`);
    values.push(status);
  }
  if (drawException)
    where.push(
      "a.draw_state IN ('waiting','settling') AND COALESCE(a.draw_closed_at,a.deadline,a.created_at)<=?",
    );
  if (drawException)
    values.push(Date.now() - ADMIN_DIAGNOSTIC_THRESHOLDS.drawWaitMs - 1);
  appendCursor(where, values, cursor, "a");
  const rows =
    await env.DB.prepare(`SELECT a.id,a.title,a.author_id,u.display_name AS authorDisplayName,
    a.participation_mode,a.reward_type,a.payment_mode,a.total_count,a.claimed_count,a.registered_count,
    a.draw_state,a.topic_id,a.post_number,a.created_at,a.opened_at,a.ended_at,a.archived_at,
    ${lifecycleSql} AS lifecycle
    FROM activities a JOIN users u ON u.id=a.author_id
    WHERE ${where.join(" AND ")}
    ORDER BY a.created_at DESC,a.id DESC LIMIT ${adminPageSize + 1}`)
      .bind(...values)
      .all<Record<string, unknown>>();
  const items = rows.results.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    authorId: String(row.author_id),
    authorDisplayName: String(row.authorDisplayName),
    participationMode: row.participation_mode as "password" | "direct",
    rewardType: row.reward_type as AdminActivityListItem["rewardType"],
    paymentMode: row.payment_mode as "simulation" | "real" | null,
    lifecycle: row.lifecycle as AdminActivityListItem["lifecycle"],
    totalCount: asInt(row.total_count),
    claimedCount: asInt(row.claimed_count),
    registeredCount: asInt(row.registered_count),
    drawState: row.draw_state as AdminActivityListItem["drawState"],
    topicId: row.topic_id === null ? null : String(row.topic_id),
    postNumber: asInt(row.post_number),
    createdAt: asInt(row.created_at),
    openedAt: row.opened_at === null ? null : asInt(row.opened_at),
    endedAt: row.ended_at === null ? null : asInt(row.ended_at),
    archivedAt: row.archived_at === null ? null : asInt(row.archived_at),
  }));
  return {
    items: page(items),
    nextCursor: nextCursor(items),
    readAt: Date.now(),
  };
}

async function activityDetail(
  env: ApiBindings,
  id: string,
): Promise<{ activity: AdminActivityDetail }> {
  const lifecycleSql = activityListStatusCaseSql(Date.now(), "a");
  const [activity, payments] = await env.DB.batch([
    env.DB.prepare(`SELECT a.id,a.title,a.author_id,u.display_name AS authorDisplayName,
      a.participation_mode,a.reward_type,a.payment_mode,a.total_count,a.claimed_count,a.registered_count,
      a.draw_state,a.topic_id,a.post_number,a.created_at,a.updated_at,a.opened_at,a.deadline,
      a.ended_at,a.end_reason,a.archived_at,a.draw_closed_at,a.draw_published_at,
      ${lifecycleSql} AS lifecycle
      FROM activities a JOIN users u ON u.id=a.author_id
      WHERE a.id=? AND a.reward_type='ldc' AND a.deleted_at IS NULL`).bind(id),
    env.DB.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status!='confirmed' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN status='attention' THEN 1 ELSE 0 END) AS attention,
      SUM(CASE WHEN unknown_outcome=1 THEN 1 ELSE 0 END) AS unknown
      FROM payment_tasks WHERE claim_id IN (SELECT id FROM claims WHERE activity_id=?)`).bind(
      id,
    ),
  ]);
  const row = activity?.results[0] as Record<string, unknown> | undefined;
  if (!row)
    throw new ActivityError(404, "ADMIN_ACTIVITY_NOT_FOUND", "未找到活动。");
  const pay = payments?.results[0] as Record<string, unknown> | undefined;
  return {
    activity: {
      id: String(row.id),
      title: String(row.title),
      authorId: String(row.author_id),
      authorDisplayName: String(row.authorDisplayName),
      participationMode: row.participation_mode as "password" | "direct",
      rewardType: row.reward_type as AdminActivityDetail["rewardType"],
      paymentMode: row.payment_mode as "simulation" | "real" | null,
      lifecycle: row.lifecycle as AdminActivityListItem["lifecycle"],
      totalCount: asInt(row.total_count),
      claimedCount: asInt(row.claimed_count),
      registeredCount: asInt(row.registered_count),
      drawState: row.draw_state as AdminActivityDetail["drawState"],
      topicId: row.topic_id === null ? null : String(row.topic_id),
      postNumber: asInt(row.post_number),
      createdAt: asInt(row.created_at),
      updatedAt: asInt(row.updated_at),
      openedAt: row.opened_at === null ? null : asInt(row.opened_at),
      deadline: row.deadline === null ? null : asInt(row.deadline),
      endedAt: row.ended_at === null ? null : asInt(row.ended_at),
      endReason: row.end_reason === null ? null : String(row.end_reason),
      archivedAt: row.archived_at === null ? null : asInt(row.archived_at),
      drawClosedAt:
        row.draw_closed_at === null ? null : asInt(row.draw_closed_at),
      drawPublishedAt:
        row.draw_published_at === null ? null : asInt(row.draw_published_at),
      payments: {
        total: asInt(pay?.total),
        pending: asInt(pay?.pending),
        confirmed: asInt(pay?.confirmed),
        attention: asInt(pay?.attention),
        unknown: asInt(pay?.unknown),
      },
    },
  };
}

async function listUsers(
  env: ApiBindings,
  query: Record<string, string | undefined>,
): Promise<AdminCursorList<AdminUserListItem>> {
  const tier = parseFilter(adminUserTierSchema, query.tier ?? "all", "tier");
  const state = parseFilter(
    adminUserStateSchema,
    query.state ?? "all",
    "state",
  );
  const cursor = parseCursor(query.cursor);
  const values: BindValue[] = [];
  const where: string[] = [];
  const q = (query.q ?? "").trim();
  if (q) {
    where.push(
      "(id=? OR external_id=? OR username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')",
    );
    values.push(q, q, like(q), like(q));
  }
  if (tier === "standard") where.push("official_connect_verified=1");
  if (tier === "lite") where.push("official_connect_verified=0");
  if (state === "active") where.push("active=1");
  if (state === "disabled") where.push("active=0");
  appendCursor(where, values, cursor);
  const rows =
    await env.DB.prepare(`SELECT id,external_id,username,display_name,avatar_url,
    official_connect_verified,active,created_at,last_login_at FROM users
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC,id DESC LIMIT ${adminPageSize + 1}`)
      .bind(...values)
      .all<Record<string, unknown>>();
  const items = rows.results.map(userListItem);
  return {
    items: page(items),
    nextCursor: nextCursor(items),
    readAt: Date.now(),
  };
}

function userListItem(row: Record<string, unknown>): AdminUserListItem {
  const official =
    row.official_connect_verified === 1 ||
    row.official_connect_verified === true;
  return {
    id: String(row.id),
    externalId: String(row.external_id),
    username: String(row.username),
    displayName: String(row.display_name),
    avatarUrl: row.avatar_url === null ? null : String(row.avatar_url),
    accountTier: official ? "standard" : "lite",
    active: row.active === 1 || row.active === true,
    officialConnectVerified: official,
    createdAt: asInt(row.created_at),
    lastLoginAt: row.last_login_at === null ? null : asInt(row.last_login_at),
  };
}

async function userDetail(
  env: ApiBindings,
  id: string,
): Promise<{ user: AdminUserDetail }> {
  const [user, counts] = await env.DB.batch([
    env.DB.prepare(`SELECT id,external_id,username,display_name,avatar_url,
      official_connect_verified,active,created_at,last_login_at FROM users WHERE id=?`).bind(
      id,
    ),
    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM activities WHERE author_id=? AND reward_type='ldc' AND deleted_at IS NULL) AS authoredActivities,
      (SELECT COUNT(*) FROM claims c JOIN activities a ON a.id=c.activity_id AND a.reward_type='ldc' AND a.deleted_at IS NULL WHERE c.user_id=?) AS claims,
      (SELECT COUNT(*) FROM activity_registrations r JOIN activities a ON a.id=r.activity_id AND a.reward_type='ldc' AND a.deleted_at IS NULL WHERE r.user_id=?) AS registrations,
      (SELECT COUNT(*) FROM merchants WHERE author_id=?) AS merchants,
      (SELECT COUNT(*) FROM payment_tasks WHERE recipient_id IN (
        SELECT external_id FROM users WHERE id=? UNION ALL
        SELECT 'simulation:' || external_id FROM users WHERE id=?
      )) AS paymentTasks`).bind(id, id, id, id, id, id),
  ]);
  const row = user?.results[0] as Record<string, unknown> | undefined;
  if (!row)
    throw new ActivityError(404, "ADMIN_USER_NOT_FOUND", "未找到用户。");
  const count = counts?.results[0] as Record<string, unknown> | undefined;
  return {
    user: {
      ...userListItem(row),
      counts: {
        authoredActivities: asInt(count?.authoredActivities),
        claims: asInt(count?.claims),
        registrations: asInt(count?.registrations),
        merchants: asInt(count?.merchants),
        paymentTasks: asInt(count?.paymentTasks),
      },
    },
  };
}

function paymentFrom(row: Record<string, unknown>): AdminPaymentListItem {
  return {
    id: String(row.id),
    source: row.source as "claim" | "acceptance",
    mode: row.mode as "simulation" | "real",
    status: row.status as AdminPaymentListItem["status"],
    reason: row.reason === null ? null : String(row.reason),
    unknownOutcome: row.unknown_outcome === 1 || row.unknown_outcome === true,
    amount: formatAmount(asInt(row.amount_minor)),
    businessNo: String(row.business_no),
    externalOrderId:
      row.external_order_id === null ? null : String(row.external_order_id),
    activityId: row.activity_id === null ? null : String(row.activity_id),
    activityTitle:
      row.activity_title === null ? null : String(row.activity_title),
    merchantId: String(row.merchant_id),
    merchantLabel:
      row.merchant_label === null ? null : String(row.merchant_label),
    recipientId: String(row.recipient_id),
    recipientUsername:
      row.recipient_username === null ? null : String(row.recipient_username),
    currentRecipientUsername:
      row.current_recipient_username === null
        ? null
        : String(row.current_recipient_username),
    createdAt: asInt(row.created_at),
    nextRunAt: asInt(row.next_run_at),
  };
}

async function listPayments(
  env: ApiBindings,
  query: Record<string, string | undefined>,
): Promise<AdminCursorList<AdminPaymentListItem>> {
  const mode = parseFilter(adminPaymentModeSchema, query.mode ?? "all", "mode");
  const status = parseFilter(
    adminPaymentStatusSchema,
    query.status ?? "all",
    "status",
  );
  const exception = query.exception === "1";
  const cursor = parseCursor(query.cursor);
  const values: BindValue[] = [];
  const where: string[] = [];
  const q = (query.q ?? "").trim();
  if (q) {
    const search = parseActivitySearch(q, env.APP_ORIGIN);
    // A raw UUID can identify a payment, merchant, user or activity. Only an
    // activity link/Emoji code unambiguously narrows the search to an activity.
    const uuid = normalizeActivityUuid(q);
    if (search.kind === "activity" && !uuid) {
      where.push("a.id=?");
      values.push(search.id);
    } else {
      where.push(
        "(p.id=? OR p.business_no=? OR p.external_order_id=? OR p.merchant_id=? OR a.id=? OR u.id=? OR p.recipient_id=?)",
      );
      const identifier = uuid ?? q;
      values.push(
        identifier,
        identifier,
        identifier,
        identifier,
        identifier,
        identifier,
        identifier,
      );
    }
  }
  const authorId = (query.authorId ?? "").trim();
  if (authorId) {
    where.push("m.author_id=?");
    values.push(authorId);
  }
  const activityId = (query.activityId ?? "").trim();
  if (activityId) {
    where.push("a.id=?");
    values.push(activityId);
  }
  const merchantId = (query.merchantId ?? "").trim();
  if (merchantId) {
    where.push("p.merchant_id=?");
    values.push(merchantId);
  }
  const recipientId = (query.recipientId ?? "").trim();
  if (recipientId) {
    where.push("p.recipient_id IN (?,?)");
    values.push(
      recipientId,
      recipientId.startsWith("simulation:")
        ? recipientId
        : `simulation:${recipientId}`,
    );
  }
  if (mode !== "all") {
    where.push("p.mode=?");
    values.push(mode);
  }
  if (status !== "all") {
    where.push("p.status=?");
    values.push(status);
  }
  if (exception) where.push("(p.unknown_outcome=1 OR p.status='attention')");
  if (query.anomaly === "unknown") where.push("p.unknown_outcome=1");
  if (query.anomaly === "attention") where.push("p.status='attention'");
  if (query.anomaly === "overdue") {
    where.push("p.status!='confirmed' AND p.created_at<=?");
    values.push(Date.now() - ADMIN_DIAGNOSTIC_THRESHOLDS.paymentWaitMs - 1);
  }
  if (query.anomaly === "undelivered")
    where.push(
      "EXISTS(SELECT 1 FROM payment_outbox o WHERE o.task_id=p.id AND o.delivered_at IS NULL AND o.created_at<=?)",
    );
  if (query.anomaly === "undelivered")
    values.push(Date.now() - ADMIN_DIAGNOSTIC_THRESHOLDS.outboxWaitMs - 1);
  appendCursor(where, values, cursor, "p");
  const rows =
    await env.DB.prepare(`SELECT p.id,p.source,p.mode,p.status,p.reason,p.unknown_outcome,
    p.amount_minor,p.business_no,p.external_order_id,p.merchant_id,m.label AS merchant_label,
    p.recipient_id,p.recipient_username,u.username AS current_recipient_username,
    p.created_at,p.next_run_at,a.id AS activity_id,a.title AS activity_title
    FROM payment_tasks p
    LEFT JOIN merchants m ON m.id=p.merchant_id
    LEFT JOIN claims c ON c.id=p.claim_id
    LEFT JOIN activities a ON a.id=c.activity_id AND a.reward_type='ldc' AND a.deleted_at IS NULL
    LEFT JOIN users u ON u.provider='linux_do' AND u.external_id=CASE
      WHEN p.mode='simulation' AND p.recipient_id LIKE 'simulation:%'
        THEN substr(p.recipient_id,12) ELSE p.recipient_id END
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY p.created_at DESC,p.id DESC LIMIT ${adminPageSize + 1}`)
      .bind(...values)
      .all<Record<string, unknown>>();
  const items = rows.results.map(paymentFrom);
  return {
    items: page(items),
    nextCursor: nextCursor(items),
    readAt: Date.now(),
  };
}

async function paymentDetail(
  env: ApiBindings,
  id: string,
  attemptsCursor: string | undefined,
): Promise<{ payment: AdminPaymentDetail }> {
  const cursor = parseCursor(attemptsCursor);
  const [payment, attempts] = await env.DB.batch([
    env.DB.prepare(`SELECT p.id,p.source,p.claim_id,p.acceptance_id,p.mode,p.status,p.reason,p.unknown_outcome,
      p.amount_minor,p.business_no,p.external_order_id,p.merchant_id,m.label AS merchant_label,
      p.recipient_id,p.recipient_username,u.username AS current_recipient_username,p.created_at,p.next_run_at,
      p.attempt_count,p.reconciliation_count,p.next_action,p.next_send_at,p.next_query_at,p.send_block_reason,
      p.order_observed_at,p.order_evidence,p.send_acknowledged_at,p.confirmed_at,
      a.id AS activity_id,a.title AS activity_title
      FROM payment_tasks p
      LEFT JOIN merchants m ON m.id=p.merchant_id
      LEFT JOIN claims c ON c.id=p.claim_id
      LEFT JOIN activities a ON a.id=c.activity_id AND a.reward_type='ldc' AND a.deleted_at IS NULL
      LEFT JOIN users u ON u.provider='linux_do' AND u.external_id=CASE
        WHEN p.mode='simulation' AND p.recipient_id LIKE 'simulation:%'
          THEN substr(p.recipient_id,12) ELSE p.recipient_id END
      WHERE p.id=?`).bind(id),
    env.DB.prepare(`SELECT id,operation,outcome,reason,http_status,purpose,credential_version,started_at,finished_at
      FROM payment_attempts WHERE task_id=?
      ${cursor ? "AND (started_at < ? OR (started_at = ? AND id < ?))" : ""}
      ORDER BY started_at DESC,id DESC LIMIT ${adminPageSize + 1}`).bind(
      id,
      ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
    ),
  ]);
  const row = payment?.results[0] as Record<string, unknown> | undefined;
  if (!row)
    throw new ActivityError(404, "ADMIN_PAYMENT_NOT_FOUND", "未找到付款。");
  const attemptItems = (
    (attempts?.results ?? []) as Array<Record<string, unknown>>
  ).map((attempt): AdminPaymentAttempt & Cursor => ({
    id: String(attempt.id),
    operation: attempt.operation as "send" | "query",
    outcome: attempt.outcome as AdminPaymentAttempt["outcome"],
    reason: attempt.reason === null ? null : String(attempt.reason),
    httpStatus:
      attempt.http_status === null ? null : asInt(attempt.http_status),
    purpose: attempt.purpose as "recovery" | "probe",
    credentialVersion: asInt(attempt.credential_version),
    startedAt: asInt(attempt.started_at),
    createdAt: asInt(attempt.started_at),
    finishedAt:
      attempt.finished_at === null ? null : asInt(attempt.finished_at),
  }));
  const base = paymentFrom(row);
  return {
    payment: {
      ...base,
      claimId: row.claim_id === null ? null : String(row.claim_id),
      acceptanceId:
        row.acceptance_id === null ? null : String(row.acceptance_id),
      attemptCount: asInt(row.attempt_count),
      reconciliationCount: asInt(row.reconciliation_count),
      nextAction: row.next_action as "query" | "send" | "none",
      nextSendAt: row.next_send_at === null ? null : asInt(row.next_send_at),
      nextQueryAt: row.next_query_at === null ? null : asInt(row.next_query_at),
      sendBlockReason:
        row.send_block_reason === null ? null : String(row.send_block_reason),
      orderObservedAt:
        row.order_observed_at === null ? null : asInt(row.order_observed_at),
      orderEvidence: row.order_evidence as
        | "receipt"
        | "query"
        | "duplicate"
        | null,
      sendAcknowledgedAt:
        row.send_acknowledged_at === null
          ? null
          : asInt(row.send_acknowledged_at),
      confirmedAt: row.confirmed_at === null ? null : asInt(row.confirmed_at),
      attempts: page(attemptItems),
      nextAttemptsCursor: nextCursor(attemptItems),
    },
  };
}

async function audit(
  env: ApiBindings,
  query: z.infer<typeof adminAuditQuerySchema>,
): Promise<AdminCursorList<AdminAuditEntry>> {
  const type = parseFilter(adminAuditTypeSchema, query.type ?? "all", "type");
  const actor = (query.actorUserId ?? query.actor ?? "").trim();
  const cursor = parseAuditCursor(query.cursor);
  const actorWhere = actor
    ? "AND (c.actor_user_id=? OR u.display_name LIKE ? ESCAPE '\\')"
    : "";
  const actorValues = actor ? [actor, like(actor)] : [];
  const from = parseOptionalSafeInt(query.from, "from");
  const to = parseOptionalSafeInt(query.to, "to");
  const dateWhere = [
    from === null ? "" : "AND c.created_at>=?",
    to === null ? "" : "AND c.created_at<=?",
  ]
    .filter(Boolean)
    .join(" ");
  const dateValues = [
    ...(from === null ? [] : [from]),
    ...(to === null ? [] : [to]),
  ];
  function cursorWhere(source: AdminAuditEntry["type"]) {
    if (!cursor) return { sql: "", values: [] as BindValue[] };
    return {
      sql: `AND (c.created_at<? OR (c.created_at=? AND (? < ? OR (? = ? AND c.id<?))))`,
      values: [
        cursor.createdAt,
        cursor.createdAt,
        source,
        cursor.type,
        source,
        cursor.type,
        cursor.id,
      ] satisfies BindValue[],
    };
  }
  const loginCursor = cursorWhere("login_settings");
  const rateCursor = cursorWhere("attempt_rate_limits");
  const login =
    type === "all" || type === "login_settings"
      ? env.DB.prepare(`SELECT 'login_settings' AS type,c.id,c.actor_user_id,u.display_name AS actorDisplayName,
        c.previous_version,c.next_version,c.previous_liteauth_enabled,c.liteauth_enabled,
        NULL AS previous_home_interval_seconds,NULL AS home_interval_seconds,
        NULL AS previous_activity_interval_seconds,NULL AS activity_interval_seconds,c.created_at
        FROM login_setting_changes c LEFT JOIN users u ON u.id=c.actor_user_id
        WHERE 1=1 ${dateWhere} ${actorWhere} ${loginCursor.sql}
        ORDER BY c.created_at DESC,c.id DESC LIMIT ${adminPageSize + 1}`).bind(
          ...dateValues,
          ...actorValues,
          ...loginCursor.values,
        )
      : null;
  const rates =
    type === "all" || type === "attempt_rate_limits"
      ? env.DB.prepare(`SELECT 'attempt_rate_limits' AS type,c.id,c.actor_user_id,u.display_name AS actorDisplayName,
        c.previous_version,c.next_version,NULL AS previous_liteauth_enabled,NULL AS liteauth_enabled,
        c.previous_home_interval_seconds,c.home_interval_seconds,
        c.previous_activity_interval_seconds,c.activity_interval_seconds,c.created_at
        FROM attempt_rate_limit_changes c LEFT JOIN users u ON u.id=c.actor_user_id
        WHERE 1=1 ${dateWhere} ${actorWhere} ${rateCursor.sql}
        ORDER BY c.created_at DESC,c.id DESC LIMIT ${adminPageSize + 1}`).bind(
          ...dateValues,
          ...actorValues,
          ...rateCursor.values,
        )
      : null;
  const results = await Promise.all([
    login?.all<Record<string, unknown>>(),
    rates?.all<Record<string, unknown>>(),
  ]);
  const items = results
    .flatMap((result) => result?.results ?? [])
    .sort(
      (a, b) =>
        asInt(b.created_at) - asInt(a.created_at) ||
        compareDescending(String(a.type), String(b.type)) ||
        compareDescending(String(a.id), String(b.id)),
    )
    .map((row): AdminAuditEntry & Cursor => {
      const auditType = row.type as "login_settings" | "attempt_rate_limits";
      return {
        id: String(row.id),
        type: auditType,
        actorUserId: String(row.actor_user_id),
        actorDisplayName:
          row.actorDisplayName === null
            ? String(row.actor_user_id)
            : String(row.actorDisplayName),
        previousVersion: asInt(row.previous_version),
        nextVersion: asInt(row.next_version),
        before:
          auditType === "login_settings"
            ? { liteauthEnabled: row.previous_liteauth_enabled === 1 }
            : {
                homeIntervalSeconds: asInt(row.previous_home_interval_seconds),
                activityIntervalSeconds: asInt(
                  row.previous_activity_interval_seconds,
                ),
              },
        after:
          auditType === "login_settings"
            ? { liteauthEnabled: row.liteauth_enabled === 1 }
            : {
                homeIntervalSeconds: asInt(row.home_interval_seconds),
                activityIntervalSeconds: asInt(row.activity_interval_seconds),
              },
        createdAt: asInt(row.created_at),
      };
    });
  const pageItems = page(items);
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    nextCursor:
      items.length > adminPageSize && last
        ? encodeAuditCursor({
            createdAt: last.createdAt,
            type: last.type,
            id: last.id,
          })
        : null,
    readAt: Date.now(),
  };
}

export const adminRoutes = new Hono<ApiContext>()
  .use("/admin/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await requireAdmin(c);
    await next();
  })
  .get("/admin/overview", async (c) => c.json(await overview(c.env)))
  .get("/admin/activities", async (c) =>
    c.json(
      await listActivities(
        c.env,
        parseAdminQuery(adminActivitiesQuerySchema, c.req.query()),
      ),
    ),
  )
  .get("/admin/activities/:id", async (c) =>
    c.json(await activityDetail(c.env, c.req.param("id"))),
  )
  .get("/admin/users", async (c) =>
    c.json(
      await listUsers(
        c.env,
        parseAdminQuery(adminUsersQuerySchema, c.req.query()),
      ),
    ),
  )
  .get("/admin/users/:id", async (c) =>
    c.json(await userDetail(c.env, c.req.param("id"))),
  )
  .get("/admin/payments", async (c) =>
    c.json(
      await listPayments(
        c.env,
        parseAdminQuery(adminPaymentsQuerySchema, c.req.query()),
      ),
    ),
  )
  .get(
    "/admin/payments/:id",
    validator("query", (query) =>
      parseAdminQuery(adminPaymentDetailQuerySchema, query),
    ),
    async (c) =>
      c.json(
        await paymentDetail(
          c.env,
          c.req.param("id"),
          c.req.valid("query").attemptsCursor,
        ),
      ),
  )
  .get("/admin/audit", async (c) =>
    c.json(
      await audit(c.env, parseAdminQuery(adminAuditQuerySchema, c.req.query())),
    ),
  )
  .get("/admin/rate-limits", async (c) => c.json(await readConfig(c.env)))
  .patch("/admin/rate-limits", async (c) => {
    const session = await requireAdmin(c);
    assertCsrf(c, session);
    const input = updateAttemptRateLimitsSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      throw new ActivityValidationError(
        input.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    const { expectedVersion, homeIntervalSeconds, activityIntervalSeconds } =
      input.data;
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`SELECT json(CASE WHEN EXISTS(
          SELECT 1 FROM attempt_rate_limits WHERE id='global' AND version=?
        ) THEN '{}' ELSE '' END)`).bind(expectedVersion),
        c.env.DB.prepare(`INSERT INTO attempt_rate_limit_changes
          (id,actor_user_id,previous_version,next_version,previous_home_interval_seconds,
          home_interval_seconds,previous_activity_interval_seconds,activity_interval_seconds,created_at)
          SELECT ?,?,version,version+1,home_interval_seconds,?,activity_interval_seconds,?,${databaseNow}
          FROM attempt_rate_limits WHERE id='global'`).bind(
          crypto.randomUUID(),
          session.user.id,
          homeIntervalSeconds,
          activityIntervalSeconds,
        ),
        c.env.DB.prepare(`UPDATE attempt_rate_limits SET version=version+1,
          home_interval_seconds=?,activity_interval_seconds=?,updated_at=${databaseNow},updated_by_user_id=?
          WHERE id='global' AND version=?`).bind(
          homeIntervalSeconds,
          activityIntervalSeconds,
          session.user.id,
          expectedVersion,
        ),
      ]);
    } catch (error) {
      const current = await readConfig(c.env);
      if (current.config.version !== expectedVersion)
        throw new ActivityError(
          409,
          "RATE_LIMIT_CONFIG_CONFLICT",
          "网站设置已发生变化，请刷新后再试。当前输入已保留。",
        );
      throw error;
    }
    return c.json(await readConfig(c.env));
  });
