// 三方积分's records (docs/third-party-points-design.md §7), for the 站长's
// panel and for the system's owner (its issuer), read on demand. A 红包 can
// have hundreds of payouts, so they are not one long list: what needs
// someone first, then the system's 红包 newest first with each one's sums,
// one 红包's payouts on their own, and a search by recipient or order
// number. The calls to the issuer show failures unless all are asked for.
// Both see the same rows: the issuer already gets each recipient's LINUX
// DO ID and name with the payout, and a 红包's sender is on its page.
import { ActivityError } from "../activities/errors";
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

/** As the site's other lists: 20 at a time (redesign 07 §1). */
const PAGE = 20;
const HONGBAO_PAGE = 20;
/** 找一笔: at most this many. */
const SEARCH_MAX = 50;
/** 要处理的: at most this many, newest first. */
const ATTENTION_MAX = 100;

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

const PAYOUT_SELECT = `SELECT p.rowid AS rid,p.id,p.activity_id,a.title,
    au.username AS author_username,p.recipient_username,p.recipient_external_id,
    p.amount_minor,p.out_trade_no,p.trade_no,p.status,p.reason,p.attempts,
    p.misses,p.resend_count,p.created_at,p.updated_at,p.done_at
  FROM points_payments p
  JOIN activities a ON a.id=p.activity_id
  JOIN users au ON au.id=p.author_id`;

function payoutOf(row: PayoutRecordRow) {
  return {
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
  };
}

const newestFirst = (a: PayoutRecordRow, b: PayoutRecordRow) =>
  b.updated_at - a.updated_at || b.rid - a.rid;

/** Rows from several reads, each once, the latest change first. */
function merged(batches: { results: PayoutRecordRow[] }[]) {
  const seen = new Map<string, PayoutRecordRow>();
  for (const batch of batches)
    for (const row of batch.results) seen.set(row.id, row);
  return [...seen.values()].sort(newestFirst);
}

/**
 * One page of payouts, the most recently changed first: a system's, or one
 * of its 红包's. Each status is read from its own stretch of an index
 * (points_payments_system_idx or _activity_idx: …, status, updated_at), in
 * one batch (D1 caps a UNION's terms), so a page reads at most a page a
 * status.
 */
export async function listPayoutRecords(
  env: ApiBindings,
  scope: { systemId: string } | { activityId: string },
  filter: PointsPayoutFilter,
  before: string | undefined,
  limit = PAGE,
) {
  const statuses = POINTS_PAYOUT_FILTERS[filter];
  const cursor = readCursor(before);
  const at = cursor?.at ?? Number.MAX_SAFE_INTEGER;
  const rowid = cursor?.rowid ?? Number.MAX_SAFE_INTEGER;
  const [column, value] =
    "systemId" in scope
      ? ["p.system_id", scope.systemId]
      : ["p.activity_id", scope.activityId];
  const batches = await env.DB.batch<PayoutRecordRow>(
    statuses.map((status) =>
      env.DB.prepare(
        `${PAYOUT_SELECT}
          WHERE ${column}=?1 AND p.status=?2 AND p.updated_at<=?3
            AND NOT (p.updated_at=?3 AND p.rowid>=?4)
          ORDER BY p.updated_at DESC, p.rowid DESC LIMIT ?5`,
      ).bind(value, status, at, rowid, limit + 1),
    ),
  );
  const rows = merged(batches);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(payoutOf),
    next:
      rows.length > limit && last ? cursorOf(last.updated_at, last.rid) : null,
  };
}

/**
 * 要处理的: payouts with no known result, those waiting for the recipient
 * to open an account, and the last 7 days' that did not go — the few worth
 * a look among hundreds that simply arrived.
 */
export async function attentionPayouts(env: ApiBindings, systemId: string) {
  const since = Date.now() - 7 * DAY_MS;
  const batches = await env.DB.batch<PayoutRecordRow>([
    env.DB.prepare(
      `${PAYOUT_SELECT} WHERE p.system_id=?1 AND p.status='unknown'
        ORDER BY p.updated_at DESC LIMIT ?2`,
    ).bind(systemId, ATTENTION_MAX),
    env.DB.prepare(
      `${PAYOUT_SELECT} WHERE p.system_id=?1 AND p.status='held'
        ORDER BY p.updated_at DESC LIMIT ?2`,
    ).bind(systemId, ATTENTION_MAX),
    env.DB.prepare(
      `${PAYOUT_SELECT} WHERE p.system_id=?1 AND p.status='failed'
        AND p.updated_at>=?3 ORDER BY p.updated_at DESC LIMIT ?2`,
    ).bind(systemId, ATTENTION_MAX, since),
  ]);
  return merged(batches).slice(0, ATTENTION_MAX).map(payoutOf);
}

type HongbaoRow = {
  id: string;
  title: string;
  author_username: string;
  opened_at: number;
  ended_at: number | null;
  deleted_at: number | null;
  claimed_count: number;
};

/** "<opened_at>~<id>": where a page of 红包 stopped. */
function readHongbaoCursor(value: string | undefined) {
  const match = /^(\d{1,16})~([0-9a-f-]{36})$/.exec(value ?? "");
  return match ? { at: Number(match[1]), id: match[2] as string } : null;
}

/**
 * The system's 红包, the latest opened first, 20 at a time
 * (activities_points_opened_idx), each with its payouts summed by state
 * (points_payments_activity_idx): 已到账, 处理中, 没发出.
 */
export async function listHongbaoRecords(
  env: ApiBindings,
  systemId: string,
  before: string | undefined,
  limit = HONGBAO_PAGE,
) {
  const cursor = readHongbaoCursor(before);
  const rows = await env.DB.prepare(
    `SELECT a.id,a.title,u.username AS author_username,a.opened_at,a.ended_at,
        a.deleted_at,a.claimed_count
      FROM activities a JOIN users u ON u.id=a.author_id
      WHERE a.points_system_id=?1 AND a.opened_at IS NOT NULL
        AND (a.opened_at<?2 OR (a.opened_at=?2 AND a.id<?3))
      ORDER BY a.opened_at DESC, a.id DESC LIMIT ?4`,
  )
    .bind(
      systemId,
      cursor?.at ?? Number.MAX_SAFE_INTEGER,
      cursor?.id ?? "~",
      limit + 1,
    )
    .all<HongbaoRow>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await withSums(env, page),
    next:
      rows.results.length > limit && last
        ? `${last.opened_at}~${last.id}`
        : null,
  };
}

/** 红包 rows with their payouts summed by state (points_payments_activity_idx). */
async function withSums(env: ApiBindings, page: HongbaoRow[]) {
  const sums = page.length
    ? await env.DB.prepare(
        `SELECT activity_id,status,COUNT(*) AS count,SUM(amount_minor) AS amount
          FROM points_payments WHERE activity_id IN (${page.map(() => "?").join(",")})
          GROUP BY activity_id,status`,
      )
        .bind(...page.map((row) => row.id))
        .all<{
          activity_id: string;
          status: string;
          count: number;
          amount: number;
        }>()
    : { results: [] };
  const sum = (id: string, statuses: readonly string[]) => {
    const picked = sums.results.filter(
      (row) => row.activity_id === id && statuses.includes(row.status),
    );
    return {
      count: picked.reduce((total, row) => total + row.count, 0),
      amountMinor: picked.reduce((total, row) => total + (row.amount ?? 0), 0),
    };
  };
  return page.map((row) => ({
    id: row.id,
    title: row.title,
    authorUsername: row.author_username,
    openedAt: row.opened_at,
    endedAt: row.ended_at,
    deleted: row.deleted_at !== null,
    claimedCount: row.claimed_count,
    confirmed: sum(row.id, POINTS_PAYOUT_FILTERS.confirmed),
    waiting: sum(row.id, POINTS_PAYOUT_FILTERS.waiting),
    failed: sum(row.id, POINTS_PAYOUT_FILTERS.failed),
  }));
}

/** One 红包's payouts, if it is this system's (else 404, as for any). */
export async function listHongbaoPayouts(
  env: ApiBindings,
  systemId: string,
  activityId: string,
  filter: PointsPayoutFilter,
  before: string | undefined,
  limit = PAGE,
) {
  const owned = await env.DB.prepare(
    `SELECT a.id,a.title,u.username AS author_username,a.opened_at,a.ended_at,
        a.deleted_at,a.claimed_count
      FROM activities a JOIN users u ON u.id=a.author_id
      WHERE a.id=? AND a.points_system_id=? AND a.opened_at IS NOT NULL`,
  )
    .bind(activityId, systemId)
    .first<HongbaoRow>();
  if (!owned)
    throw new ActivityError(404, "POINTS_HONGBAO_NOT_FOUND", "没有这个红包");
  const [page, hongbao] = await Promise.all([
    listPayoutRecords(env, { activityId }, filter, before, limit),
    // The first page names the 红包 (a link may open it straight away).
    before ? null : withSums(env, [owned]).then((rows) => rows[0] ?? null),
  ]);
  return { ...page, hongbao };
}

/**
 * 搜一笔: by this site's or the issuer's order number, the recipient's
 * LINUX DO ID, or their name as they are called now. Each from its own
 * index; at most 50, newest first.
 */
export async function searchPayouts(
  env: ApiBindings,
  systemId: string,
  query: string,
) {
  const q = query.trim().replace(/^@/, "").slice(0, 128);
  if (!q) return [];
  const reads = [
    env.DB.prepare(
      `${PAYOUT_SELECT} WHERE p.out_trade_no=?1 AND p.system_id=?2`,
    ).bind(q, systemId),
    env.DB.prepare(
      `${PAYOUT_SELECT} WHERE p.trade_no=?1 AND p.system_id=?2 LIMIT ?3`,
    ).bind(q, systemId, SEARCH_MAX),
  ];
  if (/^\d{1,20}$/.test(q))
    reads.push(
      env.DB.prepare(
        `${PAYOUT_SELECT} WHERE p.system_id=?1 AND p.recipient_external_id=?2
          ORDER BY p.updated_at DESC LIMIT ?3`,
      ).bind(systemId, q, SEARCH_MAX),
    );
  if (q.length <= 64)
    reads.push(
      env.DB.prepare(
        `${PAYOUT_SELECT} WHERE p.system_id=?1 AND p.recipient_external_id IN
            (SELECT external_id FROM users WHERE lower(username)=lower(?2))
          ORDER BY p.updated_at DESC LIMIT ?3`,
      ).bind(systemId, q, SEARCH_MAX),
    );
  const batches = await env.DB.batch<PayoutRecordRow>(reads);
  return merged(batches).slice(0, SEARCH_MAX).map(payoutOf);
}

/** Today's and the last 7 days' payouts by state: how many, how much. */
export async function payoutTotals(env: ApiBindings, systemId: string) {
  const week = Date.now() - 7 * DAY_MS;
  const today = startOfToday();
  const rows = await env.DB.prepare(
    `SELECT status,reason,COUNT(*) AS count,SUM(amount_minor) AS amount,
        SUM(CASE WHEN updated_at>=?3 THEN 1 ELSE 0 END) AS today_count,
        SUM(CASE WHEN updated_at>=?3 THEN amount_minor ELSE 0 END) AS today_amount
      FROM points_payments WHERE system_id=?1
        AND status IN ('pending','sending','held','unknown','confirmed','failed')
        AND updated_at>=?2
      GROUP BY status,reason`,
  )
    .bind(systemId, week, today)
    .all<{
      status: string;
      reason: string | null;
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
  // 发放失败 by why (§17): the recipient's side, or anything else.
  const failedBy = (count: "count" | "today_count") => {
    const failed = rows.results.filter((row) => row.status === "failed");
    const of = (reasons: (string | null)[], inside: boolean) =>
      failed
        .filter((row) => reasons.includes(row.reason) === inside)
        .reduce((total, row) => total + (row[count] ?? 0), 0);
    return {
      noRecipient: of(["no_recipient"], true),
      notAllowed: of(["not_allowed"], true),
      other: of(["no_recipient", "not_allowed"], false),
    };
  };
  const span = (
    count: "count" | "today_count",
    amount: "amount" | "today_amount",
  ) => ({
    confirmed: sum(POINTS_PAYOUT_FILTERS.confirmed, count, amount),
    waiting: sum(POINTS_PAYOUT_FILTERS.waiting, count, amount),
    failed: {
      ...sum(POINTS_PAYOUT_FILTERS.failed, count, amount),
      ...failedBy(count),
    },
  });
  return {
    today: span("today_count", "today_amount"),
    week: span("count", "amount"),
  };
}

/**
 * A page of a system's calls to its issuer, newest first: every one, or
 * (problems) only those not answered ok in the last 7 days.
 */
export async function listCallRecords(
  env: ApiBindings,
  systemId: string,
  before: string | undefined,
  problems = false,
  limit = PAGE,
) {
  const cursor = readCursor(before);
  const rows = await env.DB.prepare(
    `SELECT c.rowid AS rid,c.id,c.kind,c.result,c.http_status,c.ms,c.at,p.out_trade_no
      FROM (SELECT rowid AS rid FROM points_calls WHERE system_id=?1 AND at<=?2
        AND NOT (at=?2 AND rowid>=?4)
        ${problems ? "AND at>=?5 AND result!='ok'" : ""}
        ORDER BY at DESC, rowid DESC LIMIT ?3) picked
      JOIN points_calls c ON c.rowid=picked.rid
      LEFT JOIN points_payments p ON p.id=c.payment_id
      ORDER BY c.at DESC, c.rowid DESC`,
  )
    .bind(
      systemId,
      cursor?.at ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
      cursor?.rowid ?? Number.MAX_SAFE_INTEGER,
      ...(problems ? [Date.now() - 7 * DAY_MS] : []),
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
  const last = page.at(-1);
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
    next:
      rows.results.length > limit && last ? cursorOf(last.at, last.rid) : null,
  };
}

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/**
 * 用量 (§17 第二批): who holds a key for it (and how many of those keys
 * failed), the 红包 sent with it and by how many people, how many got some,
 * and how much went out in the last 7 days and in all.
 */
export async function pointsUsage(env: ApiBindings, systemId: string) {
  const week = Date.now() - 7 * DAY_MS;
  const [keys, hongbao, paid] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS keys, COALESCE(SUM(status<>'ok'),0) AS invalid
        FROM points_keys WHERE system_id=? AND removed_at IS NULL`,
    ).bind(systemId),
    env.DB.prepare(
      `SELECT COUNT(*) AS hongbao, COUNT(DISTINCT author_id) AS senders
        FROM activities WHERE points_system_id=? AND opened_at IS NOT NULL`,
    ).bind(systemId),
    env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount_minor),0) AS amount,
          COUNT(DISTINCT recipient_user_id) AS claimants,
          COALESCE(SUM(updated_at>=?2),0) AS week_count,
          COALESCE(SUM(CASE WHEN updated_at>=?2 THEN amount_minor ELSE 0 END),0) AS week_amount
        FROM points_payments WHERE system_id=?1 AND status='confirmed'`,
    ).bind(systemId, week),
  ]);
  const k = keys?.results?.[0] as { keys: number; invalid: number };
  const h = hongbao?.results?.[0] as { hongbao: number; senders: number };
  const p = paid?.results?.[0] as {
    count: number;
    amount: number;
    claimants: number;
    week_count: number;
    week_amount: number;
  };
  return {
    keys: k?.keys ?? 0,
    invalidKeys: k?.invalid ?? 0,
    hongbao: h?.hongbao ?? 0,
    senders: h?.senders ?? 0,
    claimants: p?.claimants ?? 0,
    week: { count: p?.week_count ?? 0, amountMinor: p?.week_amount ?? 0 },
    all: { count: p?.count ?? 0, amountMinor: p?.amount ?? 0 },
  };
}

/**
 * 近 14 天走势 (§17 第二批): each day in Shanghai, payouts ended through or
 * failed, and the issuer's average answer time for 发放 calls.
 */
export async function pointsTrend(env: ApiBindings, systemId: string) {
  const today = startOfToday();
  const from = today - 13 * DAY_MS;
  const [payouts, calls] = await env.DB.batch([
    env.DB.prepare(
      `SELECT CAST((updated_at+?3)/86400000 AS INTEGER) AS day, status, COUNT(*) AS n
        FROM points_payments WHERE system_id=?1 AND status IN ('confirmed','failed')
          AND updated_at>=?2
        GROUP BY day, status`,
    ).bind(systemId, from, SHANGHAI_OFFSET_MS),
    env.DB.prepare(
      `SELECT CAST((at+?3)/86400000 AS INTEGER) AS day, CAST(AVG(ms) AS INTEGER) AS ms, COUNT(*) AS n
        FROM points_calls WHERE system_id=?1 AND at>=?2 AND kind='transfer'
        GROUP BY day`,
    ).bind(systemId, from, SHANGHAI_OFFSET_MS),
  ]);
  const firstDay = Math.floor((from + SHANGHAI_OFFSET_MS) / DAY_MS);
  const days = Array.from({ length: 14 }, (_, index) => ({
    day: (firstDay + index) * DAY_MS - SHANGHAI_OFFSET_MS,
    confirmed: 0,
    failed: 0,
    averageMs: null as number | null,
  }));
  for (const row of (payouts?.results ?? []) as {
    day: number;
    status: string;
    n: number;
  }[]) {
    const slot = days[row.day - firstDay];
    if (!slot) continue;
    if (row.status === "confirmed") slot.confirmed = row.n;
    else slot.failed = row.n;
  }
  for (const row of (calls?.results ?? []) as {
    day: number;
    ms: number;
    n: number;
  }[]) {
    const slot = days[row.day - firstDay];
    if (slot && row.n > 0) slot.averageMs = row.ms;
  }
  return days;
}

/**
 * 发红包的人 (§17 第二批): who sends 红包 with it — how many, how much went
 * out in all and in the last 7 days, and whether their key works now;
 * the most in the last 7 days first, at most 100.
 */
export async function listSenders(env: ApiBindings, systemId: string) {
  const week = Date.now() - 7 * DAY_MS;
  const [senders, paid, keys] = await env.DB.batch([
    env.DB.prepare(
      `SELECT a.author_id, u.username, COUNT(*) AS hongbao, MAX(a.opened_at) AS last_opened,
          COALESCE(SUM(a.opened_at IS NOT NULL AND a.ended_at IS NULL AND a.deleted_at IS NULL),0) AS open
        FROM activities a JOIN users u ON u.id=a.author_id
        WHERE a.points_system_id=? AND a.opened_at IS NOT NULL
        GROUP BY a.author_id`,
    ).bind(systemId),
    env.DB.prepare(
      `SELECT author_id, COUNT(*) AS count, COALESCE(SUM(amount_minor),0) AS amount,
          COALESCE(SUM(CASE WHEN updated_at>=?2 THEN amount_minor ELSE 0 END),0) AS week_amount
        FROM points_payments WHERE system_id=?1 AND status='confirmed'
        GROUP BY author_id`,
    ).bind(systemId, week),
    env.DB.prepare(
      `SELECT author_id, status FROM points_keys
        WHERE system_id=? AND removed_at IS NULL`,
    ).bind(systemId),
  ]);
  const paidOf = new Map(
    (
      (paid?.results ?? []) as {
        author_id: string;
        count: number;
        amount: number;
        week_amount: number;
      }[]
    ).map((row) => [row.author_id, row]),
  );
  const keyOf = new Map(
    ((keys?.results ?? []) as { author_id: string; status: string }[]).map(
      (row) => [row.author_id, row.status === "ok" ? "ok" : "invalid"],
    ),
  );
  return (
    (senders?.results ?? []) as {
      author_id: string;
      username: string;
      hongbao: number;
      last_opened: number;
      open: number;
    }[]
  )
    .map((row) => {
      const sums = paidOf.get(row.author_id);
      return {
        username: row.username,
        hongbao: row.hongbao,
        open: row.open,
        lastOpenedAt: row.last_opened,
        all: { count: sums?.count ?? 0, amountMinor: sums?.amount ?? 0 },
        weekAmountMinor: sums?.week_amount ?? 0,
        key: (keyOf.get(row.author_id) ?? "none") as "ok" | "invalid" | "none",
      };
    })
    .sort(
      (a, b) =>
        b.weekAmountMinor - a.weekAmountMinor ||
        b.all.amountMinor - a.all.amountMinor ||
        b.lastOpenedAt - a.lastOpenedAt,
    )
    .slice(0, 100);
}
