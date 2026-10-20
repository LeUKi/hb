// 开放接口密钥 (docs/balance-design.md §16): a 🐟额 PLUS member's keys for
// the open API, ten in use at most. A key is shown once, as it is made; only
// its digest is kept. Its owner stops it, or an admin with a reason; a stop
// is final. What it sent is read from the 转账 it made.
import {
  amountToMinor,
  BALANCE_LIMITS,
  type BalanceApiKey,
  type BalanceApiKeyTotals,
  type CreateApiKeyInput,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import type { ApiBindings } from "../env";
import { sha256Hex } from "../security/crypto";
import { startOfBeijingDay } from "./day";
import { balanceError } from "./errors";
import { decodeRecordCursor } from "./ledger";
import { type TransferRow, transferAccess, transferViews } from "./transfers";

export type ApiKeyRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  last_four: string;
  daily_limit_minor: number | null;
  created_at: number;
  last_transfer_at: number | null;
  last_transfer_ip: string | null;
  transfer_count: number;
  transfer_total_minor: number;
  revoked_at: number | null;
  revoked_by_user_id: string | null;
  revoke_reason: string | null;
};

const TOKEN_PREFIX = "hbk_";

const tokenDigest = (token: string) => sha256Hex(`balance-api-key:${token}`);

function newToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `${TOKEN_PREFIX}${btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;
}

export function apiKeyView(
  row: ApiKeyRow,
  usedTodayMinor: number,
): BalanceApiKey {
  return {
    id: row.id,
    name: row.name,
    lastFour: row.last_four,
    status:
      row.revoked_at === null
        ? "active"
        : row.revoked_by_user_id !== null
          ? "admin_revoked"
          : "revoked",
    dailyLimitMinor: row.daily_limit_minor,
    usedTodayMinor,
    createdAt: row.created_at,
    lastTransferAt: row.last_transfer_at,
    lastTransferIp: row.last_transfer_ip,
    transferCount: row.transfer_count,
    transferTotalMinor: row.transfer_total_minor,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
  };
}

/** What each of these keys sent today (北京时间). */
async function usedToday(env: ApiBindings, keyIds: string[]) {
  if (keyIds.length === 0) return new Map<string, number>();
  const rows = await env.DB.prepare(
    `SELECT api_key_id AS id,SUM(amount_minor) AS total FROM balance_transfers
    WHERE api_key_id IN (${keyIds.map(() => "?").join(",")}) AND created_at>=?
    GROUP BY api_key_id`,
  )
    .bind(...keyIds, startOfBeijingDay())
    .all<{ id: string; total: number }>();
  return new Map(rows.results.map((row) => [row.id, row.total]));
}

/** Someone's keys, in use first, newest first. */
export async function listApiKeys(env: ApiBindings, userId: string) {
  const rows = await env.DB.prepare(
    `SELECT * FROM balance_api_keys WHERE user_id=?
    ORDER BY (revoked_at IS NULL) DESC,created_at DESC,id DESC LIMIT 50`,
  )
    .bind(userId)
    .all<ApiKeyRow>();
  const today = await usedToday(
    env,
    rows.results.map((row) => row.id),
  );
  return rows.results.map((row) => apiKeyView(row, today.get(row.id) ?? 0));
}

/** A new key for a 🐟额 PLUS member: shown this once, never again. */
export async function createApiKey(
  env: ApiBindings,
  userId: string,
  input: CreateApiKeyInput,
) {
  if (!(await transferAccess(env, userId)).allowed)
    balanceError(
      403,
      "TRANSFER_NOT_ALLOWED",
      "开通🐟额 PLUS 才能新建开放接口密钥。",
    );
  const token = newToken();
  const id = crypto.randomUUID();
  const now = Date.now();
  const limit =
    input.dailyLimit === null ? null : amountToMinor(input.dailyLimit);
  const result = await env.DB.prepare(
    `INSERT INTO balance_api_keys (id,user_id,name,token_hash,last_four,daily_limit_minor,created_at)
    SELECT ?,?,?,?,?,?,?
    WHERE (SELECT COUNT(*) FROM balance_api_keys WHERE user_id=? AND revoked_at IS NULL) < ?`,
  )
    .bind(
      id,
      userId,
      input.name,
      await tokenDigest(token),
      token.slice(-4),
      limit,
      now,
      userId,
      BALANCE_LIMITS.apiKeysMax,
    )
    .run();
  if (!result.meta.changes)
    balanceError(
      409,
      "API_KEY_LIMIT",
      `最多 ${BALANCE_LIMITS.apiKeysMax} 个有效密钥，先停用不用的。`,
    );
  console.info(JSON.stringify({ event: "balance_api_key_created", keyId: id }));
  const row = await ownedApiKey(env, userId, id);
  return { key: apiKeyView(row, 0), token };
}

export async function ownedApiKey(
  env: ApiBindings,
  userId: string,
  id: string,
) {
  const row = await env.DB.prepare(
    "SELECT * FROM balance_api_keys WHERE id=? AND user_id=?",
  )
    .bind(id, userId)
    .first<ApiKeyRow>();
  if (!row) balanceError(404, "API_KEY_NOT_FOUND", "没有找到这个密钥");
  return row;
}

/** Its owner's stop: final. Stopping a stopped one changes nothing. */
export async function revokeOwnApiKey(
  env: ApiBindings,
  userId: string,
  id: string,
) {
  await ownedApiKey(env, userId, id);
  await env.DB.prepare(
    "UPDATE balance_api_keys SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL",
  )
    .bind(Date.now(), id, userId)
    .run();
  const row = await ownedApiKey(env, userId, id);
  return apiKeyView(row, 0);
}

/** An admin's stop of someone's key, with the reason its owner will read. */
export async function adminRevokeApiKey(
  env: ApiBindings,
  adminUserId: string,
  id: string,
  reason: string,
) {
  const result = await env.DB.prepare(
    `UPDATE balance_api_keys SET revoked_at=?,revoked_by_user_id=?,revoke_reason=?
    WHERE id=? AND revoked_at IS NULL`,
  )
    .bind(Date.now(), adminUserId, reason, id)
    .run();
  const row = await env.DB.prepare("SELECT * FROM balance_api_keys WHERE id=?")
    .bind(id)
    .first<ApiKeyRow>();
  if (!row) balanceError(404, "API_KEY_NOT_FOUND", "没有找到这个密钥");
  if (!result.meta.changes && row.revoked_at === null)
    throw new Error("API key stop did not apply");
  console.info(
    JSON.stringify({ event: "balance_api_key_admin_revoked", keyId: id }),
  );
  return apiKeyView(row, 0);
}

/** What a key sent today, in the last 7 days and ever. */
export async function apiKeyTotals(
  env: ApiBindings,
  row: ApiKeyRow,
): Promise<BalanceApiKeyTotals> {
  const now = Date.now();
  const sums = await env.DB.prepare(
    `SELECT COUNT(CASE WHEN created_at>=?2 THEN 1 END) AS today_count,
      COALESCE(SUM(CASE WHEN created_at>=?2 THEN amount_minor END),0) AS today_total,
      COUNT(*) AS week_count,COALESCE(SUM(amount_minor),0) AS week_total
    FROM balance_transfers WHERE api_key_id=?1 AND created_at>=?3`,
  )
    .bind(row.id, startOfBeijingDay(now), now - 7 * 86_400_000)
    .first<{
      today_count: number;
      today_total: number;
      week_count: number;
      week_total: number;
    }>();
  return {
    today: {
      count: sums?.today_count ?? 0,
      totalMinor: sums?.today_total ?? 0,
    },
    week: { count: sums?.week_count ?? 0, totalMinor: sums?.week_total ?? 0 },
    all: { count: row.transfer_count, totalMinor: row.transfer_total_minor },
  };
}

const KEY_PAGE = 20;

/** One key, as its owner opens it: totals and what it sent, 20 at a time. */
export async function apiKeyDetail(
  env: ApiBindings,
  userId: string,
  id: string,
  cursor?: string,
) {
  const row = await ownedApiKey(env, userId, id);
  const before = decodeRecordCursor(cursor);
  const [totals, today, page] = await Promise.all([
    apiKeyTotals(env, row),
    usedToday(env, [row.id]),
    env.DB.prepare(
      `SELECT * FROM balance_transfers WHERE api_key_id=?
        AND (?=0 OR created_at<? OR (created_at=? AND id<?))
      ORDER BY created_at DESC,id DESC LIMIT ?`,
    )
      .bind(
        row.id,
        before ? 1 : 0,
        before?.time ?? 0,
        before?.time ?? 0,
        before?.id ?? "",
        KEY_PAGE + 1,
      )
      .all<TransferRow>(),
  ]);
  const rows = page.results.slice(0, KEY_PAGE);
  const last = rows.at(-1);
  return {
    key: apiKeyView(row, today.get(row.id) ?? 0),
    totals,
    transfers: await transferViews(env, rows, userId),
    nextCursor:
      page.results.length > KEY_PAGE && last
        ? btoa(JSON.stringify({ time: last.created_at, id: last.id }))
        : null,
  };
}

/** The key behind an open API request, and its owner; or 401. */
export async function authenticateApiKey(
  env: ApiBindings,
  authorization: string | undefined,
) {
  const token = /^Bearer\s+(hbk_[A-Za-z0-9_-]{32})\s*$/.exec(
    authorization ?? "",
  )?.[1];
  const row = token
    ? await env.DB.prepare(
        `SELECT k.*,u.external_id AS owner_external_id,u.username AS owner_username
        FROM balance_api_keys k JOIN users u ON u.id=k.user_id
        WHERE k.token_hash=? AND k.revoked_at IS NULL`,
      )
        .bind(await tokenDigest(token))
        .first<
          ApiKeyRow & { owner_external_id: string; owner_username: string }
        >()
    : null;
  if (!row) throw new ActivityError(401, "INVALID_API_KEY", "密钥不对或已停用");
  const { owner_external_id, owner_username, ...key } = row;
  return {
    key: key as ApiKeyRow,
    owner: { externalId: owner_external_id, username: owner_username },
  };
}
