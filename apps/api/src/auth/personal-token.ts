// 个人令牌 (docs/personal-token-design.md): someone's own token for scripts
// and clients that cannot carry the site's cookie. It stands for that one
// account, nothing else, and is good only on the routes that ask for an
// actor (requireActor, requireActorMutation): reading one's own records,
// 领取, 口令兑换 and 附带网页认人. Everything else still wants the cookie,
// the exact Origin and CSRF, as before; human checks are not skipped.
//
// A token is shown once, as it is made; only its digest is kept. It runs out
// at its expiry; its owner stops it, or an admin with a reason; a stop is
// final. Ten in use at most, for anyone signed in.
import {
  type ClaimResult,
  type CreatePersonalTokenInput,
  PERSONAL_TOKEN_LIMITS,
  PERSONAL_TOKEN_PREFIX,
  type PersonalToken,
} from "@hb/contracts";
import type { Context } from "hono";
import { ActivityError } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import { RateLimitedError } from "../balance/errors";
import type { ApiBindings, ApiContext } from "../env";
import { sha256Hex } from "../security/crypto";
import {
  type AccountRow,
  type AuthenticatedSession,
  accountOf,
  getOptionalSession,
  requireAuth,
  requireProtectedMutation,
} from "./session";

export type PersonalTokenRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  last_four: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  last_used_ip: string | null;
  use_count: number;
  revoked_at: number | null;
  revoked_by_user_id: string | null;
  revoke_reason: string | null;
};

const DAY_MS = 86_400_000;
/** Its last use is written at most this often (one write a minute, not one a request). */
const TOUCH_INTERVAL_MS = 60_000;
const TOKEN_PATTERN = /^Bearer\s+(hbp_[A-Za-z0-9_-]{32})\s*$/;

const tokenDigest = (token: string) => sha256Hex(`personal-token:${token}`);

function newToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `${PERSONAL_TOKEN_PREFIX}${btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;
}

function tokenError(
  status: 401 | 403 | 404 | 409,
  code: string,
  message: string,
): never {
  throw new ActivityError(status, code, message);
}

export function personalTokenView(
  row: PersonalTokenRow,
  now = Date.now(),
): PersonalToken {
  return {
    id: row.id,
    name: row.name,
    lastFour: row.last_four,
    status:
      row.revoked_at !== null
        ? row.revoked_by_user_id !== null
          ? "admin_revoked"
          : "revoked"
        : row.expires_at <= now
          ? "expired"
          : "active",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    useCount: row.use_count,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
  };
}

/** Someone's tokens: in use first, newest first. */
export async function listPersonalTokens(env: ApiBindings, userId: string) {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT * FROM personal_tokens WHERE user_id=?
    ORDER BY (revoked_at IS NULL AND expires_at>?) DESC,created_at DESC,id DESC LIMIT 50`,
  )
    .bind(userId, now)
    .all<PersonalTokenRow>();
  return rows.results.map((row) => personalTokenView(row, now));
}

async function ownedPersonalToken(
  env: ApiBindings,
  userId: string,
  id: string,
) {
  const row = await env.DB.prepare(
    "SELECT * FROM personal_tokens WHERE id=? AND user_id=?",
  )
    .bind(id, userId)
    .first<PersonalTokenRow>();
  if (!row) tokenError(404, "PERSONAL_TOKEN_NOT_FOUND", "没有找到这个令牌");
  return row;
}

/** A new token for anyone signed in: shown this once, never again. */
export async function createPersonalToken(
  env: ApiBindings,
  userId: string,
  input: CreatePersonalTokenInput,
) {
  const token = newToken();
  const id = crypto.randomUUID();
  const now = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO personal_tokens (id,user_id,name,token_hash,last_four,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?
    WHERE (SELECT COUNT(*) FROM personal_tokens
      WHERE user_id=? AND revoked_at IS NULL AND expires_at>?) < ?`,
  )
    .bind(
      id,
      userId,
      input.name,
      await tokenDigest(token),
      token.slice(-4),
      now,
      now + input.lifetimeDays * DAY_MS,
      userId,
      now,
      PERSONAL_TOKEN_LIMITS.activeMax,
    )
    .run();
  if (!result.meta.changes)
    tokenError(
      409,
      "PERSONAL_TOKEN_LIMIT",
      `最多 ${PERSONAL_TOKEN_LIMITS.activeMax} 个有效令牌，先停用不用的。`,
    );
  console.info(
    JSON.stringify({ event: "personal_token_created", tokenId: id }),
  );
  return {
    token,
    personalToken: personalTokenView(
      await ownedPersonalToken(env, userId, id),
      now,
    ),
  };
}

/** Its owner's stop: final. Stopping a stopped one changes nothing. */
export async function revokeOwnPersonalToken(
  env: ApiBindings,
  userId: string,
  id: string,
) {
  await ownedPersonalToken(env, userId, id);
  await env.DB.prepare(
    "UPDATE personal_tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL",
  )
    .bind(Date.now(), id, userId)
    .run();
  console.info(
    JSON.stringify({ event: "personal_token_revoked", tokenId: id }),
  );
  return personalTokenView(await ownedPersonalToken(env, userId, id));
}

/** An admin's stop of someone's token, with the reason its owner will read. */
export async function adminRevokePersonalToken(
  env: ApiBindings,
  adminUserId: string,
  id: string,
  reason: string,
) {
  const result = await env.DB.prepare(
    `UPDATE personal_tokens SET revoked_at=?,revoked_by_user_id=?,revoke_reason=?
    WHERE id=? AND revoked_at IS NULL`,
  )
    .bind(Date.now(), adminUserId, reason, id)
    .run();
  const row = await env.DB.prepare("SELECT * FROM personal_tokens WHERE id=?")
    .bind(id)
    .first<PersonalTokenRow>();
  if (!row) tokenError(404, "PERSONAL_TOKEN_NOT_FOUND", "没有找到这个令牌");
  if (!result.meta.changes)
    tokenError(409, "PERSONAL_TOKEN_STOPPED", "这个令牌已经停用");
  console.info(
    JSON.stringify({ event: "personal_token_admin_revoked", tokenId: id }),
  );
  return personalTokenView(row);
}

type TokenAccountRow = AccountRow & {
  tokensOn: number;
  tokenId: string;
  tokenExpiresAt: number;
  lastUsedAt: number | null;
  active: number;
};

/**
 * The account behind a request's `Authorization: Bearer hbp_…`; null when
 * the request has no Bearer header at all. A Bearer header that is not a
 * token in use, of an account in use, is a 401: never the cookie instead.
 */
export function personalTokenSession(
  c: Context<ApiContext>,
): Promise<AuthenticatedSession | null> {
  // Once a request: a route may ask twice, the limit counts once.
  const known = asked.get(c.req.raw);
  if (known) return known;
  const answer = tokenSessionOf(c);
  asked.set(c.req.raw, answer);
  return answer;
}

const asked = new WeakMap<Request, Promise<AuthenticatedSession | null>>();

/** What a request with a token asks for, as it is limited and counted (§8). */
export type TokenRequestKind = "read" | "square" | "claim" | "identity";

export function tokenRequestKind(
  method: string,
  path: string,
): TokenRequestKind {
  if (method === "POST" && /\/page-identity$/.test(path)) return "identity";
  if (
    method === "POST" &&
    (/^\/api\/activities\/[^/]+\/claim$/.test(path) ||
      /^\/api\/redemptions(\/discover)?$/.test(path))
  )
    return "claim";
  if (path === "/api/discovery/activities") return "square";
  return "read";
}

function limiterOf(env: ApiBindings, kind: TokenRequestKind) {
  return {
    read: env.TOKEN_READS,
    square: env.TOKEN_SQUARE,
    claim: env.TOKEN_CLAIMS,
    identity: env.TOKEN_IDENTITY,
  }[kind] as RateLimit | undefined;
}

/** One data point a request (§8): whose, what, and how it went. */
function countTokenRequest(
  env: ApiBindings,
  userId: string,
  tokenId: string,
  kind: TokenRequestKind,
  outcome: "ok" | "limited" | "paused",
) {
  try {
    env.TOKEN_EVENTS?.writeDataPoint({
      indexes: [userId],
      blobs: [kind, outcome, tokenId],
      doubles: [1],
    });
  } catch {}
}

async function tokenSessionOf(
  c: Context<ApiContext>,
): Promise<AuthenticatedSession | null> {
  const authorization = c.req.header("Authorization");
  if (authorization === undefined || !/^Bearer\s/i.test(authorization))
    return null;
  const token = TOKEN_PATTERN.exec(authorization)?.[1];
  const now = Date.now();
  const row = token
    ? await c.env.DB.prepare(
        `SELECT t.id AS tokenId,t.expires_at AS tokenExpiresAt,t.last_used_at AS lastUsedAt,
          u.id AS userId,u.username,u.display_name AS displayName,u.avatar_url AS avatarUrl,
          u.trust_level AS trustLevel,u.profile_seen_at AS profileSeenAt,u.provider,
          u.external_id AS externalId,u.active,
          cd.revision AS cooldownRevision,cd.next_allowed_at AS nextAllowedAt,
          ${databaseNow} AS serverTime,
          COALESCE((SELECT enabled FROM personal_token_settings WHERE id='global'),1) AS tokensOn
        FROM personal_tokens t JOIN users u ON u.id=t.user_id
        LEFT JOIN account_attempt_cooldowns cd ON cd.user_id=u.id
        WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?`,
      )
        .bind(await tokenDigest(token), now)
        .first<
          Omit<TokenAccountRow, "profileSeenAt"> & {
            profileSeenAt: number | null;
          }
        >()
    : null;
  if (!row?.active)
    tokenError(401, "INVALID_PERSONAL_TOKEN", "令牌不对、已过期或已停用");
  // The 站长's switch, then this account's share of a minute (§8).
  const kind = tokenRequestKind(c.req.method, new URL(c.req.url).pathname);
  if (!row.tokensOn) {
    countTokenRequest(c.env, row.userId, row.tokenId, kind, "paused");
    tokenError(
      403,
      "PERSONAL_TOKENS_PAUSED",
      "个人令牌暂时停用了，请在网页上操作。",
    );
  }
  const limiter = limiterOf(c.env, kind);
  if (limiter && !(await limiter.limit({ key: row.userId })).success) {
    countTokenRequest(c.env, row.userId, row.tokenId, kind, "limited");
    throw new RateLimitedError(60, "尝试过于频繁，请稍后再试。");
  }
  countTokenRequest(c.env, row.userId, row.tokenId, kind, "ok");
  if (row.lastUsedAt === null || now - row.lastUsedAt >= TOUCH_INTERVAL_MS)
    await c.env.DB.prepare(
      `UPDATE personal_tokens SET last_used_at=?,last_used_ip=?,use_count=use_count+1
      WHERE id=? AND revoked_at IS NULL`,
    )
      .bind(now, c.req.header("CF-Connecting-IP") ?? null, row.tokenId)
      .run();
  console.info(
    JSON.stringify({
      event: "personal_token_request",
      tokenId: row.tokenId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    }),
  );
  c.set("userId", row.userId);
  return {
    tokenHash: `personal-token:${row.tokenId}`,
    csrfToken: "",
    expiresAt: new Date(row.tokenExpiresAt),
    personalTokenId: row.tokenId,
    ...accountOf(c, {
      ...row,
      profileSeenAt:
        row.profileSeenAt === null ? null : new Date(row.profileSeenAt),
    }),
  };
}

/** The cookie session, or a 个人令牌's account; null when neither. */
export async function getOptionalActor(
  c: Context<ApiContext>,
): Promise<AuthenticatedSession | null> {
  return (await personalTokenSession(c)) ?? getOptionalSession(c);
}

/** A read a 个人令牌 may make: the token's account, or the cookie session. */
export async function requireActor(
  c: Context<ApiContext>,
): Promise<AuthenticatedSession> {
  return (await personalTokenSession(c)) ?? requireAuth(c);
}

/**
 * A write a 个人令牌 may make. With a token there is no cookie to forge, so
 * Origin and CSRF guard only the cookie session, exactly as before.
 */
export async function requireActorMutation(
  c: Context<ApiContext>,
): Promise<AuthenticatedSession> {
  return (await personalTokenSession(c)) ?? requireProtectedMutation(c);
}

/**
 * A claim made with a 个人令牌 says so (claims.via, activity_registrations.via;
 * the 名单 marks it, §8): written after, as the 社区小程序's are when its
 * line did not. A 限时开奖's prize takes its sign-up's mark when drawn.
 */
export async function markTokenClaim(
  env: ApiBindings,
  userId: string,
  result: ClaimResult,
) {
  const claimId =
    result.result === "claimed"
      ? result.claim.id
      : result.result === "judged"
        ? (result.settled?.claim?.id ?? null)
        : null;
  if (claimId)
    await env.DB.prepare(
      "UPDATE claims SET via='token' WHERE id=? AND user_id=? AND via IS NULL",
    )
      .bind(claimId, userId)
      .run();
  else if (result.result === "registered")
    await env.DB.prepare(
      "UPDATE activity_registrations SET via='token' WHERE id=? AND user_id=? AND via IS NULL",
    )
      .bind(result.registration.id, userId)
      .run();
}

/** Told to a 口令兑换's Durable Object: this one came with a token (§8). */
export const TOKEN_REQUEST_HEADER = "X-Hb-Personal-Token";

/** 允许用令牌领 off: a request with a token stops here (§8). */
export function refuseTokenOn(
  session: AuthenticatedSession,
  activity: { allowTokens: boolean },
) {
  if (session.personalTokenId !== undefined && !activity.allowTokens)
    tokenError(
      403,
      "TOKEN_CLAIMS_OFF",
      "红包作者关了“允许用令牌领”，这个红包只能在网页上领。",
    );
}
