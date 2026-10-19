import { normalizeAvatarUrl, normalizeConnectEmail } from "@hb/contracts";
import { and, eq, gt } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { balanceAccessFor } from "../balance/settings";
import { createDb } from "../db/client";
import { oauthAttempts, users } from "../db/schema";
import type { ApiBindings, ApiContext } from "../env";
import {
  decryptString,
  encryptString,
  randomToken,
  sha256Hex,
} from "../security/crypto";
import {
  assertRequestUrlOrigin,
  configuredAppOrigin,
  redirectWithAuthError,
  safeRelativeReturnTo,
  secureCookiesForOrigin,
} from "../security/http";
import {
  createSession,
  getOptionalSession,
  logout,
  setImageSessionCookie,
} from "./session";

const CONNECT = {
  authorizeUrl: "https://connect.linux.do/oauth2/authorize",
  tokenUrl: "https://connect.linux.do/oauth2/token",
  userUrl: "https://connect.linux.do/api/user",
  cookieName: "hb_oauth_state",
  callbackPath: "/api/auth/callback",
  scope: "profile email",
} as const;
const OAUTH_STATE_TTL_SECONDS = 60 * 10;
const OAUTH_PROVIDER = "linux_do";
const FETCH_TIMEOUT_MS = 20000;

type AuthFlowStage = "token" | "profile" | "persistence" | "session";
type AuthFlowReason = "network" | "timeout" | "http" | "invalid_response";

class AuthFlowError extends Error {
  constructor(
    readonly stage: AuthFlowStage,
    readonly reason: AuthFlowReason,
    readonly httpStatus?: number,
  ) {
    super("OAuth flow failed");
    this.name = "AuthFlowError";
  }
}

export const authRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    await next();
    const cacheControl = c.res.headers.get("Cache-Control") ?? "";
    if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl))
      c.header("Cache-Control", "no-store");
  })
  .get("/auth/login", (c) => beginAuthorization(c))
  .get("/auth/callback", (c) => completeAuthorization(c))
  .post("/auth/logout", async (c) => {
    await logout(c);
    return c.json({ ok: true });
  })
  .get("/session", async (c) => {
    const session = await getOptionalSession(c);
    if (!session) {
      return c.json({ user: null, csrfToken: null, attemptCooldown: null });
    }
    if (isFirstPartySessionRead(c)) await setImageSessionCookie(c, session);

    return c.json({
      user: {
        ...session.user,
        /** 🐟额's entry shows (the allowlist, until it is open to all). */
        balance: (
          await balanceAccessFor(c.env, session.user.id, session.user.isAdmin)
        ).entry,
      },
      csrfToken: session.csrfToken,
      attemptCooldown: session.attemptCooldown,
    });
  })
  .get("/me", async (c) => {
    const session = await getOptionalSession(c);
    if (!session) {
      return c.json({ user: null, csrfToken: null });
    }

    const privateProfile = await createDb(c.env.DB)
      .select({
        provider: users.provider,
        externalId: users.externalId,
        emailCiphertext: users.emailCiphertext,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .get();
    const email = privateProfile?.emailCiphertext
      ? await decryptEmail(
          c.env,
          privateProfile.emailCiphertext,
          privateProfile.provider,
          privateProfile.externalId,
        )
      : null;

    const { isAdmin: _isAdmin, ...profileUser } = session.user;
    return c.json({
      user: { ...profileUser, email },
      csrfToken: session.csrfToken,
    });
  });

function isFirstPartySessionRead(c: import("hono").Context<ApiContext>) {
  const site = c.req.header("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "same-site" && site !== "none")
    return false;
  const origin = c.req.header("Origin");
  return !origin || origin === c.env.APP_ORIGIN;
}

async function beginAuthorization(c: Context<ApiContext>) {
  const config = oauthConfig(c.env);
  if (!config) {
    if (c.req.header("Accept")?.includes("text/html")) {
      return redirectWithAuthError(c, "auth_not_configured");
    }
    return c.json(
      {
        error: {
          code: "AUTH_NOT_CONFIGURED",
          message: "Linux DO Connect is not configured",
        },
      },
      503,
    );
  }
  assertRequestUrlOrigin(c);

  const returnTo = safeRelativeReturnTo(c.req.query("returnTo"));
  const state = await randomToken(32);
  const stateCookie = await randomToken(32);
  const now = new Date();
  await createDb(c.env.DB)
    .insert(oauthAttempts)
    .values({
      stateHash: await hashOAuthValue(state),
      cookieHash: await hashOAuthValue(stateCookie),
      returnTo,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000),
    });

  setCookie(c, CONNECT.cookieName, stateCookie, {
    httpOnly: true,
    secure: secureCookiesForOrigin(config.appOrigin),
    sameSite: "Lax",
    path: CONNECT.callbackPath,
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });

  const authorizeUrl = new URL(CONNECT.authorizeUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl(config.appOrigin));
  authorizeUrl.searchParams.set("scope", CONNECT.scope);
  authorizeUrl.searchParams.set("state", state);

  return c.redirect(authorizeUrl.toString(), 302);
}

async function completeAuthorization(c: Context<ApiContext>) {
  const state = c.req.query("state");
  const stateCookie = getCookie(c, CONNECT.cookieName);
  deleteCookie(c, CONNECT.cookieName, { path: CONNECT.callbackPath });
  const config = oauthConfig(c.env);
  if (!config) {
    return redirectWithAuthError(c, "auth_not_configured");
  }
  try {
    assertRequestUrlOrigin(c);
  } catch {
    return redirectWithAuthError(c, "invalid_origin");
  }
  if (!state || !stateCookie) {
    return redirectWithAuthError(c, "invalid_state");
  }

  const attempt = await consumeOAuthAttempt(c.env.DB, state, stateCookie);
  if (!attempt) {
    return redirectWithAuthError(c, "invalid_state");
  }

  const code = c.req.query("code");
  const providerError = safeProviderError(c.req.query("error"));
  if (providerError || !code) {
    return redirectWithAuthError(
      c,
      providerError === "access_denied" ? providerError : "auth_failed",
    );
  }

  try {
    const token = await exchangeCodeForToken(config, code);
    const profile = await fetchLinuxDoUser(token.accessToken);
    const userId = await upsertUser(c.env, profile);
    try {
      await createSession(c, userId);
    } catch {
      throw new AuthFlowError("session", "invalid_response");
    }

    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(attempt.returnTo, 302);
  } catch (error) {
    logSensitiveSafeAuthFailure(error, "oauth_callback");
    return redirectWithAuthError(c, "auth_failed");
  }
}

export function oauthConfig(env: ApiBindings) {
  const appOrigin = configuredAppOrigin(env);
  if (!appOrigin) {
    return null;
  }

  const clientId = env.CONNECT_CLIENT_ID;
  const clientSecret = env.CONNECT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return null;
  }

  return { appOrigin, clientId, clientSecret };
}

async function consumeOAuthAttempt(
  database: D1Database,
  state: string,
  stateCookie: string,
) {
  if (!isOAuthToken(state) || !isOAuthToken(stateCookie)) {
    return null;
  }

  const now = new Date();
  const [attempt] = await createDb(database)
    .delete(oauthAttempts)
    .where(
      and(
        eq(oauthAttempts.stateHash, await hashOAuthValue(state)),
        eq(oauthAttempts.cookieHash, await hashOAuthValue(stateCookie)),
        gt(oauthAttempts.expiresAt, now),
      ),
    )
    .returning({ returnTo: oauthAttempts.returnTo });

  return attempt ?? null;
}

async function exchangeCodeForToken(
  config: NonNullable<ReturnType<typeof oauthConfig>>,
  code: string,
) {
  const body = await fetchJsonWithTimeout("token", CONNECT.tokenUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(config.appOrigin),
    }),
  });

  if (
    !isRecord(body) ||
    typeof body.access_token !== "string" ||
    !body.access_token ||
    body.access_token.length > 8192 ||
    hasControlCharacters(body.access_token) ||
    (body.token_type !== undefined &&
      (typeof body.token_type !== "string" ||
        body.token_type.toLowerCase() !== "bearer"))
  ) {
    throw new AuthFlowError("token", "invalid_response");
  }

  return { accessToken: body.access_token };
}

async function fetchLinuxDoUser(accessToken: string) {
  const body = await fetchJsonWithTimeout("profile", CONNECT.userUrl, {
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  return parseLinuxDoUser(body);
}

export type LinuxDoProfile = {
  externalId: string;
  username: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  active: true;
};

export function parseLinuxDoUser(body: unknown): LinuxDoProfile {
  if (!isRecord(body)) {
    throw new AuthFlowError("profile", "invalid_response");
  }

  const externalId = stableExternalId(body.id);
  const username = safeProfileString(body.username, 100);
  const name = safeProfileString(body.name, 200);
  const email = normalizeConnectEmail(body.email);
  const avatarUrl = normalizeAvatarUrl(body.avatar_url);

  if (!externalId || !username || body.active !== true) {
    throw new AuthFlowError("profile", "invalid_response");
  }

  return {
    externalId,
    username,
    displayName: name || username,
    email,
    avatarUrl,
    active: true,
  };
}

async function upsertUser(env: ApiBindings, profile: LinuxDoProfile) {
  const now = new Date();
  const emailCiphertext = profile.email
    ? await encryptString(
        profile.email,
        env,
        emailAssociatedData(OAUTH_PROVIDER, profile.externalId),
      )
    : null;
  const [row] = await createDb(env.DB)
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      provider: OAUTH_PROVIDER,
      externalId: profile.externalId,
      username: profile.username,
      displayName: profile.displayName,
      emailCiphertext,
      avatarUrl: profile.avatarUrl,
      active: profile.active,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: [users.provider, users.externalId],
      set: {
        username: profile.username,
        displayName: profile.displayName,
        emailCiphertext,
        avatarUrl: profile.avatarUrl,
        updatedAt: now,
        lastLoginAt: now,
      },
      setWhere: eq(users.active, true),
    })
    .returning({ id: users.id });
  if (!row) throw new AuthFlowError("persistence", "invalid_response");
  return row.id;
}

export function emailAssociatedData(provider: string, externalId: string) {
  return `user:${provider}:${externalId}:email`;
}

async function decryptEmail(
  env: ApiBindings,
  ciphertext: string,
  provider: string,
  externalId: string,
) {
  try {
    return await decryptString(
      ciphertext,
      env,
      emailAssociatedData(provider, externalId),
    );
  } catch {
    return null;
  }
}

async function fetchJsonWithTimeout(
  stage: Extract<AuthFlowStage, "token" | "profile">,
  url: string,
  init: RequestInit,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new AuthFlowError(
        stage,
        isAbortError(error) ? "timeout" : "network",
      );
    }

    if (!response.ok) {
      throw new AuthFlowError(stage, "http", response.status);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new AuthFlowError(
        stage,
        controller.signal.aborted || isAbortError(error)
          ? "timeout"
          : "invalid_response",
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

function callbackUrl(appOrigin: string) {
  return `${appOrigin}${CONNECT.callbackPath}`;
}

async function hashOAuthValue(value: string) {
  return sha256Hex(`hb.oauth-state.v1:${value}`);
}

function stableExternalId(id: unknown) {
  if (typeof id === "string") {
    return canonicalUint64(id);
  }

  if (typeof id === "number" && Number.isSafeInteger(id)) {
    return canonicalUint64(String(id));
  }

  return null;
}

function canonicalUint64(value: string) {
  const trimmed = value.trim();
  if (trimmed.length > 20 || !/^[0-9]+$/.test(trimmed)) {
    return null;
  }

  const parsed = BigInt(trimmed);
  const maxUint64 = 18_446_744_073_709_551_615n;
  if (parsed <= 0n || parsed > maxUint64) {
    return null;
  }

  return parsed.toString();
}

function isOAuthToken(value: string) {
  return /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

function safeProfileString(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || hasControlCharacters(trimmed)) {
    return null;
  }

  return trimmed;
}

function safeProviderError(value: string | undefined) {
  if (!value || !/^[a-z_]+$/.test(value)) {
    return null;
  }

  if (value === "access_denied") {
    return value;
  }

  return "auth_failed";
}

function hasControlCharacters(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function logSensitiveSafeAuthFailure(error: unknown, location: string) {
  if (error instanceof AuthFlowError) {
    console.error("auth_failure", {
      location,
      stage: error.stage,
      reason: error.reason,
      ...(error.httpStatus !== undefined
        ? { httpStatus: error.httpStatus }
        : {}),
    });
    return;
  }

  console.error("auth_failure", {
    location,
    stage: "unknown",
    reason: "invalid_response",
  });
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
