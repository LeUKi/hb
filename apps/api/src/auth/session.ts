import type { AttemptCooldown } from "@hb/contracts";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { databaseNow } from "../activities/lifecycle";
import { isAdministrator } from "../admin/authorization";
import { createDb } from "../db/client";
import { accountAttemptCooldowns, sessions, users } from "../db/schema";
import type { ApiContext } from "../env";
import { randomToken, sha256Hex } from "../security/crypto";
import {
  assertExactOrigin,
  requireAppOrigin,
  secureCookiesForOrigin,
} from "../security/http";
import { liteAuthLoginGuard, requireLiteAuthLogin } from "./login-settings";

export const SESSION_COOKIE = "hb_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export type LoginProvider = "connect" | "liteauth";

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  accountTier: "standard" | "lite";
  canUseLdc: boolean;
  isAdmin: boolean;
};

export type AuthenticatedSession = {
  tokenHash: string;
  csrfToken: string;
  expiresAt: Date;
  loginProvider: LoginProvider;
  user: AuthenticatedUser;
  attemptCooldown: AttemptCooldown;
};

export type SessionUser =
  | string
  | {
      provider: string;
      externalId: string;
      statement: D1PreparedStatement;
    };

export async function createSession(
  c: Context<ApiContext>,
  user: SessionUser,
  loginProvider: LoginProvider = "connect",
  liteAuthVersion?: number,
) {
  const appOrigin = requireAppOrigin(c.env);
  const expectedVersion =
    loginProvider === "liteauth"
      ? (liteAuthVersion ?? (await requireLiteAuthLogin(c.env)))
      : undefined;
  const currentToken = getCookie(c, SESSION_COOKIE);
  const previousTokenHash =
    currentToken && isCookieToken(currentToken)
      ? await hashSessionToken(currentToken)
      : null;

  const token = await randomToken(32);
  const tokenHash = await hashSessionToken(token);
  const csrfToken = await randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  const userIdSql =
    typeof user === "string"
      ? "?"
      : "(SELECT id FROM users WHERE provider=? AND external_id=? AND active=1)";
  const userIdValues =
    typeof user === "string" ? [user] : [user.provider, user.externalId];

  const statements = [
    ...(expectedVersion === undefined
      ? []
      : [liteAuthLoginGuard(c.env, expectedVersion)]),
    ...(typeof user === "string" ? [] : [user.statement]),
    c.env.DB.prepare(`INSERT INTO sessions
      (token_hash,user_id,login_provider,csrf_token,created_at,expires_at,last_seen_at)
      VALUES (?,${userIdSql},?,?,?,?,?)`).bind(
      tokenHash,
      ...userIdValues,
      loginProvider,
      csrfToken,
      now.getTime(),
      expiresAt.getTime(),
      now.getTime(),
    ),
  ];
  if (previousTokenHash)
    statements.push(
      c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(
        previousTokenHash,
      ),
    );
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    if (expectedVersion !== undefined)
      await requireLiteAuthLogin(c.env, expectedVersion);
    throw error;
  }

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookiesForOrigin(appOrigin),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return { csrfToken, expiresAt };
}

export async function getOptionalSession(c: Context<ApiContext>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return null;
  }

  if (!isCookieToken(token)) {
    clearSessionCookie(c);
    return null;
  }

  const tokenHash = await hashSessionToken(token);
  const now = new Date();
  const db = createDb(c.env.DB);
  const row = await db
    .select({
      tokenHash: sessions.tokenHash,
      csrfToken: sessions.csrfToken,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      loginProvider: sessions.loginProvider,
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      active: users.active,
      officialConnectVerified: users.officialConnectVerified,
      provider: users.provider,
      externalId: users.externalId,
      cooldownRevision: accountAttemptCooldowns.revision,
      nextAllowedAt: accountAttemptCooldowns.nextAllowedAt,
      serverTime: sql<number>`${sql.raw(databaseNow)}`,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .leftJoin(
      accountAttemptCooldowns,
      eq(accountAttemptCooldowns.userId, users.id),
    )
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .get();

  if (!row?.active) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    clearSessionCookie(c);
    return null;
  }

  if (now.getTime() - row.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(eq(sessions.tokenHash, tokenHash));
  }

  c.set("userId", row.userId);

  return {
    tokenHash: row.tokenHash,
    csrfToken: row.csrfToken,
    expiresAt: row.expiresAt,
    loginProvider: row.loginProvider,
    user: {
      id: row.userId,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      accountTier: row.officialConnectVerified ? "standard" : "lite",
      canUseLdc: row.officialConnectVerified,
      isAdmin: isAdministrator(c.env, row.provider, row.externalId),
    },
    attemptCooldown: {
      revision: row.cooldownRevision ?? 0,
      serverTime: row.serverTime,
      nextAllowedAt: row.nextAllowedAt ?? 0,
    },
  } satisfies AuthenticatedSession;
}

export async function requireAuth(c: Context<ApiContext>) {
  const session = await getOptionalSession(c);
  if (!session) {
    throw new HTTPException(401, { message: "Authentication required" });
  }
  return session;
}

export async function requireAdmin(c: Context<ApiContext>) {
  const session = await requireAuth(c);
  if (!session.user.isAdmin)
    throw new HTTPException(403, { message: "此页面仅限管理员访问" });
  return session;
}

export function requireOwner(
  sessionOrUser: AuthenticatedSession | AuthenticatedUser,
  ownerUserId: string,
) {
  const userId =
    "user" in sessionOrUser ? sessionOrUser.user.id : sessionOrUser.id;
  if (userId !== ownerUserId) {
    throw new HTTPException(403, { message: "Owner access required" });
  }
}

export function assertCsrf(
  c: Context<ApiContext>,
  session: AuthenticatedSession,
) {
  if (c.req.header("X-CSRF-Token") !== session.csrfToken) {
    throw new HTTPException(403, { message: "Invalid CSRF token" });
  }
}

export async function requireProtectedMutation(c: Context<ApiContext>) {
  assertExactOrigin(c);
  const session = await requireAuth(c);
  assertCsrf(c, session);
  return session;
}

export async function logout(c: Context<ApiContext>) {
  assertExactOrigin(c);
  const session = await getOptionalSession(c);
  if (session) {
    assertCsrf(c, session);
    await createDb(c.env.DB)
      .delete(sessions)
      .where(eq(sessions.tokenHash, session.tokenHash));
  }
  clearSessionCookie(c);
}

export function clearSessionCookie(c: Context<ApiContext>) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

async function hashSessionToken(token: string) {
  return sha256Hex(`hb.session-token.v1:${token}`);
}

function isCookieToken(value: string) {
  return /^[A-Za-z0-9_-]{32,256}$/.test(value);
}
