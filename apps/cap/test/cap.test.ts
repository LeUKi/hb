import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The same derivation as Cap's widget and capjs-core: each puzzle's salt and
// target come from the challenge token.
function fnv1aResume(state: number, text: string) {
  let hash = state;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

function prngFromHash(initial: number, length: number) {
  let state = initial;
  let result = "";
  while (result.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    result += state.toString(16).padStart(8, "0");
  }
  return result.substring(0, length);
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type Challenge = {
  challenge: { c: number; s: number; d: number };
  token: string;
  expires: number;
  instrumentation?: string;
};

async function solve({ challenge: { c, s, d }, token }: Challenge) {
  const tokenHash = fnv1aResume(2166136261, token);
  const solutions: number[] = [];
  for (let i = 1; i <= c; i++) {
    const saltSeed = fnv1aResume(tokenHash, String(i));
    const salt = prngFromHash(saltSeed, s);
    const target = prngFromHash(fnv1aResume(saltSeed, "d"), d);
    let nonce = 0;
    while (!(await sha256Hex(salt + nonce)).startsWith(target)) nonce++;
    solutions.push(nonce);
  }
  return solutions;
}

const BASE = "https://cap.test";

function post(path: string, body?: unknown, headers: HeadersInit = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function challengeAt(path: string) {
  const response = await post(`${path}/challenge`);
  expect(response.status).toBe(200);
  return (await response.json()) as Challenge;
}

async function redeemAt(path: string, challenge: Challenge) {
  const response = await post(`${path}/redeem`, {
    token: challenge.token,
    solutions: await solve(challenge),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      success: boolean;
      token?: string;
      error?: string;
    },
  };
}

function siteverify(site: string, secret: string, response: unknown) {
  return post(`/${site}/siteverify`, { secret, response });
}

describe("Cap", () => {
  it("gives a challenge, takes its solutions once, and verifies the token once", async () => {
    const challenge = await challengeAt("/plain");
    expect(challenge.challenge).toEqual({ c: 3, s: 32, d: 2 });
    expect(challenge.instrumentation).toBeUndefined();

    const redeemed = await redeemAt("/plain", challenge);
    expect(redeemed).toMatchObject({ status: 200, body: { success: true } });
    const again = await redeemAt("/plain", challenge);
    expect(again).toMatchObject({
      status: 400,
      body: { success: false, error: "already_redeemed" },
    });

    const token = redeemed.body.token as string;
    const wrongSecret = await siteverify("plain", "not-the-secret", token);
    expect(wrongSecret.status).toBe(403);
    const verified = await siteverify("plain", "plain-secret", token);
    expect(await verified.json()).toEqual({ success: true, scope: null });
    const spent = await siteverify("plain", "plain-secret", token);
    expect(await spent.json()).toEqual({
      success: false,
      error: "invalid_token",
    });
  });

  it("binds a scoped challenge and its token to the scope", async () => {
    const scoped = "/plain/scope/claim%3Ahongbao-1";
    const challenge = await challengeAt(scoped);
    const elsewhere = await redeemAt("/plain/scope/claim:hongbao-2", challenge);
    expect(elsewhere.body).toMatchObject({ error: "scope_mismatch" });
    const unscoped = await redeemAt("/plain", challenge);
    expect(unscoped.body).toMatchObject({ error: "scope_mismatch" });

    const redeemed = await redeemAt(scoped, challenge);
    expect(redeemed.body.success).toBe(true);
    const verified = await siteverify(
      "plain",
      "plain-secret",
      redeemed.body.token,
    );
    expect(await verified.json()).toEqual({
      success: true,
      scope: "claim:hongbao-1",
    });
  });

  it("keeps sites apart: one site's challenge and token mean nothing at another", async () => {
    const challenge = await challengeAt("/plain");
    expect((await redeemAt("/checked", challenge)).body).toMatchObject({
      error: "invalid_token",
    });
    const redeemed = await redeemAt("/plain", challenge);
    const verified = await siteverify(
      "checked",
      "plain-secret",
      redeemed.body.token,
    );
    expect(await verified.json()).toMatchObject({ success: false });
  });

  it("sends its browser checks where a site has them, and wants their result back", async () => {
    const challenge = await challengeAt("/checked");
    expect(typeof challenge.instrumentation).toBe("string");
    expect(challenge.instrumentation?.length).toBeGreaterThan(100);
    expect((await redeemAt("/checked", challenge)).body).toMatchObject({
      success: false,
      error: "instr_missing",
    });
  });

  it("answers CORS only for the site's own origins", async () => {
    const allowed = await post("/plain/challenge", undefined, {
      Origin: "https://page.test",
    });
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://page.test",
    );
    const other = await post("/plain/challenge", undefined, {
      Origin: "https://other.test",
    });
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const preflight = await SELF.fetch(`${BASE}/plain/redeem`, {
      method: "OPTIONS",
      headers: { Origin: "https://page.test" },
    });
    expect(preflight.status).toBe(204);
    const verify = await post(
      "/plain/siteverify",
      {},
      {
        Origin: "https://page.test",
      },
    );
    expect(verify.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("refuses unknown sites, other methods and malformed input", async () => {
    expect((await post("/nobody/challenge")).status).toBe(404);
    expect((await post("/plain/scope/%E0%A4%A/challenge")).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/plain/challenge`)).status).toBe(405);
    expect((await post("/plain/redeem", "not an object")).status).toBe(400);
    for (const response of [null, 42, "no-colon", "a:b:c", "x".repeat(300)]) {
      const verified = await siteverify("plain", "plain-secret", response);
      expect(await verified.json()).toMatchObject({ success: false });
    }
    expect((await SELF.fetch(`${BASE}/health`)).status).toBe(200);
  });
});
