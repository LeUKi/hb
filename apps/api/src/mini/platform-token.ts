import { FORUM_ORIGIN } from "@hb/contracts";
import type { ApiBindings } from "../env";
import { base64UrlDecode, base64UrlEncode } from "../security/crypto";

// 社区小程序 (docs/mini-app-design.md §7): the forum signs each request its
// mini app makes, a JWT bound to that endpoint (`iss` the forum, `aud` this
// site, `sub` the LINUX DO id). Checked here rule by rule as the forum's own
// server SDK checks it (@discourse-mini-app/sdk/server, which needs
// node:crypto), with WebCrypto. Anything off is the same one refusal.

/** The forum's word on who is asking, once its signature checks out. */
export type PlatformIdentity = {
  iss: string;
  aud: string;
  /** The LINUX DO id: with `iss`, the account. */
  sub: string;
  app_id: string;
  version: string;
  channel: "production" | "sandbox";
  scopes: ("network.request" | "network.websocket")[];
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  htm: string;
  htu: string;
  query_keys: string[];
};

export type MiniAppTrust = {
  issuer: string;
  /** This site's origin, which the forum signs each token for. */
  audience: string;
  appId: string;
  /** Stage takes the sandbox's builds, production the published ones. */
  channel: "production" | "sandbox";
  /** The forum's public keys by `kid`: SHA-256 of each one's SPKI. */
  keys: Map<string, CryptoKey>;
};

export class PlatformTokenError extends Error {
  constructor() {
    super("Invalid platform request");
  }
}

const refuse = (): never => {
  throw new PlatformTokenError();
};

const encoder = new TextEncoder();

/** One part of the token: base64url as written, nothing else. */
function part(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) refuse();
  const bytes = base64UrlDecode(value);
  if (base64UrlEncode(bytes) !== value) refuse();
  return bytes;
}

const json = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

async function sha256Hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function importJwk(jwk: JsonWebKey) {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || "d" in jwk) refuse();
  const { kty, crv, x, y } = jwk;
  return crypto.subtle.importKey(
    "jwk",
    { kty, crv, x, y },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
}

/**
 * The forum's public keys — its JWKS as https://linux.do/mini-app-api/jwks
 * serves it, one JWK, or a PEM (SPKI); never a private one — by `kid`,
 * worked out here as the forum's SDK does.
 */
async function importKeys(text: string) {
  const value = text.trim();
  if (value.includes("PRIVATE KEY")) refuse();
  let keys: CryptoKey[];
  if (value.startsWith("{")) {
    const parsed = JSON.parse(value) as JsonWebKey & { keys?: JsonWebKey[] };
    keys = await Promise.all(
      (Array.isArray(parsed.keys) ? parsed.keys : [parsed]).map(importJwk),
    );
  } else {
    const body = /^-----BEGIN PUBLIC KEY-----([\s\S]+)-----END PUBLIC KEY-----$/
      .exec(value)?.[1]
      ?.replace(/\s+/g, "");
    if (!body) refuse();
    const der = Uint8Array.from(atob(body ?? ""), (char) => char.charCodeAt(0));
    keys = [
      await crypto.subtle.importKey(
        "spki",
        der,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"],
      ),
    ];
  }
  if (keys.length === 0) refuse();
  const byKid = new Map<string, CryptoKey>();
  for (const key of keys)
    byKid.set(
      await sha256Hex(
        (await crypto.subtle.exportKey("spki", key)) as ArrayBuffer,
      ),
      key,
    );
  return byKid;
}

const trusted = new Map<string, Promise<Map<string, CryptoKey>>>();

/**
 * How this deployment trusts the forum (MINI_APP_*), or null while it is
 * not set up: then the mini app's routes answer 503.
 */
export async function miniAppTrust(
  env: ApiBindings,
): Promise<MiniAppTrust | null> {
  const appId = env.MINI_APP_ID?.trim();
  const publicKey = env.MINI_APP_PUBLIC_KEY?.trim();
  const audience = env.APP_ORIGIN?.trim();
  const channel = env.MINI_APP_CHANNEL?.trim();
  if (!appId || !publicKey || !audience) return null;
  if (channel !== "production" && channel !== "sandbox") return null;
  let loaded = trusted.get(publicKey);
  if (!loaded) {
    loaded = importKeys(publicKey);
    trusted.set(publicKey, loaded);
    loaded.catch(() => trusted.delete(publicKey));
  }
  let keys: Map<string, CryptoKey>;
  try {
    keys = await loaded;
  } catch {
    return null;
  }
  return {
    issuer: env.MINI_APP_ISSUER?.trim() || FORUM_ORIGIN,
    audience: new URL(audience).origin,
    appId,
    channel,
    keys,
  };
}

/** An https URL as the forum writes one: no port, no user, no fragment. */
function target(value: string) {
  if (value.length > 2048 || /[^\x21-\x7e]|\\|#/.test(value)) refuse();
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port
  )
    refuse();
  const at = value.indexOf("?");
  const path = /^https:\/\/[^/?#]*([^?#]*)/i.exec(value)?.[1];
  if (path === undefined || (path || "/") !== parsed.pathname) refuse();
  return { parsed, query: at < 0 ? "" : value.slice(at + 1) };
}

/**
 * The request is the endpoint the token was signed for: same origin and
 * path, its fixed query first, then only the reviewed dynamic keys, each
 * once and short.
 */
function matchEndpoint(
  htu: unknown,
  keys: unknown,
  url: string,
  audience: string,
) {
  if (typeof htu !== "string" || htu.length > 2048) refuse();
  const base = target(htu as string);
  const actual = target(url);
  if (
    base.parsed.searchParams.has("mini_app_token") ||
    base.parsed.origin !== audience ||
    actual.parsed.origin !== base.parsed.origin ||
    actual.parsed.pathname !== base.parsed.pathname
  )
    refuse();
  if (!Array.isArray(keys) || keys.length > 16) refuse();
  const allowed = new Set<string>();
  for (const key of keys as unknown[]) {
    if (
      typeof key !== "string" ||
      !/^[A-Za-z0-9_.-]{1,64}$/.test(key) ||
      key === "mini_app_token" ||
      allowed.has(key) ||
      base.parsed.searchParams.has(key)
    )
      refuse();
    allowed.add(key as string);
  }
  let dynamic = "";
  if (actual.query !== base.query) {
    if (base.query && !actual.query.startsWith(`${base.query}&`)) refuse();
    dynamic = base.query
      ? actual.query.slice(base.query.length + 1)
      : actual.query;
    if (!dynamic) refuse();
  }
  const params = new URLSearchParams(dynamic);
  if (params.toString() !== dynamic || params.size > 16) refuse();
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (
      !allowed.has(key) ||
      seen.has(key) ||
      encoder.encode(value).length > 200
    )
      refuse();
    seen.add(key);
  }
  return [...allowed];
}

const safe = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

/** An HTTP request's `Authorization: Bearer …`, for this method and URL. */
export async function verifyPlatformRequest(
  trust: MiniAppTrust,
  request: {
    authorization: string;
    scope: "network.request" | "network.websocket";
    method: string;
    /** The external URL: this site's origin and the raw request target. */
    url: string;
    now?: number;
  },
): Promise<PlatformIdentity> {
  try {
    const { authorization, scope, method, url } = request;
    if (
      authorization.length > 8199 ||
      !authorization.startsWith("Bearer ") ||
      !/^[A-Z]+$/.test(method)
    )
      refuse();
    const pieces = authorization.slice(7).split(".");
    if (pieces.length !== 3) refuse();
    const [head, body, signature] = pieces as [string, string, string];
    const header = (json(part(head)) ?? refuse()) as Record<string, unknown>;
    const claims = json(part(body)) as Record<string, unknown> | null;
    if (
      header.alg !== "ES256" ||
      header.typ !== "mini-app-access+jwt" ||
      header.jku ||
      header.jwk ||
      header.x5u ||
      header.crit ||
      typeof header.kid !== "string"
    )
      refuse();
    const key = trust.keys.get(String(header.kid)) ?? refuse();
    const sig = part(signature);
    if (
      sig.length !== 64 ||
      !(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        sig,
        encoder.encode(`${head}.${body}`),
      ))
    )
      refuse();
    const now = Math.floor(request.now ?? Date.now() / 1000);
    const c = claims ?? refuse();
    if (
      c.iss !== trust.issuer ||
      c.aud !== trust.audience ||
      c.app_id !== trust.appId ||
      c.channel !== trust.channel ||
      typeof c.sub !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(c.sub) ||
      typeof c.version !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(c.version) ||
      !Array.isArray(c.scopes) ||
      c.scopes.length !== 1 ||
      c.scopes[0] !== scope ||
      !safe(c.iat) ||
      !safe(c.nbf) ||
      !safe(c.exp) ||
      !safe(now) ||
      c.exp <= c.iat ||
      c.exp - c.iat > 900 ||
      c.iat > now + 5 ||
      c.nbf > now + 5 ||
      c.nbf > c.iat ||
      c.iat - c.nbf > 5 ||
      c.exp <= now ||
      typeof c.jti !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(c.jti) ||
      c.htm !== method ||
      typeof c.htu !== "string"
    )
      refuse();
    const keys = matchEndpoint(c.htu, c.query_keys, url, trust.audience);
    return { ...(c as PlatformIdentity), query_keys: keys };
  } catch {
    throw new PlatformTokenError();
  }
}

/**
 * A WebSocket handshake: the token rides in its only `mini_app_token`
 * query value; the rest of the URL is the endpoint it was signed for.
 */
export async function verifyPlatformUpgrade(
  trust: MiniAppTrust,
  request: { url: string; now?: number },
): Promise<PlatformIdentity> {
  try {
    const { url } = request;
    if (url.length > 8192 || url.includes("#")) refuse();
    const parsed = new URL(url);
    if (
      !["https:", "wss:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.port
    )
      refuse();
    const at = url.indexOf("?");
    if (at < 0) refuse();
    const rest: string[] = [];
    let token: string | undefined;
    for (const pair of url.slice(at + 1).split("&")) {
      const equals = pair.indexOf("=");
      const name = equals < 0 ? pair : pair.slice(0, equals);
      let decoded: string;
      try {
        decoded = decodeURIComponent(name.replaceAll("+", " "));
      } catch {
        rest.push(pair);
        continue;
      }
      if (decoded !== "mini_app_token") {
        rest.push(pair);
        continue;
      }
      if (token !== undefined || equals < 0) refuse();
      token = decodeURIComponent(pair.slice(equals + 1).replaceAll("+", " "));
      if (!token) refuse();
    }
    if (!token) refuse();
    const endpoint =
      url.slice(0, at).replace(/^wss:/i, "https:") +
      (rest.length ? `?${rest.join("&")}` : "");
    return await verifyPlatformRequest(trust, {
      authorization: `Bearer ${token}`,
      scope: "network.websocket",
      method: "GET",
      url: endpoint,
      now: request.now,
    });
  } catch {
    throw new PlatformTokenError();
  }
}
