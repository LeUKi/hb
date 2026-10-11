import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import {
  hasOfficialConnect,
  requireOfficialConnect,
} from "../src/auth/eligibility";
import { pkceAssociatedData } from "../src/auth/oauth";
import type { LoginProvider } from "../src/auth/session";
import type { ApiBindings } from "../src/env";
import { decryptString, sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
const issuer = "https://liteauth.442224.xyz/api/auth";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  CONNECT_CLIENT_ID: "connect-fixture",
  CONNECT_CLIENT_SECRET: "connect-fixture-secret",
  LITEAUTH_CLIENT_ID: "liteauth-fixture",
  LITEAUTH_CLIENT_SECRET: "liteauth-fixture-secret",
};
const providers = {
  connect: {
    login: "/api/auth/login",
    callback: "/api/auth/callback",
    token: "https://connect.linux.do/oauth2/token",
    profile: "https://connect.linux.do/api/user",
  },
  liteauth: {
    login: "/api/auth/liteauth/login",
    callback: "/api/auth/liteauth/callback",
    token: `${issuer}/oauth2/token`,
    profile: "https://liteauth.442224.xyz/api/user",
  },
} as const;

type Me = {
  user: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    email: string | null;
    accountTier: "standard" | "lite";
    canUseLdc: boolean;
    loginProvider: LoginProvider;
  } | null;
  csrfToken: string | null;
};

function request(path: string, init?: RequestInit, config = bindings) {
  return app.request(`${origin}${path}`, init, config);
}

function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

async function begin(
  loginProvider: LoginProvider = "liteauth",
  options: { cookie?: string; upgrade?: boolean; returnTo?: string } = {},
) {
  const query = new URLSearchParams({
    returnTo: options.returnTo ?? "/account",
  });
  if (options.upgrade) query.set("intent", "upgrade");
  const response = await request(`${providers[loginProvider].login}?${query}`, {
    headers: options.cookie ? { Cookie: options.cookie } : undefined,
  });
  const location = new URL(response.headers.get("location") ?? "", origin);
  const state = location.searchParams.get("state") ?? "";
  return { response, location, state, cookie: cookie(response), loginProvider };
}

async function finish(
  start: Awaited<ReturnType<typeof begin>>,
  options: {
    sessionCookie?: string;
    issuer?: string | null;
    accept?: string;
  } = {},
) {
  const query = new URLSearchParams({
    state: start.state,
    code: "fixture-code",
  });
  if (start.loginProvider === "liteauth" && options.issuer !== null) {
    query.set("iss", options.issuer ?? issuer);
  }
  return request(`${providers[start.loginProvider].callback}?${query}`, {
    headers: {
      Cookie: [start.cookie, options.sessionCookie].filter(Boolean).join("; "),
      ...(options.accept ? { Accept: options.accept } : {}),
    },
  });
}

function profile(fields: Record<string, unknown> = {}) {
  return {
    id: "12345",
    sub: "liteauth-internal-account",
    liteauth_user_id: "liteauth-internal-account",
    username: "Alice",
    name: "Alice Display",
    active: true,
    auth_source: "linuxdo",
    login_method: "lite_self_app",
    ...fields,
  };
}

function mockProvider(
  loginProvider: LoginProvider = "liteauth",
  value: unknown = profile(),
  expectedPkceVerifier?: string,
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const outbound = new Request(input, init);
      expect(outbound.redirect).toBe("manual");
      if (outbound.url === providers[loginProvider].token) {
        expect(outbound.method).toBe("POST");
        const body = await outbound.formData();
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("redirect_uri")).toBe(
          `${origin}${providers[loginProvider].callback}`,
        );
        if (loginProvider === "liteauth") {
          expect(outbound.headers.get("Authorization")).toBeNull();
          expect(body.get("client_id")).toBe(bindings.LITEAUTH_CLIENT_ID);
          expect(body.get("client_secret")).toBe(
            bindings.LITEAUTH_CLIENT_SECRET,
          );
          expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
          if (expectedPkceVerifier) {
            expect(body.get("code_verifier")).toBe(expectedPkceVerifier);
          }
        } else {
          expect(outbound.headers.get("Authorization")).toBe(
            `Basic ${btoa("connect-fixture:connect-fixture-secret")}`,
          );
          expect(body.has("client_secret")).toBe(false);
        }
        return Response.json({
          access_token: "fixture-access-token",
          token_type: "Bearer",
        });
      }
      if (outbound.url === providers[loginProvider].profile) {
        expect(outbound.headers.get("Authorization")).toBe(
          "Bearer fixture-access-token",
        );
        return Response.json(value);
      }
      throw new Error("Unexpected simulated OAuth request");
    });
}

async function me(sessionCookie: string): Promise<Me> {
  const response = await request("/api/me", {
    headers: { Cookie: sessionCookie },
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response.json();
}

async function login(
  loginProvider: LoginProvider = "liteauth",
  value?: unknown,
) {
  const start = await begin(loginProvider);
  const provider = mockProvider(loginProvider, value);
  const response = await finish(start);
  provider.mockRestore();
  expect(response.headers.get("Location")).toBe("/account");
  const sessionCookie = cookie(response);
  return { cookie: sessionCookie, response, me: await me(sessionCookie) };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE login_settings SET version=1,liteauth_enabled=1,updated_by_user_id=NULL WHERE id='global'",
    ),
    env.DB.prepare("DELETE FROM login_setting_changes"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM oauth_attempts"),
    env.DB.prepare("DELETE FROM users"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

async function setLiteAuthEnabled(enabled: boolean) {
  await env.DB.prepare(
    "UPDATE login_settings SET liteauth_enabled=?,version=version+1 WHERE id='global'",
  )
    .bind(Number(enabled))
    .run();
}

async function recordCount(table: "sessions" | "oauth_attempts" | "users") {
  return env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>(
    "n",
  );
}

async function userRecords() {
  const { results } = await env.DB.prepare(
    "SELECT * FROM users ORDER BY id",
  ).all();
  return results;
}

function hasNewSessionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .some((value) => value.startsWith("hb_session="));
}

describe("LiteAUTH login switch", () => {
  it("blocks browser and API starts without state or upstream traffic while Connect stays available", async () => {
    await setLiteAuthEnabled(false);
    const upstream = mockProvider();
    const api = await request(providers.liteauth.login);
    expect(api.status).toBe(403);
    expect(await api.json()).toMatchObject({
      error: { code: "LITEAUTH_LOGIN_DISABLED" },
    });
    expect(api.headers.get("Set-Cookie")).toBeNull();
    const browser = await request(providers.liteauth.login, {
      headers: { Accept: "text/html" },
    });
    expect(browser.headers.get("Location")).toBe(
      "/?authError=liteauth_disabled",
    );
    expect(browser.headers.get("Set-Cookie")).toBeNull();
    expect(await recordCount("oauth_attempts")).toBe(0);
    expect(upstream).not.toHaveBeenCalled();
    const guest = await request("/api/session");
    expect(await guest.json()).toMatchObject({
      user: null,
      loginOptions: { liteauthEnabled: false },
    });
    expect((await begin("connect")).location.origin).toBe(
      "https://connect.linux.do",
    );
  });

  it.each([false, true])(
    "atomically rejects a start if the setting changes before OAuth state persistence, reopened=%s",
    async (reopened) => {
      const batch = env.DB.batch.bind(env.DB);
      vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
        await setLiteAuthEnabled(false);
        if (reopened) await setLiteAuthEnabled(true);
        return batch(statements);
      });
      const response = await request(providers.liteauth.login);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "LITEAUTH_LOGIN_DISABLED" },
      });
      expect(await recordCount("oauth_attempts")).toBe(0);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    },
  );

  it("consumes disabled callback state and clears its cookie before any upstream request", async () => {
    const start = await begin();
    await setLiteAuthEnabled(false);
    const upstream = mockProvider();
    const callback = await finish(start, { accept: "text/html" });
    expect(callback.headers.get("Location")).toBe(
      "/?authError=liteauth_disabled",
    );
    expect(
      callback.headers
        .getSetCookie()
        .some(
          (value) =>
            value.startsWith("hb_liteauth_state=;") &&
            value.includes("Max-Age=0"),
        ),
    ).toBe(true);
    expect(hasNewSessionCookie(callback)).toBe(false);
    expect(await recordCount("oauth_attempts")).toBe(0);
    expect(await recordCount("sessions")).toBe(0);
    expect(upstream).not.toHaveBeenCalled();
    await setLiteAuthEnabled(true);
    expect((await finish(start)).headers.get("Location")).toBe(
      "/?authError=invalid_state",
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns a non-HTML callback rejection as 403 and also consumes the saved state", async () => {
    const start = await begin();
    await setLiteAuthEnabled(false);
    const upstream = mockProvider();
    const callback = await finish(start);
    expect(callback.status).toBe(403);
    expect(await callback.json()).toMatchObject({
      error: { code: "LITEAUTH_LOGIN_DISABLED" },
    });
    expect(await recordCount("oauth_attempts")).toBe(0);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("cannot revive an unconsumed LiteAUTH callback after an administrator closes and reopens login", async () => {
    const administrator = await login("connect");
    const lite = await begin();
    const official = await begin("connect");
    async function update(enabled: boolean, expectedVersion: number) {
      const response = await request(
        "/api/admin/login-settings",
        {
          method: "PATCH",
          headers: {
            Cookie: administrator.cookie,
            Origin: origin,
            "Content-Type": "application/json",
            "X-CSRF-Token": administrator.me.csrfToken ?? "",
          },
          body: JSON.stringify({ expectedVersion, liteauthEnabled: enabled }),
        },
        { ...bindings, ADMIN_LINUX_DO_IDS: "12345" },
      );
      expect(response.status).toBe(200);
      await response.json();
    }
    await update(false, 1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM oauth_attempts WHERE login_provider='liteauth'",
      ).first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM oauth_attempts WHERE login_provider='connect'",
      ).first("n"),
    ).toBe(1);
    await update(true, 2);
    const upstream = mockProvider();
    expect((await finish(lite)).headers.get("Location")).toBe(
      "/?authError=invalid_state",
    );
    expect(upstream).not.toHaveBeenCalled();
    upstream.mockRestore();
    mockProvider("connect");
    expect((await finish(official)).headers.get("Location")).toBe("/account");
    const newStart = await begin();
    expect(newStart.location.origin).toBe("https://liteauth.442224.xyz");
  });

  it.each([false, true])(
    "rejects an in-flight callback when closed during upstream, even if reopened=%s",
    async (reopened) => {
      const signed = await login("connect");
      const start = await begin();
      const previous = await me(signed.cookie);
      const upstream = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const outbound = new Request(input, init);
          if (outbound.url === providers.liteauth.token)
            return Response.json({
              access_token: "fixture-access-token",
              token_type: "Bearer",
            });
          if (outbound.url === providers.liteauth.profile) {
            expect(await recordCount("oauth_attempts")).toBe(0);
            await setLiteAuthEnabled(false);
            if (reopened) await setLiteAuthEnabled(true);
            return Response.json(profile({ name: "Must Not Persist" }));
          }
          throw new Error("Unexpected simulated request");
        });
      const response = await finish(start, {
        sessionCookie: signed.cookie,
        accept: "text/html",
      });
      expect(response.headers.get("Location")).toBe(
        "/?authError=liteauth_disabled",
      );
      expect(hasNewSessionCookie(response)).toBe(false);
      expect(await me(signed.cookie)).toEqual(previous);
      expect(await recordCount("sessions")).toBe(1);
      expect(upstream).toHaveBeenCalledTimes(2);
    },
  );

  it("stops before the profile request if LiteAUTH closes while token exchange is in flight", async () => {
    const start = await begin();
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        expect(new Request(input, init).url).toBe(providers.liteauth.token);
        await setLiteAuthEnabled(false);
        return Response.json({
          access_token: "fixture-access-token",
          token_type: "Bearer",
        });
      });
    const response = await finish(start, { accept: "text/html" });
    expect(response.headers.get("Location")).toBe(
      "/?authError=liteauth_disabled",
    );
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await recordCount("users")).toBe(0);
    expect(await recordCount("sessions")).toBe(0);
    expect(hasNewSessionCookie(response)).toBe(false);
  });

  it.each([false, true])(
    "rolls back user persistence and keeps the previous session if LiteAUTH session INSERT fails, newUser=%s",
    async (newUser) => {
      const signed = await login("connect");
      const start = await begin();
      const before = await userRecords();
      mockProvider(
        "liteauth",
        profile({
          id: newUser ? "67890" : "12345",
          username: "MustNotPersist",
          name: "Must Not Persist",
          avatar_url: "https://cdn.example.com/must-not-persist.png",
        }),
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await env.DB.prepare(
        "CREATE TRIGGER fail_liteauth_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'injected session insert failure'); END",
      ).run();
      try {
        const response = await finish(start, { sessionCookie: signed.cookie });
        expect(response.headers.get("Location")).toBe(
          "/?authError=liteauth_failed",
        );
        expect(hasNewSessionCookie(response)).toBe(false);
        expect(await recordCount("sessions")).toBe(1);
        expect(await userRecords()).toEqual(before);
        expect((await me(signed.cookie)).user?.id).toBe(signed.me.user?.id);
      } finally {
        await env.DB.prepare("DROP TRIGGER fail_liteauth_session").run();
      }
    },
  );

  it.each([false, true])(
    "atomically preserves an old session when the final LiteAUTH guard loses to a close, reopened=%s",
    async (reopened) => {
      const signed = await login("connect");
      const start = await begin();
      const before = await userRecords();
      mockProvider(
        "liteauth",
        profile({
          id: reopened ? "67890" : "12345",
          username: "MustNotPersist",
          name: "Must Not Persist",
          avatar_url: "https://cdn.example.com/must-not-persist.png",
        }),
      );
      const batch = env.DB.batch.bind(env.DB);
      vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
        await setLiteAuthEnabled(false);
        if (reopened) await setLiteAuthEnabled(true);
        return batch(statements);
      });
      const response = await finish(start, {
        sessionCookie: signed.cookie,
        accept: "text/html",
      });
      expect(response.headers.get("Location")).toBe(
        "/?authError=liteauth_disabled",
      );
      expect(hasNewSessionCookie(response)).toBe(false);
      expect(await recordCount("sessions")).toBe(1);
      expect(await userRecords()).toEqual(before);
      expect((await me(signed.cookie)).user?.id).toBe(signed.me.user?.id);
      expect((await me(signed.cookie)).user?.loginProvider).toBe("connect");
    },
  );

  it.each([true, false])(
    "creates valid sessions for concurrent first LiteAUTH callbacks, sameAccount=%s",
    async (sameAccount) => {
      const starts = await Promise.all([begin(), begin()]);
      let profileCount = 0;
      const upstream = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const outbound = new Request(input, init);
          if (outbound.url === providers.liteauth.token)
            return Response.json({
              access_token: "fixture-access-token",
              token_type: "Bearer",
            });
          if (outbound.url === providers.liteauth.profile) {
            profileCount += 1;
            return Response.json(
              profile({
                id: sameAccount || profileCount === 1 ? "12345" : "67890",
              }),
            );
          }
          throw new Error("Unexpected simulated request");
        });
      const responses = await Promise.all(starts.map((start) => finish(start)));
      for (const response of responses) {
        expect(response.headers.get("Location")).toBe("/account");
        expect(hasNewSessionCookie(response)).toBe(true);
      }
      const identities = await Promise.all(
        responses.map((response) => me(cookie(response))),
      );
      for (const identity of identities)
        expect(identity.user).toMatchObject({
          accountTier: "lite",
          loginProvider: "liteauth",
        });
      expect(
        new Set(identities.map((identity) => identity.user?.id)).size,
      ).toBe(sameAccount ? 1 : 2);
      expect(await recordCount("users")).toBe(sameAccount ? 1 : 2);
      expect(await recordCount("sessions")).toBe(2);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE u.id IS NULL",
        ).first("n"),
      ).toBe(0);
      expect(upstream).toHaveBeenCalledTimes(4);
    },
  );

  it.each(["liteauth", "connect"] as const)(
    "keeps existing %s sessions valid and reports the closed option",
    async (provider) => {
      const signed = await login(provider);
      await setLiteAuthEnabled(false);
      const response = await request("/api/session", {
        headers: { Cookie: signed.cookie },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        user: { id: signed.me.user?.id, loginProvider: provider },
        csrfToken: signed.me.csrfToken,
        loginOptions: { liteauthEnabled: false },
      });
      expect(hasNewSessionCookie(response)).toBe(false);
      expect(await me(signed.cookie)).toEqual(signed.me);
      expect(await recordCount("sessions")).toBe(1);
    },
  );

  it("fails new LiteAUTH logins closed on a settings read failure while preserving valid session identity and the me shape", async () => {
    const signed = await login();
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
      if (query.includes("FROM login_settings"))
        throw new Error("Injected settings read failure");
      return prepare(query);
    });
    const session = await request("/api/session", {
      headers: { Cookie: signed.cookie },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      user: { id: signed.me.user?.id },
      csrfToken: signed.me.csrfToken,
      loginOptions: { liteauthEnabled: false },
    });
    expect(hasNewSessionCookie(session)).toBe(false);
    expect(await me(signed.cookie)).toEqual(signed.me);
    expect((await request(providers.liteauth.login)).status).toBe(403);
    expect((await begin("connect")).location.origin).toBe(
      "https://connect.linux.do",
    );
    expect(await recordCount("sessions")).toBe(1);
  });
});

describe("LiteAuth OAuth and permanent account qualification", () => {
  it("keeps provider configuration independent and fails an unavailable entry closed", async () => {
    const config = { ...bindings, LITEAUTH_CLIENT_SECRET: "" };
    const lite = await request(providers.liteauth.login, undefined, config);
    expect(lite.status).toBe(503);
    expect((await lite.json<{ error: { code: string } }>()).error.code).toBe(
      "AUTH_NOT_CONFIGURED",
    );
    expect(
      (await request(providers.connect.login, undefined, config)).status,
    ).toBe(302);
    expect(
      (
        await request(
          providers.liteauth.login,
          { headers: { Accept: "text/html" } },
          config,
        )
      ).headers.get("Location"),
    ).toBe("/?authError=liteauth_not_configured");
    expect(
      (
        await request(providers.liteauth.login, undefined, {
          ...bindings,
          CONNECT_CLIENT_SECRET: "",
        })
      ).status,
    ).toBe(302);
  });

  it("binds PKCE and the provider to a one-time attempt without saving the verifier in plaintext", async () => {
    const start = await begin();
    expect(start.location.origin).toBe("https://liteauth.442224.xyz");
    expect(start.location.pathname).toBe("/api/auth/oauth2/authorize");
    expect(start.location.searchParams.get("scope")).toBe("profile");
    expect(start.location.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(start.location.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/liteauth/callback`,
    );
    expect(start.response.headers.get("Set-Cookie")).toContain(
      "hb_liteauth_state=",
    );
    expect(start.response.headers.get("Set-Cookie")).toContain(
      "Path=/api/auth/liteauth/callback",
    );
    expect(start.response.headers.get("Set-Cookie")).toContain(
      "HttpOnly; Secure; SameSite=Lax",
    );
    const attempt = await env.DB.prepare(
      "SELECT state_hash,login_provider,pkce_verifier_ciphertext,expected_user_id FROM oauth_attempts",
    ).first<{
      state_hash: string;
      login_provider: string;
      pkce_verifier_ciphertext: string;
      expected_user_id: string | null;
    }>();
    expect(attempt?.login_provider).toBe("liteauth");
    expect(attempt?.expected_user_id).toBeNull();
    const verifier = await decryptString(
      attempt?.pkce_verifier_ciphertext ?? "",
      bindings,
      pkceAssociatedData(attempt?.state_hash ?? ""),
    );
    expect(attempt?.pkce_verifier_ciphertext).not.toContain(verifier);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(start.location.searchParams.get("code_challenge")).toBe(challenge);
    const provider = mockProvider("liteauth", profile(), verifier);
    const response = await finish(start);
    expect(response.headers.get("Location")).toBe("/account");
    const signed = await me(cookie(response));
    expect(signed.user).toMatchObject({
      username: "Alice",
      accountTier: "lite",
      canUseLdc: false,
      loginProvider: "liteauth",
      email: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT provider,external_id,official_connect_verified FROM users",
      ).first(),
    ).toEqual({
      provider: "linux_do",
      external_id: "12345",
      official_connect_verified: 0,
    });
    expect((await finish(start)).headers.get("Location")).toBe(
      "/?authError=invalid_state",
    );
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    "https://untrusted.example/api/auth",
    `${issuer}/`,
    `${issuer}?x=1`,
  ])(
    "rejects invalid LiteAuth issuer %s before token exchange",
    async (invalidIssuer) => {
      const start = await begin();
      const provider = mockProvider();
      expect(
        (await finish(start, { issuer: invalidIssuer })).headers.get(
          "Location",
        ),
      ).toBe("/?authError=liteauth_failed");
      expect(provider).not.toHaveBeenCalled();
      expect((await finish(start)).headers.get("Location")).toBe(
        "/?authError=invalid_state",
      );
    },
  );

  it("rejects duplicate issuers and an attempt with ciphertext from another state", async () => {
    const first = await begin();
    const second = await begin();
    const ciphertext = await env.DB.prepare(
      "SELECT pkce_verifier_ciphertext FROM oauth_attempts WHERE state_hash=?",
    )
      .bind(await sha256Hex(`hb.oauth-state.v1:${first.state}`))
      .first<string>("pkce_verifier_ciphertext");
    const provider = mockProvider();
    const duplicate = await request(
      `${providers.liteauth.callback}?state=${first.state}&code=fixture-code&iss=${encodeURIComponent(issuer)}&iss=${encodeURIComponent(issuer)}`,
      { headers: { Cookie: first.cookie } },
    );
    expect(duplicate.headers.get("Location")).toBe(
      "/?authError=liteauth_failed",
    );
    await env.DB.prepare(
      "UPDATE oauth_attempts SET pkce_verifier_ciphertext=? WHERE state_hash=?",
    )
      .bind(ciphertext, await sha256Hex(`hb.oauth-state.v1:${second.state}`))
      .run();
    expect((await finish(second)).headers.get("Location")).toBe(
      "/?authError=liteauth_failed",
    );
    expect(provider).not.toHaveBeenCalled();
  });

  it("prevents provider mixing and does not consume the other provider's valid attempt", async () => {
    const lite = await begin();
    const connect = await begin("connect");
    const provider = mockProvider();
    const mixed = await request(
      `${providers.liteauth.callback}?state=${connect.state}&code=fixture-code&iss=${encodeURIComponent(issuer)}`,
      { headers: { Cookie: lite.cookie } },
    );
    expect(mixed.headers.get("Location")).toBe("/?authError=invalid_state");
    const missingOwnCookie = await request(
      `${providers.liteauth.callback}?state=${lite.state}&code=fixture-code&iss=${encodeURIComponent(issuer)}`,
      { headers: { Cookie: connect.cookie } },
    );
    expect(missingOwnCookie.headers.get("Location")).toBe(
      "/?authError=invalid_state",
    );
    expect(provider).not.toHaveBeenCalled();
    expect((await finish(lite)).headers.get("Location")).toBe("/account");
    expect(
      await env.DB.prepare("SELECT login_provider FROM oauth_attempts").first(
        "login_provider",
      ),
    ).toBe("connect");
  });

  it.each([
    { id: undefined },
    { id: null },
    { id: "not-an-id" },
    { id: 0 },
    { id: "18446744073709551616" },
    { id: 9007199254740992 },
    { auth_source: "other" },
    { login_method: "official_connect" },
    { login_method: undefined },
    { active: false },
    { username: undefined },
  ])(
    "rejects invalid or non-Lite identity %# without using sub or another identifier",
    async (fields) => {
      const start = await begin();
      mockProvider("liteauth", profile(fields));
      expect((await finish(start)).headers.get("Location")).toBe(
        "/?authError=liteauth_failed",
      );
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n"),
      ).toBe(0);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
      ).toBe(0);
    },
  );

  it("canonicalizes uint64 text without rounding and never merges by names or LiteAuth internal IDs", async () => {
    const max = await login(
      "liteauth",
      profile({ id: "18446744073709551615" }),
    );
    const other = await login("liteauth", profile({ id: "0012345" }));
    const official = await login("connect", profile({ id: 12345 }));
    expect(other.me.user?.id).not.toBe(max.me.user?.id);
    expect(other.me.user?.id).toBe(official.me.user?.id);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n"),
    ).toBe(2);
    expect(
      await env.DB.prepare("SELECT external_id FROM users WHERE id=?")
        .bind(max.me.user?.id)
        .first("external_id"),
    ).toBe("18446744073709551615");
  });

  it("preserves Connect email and optional avatar while synchronizing LiteAuth names", async () => {
    const official = await login(
      "connect",
      profile({
        email: "connect-private@example.com",
        avatar_url: "https://cdn.example.com/old.png",
      }),
    );
    const savedEmail = await env.DB.prepare(
      "SELECT email_ciphertext FROM users WHERE id=?",
    )
      .bind(official.me.user?.id)
      .first("email_ciphertext");
    const lite = await login(
      "liteauth",
      profile({
        username: "NewCase",
        name: "Updated",
        email: "ignored@example.com",
        avatar_url: "javascript:bad()",
      }),
    );
    expect(lite.me.user).toMatchObject({
      id: official.me.user?.id,
      username: "NewCase",
      displayName: "Updated",
      email: "connect-private@example.com",
      avatarUrl: "https://cdn.example.com/old.png",
      accountTier: "standard",
      canUseLdc: true,
      loginProvider: "liteauth",
    });
    expect(
      await env.DB.prepare("SELECT email_ciphertext FROM users WHERE id=?")
        .bind(official.me.user?.id)
        .first("email_ciphertext"),
    ).toBe(savedEmail);
    const updated = await login(
      "liteauth",
      profile({ avatar_url: "https://cdn.example.com/new.png" }),
    );
    expect(updated.me.user?.avatarUrl).toBe("https://cdn.example.com/new.png");
    expect(updated.me.user?.email).toBe("connect-private@example.com");
  });

  it("updates existing session eligibility after official login without changing its login source", async () => {
    const lite = await login();
    const same = await login("connect");
    expect(same.me.user?.id).toBe(lite.me.user?.id);
    expect((await me(lite.cookie)).user).toMatchObject({
      accountTier: "standard",
      canUseLdc: true,
      loginProvider: "liteauth",
    });
    expect(await hasOfficialConnect(bindings, lite.me.user?.id ?? "")).toBe(
      true,
    );
  });

  it("does not downgrade when a LiteAuth profile response arrives after official authentication", async () => {
    const lite = await begin();
    const official = await begin("connect");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markProfileStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markProfileStarted = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const outbound = new Request(input, init);
      if (outbound.url === providers.liteauth.profile) {
        markProfileStarted();
        await gate;
        return Response.json(profile());
      }
      if (outbound.url === providers.connect.profile)
        return Response.json(
          profile({ email: "official-private@example.com" }),
        );
      if (
        outbound.url === providers.liteauth.token ||
        outbound.url === providers.connect.token
      )
        return Response.json({ access_token: "fixture-token" });
      throw new Error("Unexpected outbound request");
    });
    const pendingLite = finish(lite);
    await started;
    const acceptedOfficial = await finish(official);
    release();
    const acceptedLite = await pendingLite;
    expect((await me(cookie(acceptedOfficial))).user).toMatchObject({
      accountTier: "standard",
      email: "official-private@example.com",
    });
    expect((await me(cookie(acceptedLite))).user).toMatchObject({
      accountTier: "standard",
      email: "official-private@example.com",
      loginProvider: "liteauth",
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n"),
    ).toBe(1);
  });

  it("binds an explicit upgrade to the current account and returns to the original page", async () => {
    const lite = await login();
    const start = await begin("connect", {
      cookie: lite.cookie,
      upgrade: true,
      returnTo: "/activities/fixture",
    });
    expect(
      await env.DB.prepare("SELECT expected_user_id FROM oauth_attempts").first(
        "expected_user_id",
      ),
    ).toBe(lite.me.user?.id);
    mockProvider("connect");
    const response = await finish(start, { sessionCookie: lite.cookie });
    expect(response.headers.get("Location")).toBe("/activities/fixture");
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith("hb_session=")),
    ).toBe(false);
    expect((await me(lite.cookie)).user).toMatchObject({
      id: lite.me.user?.id,
      accountTier: "standard",
      loginProvider: "connect",
    });
  });

  for (const when of ["before", "after"] as const) {
    it(`cannot revive a session when logout happens ${when} the atomic upgrade batch`, async () => {
      const lite = await login();
      const start = await begin("connect", {
        cookie: lite.cookie,
        upgrade: true,
      });
      mockProvider("connect", profile({ name: "Official Verified Name" }));
      const batch = env.DB.batch.bind(env.DB);
      async function logoutCurrent() {
        const result = await request("/api/auth/logout", {
          method: "POST",
          headers: {
            Cookie: lite.cookie,
            Origin: origin,
            "X-CSRF-Token": lite.me.csrfToken ?? "",
          },
        });
        expect(result.status).toBe(200);
      }
      vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
        if (when === "before") await logoutCurrent();
        const result = await batch(statements);
        if (when === "after") await logoutCurrent();
        return result;
      });
      const response = await finish(start, { sessionCookie: lite.cookie });
      expect(response.headers.get("Location")).toBe(
        when === "before" ? "/?authError=upgrade_session_changed" : "/account",
      );
      expect(
        response.headers
          .getSetCookie()
          .some((value) => value.startsWith("hb_session=")),
      ).toBe(false);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
      ).toBe(0);
      expect((await me(lite.cookie)).user).toBeNull();
      expect(await hasOfficialConnect(bindings, lite.me.user?.id ?? "")).toBe(
        when === "after",
      );
      expect(
        await env.DB.prepare("SELECT display_name FROM users WHERE id=?")
          .bind(lite.me.user?.id)
          .first("display_name"),
      ).toBe(when === "before" ? "Alice Display" : "Official Verified Name");
    });
  }

  it("rejects upgrading a different Linux DO account without creating it or revoking the original session", async () => {
    const lite = await login();
    const start = await begin("connect", {
      cookie: lite.cookie,
      upgrade: true,
    });
    mockProvider("connect", profile({ id: "99999" }));
    const response = await finish(start, { sessionCookie: lite.cookie });
    expect(response.headers.get("Location")).toBe(
      "/?authError=identity_mismatch",
    );
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith("hb_session=")),
    ).toBe(false);
    expect((await me(lite.cookie)).user).toMatchObject({
      id: lite.me.user?.id,
      accountTier: "lite",
      loginProvider: "liteauth",
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n"),
    ).toBe(1);
  });

  it("rejects an upgrade after logout or an account switch before contacting the upstream", async () => {
    const lite = await login();
    const start = await begin("connect", {
      cookie: lite.cookie,
      upgrade: true,
    });
    const other = await login("liteauth", profile({ id: "99999" }));
    const provider = mockProvider("connect");
    expect(
      (await finish(start, { sessionCookie: other.cookie })).headers.get(
        "Location",
      ),
    ).toBe("/?authError=upgrade_session_changed");
    expect(provider).not.toHaveBeenCalled();
    expect((await me(other.cookie)).user?.id).toBe(other.me.user?.id);
    expect(
      (await begin("connect", { upgrade: true })).response.headers.get(
        "Location",
      ),
    ).toBe("/?authError=upgrade_session_required");
  });

  it("does not restore a logged-out account when an upgrade profile response arrives late", async () => {
    const lite = await login();
    const start = await begin("connect", {
      cookie: lite.cookie,
      upgrade: true,
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const outbound = new Request(input, init);
      if (outbound.url === providers.connect.token) {
        return Response.json({ access_token: "fixture-access-token" });
      }
      if (outbound.url === providers.connect.profile) {
        markStarted();
        await gate;
        return Response.json(profile());
      }
      throw new Error("Unexpected simulated upstream");
    });
    const pending = finish(start, { sessionCookie: lite.cookie });
    await started;
    const loggedOut = await request("/api/auth/logout", {
      method: "POST",
      headers: {
        Cookie: lite.cookie,
        Origin: origin,
        "X-CSRF-Token": lite.me.csrfToken ?? "",
      },
    });
    release();
    expect(loggedOut.status).toBe(200);
    expect((await pending).headers.get("Location")).toBe(
      "/?authError=upgrade_session_changed",
    );
    expect((await me(lite.cookie)).user).toBeNull();
    expect(await hasOfficialConnect(bindings, lite.me.user?.id ?? "")).toBe(
      false,
    );
  });

  it("keeps a locally disabled account disabled when LiteAuth authenticates it", async () => {
    const signed = await login();
    await env.DB.prepare("UPDATE users SET active=0 WHERE id=?")
      .bind(signed.me.user?.id)
      .run();
    const start = await begin();
    mockProvider();
    expect((await finish(start)).headers.get("Location")).toBe(
      "/?authError=liteauth_failed",
    );
    expect((await me(signed.cookie)).user).toBeNull();
    expect(
      await env.DB.prepare("SELECT active FROM users WHERE id=?")
        .bind(signed.me.user?.id)
        .first("active"),
    ).toBe(0);
  });

  it("checks qualification from the database and rejects inactive or missing users", async () => {
    const lite = await login();
    await expect(
      requireOfficialConnect(bindings, lite.me.user?.id ?? ""),
    ).rejects.toMatchObject({ status: 403, code: "OFFICIAL_CONNECT_REQUIRED" });
    expect(await hasOfficialConnect(bindings, "missing-user")).toBe(false);
    const official = await login("connect");
    await expect(
      requireOfficialConnect(bindings, official.me.user?.id ?? ""),
    ).resolves.toBeUndefined();
    await env.DB.prepare("UPDATE users SET active=0 WHERE id=?")
      .bind(official.me.user?.id)
      .run();
    expect(await hasOfficialConnect(bindings, official.me.user?.id ?? "")).toBe(
      false,
    );
  });

  it("consumes an expired or denied attempt without exposing upstream parameters", async () => {
    const expired = await begin();
    await env.DB.prepare("UPDATE oauth_attempts SET expires_at=0").run();
    const provider = mockProvider();
    expect((await finish(expired)).headers.get("Location")).toBe(
      "/?authError=invalid_state",
    );
    const denied = await begin();
    const result = await request(
      `${providers.liteauth.callback}?state=${denied.state}&error=access_denied&error_description=private-upstream-data`,
      { headers: { Cookie: denied.cookie } },
    );
    expect(result.headers.get("Location")).toBe("/?authError=access_denied");
    expect((await finish(denied)).headers.get("Location")).toBe(
      "/?authError=invalid_state",
    );
    expect(provider).not.toHaveBeenCalled();
  });

  it("performs at most one token exchange for concurrent callbacks", async () => {
    const start = await begin();
    const provider = mockProvider();
    const responses = await Promise.all([finish(start), finish(start)]);
    expect(
      responses.filter(
        (response) => response.headers.get("Location") === "/account",
      ),
    ).toHaveLength(1);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
    ).toBe(1);
  });

  it("keeps transport errors and protocol failures out of logs and never follows redirects", async () => {
    const start = await begin();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        expect(new Request(input, init).redirect).toBe("manual");
        return new Response("private-profile@example.com credential_secret", {
          status: 302,
          headers: { Location: "https://untrusted.example/" },
        });
      });
    expect((await finish(start)).headers.get("Location")).toBe(
      "/?authError=liteauth_failed",
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("auth_failure", {
      location: "liteauth_callback",
      stage: "token",
      reason: "http",
      httpStatus: 302,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /private-profile|credential_secret/,
    );
  });
});
