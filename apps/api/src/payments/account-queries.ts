import {
  type AccountPayment,
  type AccountPaymentDetail,
  type AccountPaymentFilter,
  type AccountPaymentGroup,
  type AccountPaymentList,
  type AccountPaymentSummary,
  formatAmount,
  type PaymentState,
} from "@hb/contracts";
import { inArray } from "drizzle-orm";
import { ActivityError, invalidActivity } from "../activities/errors";
import { activityListFields } from "../activities/history-query";
import { projectActivitySummary } from "../activities/service";
import { createDb } from "../db/client";
import { activities } from "../db/schema";
import type { ApiBindings } from "../env";
import { getMerchant } from "./merchants";
import { merchantPaymentDetail } from "./queries";

// /payments and /payments/<id> (redesign 07 §8): every payment of the
// account's 红包, across its merchants, grouped by 红包.

type Cursor = { g: number; a: string; t: number; id: string; scope: string };

function parseCursor(value: string | undefined, scope: string) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(atob(value)) as Cursor;
    if (
      !Number.isSafeInteger(parsed.g) ||
      !Number.isSafeInteger(parsed.t) ||
      typeof parsed.a !== "string" ||
      typeof parsed.id !== "string" ||
      parsed.scope !== scope
    )
      invalidActivity("分页标识无效");
    return parsed;
  } catch {
    invalidActivity("分页标识无效");
  }
}

/** The account's payments: claims of its own LDC 红包, paid by their merchant. */
// The unary + keeps D1 off payment_tasks' merchant index, which would read
// every payment of the merchant once per 红包: the plan goes author → 红包 →
// claim → payment instead (docs/redesign/06 §12).
function scopeSql(activityId: string | undefined) {
  return `p.source='claim' AND a.author_id=? AND a.reward_type='ldc'
    AND a.deleted_at IS NULL AND +p.merchant_id=a.merchant_id${activityId ? " AND a.id=?" : ""}`;
}

type Row = {
  id: string;
  mode: "simulation" | "real";
  status: PaymentState;
  reason: string | null;
  confirmed_at: number | null;
  amount_minor: number;
  business_no: string;
  external_order_id: string | null;
  created_at: number;
  next_run_at: number;
  claim_id: string;
  activity_id: string;
  merchant_id: string;
  group_at: number;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

function paymentOf(row: Row): AccountPayment {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    reason: row.reason,
    confirmedAt:
      row.confirmed_at === null
        ? null
        : new Date(row.confirmed_at).toISOString(),
    amount: formatAmount(row.amount_minor),
    businessNo: row.business_no,
    externalOrderId: row.external_order_id,
    createdAt: new Date(row.created_at).toISOString(),
    nextRunAt: new Date(row.next_run_at).toISOString(),
    source: "claim",
    claimId: row.claim_id,
    activityId: row.activity_id,
    acceptanceId: null,
    merchantId: row.merchant_id,
    recipientProfile: {
      username: row.username ?? "",
      displayName: row.display_name ?? row.username ?? "",
      avatarUrl: row.avatar_url,
    },
  };
}

async function summaryOf(
  env: ApiBindings,
  authorId: string,
  activityId: string | undefined,
): Promise<AccountPaymentSummary> {
  const binds = activityId ? [authorId, activityId] : [authorId];
  const [totals, repairable] = await env.DB.batch([
    env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN p.status='confirmed' THEN p.amount_minor ELSE 0 END),0) AS confirmedMinor,
      COALESCE(SUM(CASE WHEN p.status='confirmed' THEN 1 ELSE 0 END),0) AS confirmedCount,
      COALESCE(SUM(CASE WHEN p.status NOT IN ('confirmed','failed') THEN p.amount_minor ELSE 0 END),0) AS openMinor,
      COALESCE(SUM(CASE WHEN p.status NOT IN ('confirmed','failed') THEN 1 ELSE 0 END),0) AS openCount,
      COALESCE(SUM(CASE WHEN p.status='attention' THEN 1 ELSE 0 END),0) AS attentionCount,
      COALESCE(SUM(CASE WHEN p.status='failed' THEN 1 ELSE 0 END),0) AS failedCount
      FROM payment_tasks p JOIN claims c ON c.id=p.claim_id JOIN activities a ON a.id=c.activity_id
      WHERE ${scopeSql(activityId)}`).bind(...binds),
    // The same rule as the detail's canRepairCredentials: an unconfirmed
    // real payment whose order's Client ID is no longer the merchant's,
    // and whose key for it was rejected.
    env.DB.prepare(`WITH effective AS (
        SELECT p.id, p.created_at, p.merchant_id,
          COALESCE((SELECT i.corrected_client_id FROM payment_identity_corrections i
            WHERE i.task_id=p.id ORDER BY i.version DESC LIMIT 1), p.client_id) AS client_id
        FROM payment_tasks p JOIN claims c ON c.id=p.claim_id JOIN activities a ON a.id=c.activity_id
        WHERE ${scopeSql(activityId)} AND +p.mode='real' AND p.status NOT IN ('confirmed','failed')
      ), latest AS (
        SELECT e.id, e.created_at, e.client_id, m.client_id AS current_client_id,
          (SELECT cr.verification_status || ':' || COALESCE(cr.verification_reason,'')
            FROM merchant_credentials cr WHERE cr.merchant_id=e.merchant_id AND cr.client_id=e.client_id
            ORDER BY cr.version DESC LIMIT 1) AS verification
        FROM effective e JOIN merchants m ON m.id=e.merchant_id
      )
      SELECT id FROM latest WHERE client_id<>current_client_id AND verification='rejected:credentials'
      ORDER BY created_at DESC, id DESC`).bind(...binds),
  ]);
  const row = totals?.results[0] as
    | {
        confirmedMinor: number;
        confirmedCount: number;
        openMinor: number;
        openCount: number;
        attentionCount: number;
        failedCount: number;
      }
    | undefined;
  const ids = (repairable?.results ?? []) as { id: string }[];
  return {
    confirmedAmount: formatAmount(Number(row?.confirmedMinor ?? 0)),
    confirmedCount: Number(row?.confirmedCount ?? 0),
    openAmount: formatAmount(Number(row?.openMinor ?? 0)),
    openCount: Number(row?.openCount ?? 0),
    attentionCount: Number(row?.attentionCount ?? 0),
    failedCount: Number(row?.failedCount ?? 0),
    repairableCount: ids.length,
    firstRepairableId: ids[0]?.id ?? null,
  };
}

export async function listAccountPayments(
  env: ApiBindings,
  authorId: string,
  filter: AccountPaymentFilter = "all",
  activityId?: string,
  cursorValue?: string,
): Promise<AccountPaymentList> {
  const scope = `account-payments:${authorId}:${activityId ?? "*"}:${filter}`;
  const after = parseCursor(cursorValue, scope);
  const binds: (string | number)[] = activityId
    ? [authorId, activityId]
    : [authorId];
  const status =
    filter === "confirmed"
      ? "AND m.status='confirmed'"
      : filter === "open"
        ? "AND m.status NOT IN ('confirmed','failed')"
        : filter === "failed"
          ? "AND m.status='failed'"
          : "";
  const page = after
    ? `AND (m.group_at<? OR (m.group_at=? AND (m.activity_id<? OR (m.activity_id=? AND (m.created_at<? OR (m.created_at=? AND m.id<?))))))`
    : "";
  const pageBinds = after
    ? [after.g, after.g, after.a, after.a, after.t, after.t, after.id]
    : [];
  // A 红包's place is its latest payment, so its payments stay together:
  // one window over the listed payments, each read once.
  const rows = await env.DB.prepare(`WITH mine AS (
      SELECT p.id, p.mode, p.status, p.reason, p.confirmed_at, p.amount_minor, p.business_no,
        p.external_order_id, p.created_at, p.next_run_at, p.claim_id, p.merchant_id,
        c.activity_id, c.user_id AS claimant_id,
        MAX(p.created_at) OVER (PARTITION BY c.activity_id) AS group_at
      FROM payment_tasks p JOIN claims c ON c.id=p.claim_id JOIN activities a ON a.id=c.activity_id
      WHERE ${scopeSql(activityId)}
    )
    SELECT m.*, u.username, u.display_name, u.avatar_url
    FROM mine m LEFT JOIN users u ON u.id=m.claimant_id
    WHERE 1=1 ${status} ${page}
    ORDER BY m.group_at DESC, m.activity_id DESC, m.created_at DESC, m.id DESC
    LIMIT 21`)
    .bind(...binds, ...pageBinds)
    .all<Row>();
  const items = rows.results.slice(0, 20);
  const last = items.at(-1);
  const summary = await summaryOf(env, authorId, activityId);
  const ids = [...new Set(items.map((row) => row.activity_id))];
  const groups: Record<string, AccountPaymentGroup> = {};
  if (ids.length > 0) {
    const [activityRows, paid] = await Promise.all([
      createDb(env.DB)
        .select()
        .from(activities)
        .where(inArray(activities.id, ids)),
      env.DB.prepare(
        `SELECT c.activity_id AS id, COALESCE(SUM(p.amount_minor),0) AS minor
        FROM payment_tasks p JOIN claims c ON c.id=p.claim_id
        WHERE p.source='claim' AND p.status='confirmed' AND c.activity_id IN (${ids.map(() => "?").join(",")})
        GROUP BY c.activity_id`,
      )
        .bind(...ids)
        .all<{ id: string; minor: number }>(),
    ]);
    const confirmed = new Map(
      paid.results.map((row) => [row.id, Number(row.minor)]),
    );
    for (const row of activityRows) {
      const activity = projectActivitySummary(row);
      groups[row.id] = {
        ...activity,
        ...activityListFields(row, activity.status),
        confirmedAmount: formatAmount(confirmed.get(row.id) ?? 0),
      };
    }
  }
  return {
    items: items.map(paymentOf),
    activities: groups,
    summary,
    total:
      filter === "confirmed"
        ? summary.confirmedCount
        : filter === "open"
          ? summary.openCount
          : filter === "failed"
            ? summary.failedCount
            : summary.confirmedCount + summary.openCount + summary.failedCount,
    nextCursor:
      rows.results.length > 20 && last
        ? btoa(
            JSON.stringify({
              g: last.group_at,
              a: last.activity_id,
              t: last.created_at,
              id: last.id,
              scope,
            } satisfies Cursor),
          )
        : null,
  };
}

/** One payment of the account's 红包, wherever its merchant now stands. */
export async function accountPaymentDetail(
  env: ApiBindings,
  authorId: string,
  taskId: string,
  cursor?: string,
): Promise<AccountPaymentDetail> {
  const row =
    await env.DB.prepare(`SELECT p.merchant_id, a.id AS activity_id, a.title,
      json_extract(a.config,'$.money.mode') AS money_mode
    FROM payment_tasks p JOIN claims c ON c.id=p.claim_id JOIN activities a ON a.id=c.activity_id
    WHERE p.id=? AND ${scopeSql(undefined)}`)
      .bind(taskId, authorId)
      .first<{
        merchant_id: string;
        activity_id: string;
        title: string;
        money_mode: string | null;
      }>();
  if (!row) throw new ActivityError(404, "NOT_FOUND", "未找到付款记录");
  const [payment, merchant] = await Promise.all([
    merchantPaymentDetail(env, row.merchant_id, taskId, cursor),
    getMerchant(env, row.merchant_id, authorId),
  ]);
  return {
    payment,
    merchant,
    activity: {
      id: row.activity_id,
      title: row.title,
      draw: row.money_mode === "timed_draw",
    },
  };
}
