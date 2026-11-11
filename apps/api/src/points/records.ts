// 三方积分's records (docs/third-party-points-design.md §7): every payout of
// one system and its calls to the issuer, newest first, for the 站长's panel
// and for the system's owner (its issuer). Read on demand. Both see the
// same rows: the issuer already gets each recipient's LINUX DO ID and name
// with the payout, and a 红包's sender is on its page.
import type { ApiBindings } from "../env";
import { startOfToday } from "./admin";

const DAY_MS = 86_400_000;

export const POINTS_PAYOUT_FILTERS = {
  all: ["pending", "sending", "held", "unknown", "confirmed", "failed"],
  confirmed: ["confirmed"],
  waiting: ["pending", "sending", "held", "unknown"],
  failed: ["failed"],
} as const;
export type PointsPayoutFilter = keyof typeof POINTS_PAYOUT_FILTERS;

const PAGE = 50;

/**
 * Where the last page stopped: "<time>.<rowid>". Many payouts can change in
 * the same millisecond (a 红包's end settles its rest at once), so the rowid
 * breaks ties, in the index's own order.
 */
export function readCursor(value: string | undefined) {
  const match = /^(\d{1,16})\.(\d{1,16})$/.exec(value ?? "");
  return match ? { at: Number(match[1]), rowid: Number(match[2]) } : null;
}
const cursorOf = (at: number, rowid: number) => `${at}.${rowid}`;

type PayoutRecordRow = {
  rid: number;
  id: string;
  activity_id: string;
  title: string;
  author_username: string;
  recipient_username: string;
  recipient_external_id: string;
  amount_minor: number;
  out_trade_no: string;
  trade_no: string | null;
  status: string;
  reason: string | null;
  attempts: number;
  misses: number;
  resend_count: number;
  created_at: number;
  updated_at: number;
  done_at: number | null;
};

/**
 * One page of a system's payouts, the most recently changed first. Each
 * status is read from its own stretch of points_payments_system_idx
 * (system_id, status, updated_at), so a page reads at most a page a status.
 */
export async function listPayoutRecords(
  env: ApiBindings,
  systemId: string,
  filter: PointsPayoutFilter,
  before: string | undefined,
  limit = PAGE,
) {
  const statuses = POINTS_PAYOUT_FILTERS[filter];
  const cursor = readCursor(before);
  const at = cursor?.at ?? Number.MAX_SAFE_INTEGER;
  const rowid = cursor?.rowid ?? Number.MAX_SAFE_INTEGER;
  // One read a status, in one round trip (D1 caps a UNION's terms).
  const batches = await env.DB.batch<PayoutRecordRow>(
    statuses.map((status) =>
      env.DB.prepare(
        `SELECT p.rowid AS rid,p.id,p.activity_id,a.title,au.username AS author_username,
            p.recipient_username,p.recipient_external_id,p.amount_minor,p.out_trade_no,
            p.trade_no,p.status,p.reason,p.attempts,p.misses,p.resend_count,
            p.created_at,p.updated_at,p.done_at
          FROM points_payments p
          JOIN activities a ON a.id=p.activity_id
          JOIN users au ON au.id=p.author_id
          WHERE p.system_id=?1 AND p.status=?2 AND p.updated_at<=?3
            AND NOT (p.updated_at=?3 AND p.rowid>=?4)
          ORDER BY p.updated_at DESC, p.rowid DESC LIMIT ?5`,
      ).bind(systemId, status, at, rowid, limit + 1),
    ),
  );
  const rows = {
    results: batches
      .flatMap((batch) => batch.results)
      .sort((a, b) => b.updated_at - a.updated_at || b.rid - a.rid),
  };
  const page = rows.results.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      activityId: row.activity_id,
      title: row.title,
      authorUsername: row.author_username,
      recipientUsername: row.recipient_username,
      recipientId: row.recipient_external_id,
      amountMinor: row.amount_minor,
      outTradeNo: row.out_trade_no,
      tradeNo: row.trade_no,
      status: row.status,
      reason: row.reason,
      attempts: row.attempts,
      misses: row.misses,
      resent: row.resend_count > 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      doneAt: row.done_at,
    })),
    next: nextCursor(rows.results.length > limit, page.at(-1), (row) => [
      row.updated_at,
      row.rid,
    ]),
  };
}

/** Today's and the last 7 days' payouts by status: how many, how much. */
export async function payoutTotals(env: ApiBindings, systemId: string) {
  const week = Date.now() - 7 * DAY_MS;
  const today = startOfToday();
  const rows = await env.DB.prepare(
    `SELECT status,COUNT(*) AS count,SUM(amount_minor) AS amount,
        SUM(CASE WHEN updated_at>=?3 THEN 1 ELSE 0 END) AS today_count,
        SUM(CASE WHEN updated_at>=?3 THEN amount_minor ELSE 0 END) AS today_amount
      FROM points_payments WHERE system_id=?1
        AND status IN ('pending','sending','held','unknown','confirmed','failed')
        AND updated_at>=?2
      GROUP BY status`,
  )
    .bind(systemId, week, today)
    .all<{
      status: string;
      count: number;
      amount: number;
      today_count: number;
      today_amount: number;
    }>();
  const sum = (
    statuses: readonly string[],
    count: "count" | "today_count",
    amount: "amount" | "today_amount",
  ) => {
    const picked = rows.results.filter((row) => statuses.includes(row.status));
    return {
      count: picked.reduce((total, row) => total + (row[count] ?? 0), 0),
      amountMinor: picked.reduce((total, row) => total + (row[amount] ?? 0), 0),
    };
  };
  const span = (
    count: "count" | "today_count",
    amount: "amount" | "today_amount",
  ) => ({
    confirmed: sum(POINTS_PAYOUT_FILTERS.confirmed, count, amount),
    waiting: sum(POINTS_PAYOUT_FILTERS.waiting, count, amount),
    failed: sum(POINTS_PAYOUT_FILTERS.failed, count, amount),
  });
  return {
    today: span("today_count", "today_amount"),
    week: span("count", "amount"),
  };
}

/** One page of a system's calls to its issuer, newest first. */
export async function listCallRecords(
  env: ApiBindings,
  systemId: string,
  before: string | undefined,
  limit = PAGE,
) {
  const cursor = readCursor(before);
  const rows = await env.DB.prepare(
    `SELECT c.rowid AS rid,c.id,c.kind,c.result,c.http_status,c.ms,c.at,p.out_trade_no
      FROM (SELECT rowid AS rid FROM points_calls WHERE system_id=?1 AND at<=?2
        AND NOT (at=?2 AND rowid>=?4) ORDER BY at DESC, rowid DESC LIMIT ?3) picked
      JOIN points_calls c ON c.rowid=picked.rid
      LEFT JOIN points_payments p ON p.id=c.payment_id
      ORDER BY c.at DESC, c.rowid DESC`,
  )
    .bind(
      systemId,
      cursor?.at ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
      cursor?.rowid ?? Number.MAX_SAFE_INTEGER,
    )
    .all<{
      rid: number;
      id: string;
      kind: string;
      result: string;
      http_status: number | null;
      ms: number;
      at: number;
      out_trade_no: string | null;
    }>();
  const page = rows.results.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      result: row.result,
      httpStatus: row.http_status,
      ms: row.ms,
      at: row.at,
      outTradeNo: row.out_trade_no,
    })),
    next: nextCursor(rows.results.length > limit, page.at(-1), (row) => [
      row.at,
      row.rid,
    ]),
  };
}

function nextCursor<T>(
  more: boolean,
  last: T | undefined,
  key: (row: T) => [number, number],
) {
  return more && last ? cursorOf(...key(last)) : null;
}
