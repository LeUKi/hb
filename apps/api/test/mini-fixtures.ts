import type { ApiBindings } from "../src/env";
import { base64UrlEncode } from "../src/security/crypto";

// 社区小程序 (docs/mini-app-design.md §7): a stand-in for the forum, which
// signs each request its mini app makes for one endpoint of this site.

export const forum = "https://linux.do";
const appId = "01a19ba5-b9d2-766f-9fb9-b7eddc10e0c7";
const encoder = new TextEncoder();
const part = (value: unknown) =>
  base64UrlEncode(encoder.encode(JSON.stringify(value)));

export type MiniForum = {
  /** `base` taking this forum's tokens (sandbox builds, as on Stage). */
  bindings: ApiBindings;
  /** A token for `path` on `origin`, its claims changed by `claims`. */
  token(path: string, claims?: Record<string, unknown>): Promise<string>;
};

export async function miniForum(
  base: ApiBindings,
  origin: string,
): Promise<MiniForum> {
  const keys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = (await crypto.subtle.exportKey(
    "spki",
    keys.publicKey,
  )) as ArrayBuffer;
  const kid = [...new Uint8Array(await crypto.subtle.digest("SHA-256", spki))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const bindings: ApiBindings = {
    ...base,
    APP_ORIGIN: origin,
    MINI_APP_ID: appId,
    MINI_APP_CHANNEL: "sandbox",
    MINI_APP_PUBLIC_KEY: JSON.stringify({
      keys: [
        {
          ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
          use: "sig",
          alg: "ES256",
          kid,
        },
      ],
    }),
  };
  return {
    bindings,
    async token(path, claims = {}) {
      const now = Math.floor(Date.now() / 1000);
      const head = part({ alg: "ES256", typ: "mini-app-access+jwt", kid });
      const body = part({
        iss: forum,
        aud: origin,
        sub: "332940",
        app_id: appId,
        version: "0.2.5",
        channel: "sandbox",
        scopes: ["network.request"],
        iat: now,
        nbf: now - 5,
        exp: now + 900,
        jti: crypto.randomUUID().replaceAll("-", ""),
        htm: "GET",
        htu: `${origin}${path}`,
        query_keys: [],
        ...claims,
      });
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        encoder.encode(`${head}.${body}`),
      );
      return `${head}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
    },
  };
}
