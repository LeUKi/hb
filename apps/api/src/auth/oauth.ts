import { normalizeAvatarUrl, normalizeConnectEmail } from "@hb/contracts";
import { and, eq, gt, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
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
  LiteAuthLoginDisabledError,
  liteAuthLoginGuard,
  readLoginOptions,
  requireLiteAuthLogin,
} from "./login-settings";
import {
  type AuthenticatedSession,
  createSession,
  getOptionalSession,
  type LoginProvider,
  logout,
  type SessionUser,
  setImageSessionCookie,
} from "./session";

const PROVIDERS = {
  connect: {
    authorizeUrl: "https://connect.linux.do/oauth2/authorize",
    tokenUrl: "https://connect.linux.do/oauth2/token",
    userUrl: "https://connect.linux.do/api/user",
    cookieName: "hb_oauth_state",
    callbackPath: "/api/auth/callback",
    scope: "profile email",
  },
  liteauth: {
    authorizeUrl: "https://liteauth.442224.xyz/api/auth/oauth2/authorize",
    tokenUrl: "https://liteauth.442224.xyz/api/auth/oauth2/token",
    userUrl: "https://liteauth.442224.xyz/api/user",
    cookieName: "hb_liteauth_state",
    callbackPath: "/api/auth/liteauth/callback",
    scope: "profile",
  },
} as const;
const LITEAUTH_ISSUER = "https://liteauth.442224.xyz/api/auth";
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
  .get("/auth/login", (c) => beginAuthorization(c, "connect"))
  .get("/auth/callback", (c) => completeAuthorization(c, "connect"))
  .get("/auth/liteauth/login", (c) => beginAuthorization(c, "liteauth"))
  .get("/auth/liteauth/callback", (c) => completeAuthorization(c, "liteauth"))
  .post("/auth/logout", async (c) => {
    await logout(c);
    return c.json({ ok: true });
  })
  .get("/session", async (c) => {
    const [session, loginOptions] = await Promise.all([
      getOptionalSession(c),
      readLoginOptions(c.env),
    ]);
    if (!session) {
      return c.json({
        user: null,
        csrfToken: null,
        attemptCooldown: null,
        loginOptions,
      });
    }
    if (isFirstPartySessionRead(c)) await setImageSessionCookie(c, session);

    return c.json({
      user: { ...session.user, loginProvider: session.loginProvider },
      csrfToken: session.csrfToken,
      attemptCooldown: session.attemptCooldown,
      loginOptions,
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
      user: { ...profileUser, email, loginProvider: session.loginProvider },
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

async function beginAuthorization(
  c: Context<ApiContext>,
  loginProvider: LoginProvider,
) {
  let liteAuthVersion: number | undefined;
  if (loginProvider === "liteauth") {
    try {
      liteAuthVersion = await requireLiteAuthLogin(c.env);
    } catch (error) {
      if (error instanceof LiteAuthLoginDisabledError)
        return liteAuthLoginDisabled(c);
      throw error;
    }
  }
  const config = oauthConfig(c.env, loginProvider);
  if (!config) {
    if (c.req.header("Accept")?.includes("text/html")) {
      return redirectWithAuthError(c, providerNotConfigured(loginProvider));
    }
    return c.json(
      {
        error: {
          code: "AUTH_NOT_CONFIGURED",
          message:
            loginProvider === "connect"
              ? "Linux DO Connect is not configured"
              : "LiteAuth is not configured",
        },
      },
      503,
    );
  }
  assertRequestUrlOrigin(c);

  const upgrade = c.req.query("intent") === "upgrade";
  const session = upgrade ? await getOptionalSession(c) : null;
  if (upgrade && (loginProvider !== "connect" || !session)) {
    return redirectWithAuthError(c, "upgrade_session_required");
  }

  const returnTo = safeRelativeReturnTo(c.req.query("returnTo"));
  const state = await randomToken(32);
  const stateCookie = await randomToken(32);
  const stateHash = await hashOAuthValue(state);
  const pkceVerifier =
    loginProvider === "liteauth" ? await randomToken(32) : null;
  const now = new Date();
  const attempt = {
    stateHash,
    cookieHash: await hashOAuthValue(stateCookie),
    loginProvider,
    expectedUserId: session?.user.id ?? null,
    pkceVerifierCiphertext: pkceVerifier
      ? await encryptString(pkceVerifier, c.env, pkceAssociatedData(stateHash))
      : null,
    returnTo,
    createdAt: now,
    expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000),
  };
  if (liteAuthVersion !== undefined) {
    try {
      await c.env.DB.batch([
        liteAuthLoginGuard(c.env, liteAuthVersion),
        c.env.DB.prepare(`INSERT INTO oauth_attempts
          (state_hash,cookie_hash,login_provider,expected_user_id,pkce_verifier_ciphertext,return_to,created_at,expires_at)
          VALUES (?,?,?,?,?,?,?,?)`).bind(
          attempt.stateHash,
          attempt.cookieHash,
          attempt.loginProvider,
          attempt.expectedUserId,
          attempt.pkceVerifierCiphertext,
          attempt.returnTo,
          attempt.createdAt.getTime(),
          attempt.expiresAt.getTime(),
        ),
      ]);
    } catch (error) {
      try {
        await requireLiteAuthLogin(c.env, liteAuthVersion);
      } catch (settingsError) {
        if (settingsError instanceof LiteAuthLoginDisabledError)
          return liteAuthLoginDisabled(c);
        throw settingsError;
      }
      throw error;
    }
  } else {
    await createDb(c.env.DB).insert(oauthAttempts).values(attempt);
  }

  const provider = PROVIDERS[loginProvider];
  setCookie(c, provider.cookieName, stateCookie, {
    httpOnly: true,
    secure: secureCookiesForOrigin(config.appOrigin),
    sameSite: "Lax",
    path: provider.callbackPath,
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });

  const authorizeUrl = new URL(provider.authorizeUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set(
    "redirect_uri",
    callbackUrl(config.appOrigin, loginProvider),
  );
  authorizeUrl.searchParams.set("scope", provider.scope);
  authorizeUrl.searchParams.set("state", state);
  if (pkceVerifier) {
    authorizeUrl.searchParams.set(
      "code_challenge",
      await pkceChallenge(pkceVerifier),
    );
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
  }

  return c.redirect(authorizeUrl.toString(), 302);
}

async function completeAuthorization(
  c: Context<ApiContext>,
  loginProvider: LoginProvider,
) {
  const state = c.req.query("state");
  const provider = PROVIDERS[loginProvider];
  const stateCookie = getCookie(c, provider.cookieName);
  deleteCookie(c, provider.cookieName, { path: provider.callbackPath });
  let liteAuthVersion: number | undefined;
  let liteAuthDisabled = false;
  if (loginProvider === "liteauth") {
    try {
      liteAuthVersion = await requireLiteAuthLogin(c.env);
    } catch (error) {
      if (!(error instanceof LiteAuthLoginDisabledError)) throw error;
      liteAuthDisabled = true;
    }
  }
  const config = oauthConfig(c.env, loginProvider);
  if (!config && !liteAuthDisabled) {
    return redirectWithAuthError(c, providerNotConfigured(loginProvider));
  }
  try {
    assertRequestUrlOrigin(c);
  } catch {
    return redirectWithAuthError(c, "invalid_origin");
  }
  if (!state || !stateCookie) {
    if (liteAuthDisabled) return liteAuthLoginDisabled(c);
    return redirectWithAuthError(c, "invalid_state");
  }

  const attempt = await consumeOAuthAttempt(
    c.env.DB,
    state,
    stateCookie,
    loginProvider,
  );
  if (liteAuthDisabled) return liteAuthLoginDisabled(c);
  if (!attempt) {
    return redirectWithAuthError(c, "invalid_state");
  }
  if (!config)
    return redirectWithAuthError(c, providerNotConfigured(loginProvider));

  const code = c.req.query("code");
  const providerError = safeProviderError(c.req.query("error"));
  if (providerError || !code) {
    return redirectWithAuthError(
      c,
      providerError === "access_denied"
        ? providerError
        : providerFailed(loginProvider),
    );
  }
  if (
    loginProvider === "liteauth" &&
    (c.req.query("iss") !== LITEAUTH_ISSUER ||
      new URL(c.req.url).searchParams.getAll("iss").length !== 1 ||
      !attempt.pkceVerifierCiphertext ||
      attempt.expectedUserId)
  ) {
    return redirectWithAuthError(c, providerFailed(loginProvider));
  }
  let upgradeSession: AuthenticatedSession | null = null;
  if (attempt.expectedUserId) {
    const session = await getOptionalSession(c);
    if (session?.user.id !== attempt.expectedUserId) {
      return redirectWithAuthError(c, "upgrade_session_changed");
    }
    upgradeSession = session;
  }

  try {
    const pkceVerifier = attempt.pkceVerifierCiphertext
      ? await decryptString(
          attempt.pkceVerifierCiphertext,
          c.env,
          pkceAssociatedData(attempt.stateHash),
        )
      : null;
    if (pkceVerifier && !isOAuthToken(pkceVerifier)) {
      throw new AuthFlowError("token", "invalid_response");
    }
    if (liteAuthVersion !== undefined)
      await requireLiteAuthLogin(c.env, liteAuthVersion);
    const token = await exchangeCodeForToken(config, code, pkceVerifier);
    if (liteAuthVersion !== undefined)
      await requireLiteAuthLogin(c.env, liteAuthVersion);
    const profile = await fetchLinuxDoUser(token.accessToken, loginProvider);
    if (liteAuthVersion !== undefined)
      await requireLiteAuthLogin(c.env, liteAuthVersion);
    if (attempt.expectedUserId) {
      // The original session can be revoked while token/profile requests are
      // in flight. Do not overwrite a logout or account switch when it returns.
      const session = await getOptionalSession(c);
      if (session?.user.id !== attempt.expectedUserId) {
        return redirectWithAuthError(c, "upgrade_session_changed");
      }
      upgradeSession = session;
      const expected = await createDb(c.env.DB)
        .select({ provider: users.provider, externalId: users.externalId })
        .from(users)
        .where(eq(users.id, attempt.expectedUserId))
        .get();
      if (
        expected?.provider !== OAUTH_PROVIDER ||
        expected.externalId !== profile.externalId
      ) {
        return redirectWithAuthError(c, "identity_mismatch");
      }
    }
    if (upgradeSession) {
      if (!(await upgradeUserAndSession(c.env, profile, upgradeSession))) {
        return redirectWithAuthError(c, "upgrade_session_changed");
      }
    } else {
      const sessionUser: SessionUser =
        loginProvider === "liteauth"
          ? {
              provider: OAUTH_PROVIDER,
              externalId: profile.externalId,
              statement: await prepareUserUpsert(c.env, profile, loginProvider),
            }
          : await upsertUser(c.env, profile, loginProvider);
      try {
        await createSession(c, sessionUser, loginProvider, liteAuthVersion);
      } catch (error) {
        if (error instanceof LiteAuthLoginDisabledError) throw error;
        throw new AuthFlowError("session", "invalid_response");
      }
    }

    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(attempt.returnTo, 302);
  } catch (error) {
    if (error instanceof LiteAuthLoginDisabledError)
      return liteAuthLoginDisabled(c);
    logSensitiveSafeAuthFailure(
      error,
      loginProvider === "connect" ? "oauth_callback" : "liteauth_callback",
    );
    return redirectWithAuthError(c, providerFailed(loginProvider));
  }
}

function liteAuthLoginDisabled(c: Context<ApiContext>) {
  if (c.req.header("Accept")?.includes("text/html"))
    return redirectWithAuthError(c, "liteauth_disabled");
  return c.json(
    {
      error: {
        code: "LITEAUTH_LOGIN_DISABLED",
        message: "LiteAUTH 登录暂时关闭，请使用 Linux DO Connect 登录。",
      },
    },
    403,
  );
}

export function oauthConfig(
  env: ApiBindings,
  loginProvider: LoginProvider = "connect",
) {
  const appOrigin = configuredAppOrigin(env);
  if (!appOrigin) {
    return null;
  }

  const clientId =
    loginProvider === "connect"
      ? env.CONNECT_CLIENT_ID
      : env.LITEAUTH_CLIENT_ID;
  const clientSecret =
    loginProvider === "connect"
      ? env.CONNECT_CLIENT_SECRET
      : env.LITEAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return null;
  }

  return {
    appOrigin,
    clientId,
    clientSecret,
    loginProvider,
  };
}

async function consumeOAuthAttempt(
  database: D1Database,
  state: string,
  stateCookie: string,
  loginProvider: LoginProvider,
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
        eq(oauthAttempts.loginProvider, loginProvider),
        gt(oauthAttempts.expiresAt, now),
      ),
    )
    .returning({
      returnTo: oauthAttempts.returnTo,
      stateHash: oauthAttempts.stateHash,
      pkceVerifierCiphertext: oauthAttempts.pkceVerifierCiphertext,
      expectedUserId: oauthAttempts.expectedUserId,
    });

  return attempt ?? null;
}

async function exchangeCodeForToken(
  config: NonNullable<ReturnType<typeof oauthConfig>>,
  code: string,
  pkceVerifier: string | null,
) {
  const provider = PROVIDERS[config.loginProvider];
  const body = await fetchJsonWithTimeout("token", provider.tokenUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...(config.loginProvider === "connect"
        ? {
            Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
          }
        : {}),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(config.appOrigin, config.loginProvider),
      ...(config.loginProvider === "liteauth" && pkceVerifier
        ? {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code_verifier: pkceVerifier,
          }
        : {}),
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

async function fetchLinuxDoUser(
  accessToken: string,
  loginProvider: LoginProvider,
) {
  const body = await fetchJsonWithTimeout(
    "profile",
    PROVIDERS[loginProvider].userUrl,
    {
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  return loginProvider === "connect"
    ? parseLinuxDoUser(body)
    : parseLiteAuthUser(body);
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

export function parseLiteAuthUser(body: unknown): LinuxDoProfile {
  if (
    !isRecord(body) ||
    body.auth_source !== "linuxdo" ||
    body.login_method !== "lite_self_app"
  ) {
    throw new AuthFlowError("profile", "invalid_response");
  }
  // LiteAuth's sub and liteauth_user_id identify its own account, not Linux DO.
  return { ...parseLinuxDoUser(body), email: null };
}

async function upsertUser(
  env: ApiBindings,
  profile: LinuxDoProfile,
  loginProvider: LoginProvider,
) {
  const statement = await prepareUserUpsert(env, profile, loginProvider);
  const { results } = await statement.all<{ id: string }>();
  const row = results[0];
  if (!row) throw new AuthFlowError("persistence", "invalid_response");
  return row.id;
}

async function prepareUserUpsert(
  env: ApiBindings,
  profile: LinuxDoProfile,
  loginProvider: LoginProvider,
) {
  const now = new Date();
  const db = createDb(env.DB);
  const emailCiphertext =
    loginProvider === "connect" && profile.email
      ? await encryptString(
          profile.email,
          env,
          emailAssociatedData(OAUTH_PROVIDER, profile.externalId),
        )
      : null;
  const query = db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      provider: OAUTH_PROVIDER,
      externalId: profile.externalId,
      username: profile.username,
      displayName: profile.displayName,
      emailCiphertext,
      avatarUrl: profile.avatarUrl,
      officialConnectVerified: loginProvider === "connect",
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
        ...(loginProvider === "connect" ? { emailCiphertext } : {}),
        avatarUrl:
          loginProvider === "connect"
            ? profile.avatarUrl
            : sql`COALESCE(${profile.avatarUrl},${users.avatarUrl})`,
        // Only successful official Connect authentication can add this fact.
        // LiteAuth never clears it, including a callback that arrives late.
        officialConnectVerified:
          loginProvider === "connect" ? true : users.officialConnectVerified,
        updatedAt: now,
        lastLoginAt: now,
      },
      setWhere: eq(users.active, true),
    })
    .returning({ id: users.id });
  const { sql: statementSql, params } = query.toSQL();
  return env.DB.prepare(statementSql).bind(...params);
}

async function upgradeUserAndSession(
  env: ApiBindings,
  profile: LinuxDoProfile,
  session: AuthenticatedSession,
) {
  const now = new Date();
  const emailCiphertext = profile.email
    ? await encryptString(
        profile.email,
        env,
        emailAssociatedData(OAUTH_PROVIDER, profile.externalId),
      )
    : null;
  const eligibility = `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
    AND u.provider=? AND u.external_id=? AND u.active=1`;
  const guardValues = [
    session.tokenHash,
    session.user.id,
    OAUTH_PROVIDER,
    profile.externalId,
  ];
  try {
    await env.DB.batch([
      env.DB.prepare(
        `SELECT json(CASE WHEN EXISTS(${eligibility}) THEN '{}' ELSE '' END) AS upgrade_session_guard`,
      ).bind(...guardValues),
      env.DB.prepare(`UPDATE users SET username=?,display_name=?,email_ciphertext=?,avatar_url=?,
        official_connect_verified=1,updated_at=?,last_login_at=? WHERE id=?`).bind(
        profile.username,
        profile.displayName,
        emailCiphertext,
        profile.avatarUrl,
        now.getTime(),
        now.getTime(),
        session.user.id,
      ),
      env.DB.prepare(
        "UPDATE sessions SET login_provider='connect' WHERE token_hash=? AND user_id=?",
      ).bind(session.tokenHash, session.user.id),
    ]);
  } catch (error) {
    const eligible = await env.DB.prepare(eligibility)
      .bind(...guardValues)
      .first();
    if (!eligible) return false;
    throw error;
  }
  // Preserve the original token: a logout before this batch makes its guard
  // fail; a logout after it still deletes that same token. No late Set-Cookie
  // or newly inserted session can revive the account after logout.
  return true;
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

function callbackUrl(appOrigin: string, loginProvider: LoginProvider) {
  return `${appOrigin}${PROVIDERS[loginProvider].callbackPath}`;
}

function providerNotConfigured(loginProvider: LoginProvider) {
  return loginProvider === "connect"
    ? "auth_not_configured"
    : "liteauth_not_configured";
}

function providerFailed(loginProvider: LoginProvider) {
  return loginProvider === "connect" ? "auth_failed" : "liteauth_failed";
}

export function pkceAssociatedData(stateHash: string) {
  return `oauth:liteauth:${LITEAUTH_ISSUER}:${stateHash}:pkce`;
}

async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
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
