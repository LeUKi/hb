import { and, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { createDb } from "../db/client";
import { sessions, users } from "../db/schema";
import type { ApiContext } from "../env";
import { randomToken, sha256Hex } from "../security/crypto";
import {
  assertExactOrigin,
  requireAppOrigin,
  secureCookiesForOrigin,
} from "../security/http";

export const SESSION_COOKIE = "hb_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
};

export type AuthenticatedSession = {
  tokenHash: string;
  csrfToken: string;
  expiresAt: Date;
  user: AuthenticatedUser;
};

export async function createSession(c: Context<ApiContext>, userId: string) {
  const appOrigin = requireAppOrigin(c.env);
  await revokeCurrentSession(c);

  const token = await randomToken(32);
  const tokenHash = await hashSessionToken(token);
  const csrfToken = await randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  await createDb(c.env.DB).insert(sessions).values({
    tokenHash,
    userId,
    csrfToken,
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
  });

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
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      active: users.active,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
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
    user: {
      id: row.userId,
      username: row.username,
      displayName: row.displayName,
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

async function revokeCurrentSession(c: Context<ApiContext>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !isCookieToken(token)) {
    return;
  }

  await createDb(c.env.DB)
    .delete(sessions)
    .where(eq(sessions.tokenHash, await hashSessionToken(token)));
}

async function hashSessionToken(token: string) {
  return sha256Hex(`hb.session-token.v1:${token}`);
}

function isCookieToken(value: string) {
  return /^[A-Za-z0-9_-]{32,256}$/.test(value);
}
