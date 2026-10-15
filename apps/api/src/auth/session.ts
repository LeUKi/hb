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
import {
  decryptString,
  encryptString,
  randomToken,
  sha256Hex,
} from "../security/crypto";
import {
  assertExactOrigin,
  requireAppOrigin,
  secureCookiesForOrigin,
} from "../security/http";

export const SESSION_COOKIE = "hb_session";
export const IMAGE_SESSION_COOKIE = "__Host-hb_image_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
};

export type AuthenticatedSession = {
  tokenHash: string;
  csrfToken: string;
  expiresAt: Date;
  user: AuthenticatedUser;
  attemptCooldown: AttemptCooldown;
};

export async function createSession(c: Context<ApiContext>, userId: string) {
  const appOrigin = requireAppOrigin(c.env);
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

  const statements = [
    c.env.DB.prepare(`INSERT INTO sessions
      (token_hash,user_id,csrf_token,created_at,expires_at,last_seen_at)
      VALUES (?,?,?,?,?,?)`).bind(
      tokenHash,
      userId,
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
  await c.env.DB.batch(statements);

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookiesForOrigin(appOrigin),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  await setImageSessionCookie(c, { tokenHash, expiresAt });

  return { csrfToken, expiresAt };
}

export async function setImageSessionCookie(
  c: Context<ApiContext>,
  session: Pick<AuthenticatedSession, "tokenHash" | "expiresAt">,
) {
  const appOrigin = requireAppOrigin(c.env);
  const now = Date.now();
  const maxAge = Math.max(
    0,
    Math.floor((session.expiresAt.getTime() - now) / 1000),
  );
  if (maxAge <= 0) {
    clearImageSessionCookie(c);
    return;
  }
  const value = await encryptStringCookie(
    JSON.stringify({
      v: 1,
      tokenHash: session.tokenHash,
      expiresAt: session.expiresAt.getTime(),
    }),
    c.env,
    imageSessionAssociatedData(appOrigin),
  );
  setCookie(c, IMAGE_SESSION_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: "/",
    maxAge: Math.min(maxAge, SESSION_TTL_SECONDS),
  });
}

export async function getReadOnlyImageSession(c: Context<ApiContext>) {
  const appOrigin = requireAppOrigin(c.env);
  const mainToken = getCookie(c, SESSION_COOKIE);
  if (mainToken !== undefined) {
    if (!isCookieToken(mainToken)) return null;
    return readOnlyImageSessionByHash(c, await hashSessionToken(mainToken));
  }
  const imageCookie = getCookie(c, IMAGE_SESSION_COOKIE);
  if (!imageCookie) return null;
  let payload: { v?: unknown; tokenHash?: unknown; expiresAt?: unknown };
  try {
    payload = JSON.parse(
      await decryptStringCookie(
        imageCookie,
        c.env,
        imageSessionAssociatedData(appOrigin),
      ),
    ) as typeof payload;
  } catch {
    return null;
  }
  if (
    payload.v !== 1 ||
    typeof payload.tokenHash !== "string" ||
    typeof payload.expiresAt !== "number" ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= Date.now()
  ) {
    return null;
  }
  const session = await readOnlyImageSessionByHash(c, payload.tokenHash);
  if (!session || session.expiresAt.getTime() !== payload.expiresAt)
    return null;
  return session;
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
      avatarUrl: users.avatarUrl,
      active: users.active,
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
    user: {
      id: row.userId,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
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
  clearImageSessionCookie(c);
}

export function clearSessionCookie(c: Context<ApiContext>) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function clearImageSessionCookie(c: Context<ApiContext>) {
  deleteCookie(c, IMAGE_SESSION_COOKIE, {
    path: "/",
    secure: true,
    sameSite: "None",
  });
}

export async function hashSessionToken(token: string) {
  return sha256Hex(`hb.session-token.v1:${token}`);
}

function isCookieToken(value: string) {
  return /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

async function readOnlyImageSessionByHash(
  c: Context<ApiContext>,
  tokenHash: string,
): Promise<
  | (Pick<AuthenticatedSession, "tokenHash" | "expiresAt"> & {
      user: Pick<AuthenticatedUser, "id">;
    })
  | null
> {
  const now = new Date();
  const row = await createDb(c.env.DB)
    .select({
      tokenHash: sessions.tokenHash,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      active: users.active,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .get();
  if (!row?.active) return null;
  return {
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    user: { id: row.userId },
  };
}

function imageSessionAssociatedData(appOrigin: string) {
  return `image-session:${appOrigin}`;
}

async function encryptStringCookie(
  plaintext: string,
  env: { ENCRYPTION_KEYS?: string; ENCRYPTION_KEY_VERSION?: string },
  associatedData: string,
) {
  return base64UrlEncode(
    new TextEncoder().encode(
      await encryptString(plaintext, env, associatedData),
    ),
  );
}

async function decryptStringCookie(
  value: string,
  env: { ENCRYPTION_KEYS?: string },
  associatedData: string,
) {
  return decryptString(
    new TextDecoder().decode(base64UrlDecode(value)),
    env,
    associatedData,
  );
}

function base64UrlEncode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string) {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
