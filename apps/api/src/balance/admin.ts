// 网站管理 · 🐟额 (docs/balance-design.md §7): what is held, what needs a
// look, every 转入 and 调整.
import type { ApiBindings } from "../env";
import { credentialVerificationView } from "../payments/verification";
import { memberOf } from "./invites";
import { decodeRecordCursor, listRecords, readAccount } from "./ledger";
import { readPlatformAppRow } from "./platform-app";
import { type TopupRow, topupView } from "./topups";
import {
  type WithdrawalPayment,
  type WithdrawalRow,
  withdrawalView,
} from "./withdrawals";

type UserRef = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

function userRef(row: Record<string, unknown>, prefix = "user"): UserRef {
  return {
    id: String(row[`${prefix}_id`]),
    username: String(row[`${prefix}_username`] ?? ""),
    displayName: String(row[`${prefix}_display_name`] ?? ""),
    avatarUrl:
      row[`${prefix}_avatar_url`] == null
        ? null
        : String(row[`${prefix}_avatar_url`]),
  };
}

/** Midnight in Beijing, today. */
function startOfBeijingDay(now = Date.now()) {
  const offset = 8 * 60 * 60_000;
  return Math.floor((now + offset) / 86_400_000) * 86_400_000 - offset;
}

/** A 转入 needs a look: a flag, or Credit turned down the platform app's key. */
const NEEDS_LOOK = `(t.flag IS NOT NULL OR (t.status!='credited' AND t.last_check_result='credentials'))`;

/** How long a 转出 may take before it is one to look at anyway. */
const WITHDRAWAL_SLOW_MS = 30 * 60_000;

/**
 * A 转出 needs a look while 发放中 and its payment is held (daily limit,
 * the platform account's LDC, its credentials), unclear, or with an admin
 * (Credit's answer did not match), or simply slow.
 */
function withdrawalNeedsLook(now = Date.now()) {
  return `(w.status='sending' AND EXISTS(SELECT 1 FROM payment_tasks p WHERE p.withdrawal_id=w.id
    AND (p.status IN ('attention','waiting') OR p.unknown_outcome=1 OR w.created_at<${now - WITHDRAWAL_SLOW_MS})))`;
}

/**
 * Where the ledger disagrees with itself (none, normally; the triggers in
 * 0029 and 0030 keep it so): an account against its entries or its locks,
 * a 转出 against its lock or its payment.
 */
const MISMATCHES = `SELECT
  (SELECT COUNT(*) FROM balance_accounts a WHERE
    a.available_minor!=COALESCE((SELECT SUM(e.available_delta_minor) FROM balance_entries e WHERE e.user_id=a.user_id),0)
    OR a.locked_minor!=COALESCE((SELECT SUM(e.locked_delta_minor) FROM balance_entries e WHERE e.user_id=a.user_id),0)
    OR a.locked_minor!=COALESCE((SELECT SUM(l.remaining_minor) FROM balance_locks l WHERE l.user_id=a.user_id AND l.status='active'),0))
  + (SELECT COUNT(*) FROM balance_withdrawals w WHERE
    (w.status='sending') != EXISTS(SELECT 1 FROM balance_locks l WHERE l.withdrawal_id=w.id AND l.status='active')
    OR (w.status='sending' AND EXISTS(SELECT 1 FROM payment_tasks p WHERE p.withdrawal_id=w.id AND p.status IN ('confirmed','failed')))
    OR NOT EXISTS(SELECT 1 FROM payment_tasks p WHERE p.withdrawal_id=w.id)) AS count`;

/** For 网站管理 · 概览's 需要留意: the 转入 and 转出 to look at. */
export async function balanceAttentionCounts(env: ApiBindings) {
  const row = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM balance_topups t WHERE ${NEEDS_LOOK}) AS topups,
    (SELECT COUNT(*) FROM balance_withdrawals w WHERE ${withdrawalNeedsLook()}) AS withdrawals`).first<{
    topups: number;
    withdrawals: number;
  }>();
  return {
    topups: Number(row?.topups ?? 0),
    withdrawals: Number(row?.withdrawals ?? 0),
  };
}

export async function adminBalanceOverview(env: ApiBindings) {
  const today = startOfBeijingDay();
  const [held, credited, attention, sending, sent, mismatches] =
    await env.DB.batch<Record<string, number | null>>([
      env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN available_minor>0 THEN available_minor ELSE 0 END),0)+COALESCE(SUM(locked_minor),0) AS heldMinor,
      COALESCE(SUM(CASE WHEN available_minor<0 THEN 1 ELSE 0 END),0) AS negativeCount,
      COALESCE(SUM(CASE WHEN available_minor<0 THEN available_minor ELSE 0 END),0) AS negativeMinor
      FROM balance_accounts`),
      env.DB.prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(credit_minor),0) AS creditMinor FROM balance_topups WHERE status='credited' AND credited_at>=?",
      ).bind(today),
      env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM balance_topups t WHERE ${NEEDS_LOOK}) AS topups,
      (SELECT COUNT(*) FROM balance_topups WHERE status!='credited') AS open,
      (SELECT COUNT(*) FROM balance_withdrawals w WHERE ${withdrawalNeedsLook()}) AS withdrawals`),
      env.DB.prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(debit_minor),0) AS minor FROM balance_withdrawals WHERE status='sending'",
      ),
      env.DB.prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(debit_minor),0) AS minor FROM balance_withdrawals WHERE status='sent' AND sent_at>=?",
      ).bind(today),
      env.DB.prepare(MISMATCHES),
    ]);
  const platform = await readPlatformAppRow(env);
  const verification = platform
    ? await credentialVerificationView(
        env,
        platform.id,
        platform.credential_version,
      )
    : null;
  const totals = held?.results[0] ?? {};
  const today_ = credited?.results[0] ?? {};
  const counts = attention?.results[0] ?? {};
  const out = sending?.results[0] ?? {};
  const outToday = sent?.results[0] ?? {};
  return {
    /** 代存合计: what the platform account must keep for everyone. */
    heldMinor: Number(totals.heldMinor ?? 0),
    negative: {
      count: Number(totals.negativeCount ?? 0),
      minor: Number(totals.negativeMinor ?? 0),
    },
    today: {
      topups: Number(today_.count ?? 0),
      creditMinor: Number(today_.creditMinor ?? 0),
      withdrawals: Number(outToday.count ?? 0),
      withdrawnMinor: Number(outToday.minor ?? 0),
    },
    /** 转出 发放中, and how much they hold. */
    sending: { count: Number(out.count ?? 0), minor: Number(out.minor ?? 0) },
    attention: {
      topups: Number(counts.topups ?? 0),
      openTopups: Number(counts.open ?? 0),
      withdrawals: Number(counts.withdrawals ?? 0),
    },
    /** Places the ledger disagrees with itself: 0. */
    mismatches: Number(mismatches?.results[0]?.count ?? 0),
    platformApp: verification ? { status: verification.status } : null,
  };
}

const TOPUP_WITH_USER = `SELECT t.*,u.id AS user_id,u.username AS user_username,u.display_name AS user_display_name,u.avatar_url AS user_avatar_url
  FROM balance_topups t JOIN users u ON u.id=t.user_id`;

export type AdminTopupView = "attention" | "all";

export async function listAdminTopups(
  env: ApiBindings,
  view: AdminTopupView,
  cursor?: string,
) {
  const before = decodeRecordCursor(cursor);
  const rows = await env.DB.prepare(
    `${TOPUP_WITH_USER} WHERE (?='all' OR ${NEEDS_LOOK})
      AND (?=0 OR t.created_at<? OR (t.created_at=? AND t.id<?))
    ORDER BY t.created_at DESC,t.id DESC LIMIT 21`,
  )
    .bind(
      view,
      before ? 1 : 0,
      before?.time ?? 0,
      before?.time ?? 0,
      before?.id ?? "",
    )
    .all<TopupRow & Record<string, unknown>>();
  const items = rows.results.slice(0, 20);
  const last = items.at(-1);
  return {
    items: items.map((row) => ({
      topup: topupView(row),
      user: userRef(row),
      lastCheckResult: row.last_check_result,
    })),
    nextCursor:
      rows.results.length > 20 && last
        ? btoa(JSON.stringify({ time: last.created_at, id: last.id }))
        : null,
  };
}

export async function adminTopupDetail(env: ApiBindings, id: string) {
  const row = await env.DB.prepare(`${TOPUP_WITH_USER} WHERE t.id=?`)
    .bind(id)
    .first<TopupRow & Record<string, unknown>>();
  if (!row) return null;
  const [checks, creditor] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT trigger,result,http_status AS httpStatus,created_at AS createdAt
      FROM balance_topup_checks WHERE topup_id=? ORDER BY created_at DESC,id DESC LIMIT 50`,
    ).bind(id),
    env.DB.prepare(
      "SELECT display_name AS displayName FROM users WHERE id=?",
    ).bind(row.credited_by_user_id ?? ""),
  ]);
  return {
    topup: topupView(row),
    user: userRef(row),
    /** Who invited the person (第 13 节), or null. */
    member: await memberOf(env, String(row.user_id)),
    clientId: row.client_id,
    credentialVersion: row.credential_version,
    lastCheckResult: row.last_check_result,
    creditedByAdmin:
      row.credited_by === "admin"
        ? {
            displayName: String(
              creditor?.results[0]?.displayName ?? row.credited_by_user_id,
            ),
            reason: row.credit_reason ?? "",
          }
        : null,
    checks: (checks?.results ?? []) as {
      trigger: string;
      result: string;
      httpStatus: number | null;
      createdAt: number;
    }[],
  };
}

const WITHDRAWAL_WITH_USER = `SELECT w.*,u.id AS user_id,u.username AS user_username,u.display_name AS user_display_name,u.avatar_url AS user_avatar_url,
    p.id AS task_id,p.status AS task_status,p.reason AS task_reason,p.unknown_outcome AS task_unknown,
    p.external_order_id AS task_order,p.next_send_at AS task_next_send,p.next_run_at AS task_next_run
  FROM balance_withdrawals w JOIN users u ON u.id=w.user_id LEFT JOIN payment_tasks p ON p.withdrawal_id=w.id`;

type WithdrawalWithUser = WithdrawalRow & Record<string, unknown>;

function paymentOf(row: WithdrawalWithUser): WithdrawalPayment | null {
  if (row.task_id == null) return null;
  return {
    id: String(row.task_id),
    status: String(row.task_status),
    reason: row.task_reason == null ? null : String(row.task_reason),
    unknownOutcome: Number(row.task_unknown) === 1,
    externalOrderId: row.task_order == null ? null : String(row.task_order),
    nextSendAt: row.task_next_send == null ? null : Number(row.task_next_send),
    nextRunAt: Number(row.task_next_run),
  };
}

function adminWithdrawalItem(row: WithdrawalWithUser) {
  const payment = paymentOf(row);
  return {
    withdrawal: withdrawalView(row, payment),
    user: userRef(row),
    payment: payment
      ? { id: payment.id, status: payment.status, reason: payment.reason }
      : null,
  };
}

export type AdminWithdrawalView = "attention" | "all";

export async function listAdminWithdrawals(
  env: ApiBindings,
  view: AdminWithdrawalView,
  cursor?: string,
) {
  const before = decodeRecordCursor(cursor);
  const rows = await env.DB.prepare(
    `${WITHDRAWAL_WITH_USER} WHERE (?='all' OR ${withdrawalNeedsLook()})
      AND (?=0 OR w.created_at<? OR (w.created_at=? AND w.id<?))
    ORDER BY w.created_at DESC,w.id DESC LIMIT 21`,
  )
    .bind(
      view,
      before ? 1 : 0,
      before?.time ?? 0,
      before?.time ?? 0,
      before?.id ?? "",
    )
    .all<WithdrawalWithUser>();
  const items = rows.results.slice(0, 20);
  const last = items.at(-1);
  return {
    items: items.map(adminWithdrawalItem),
    nextCursor:
      rows.results.length > 20 && last
        ? btoa(JSON.stringify({ time: last.created_at, id: last.id }))
        : null,
  };
}

/** One 转出, with its payment's tries: only to read, nothing to do. */
export async function adminWithdrawalDetail(env: ApiBindings, id: string) {
  const row = await env.DB.prepare(`${WITHDRAWAL_WITH_USER} WHERE w.id=?`)
    .bind(id)
    .first<WithdrawalWithUser>();
  if (!row) return null;
  const attempts = row.task_id
    ? await env.DB.prepare(
        `SELECT operation,outcome,reason,http_status AS httpStatus,started_at AS startedAt
        FROM payment_attempts WHERE task_id=? ORDER BY started_at DESC,id DESC LIMIT 20`,
      )
        .bind(row.task_id)
        .all<{
          operation: string;
          outcome: string;
          reason: string | null;
          httpStatus: number | null;
          startedAt: number;
        }>()
    : null;
  return {
    ...adminWithdrawalItem(row),
    recipientId: row.recipient_id,
    clientId: row.client_id,
    attempts: attempts?.results ?? [],
  };
}

/**
 * 待处理: the 转入 and 转出 that need a look, newest first, 20 at a time
 * (one cursor over both).
 */
export async function listAdminAttention(env: ApiBindings, cursor?: string) {
  const [topups, withdrawals] = await Promise.all([
    listAdminTopups(env, "attention", cursor),
    listAdminWithdrawals(env, "attention", cursor),
  ]);
  const items = [
    ...topups.items.map((item) => ({
      type: "topup" as const,
      createdAt: item.topup.createdAt,
      id: item.topup.id,
      ...item,
    })),
    ...withdrawals.items.map((item) => ({
      type: "withdrawal" as const,
      createdAt: item.withdrawal.createdAt,
      id: item.withdrawal.id,
      ...item,
    })),
  ].sort((left, right) =>
    right.createdAt !== left.createdAt
      ? right.createdAt - left.createdAt
      : right.id > left.id
        ? 1
        : -1,
  );
  const page = items.slice(0, 20);
  const last = page.at(-1);
  const more =
    items.length > 20 ||
    topups.nextCursor !== null ||
    withdrawals.nextCursor !== null;
  return {
    items: page,
    nextCursor:
      more && last
        ? btoa(JSON.stringify({ time: last.createdAt, id: last.id }))
        : null,
  };
}

export async function listAdminAdjustments(env: ApiBindings, cursor?: string) {
  const before = decodeRecordCursor(cursor);
  const rows = await env.DB.prepare(
    `SELECT a.*,u.id AS user_id,u.username AS user_username,u.display_name AS user_display_name,u.avatar_url AS user_avatar_url,
      COALESCE(actor.display_name,a.actor_user_id) AS actor_display_name
    FROM balance_adjustments a JOIN users u ON u.id=a.user_id LEFT JOIN users actor ON actor.id=a.actor_user_id
    WHERE (?=0 OR a.created_at<? OR (a.created_at=? AND a.id<?))
    ORDER BY a.created_at DESC,a.id DESC LIMIT 21`,
  )
    .bind(
      before ? 1 : 0,
      before?.time ?? 0,
      before?.time ?? 0,
      before?.id ?? "",
    )
    .all<Record<string, unknown>>();
  const items = rows.results.slice(0, 20);
  const last = items.at(-1);
  return {
    items: items.map((row) => ({
      id: String(row.id),
      direction:
        row.direction === "deduct" ? ("deduct" as const) : ("add" as const),
      amountMinor: Number(row.amount_minor),
      reason: String(row.reason),
      createdAt: Number(row.created_at),
      user: userRef(row),
      actorDisplayName: String(row.actor_display_name),
    })),
    nextCursor:
      rows.results.length > 20 && last
        ? btoa(
            JSON.stringify({
              time: Number(last.created_at),
              id: String(last.id),
            }),
          )
        : null,
  };
}

export async function adminUserBalance(
  env: ApiBindings,
  userId: string,
  cursor?: string,
) {
  const [account, records, member] = await Promise.all([
    readAccount(env, userId),
    listRecords(env, userId, "all", cursor),
    memberOf(env, userId),
  ]);
  return { account, member, ...records };
}
