// A sender's key at an issuer (docs/third-party-points-design.md §8): one
// each per points system, checked with 额度 when pasted, kept encrypted.
// Whose account it pays from is the issuer's word: shown, not required to
// be the sender's own (§1).

import type { ApiBindings } from "../env";
import { decryptString, encryptString } from "../security/crypto";
import { issuerBalance } from "./issuer";
import { maskKey } from "./protocol";
import {
  endOpenStatements,
  type PointsSystemRow,
  pointsError,
  requireSystem,
} from "./systems";

export type PointsKeyRow = {
  id: string;
  system_id: string;
  author_id: string;
  version: number;
  ciphertext: string;
  account_id: string | null;
  account_username: string | null;
  status: "ok" | "invalid";
  checked_at: number;
  removed_at: number | null;
  created_at: number;
  updated_at: number;
};

const keyAad = (id: string, version: number) => `points-key:${id}:${version}`;

export async function readKey(
  env: ApiBindings,
  systemId: string,
  authorId: string,
) {
  return env.DB.prepare(
    `SELECT * FROM points_keys WHERE system_id=? AND author_id=? AND removed_at IS NULL`,
  )
    .bind(systemId, authorId)
    .first<PointsKeyRow>();
}

export function keySecret(env: ApiBindings, row: PointsKeyRow) {
  return decryptString(row.ciphertext, env, keyAad(row.id, row.version));
}

export function keyView(row: PointsKeyRow | null) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    accountUsername: row.account_username,
    status: row.status,
    checkedAt: row.checked_at,
    updatedAt: row.updated_at,
  };
}
export type PointsKeyView = NonNullable<ReturnType<typeof keyView>>;

function usable(system: PointsSystemRow) {
  if (system.status !== "online")
    pointsError(409, "POINTS_NOT_ONLINE", "这种三方积分现在没有上线");
}

/** Paste (or replace) one's key: checked with 额度 first (§8). */
export async function saveKey(
  env: ApiBindings,
  userId: string,
  systemId: string,
  key: string,
) {
  const system = await requireSystem(env, systemId);
  usable(system);
  const target = { id: system.id, baseUrl: system.base_url };
  const answer = await issuerBalance(env, target, key);
  if (answer.kind === "key_invalid")
    pointsError(400, "POINTS_KEY_INVALID", `${system.host} 说这把密钥无效`);
  if (answer.kind === "missed")
    pointsError(
      503,
      "POINTS_ISSUER_UNREACHABLE",
      `暂时连不上 ${system.host}，请稍后再试`,
    );
  if (answer.kind === "bad_answer")
    pointsError(
      503,
      "POINTS_ISSUER_BAD_ANSWER",
      `${system.host} 的回复看不懂，请联系发行方`,
    );
  const now = Date.now();
  const existing = await readKey(env, systemId, userId);
  const id = existing?.id ?? crypto.randomUUID();
  const version = (existing?.version ?? 0) + 1;
  const ciphertext = await encryptString(key, env, keyAad(id, version));
  if (existing) {
    const result = await env.DB.prepare(
      `UPDATE points_keys SET version=?1,ciphertext=?2,account_id=?3,account_username=?4,
        status='ok',checked_at=?5,updated_at=?5 WHERE id=?6 AND version=?7 AND removed_at IS NULL`,
    )
      .bind(
        version,
        ciphertext,
        answer.accountId,
        answer.accountUsername,
        now,
        id,
        existing.version,
      )
      .run();
    if (!result.meta.changes)
      pointsError(409, "POINTS_KEY_CONFLICT", "密钥刚被改过，请刷新后重试");
  } else {
    await env.DB.prepare(
      `INSERT INTO points_keys (id,system_id,author_id,version,ciphertext,account_id,
        account_username,status,checked_at,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'ok',?8,?8,?8)`,
    )
      .bind(
        id,
        systemId,
        userId,
        version,
        ciphertext,
        answer.accountId,
        answer.accountUsername,
        now,
      )
      .run()
      .catch(() =>
        pointsError(409, "POINTS_KEY_CONFLICT", "密钥刚被改过，请刷新后重试"),
      );
  }
  console.info(
    JSON.stringify({
      event: "points_key_saved",
      systemId,
      userId: userId.slice(0, 8),
      key: maskKey(key),
    }),
  );
  return {
    key: keyView(await readKey(env, systemId, userId)),
    available: answer.available,
  };
}

/** 删掉密钥: the 红包 it pays for end at once (§8). */
export async function removeKey(
  env: ApiBindings,
  userId: string,
  systemId: string,
) {
  const existing = await readKey(env, systemId, userId);
  if (!existing) return { removed: false };
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE points_keys SET removed_at=?1,updated_at=?1 WHERE id=?2 AND removed_at IS NULL",
    ).bind(now, existing.id),
    endOpenStatements(env, systemId, "key_removed", userId),
  ]);
  return { removed: true };
}

/** 额度 now, with the saved key: for the form and the opening check. */
export async function availableNow(
  env: ApiBindings,
  userId: string,
  system: PointsSystemRow,
) {
  const row = await readKey(env, system.id, userId);
  if (!row) return { kind: "no_key" as const };
  const secret = await keySecret(env, row);
  const answer = await issuerBalance(
    env,
    { id: system.id, baseUrl: system.base_url },
    secret,
  );
  const now = Date.now();
  if (answer.kind === "ok" || answer.kind === "key_invalid")
    await env.DB.prepare(
      `UPDATE points_keys SET status=?1,checked_at=?2,
        account_id=COALESCE(?3,account_id),account_username=COALESCE(?4,account_username)
       WHERE id=?5 AND version=?6`,
    )
      .bind(
        answer.kind === "ok" ? "ok" : "invalid",
        now,
        answer.kind === "ok" ? answer.accountId : null,
        answer.kind === "ok" ? answer.accountUsername : null,
        row.id,
        row.version,
      )
      .run();
  if (answer.kind === "ok")
    return {
      kind: "ok" as const,
      available: answer.available,
      accountId: answer.accountId,
      accountUsername: answer.accountUsername,
    };
  if (answer.kind === "key_invalid") return { kind: "key_invalid" as const };
  return { kind: "unreachable" as const };
}

/**
 * What the sender's other open 红包 of this system may still pay (§5):
 * their pools less what was paid, refused for good, or claimed by the
 * sender (自领 pays nothing).
 */
export async function committedElsewhere(
  env: ApiBindings,
  userId: string,
  systemId: string,
  exceptActivityId: string,
) {
  const rows = await env.DB.prepare(
    `SELECT a.id,
       CAST(ROUND(CAST(json_extract(a.config,'$.money.totalAmount') AS REAL)*100) AS INTEGER) AS pool,
       COALESCE((SELECT SUM(p.amount_minor) FROM points_payments p
         WHERE p.activity_id=a.id AND p.status IN ('confirmed','failed')),0) AS settled,
       COALESCE((SELECT SUM(r.amount_minor) FROM claims c
         JOIN reward_inventory r ON r.id=c.inventory_id AND r.activity_id=c.activity_id
         WHERE c.activity_id=a.id AND c.user_id=a.author_id),0) AS own
     FROM activities a
     WHERE a.author_id=?1 AND a.points_system_id=?2 AND a.funding='points' AND a.id<>?3
       AND a.opened_at IS NOT NULL AND a.ended_at IS NULL AND a.deleted_at IS NULL`,
  )
    .bind(userId, systemId, exceptActivityId)
    .all<{ id: string; pool: number; settled: number; own: number }>();
  return rows.results.reduce(
    (sum, row) => sum + Math.max(0, row.pool - row.settled - row.own),
    0,
  );
}
