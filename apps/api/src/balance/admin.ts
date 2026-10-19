// 网站管理 · 🐟额 (docs/balance-design.md §7): what is held, what needs a
// look, every 转入 and 调整.
import type { ApiBindings } from "../env";
import { credentialVerificationView } from "../payments/verification";
import { decodeRecordCursor, listRecords, readAccount } from "./ledger";
import { readPlatformAppRow } from "./platform-app";
import { type TopupRow, topupView } from "./topups";

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

export async function adminBalanceOverview(env: ApiBindings) {
  const today = startOfBeijingDay();
  const [held, credited, attention] = await env.DB.batch<
    Record<string, number | null>
  >([
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
      (SELECT COUNT(*) FROM balance_topups WHERE status!='credited') AS open`),
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
    },
    attention: {
      topups: Number(counts.topups ?? 0),
      openTopups: Number(counts.open ?? 0),
    },
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
  const [account, records] = await Promise.all([
    readAccount(env, userId),
    listRecords(env, userId, "all", cursor),
  ]);
  return { account, ...records };
}
