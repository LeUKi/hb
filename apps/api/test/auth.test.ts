import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { requireAuth, requireOwner } from "../src/auth/session";
import type { ApiBindings, ApiContext } from "../src/env";
import { cleanupExpiredIdentityRows } from "../src/scheduled";

const origin = "https://hb.example.com";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  CONNECT_CLIENT_ID: "test-client",
  CONNECT_CLIENT_SECRET: "test-secret-only",
};

function request(path: string, init?: RequestInit, config = bindings) {
  return app.request(`${origin}${path}`, init, config);
}

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function begin(returnTo = "/account") {
  const response = await request(
    `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin).toBe("https://connect.linux.do");
  expect(location.pathname).toBe("/oauth2/authorize");
  expect(location.searchParams.get("redirect_uri")).toBe(
    `${origin}/api/auth/callback`,
  );
  const state = location.searchParams.get("state");
  expect(state).toBeTruthy();
  return { response, state, cookie: cookies(response) };
}

function mockProvider(
  profile: unknown = {
    id: 12345,
    username: "alice",
    name: "Alice",
    active: true,
  },
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      // Preserve workerd's Request validation while keeping provider traffic offline.
      const outbound = new Request(input, init);
      expect(outbound.redirect).toBe("manual");
      if (outbound.url === "https://connect.linux.do/oauth2/token") {
        expect(outbound.method).toBe("POST");
        expect(outbound.headers.get("authorization")).toBe(
          `Basic ${btoa("test-client:test-secret-only")}`,
        );
        const body = await outbound.formData();
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("redirect_uri")).toBe(`${origin}/api/auth/callback`);
        return Response.json({
          access_token: "test-access-token",
          token_type: "Bearer",
        });
      }
      if (outbound.url === "https://connect.linux.do/api/user") {
        expect(outbound.headers.get("authorization")).toBe(
          "Bearer test-access-token",
        );
        return Response.json(profile);
      }
      throw new Error("Unexpected outbound request");
    });
}

async function complete(start: Awaited<ReturnType<typeof begin>>) {
  return request(`/api/auth/callback?state=${start.state}&code=test-code`, {
    headers: { Cookie: start.cookie },
  });
}

async function login(profile?: unknown) {
  const start = await begin();
  const provider = mockProvider(profile);
  const response = await complete(start);
  provider.mockRestore();
  expect(response.headers.get("location")).toBe("/account");
  const cookie = cookies(response);
  const me = await request("/api/me", { headers: { Cookie: cookie } });
  return {
    cookie,
    response,
    me: (await me.json()) as {
      user: { id: string; username: string; displayName: string };
      csrfToken: string;
    },
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM payment_outbox"),
    env.DB.prepare("DELETE FROM payment_attempts"),
    env.DB.prepare("DELETE FROM payment_tasks"),
    env.DB.prepare("DELETE FROM simulation_orders"),
    env.DB.prepare("DELETE FROM simulation_controls"),
    env.DB.prepare("DELETE FROM merchant_credentials"),
    env.DB.prepare("DELETE FROM global_redemptions"),
    env.DB.prepare("DELETE FROM attempt_events"),
    env.DB.prepare("DELETE FROM redemption_submissions"),
    env.DB.prepare("DELETE FROM claims"),
    env.DB.prepare("DELETE FROM reward_inventory"),
    env.DB.prepare("DELETE FROM activity_passwords"),
    env.DB.prepare("DELETE FROM activities"),
    env.DB.prepare("DELETE FROM merchants"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM oauth_attempts"),
    env.DB.prepare("DELETE FROM users"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("Connect authorization and sessions", () => {
  it("allows anonymous me and health without credentials, but fails login closed", async () => {
    const response = await request("/api/me", undefined, { ...env });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: null, csrfToken: null });
    expect(
      (await request("/api/auth/login", undefined, { ...env })).status,
    ).toBe(503);
    const browserLogin = await request(
      "/api/auth/login",
      { headers: { Accept: "text/html" } },
      { ...env },
    );
    expect(browserLogin.headers.get("location")).toBe(
      "/?authError=auth_not_configured",
    );
  });

  it("binds one-time authorization state to the browser and creates a private session", async () => {
    const start = await begin();
    expect(start.response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(start.response.headers.get("set-cookie")).toContain("Secure");
    expect(start.response.headers.get("set-cookie")).toContain("SameSite=Lax");
    const provider = mockProvider();
    const missingCookie = await request(
      `/api/auth/callback?state=${start.state}&code=test-code`,
    );
    expect(missingCookie.headers.get("location")).toContain("authError=");
    expect(provider).not.toHaveBeenCalled();
    const response = await complete(start);
    expect(response.headers.get("location")).toBe("/account");
    const cookie = cookies(response);
    const me = await request("/api/me", { headers: { Cookie: cookie } });
    expect(await me.json()).toMatchObject({
      user: { username: "alice", displayName: "Alice" },
      csrfToken: expect.any(String),
    });
    expect(me.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const sessionCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("hb_session="));
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).toContain("Path=/");
    expect(sessionCookie).toContain("Max-Age=604800");
    const replay = await complete(start);
    expect(replay.headers.get("location")).toContain("authError=");
    expect(provider).toHaveBeenCalledTimes(2);
    const row = await env.DB.prepare("SELECT token_hash FROM sessions").first<{
      token_hash: string;
    }>();
    expect(row?.token_hash).toHaveLength(64);
    expect(cookie).not.toContain(row?.token_hash);
  });

  it("allows only one exchange when callbacks race", async () => {
    const start = await begin();
    const provider = mockProvider();
    const responses = await Promise.all([complete(start), complete(start)]);
    expect(
      responses.filter((r) => r.headers.get("location") === "/account"),
    ).toHaveLength(1);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("rejects a state paired with another browser's cookie", async () => {
    const first = await begin();
    const second = await begin();
    const provider = mockProvider();
    const response = await complete({ ...first, cookie: second.cookie });
    expect(response.headers.get("location")).toBe("/?authError=invalid_state");
    expect(provider).not.toHaveBeenCalled();
    expect((await complete(first)).headers.get("location")).toBe("/account");
  });

  it.each([
    {},
    { access_token: "" },
    { access_token: 123 },
    { access_token: "token", token_type: "mac" },
  ])("fails closed for malformed token responses %#", async (token) => {
    const start = await begin();
    const provider = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(token));
    expect((await complete(start)).headers.get("location")).toBe(
      "/?authError=auth_failed",
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM sessions").first("n"),
    ).toBe(0);
  });

  it("rejects expired authorization without calling the provider", async () => {
    const start = await begin();
    await env.DB.prepare("UPDATE oauth_attempts SET expires_at = 0").run();
    const provider = mockProvider();
    expect((await complete(start)).headers.get("location")).toContain(
      "authError=",
    );
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/\t/evil.example/",
    "/%2f%2fevil.example/",
  ])("rejects unsafe return target %s", async (returnTo) => {
    const start = await begin(returnTo);
    mockProvider();
    const response = await complete(start);
    expect(response.headers.get("location")).toBe("/");
  });

  it("handles provider denial without leaking parameters or creating a session", async () => {
    const start = await begin();
    const response = await request(
      `/api/auth/callback?state=${start.state}&error=access_denied&error_description=secret-value`,
      { headers: { Cookie: start.cookie } },
    );
    expect(response.headers.get("location")).toBe("/?authError=access_denied");
    expect(response.headers.get("location")).not.toContain("secret-value");
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM sessions").first("n"),
    ).toBe(0);
    mockProvider();
    expect((await complete(start)).headers.get("location")).toBe(
      "/?authError=invalid_state",
    );
  });

  it.each([
    { id: 12345, username: "alice", active: false },
    { id: 12345, username: "alice" },
    { id: 0, username: "alice", active: true },
    { id: "0", username: "alice", active: true },
    { id: "not-an-id", username: "alice", active: true },
    { id: "18446744073709551616", username: "alice", active: true },
    { id: 9007199254740992, username: "alice", active: true },
    { id: 12345, active: true },
  ])("rejects invalid or disabled identity %#", async (profile) => {
    const start = await begin();
    mockProvider(profile);
    expect((await complete(start)).headers.get("location")).toContain(
      "authError=",
    );
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM sessions").first("n"),
    ).toBe(0);
  });

  it("handles upstream errors without raw secret-bearing logs", async () => {
    const start = await begin();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("secret-token?client_secret=do-not-log"),
    );
    const response = await complete(start);
    expect(response.headers.get("location")).toContain("authError=");
    expect(JSON.stringify(log.mock.calls)).not.toContain("do-not-log");
    expect(log).toHaveBeenCalledWith("auth_failure", {
      location: "oauth_callback",
      stage: "token",
      reason: "network",
    });
  });

  it("records upstream HTTP status without reading or logging the response body", async () => {
    const start = await begin();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = new Response("upstream-secret-body", { status: 401 });
    const readBody = vi.spyOn(response, "json");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    expect((await complete(start)).headers.get("location")).toBe(
      "/?authError=auth_failed",
    );
    expect(log).toHaveBeenCalledWith("auth_failure", {
      location: "oauth_callback",
      stage: "token",
      reason: "http",
      httpStatus: 401,
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "upstream-secret-body",
    );
  });

  it("distinguishes profile transport failure from token exchange failure", async () => {
    const start = await begin();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          access_token: "private-access-token",
          token_type: "Bearer",
        }),
      )
      .mockRejectedValueOnce(new TypeError("private-profile-url"));
    expect((await complete(start)).headers.get("location")).toBe(
      "/?authError=auth_failed",
    );
    expect(log).toHaveBeenCalledWith("auth_failure", {
      location: "oauth_callback",
      stage: "profile",
      reason: "network",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-");
  });

  it.each([
    { stage: "token", status: 302 },
    { stage: "token", status: 307 },
    { stage: "profile", status: 302 },
    { stage: "profile", status: 307 },
  ])(
    "rejects $stage HTTP $status without following redirects or replaying state",
    async ({ stage, status }) => {
      const start = await begin();
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const redirected = new Response("private-redirect-body", {
        status,
        headers: { Location: "https://untrusted.example/collect" },
      });
      const readBody = vi.spyOn(redirected, "json");
      const contactedUrls: string[] = [];
      const provider = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const outbound = new Request(input, init);
          expect(outbound.redirect).toBe("manual");
          contactedUrls.push(outbound.url);
          if (
            stage === "profile" &&
            outbound.url === "https://connect.linux.do/oauth2/token"
          ) {
            return Response.json({
              access_token: "private-access-token",
              token_type: "Bearer",
            });
          }
          return redirected;
        });

      const response = await complete(start);
      expect(response.headers.get("location")).toBe("/?authError=auth_failed");
      expect(contactedUrls).toEqual(
        stage === "token"
          ? ["https://connect.linux.do/oauth2/token"]
          : [
              "https://connect.linux.do/oauth2/token",
              "https://connect.linux.do/api/user",
            ],
      );
      expect(readBody).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("auth_failure", {
        location: "oauth_callback",
        stage,
        reason: "http",
        httpStatus: status,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-");
      expect(
        await env.DB.prepare("SELECT count(*) AS n FROM sessions").first("n"),
      ).toBe(0);
      expect(
        await env.DB.prepare("SELECT count(*) AS n FROM users").first("n"),
      ).toBe(0);

      expect((await complete(start)).headers.get("location")).toBe(
        "/?authError=invalid_state",
      );
      expect(provider).toHaveBeenCalledTimes(stage === "token" ? 1 : 2);
    },
  );

  it("records a timeout safely without replaying the authorization code", async () => {
    const start = await begin();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new DOMException("private timeout details", "AbortError"),
      );
    expect((await complete(start)).headers.get("location")).toBe(
      "/?authError=auth_failed",
    );
    expect(log).toHaveBeenCalledWith("auth_failure", {
      location: "oauth_callback",
      stage: "token",
      reason: "timeout",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  it("updates mutable profile without changing identity or conflating reused usernames", async () => {
    const first = await login();
    const second = await login({
      id: 12345,
      username: "renamed",
      name: "New Name",
      active: true,
    });
    expect(second.me.user.id).toBe(first.me.user.id);
    expect(second.me.user.username).toBe("renamed");
    const third = await login({ id: 67890, username: "renamed", active: true });
    expect(third.me.user.id).not.toBe(first.me.user.id);
  });

  it("rejects callbacks on a different origin without consuming their state", async () => {
    const start = await begin();
    const provider = mockProvider();
    const invalid = await app.request(
      `https://wrong.example/api/auth/callback?state=${start.state}&code=test-code`,
      { headers: { Cookie: start.cookie } },
      bindings,
    );
    expect(invalid.status).toBe(302);
    expect(invalid.headers.get("location")).toBe("/?authError=invalid_origin");
    expect(provider).not.toHaveBeenCalled();
    expect((await complete(start)).headers.get("location")).toBe("/account");
  });

  it("keeps local disabled accounts disabled and invalidates their old session", async () => {
    const signed = await login();
    await env.DB.prepare("UPDATE users SET active = 0 WHERE id = ?")
      .bind(signed.me.user.id)
      .run();
    expect(
      await (
        await request("/api/me", { headers: { Cookie: signed.cookie } })
      ).json(),
    ).toEqual({ user: null, csrfToken: null });
    const start = await begin();
    mockProvider();
    expect((await complete(start)).headers.get("location")).toContain(
      "authError=",
    );
    expect(
      await env.DB.prepare("SELECT active FROM users WHERE id = ?")
        .bind(signed.me.user.id)
        .first("active"),
    ).toBe(0);
  });

  it("periodically removes expired authorization and session records without deleting live records", async () => {
    await login();
    await begin();
    await cleanupExpiredIdentityRows(env.DB);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM sessions").first("n"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM oauth_attempts").first(
        "n",
      ),
    ).toBe(1);
    await env.DB.prepare("UPDATE sessions SET expires_at = 0").run();
    await env.DB.prepare("UPDATE oauth_attempts SET expires_at = 0").run();
    await cleanupExpiredIdentityRows(env.DB);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM sessions").first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM oauth_attempts").first(
        "n",
      ),
    ).toBe(0);
  });

  it("rejects cross-origin and missing or wrong CSRF logout, then revokes the session", async () => {
    const signed = await login();
    const invalidHeaders: Record<string, string>[] = [
      { "X-CSRF-Token": signed.me.csrfToken },
      { Origin: "https://evil.example", "X-CSRF-Token": signed.me.csrfToken },
      { Origin: origin },
      { Origin: origin, "X-CSRF-Token": "wrong" },
    ];
    for (const headers of invalidHeaders) {
      expect(
        (
          await request("/api/auth/logout", {
            method: "POST",
            headers: { Cookie: signed.cookie, ...headers },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await request("/api/auth/logout", {
          method: "POST",
          headers: {
            Cookie: signed.cookie,
            Origin: origin,
            "X-CSRF-Token": signed.me.csrfToken,
          },
        })
      ).status,
    ).toBe(200);
    expect(
      await (
        await request("/api/me", { headers: { Cookie: signed.cookie } })
      ).json(),
    ).toEqual({ user: null, csrfToken: null });
  });

  it("rejects expired sessions and enforces owner permissions using the current account", async () => {
    const signed = await login();
    const protectedApp = new Hono<ApiContext>().get(
      "/private/:owner",
      async (c) => {
        const session = await requireAuth(c);
        requireOwner(session, c.req.param("owner"));
        return c.json({ userId: session.user.id });
      },
    );
    expect(
      (
        await protectedApp.request(
          `${origin}/private/${signed.me.user.id}`,
          {},
          bindings,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await protectedApp.request(
          `${origin}/private/another-user`,
          { headers: { Cookie: signed.cookie } },
          bindings,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await protectedApp.request(
          `${origin}/private/${signed.me.user.id}`,
          { headers: { Cookie: signed.cookie } },
          bindings,
        )
      ).status,
    ).toBe(200);
    await env.DB.prepare("UPDATE sessions SET expires_at = 0").run();
    expect(
      await (
        await request("/api/me", { headers: { Cookie: signed.cookie } })
      ).json(),
    ).toEqual({ user: null, csrfToken: null });
  });
});
