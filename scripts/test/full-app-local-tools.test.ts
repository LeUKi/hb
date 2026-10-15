import { describe, expect, it } from "vitest";
import {
  createLocalLoginResponse,
  createLocalOAuthAuthorizeResponse,
  nodeHeadersFromWebResponse,
  rewriteOAuthAuthorizeLocation,
} from "../full-app-local-tools.mjs";

const origin = "http://127.0.0.1:4195";

describe("full-app local experience OAuth bridge", () => {
  it("rewrites only Connect authorize redirects to the local bridge", () => {
    const external =
      "https://connect.linux.do/oauth2/authorize?response_type=code&state=abc";
    expect(rewriteOAuthAuthorizeLocation(external, origin)).toBe(
      `${origin}/__local/full-app/oauth/connect/authorize?response_type=code&state=abc`,
    );
    expect(
      rewriteOAuthAuthorizeLocation(
        "https://example.test/oauth2/authorize",
        origin,
      ),
    ).toBeNull();
    expect(
      rewriteOAuthAuthorizeLocation(
        "https://liteauth.442224.xyz/api/auth/oauth2/authorize?state=abc",
        origin,
      ),
    ).toBeNull();
    expect(
      rewriteOAuthAuthorizeLocation("/api/auth/callback", origin),
    ).toBeNull();
  });

  it("creates a local login hop without directly setting the app session", () => {
    const response = createLocalLoginResponse(
      `${origin}/__local/full-app/login?role=recipient&returnTo=%2Faccount`,
      origin,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${origin}/api/auth/login?returnTo=%2Faccount`,
    );
    expect(response.headers.get("set-cookie")).toContain(
      "hb_full_app_local_oauth=recipient;",
    );
    expect(response.headers.get("set-cookie")).not.toContain("hb_session");
  });

  it("turns a valid Connect authorization request into the real app callback", () => {
    const state = "A".repeat(32);
    const authorize = new URL(
      "/__local/full-app/oauth/connect/authorize",
      origin,
    );
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", "hb_full_app_connect");
    authorize.searchParams.set("redirect_uri", `${origin}/api/auth/callback`);
    authorize.searchParams.set("state", state);
    const response = createLocalOAuthAuthorizeResponse(
      authorize.toString(),
      origin,
      "hb_full_app_local_oauth=recipient",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${origin}/api/auth/callback?state=${state}&code=full-app-code-recipient`,
    );
  });

  it("defaults a direct authorize click without a selected role to the author", () => {
    const state = "B".repeat(32);
    const authorize = new URL(
      "/__local/full-app/oauth/connect/authorize",
      origin,
    );
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", "hb_full_app_connect");
    authorize.searchParams.set("redirect_uri", `${origin}/api/auth/callback`);
    authorize.searchParams.set("state", state);
    const response = createLocalOAuthAuthorizeResponse(
      authorize.toString(),
      origin,
      "",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${origin}/api/auth/callback?state=${state}&code=full-app-code-author`,
    );
  });
});

describe("full-app local experience proxy headers", () => {
  it("keeps multiple Set-Cookie headers as separate node headers", () => {
    const headers = new Headers([
      ["Set-Cookie", "hb_oauth_state=one; Path=/api/auth/callback"],
      ["Set-Cookie", "hb_session=two; Path=/"],
      ["Location", "https://connect.linux.do/oauth2/authorize"],
      ["Content-Encoding", "gzip"],
      ["Content-Length", "999"],
    ]);
    expect(
      nodeHeadersFromWebResponse(headers, `${origin}/__local/oauth`),
    ).toEqual({
      location: `${origin}/__local/oauth`,
      "set-cookie": [
        "hb_oauth_state=one; Path=/api/auth/callback",
        "hb_session=two; Path=/",
      ],
    });
  });
});
