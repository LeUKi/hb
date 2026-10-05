import { and, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createDb } from "../db/client";
import { oauthAttempts, users } from "../db/schema";
import type { ApiBindings, ApiContext } from "../env";
import { randomToken, sha256Hex } from "../security/crypto";
import {
  assertRequestUrlOrigin,
  configuredAppOrigin,
  redirectWithAuthError,
  safeRelativeReturnTo,
  secureCookiesForOrigin,
} from "../security/http";
import { createSession, getOptionalSession, logout } from "./session";

const AUTHORIZE_URL = "https://connect.linux.do/oauth2/authorize";
const TOKEN_URL = "https://connect.linux.do/oauth2/token";
const USER_URL = "https://connect.linux.do/api/user";
const OAUTH_STATE_COOKIE = "hb_oauth_state";
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
    c.header("Cache-Control", "no-store");
  })
  .get("/auth/login", async (c) => {
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

    setCookie(c, OAUTH_STATE_COOKIE, stateCookie, {
      httpOnly: true,
      secure: secureCookiesForOrigin(config.appOrigin),
      sameSite: "Lax",
      path: "/api/auth/callback",
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });

    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set(
      "redirect_uri",
      callbackUrl(config.appOrigin),
    );
    authorizeUrl.searchParams.set("scope", "profile");
    authorizeUrl.searchParams.set("state", state);

    return c.redirect(authorizeUrl.toString(), 302);
  })
  .get("/auth/callback", async (c) => {
    const config = oauthConfig(c.env);
    if (!config) {
      return redirectWithAuthError(c, "auth_not_configured");
    }
    try {
      assertRequestUrlOrigin(c);
    } catch {
      return redirectWithAuthError(c, "invalid_origin");
    }

    const state = c.req.query("state");
    const stateCookie = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/api/auth/callback" });

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
      return redirectWithAuthError(c, providerError ?? "auth_failed");
    }

    try {
      const token = await exchangeCodeForToken(config, code);
      const profile = await fetchLinuxDoUser(token.accessToken);
      const userId = await upsertUser(c.env.DB, profile);
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
  })
  .post("/auth/logout", async (c) => {
    await logout(c);
    return c.json({ ok: true });
  })
  .get("/me", async (c) => {
    const session = await getOptionalSession(c);
    if (!session) {
      return c.json({ user: null, csrfToken: null });
    }

    return c.json({ user: session.user, csrfToken: session.csrfToken });
  });

export function oauthConfig(env: ApiBindings) {
  const appOrigin = configuredAppOrigin(env);
  if (!appOrigin) {
    return null;
  }

  if (!env.CONNECT_CLIENT_ID || !env.CONNECT_CLIENT_SECRET) {
    return null;
  }

  return {
    appOrigin,
    clientId: env.CONNECT_CLIENT_ID,
    clientSecret: env.CONNECT_CLIENT_SECRET,
  };
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
  const body = await fetchJsonWithTimeout("token", TOKEN_URL, {
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
  const body = await fetchJsonWithTimeout("profile", USER_URL, {
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
  active: true;
};

export function parseLinuxDoUser(body: unknown): LinuxDoProfile {
  if (!isRecord(body)) {
    throw new AuthFlowError("profile", "invalid_response");
  }

  const externalId = stableExternalId(body.id, body.sub);
  const username = safeProfileString(body.username, 100);
  const name = safeProfileString(body.name, 200);

  if (!externalId || !username || body.active !== true) {
    throw new AuthFlowError("profile", "invalid_response");
  }

  return {
    externalId,
    username,
    displayName: name || username,
    active: true,
  };
}

async function upsertUser(database: D1Database, profile: LinuxDoProfile) {
  const now = new Date();
  const db = createDb(database);
  const [row] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      provider: OAUTH_PROVIDER,
      externalId: profile.externalId,
      username: profile.username,
      displayName: profile.displayName,
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
        updatedAt: now,
        lastLoginAt: now,
      },
      setWhere: eq(users.active, true),
    })
    .returning({ id: users.id });

  if (!row) {
    throw new AuthFlowError("persistence", "invalid_response");
  }

  return row.id;
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
  return `${appOrigin}/api/auth/callback`;
}

async function hashOAuthValue(value: string) {
  return sha256Hex(`hb.oauth-state.v1:${value}`);
}

function stableExternalId(id: unknown, sub: unknown) {
  const candidate = id ?? sub;
  if (typeof candidate === "string") {
    return canonicalUint64(candidate);
  }

  if (typeof candidate === "number" && Number.isSafeInteger(candidate)) {
    return canonicalUint64(String(candidate));
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
