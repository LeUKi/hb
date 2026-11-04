import {
  generateChallenge,
  type ValidateChallengeBody,
  validateChallenge,
} from "capjs-core";
import {
  type Site,
  secretMatches,
  sha256Hex,
  siteSecret,
  sitesOf,
} from "./sites";

export { CapStore } from "./store";

// Cap (docs/cap-design.md §2): the same paths as Cap's own Standalone server,
// the site key first. A scope in the path binds a challenge and its token to
// what it is for, and siteverify hands it back.

/** How long a redeemed token may wait for its siteverify. */
const TOKEN_TTL_MS = 5 * 60_000;
/** A redeem body: the solutions and the browser checks' result. */
const MAX_BODY_BYTES = 64 * 1024;

const SCOPE = /^[A-Za-z0-9:_.-]{1,128}$/;

type Route =
  | { siteKey: string; action: "challenge" | "redeem"; scope: string | null }
  | { siteKey: string; action: "siteverify"; scope: null };

function routeOf(pathname: string): Route | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 2) {
    const [siteKey, action] = parts as [string, string];
    if (
      action === "challenge" ||
      action === "redeem" ||
      action === "siteverify"
    )
      return { siteKey, action, scope: null } as Route;
  }
  if (parts.length === 4 && parts[1] === "scope") {
    const [siteKey, , scope, action] = parts as [
      string,
      string,
      string,
      string,
    ];
    let decoded: string;
    try {
      decoded = decodeURIComponent(scope);
    } catch {
      return null;
    }
    if ((action === "challenge" || action === "redeem") && SCOPE.test(decoded))
      return { siteKey, action, scope: decoded };
  }
  return null;
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

/** CORS for a page on one of the site's origins; none for anyone else. */
function corsHeaders(site: Site, request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const allowed = site.origins.includes("*")
    ? "*"
    : site.origins.includes(origin)
      ? origin
      : null;
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function bodyOf(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function storeOf(env: CloudflareEnv, site: Site) {
  const id = env.CAP_STORE.idFromName(`site:${site.key}`);
  const hint = env.DO_LOCATION_HINT as DurableObjectLocationHint | "";
  return env.CAP_STORE.get(id, hint ? { locationHint: hint } : undefined);
}

/**
 * Requests from the internet carry `cf`; a Worker of ours calling through a
 * service binding does not, and limits its own callers.
 */
async function limited(env: CloudflareEnv, site: Site, request: Request) {
  if (!request.cf) return false;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.PUBLIC_LIMIT.limit({
    key: `${site.key}:${ip}`,
  });
  return !success;
}

async function challenge(env: CloudflareEnv, site: Site, scope: string | null) {
  const secret = await siteSecret(env.CAP_MASTER_SECRET, site.key);
  return generateChallenge(secret, {
    challengeCount: site.challengeCount,
    challengeDifficulty: site.difficulty,
    ...(scope ? { scope } : {}),
    ...(site.instrumentation
      ? { instrumentation: { blockAutomatedBrowsers: true } }
      : {}),
  });
}

/**
 * The scope a challenge token names (its JWT payload's `sk`), unverified:
 * validateChallenge checks the signature next.
 */
function challengeScope(token: unknown): string | null | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const { sk } = JSON.parse(
      atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
    ) as { sk?: unknown };
    return typeof sk === "string" ? sk : null;
  } catch {
    return undefined;
  }
}

async function redeem(
  env: CloudflareEnv,
  site: Site,
  scope: string | null,
  body: unknown,
) {
  if (!body || typeof body !== "object")
    return { success: false as const, error: "invalid_body" };
  // capjs-core compares scopes only when one is asked for: a scoped
  // challenge must not be redeemed without its scope either.
  if (challengeScope((body as { token?: unknown }).token) !== scope)
    return { success: false as const, error: "scope_mismatch" };
  const store = storeOf(env, site);
  const secret = await siteSecret(env.CAP_MASTER_SECRET, site.key);
  const result = await validateChallenge(
    secret,
    body as ValidateChallengeBody,
    {
      ...(scope ? { scope } : {}),
      tokenTtlMs: TOKEN_TTL_MS,
      consumeNonce: (sig, ttlMs) => store.consumeNonce(sig, ttlMs),
    },
  );
  if (!result.success) {
    console.log(
      JSON.stringify({
        event: "cap_redeem_failed",
        site: site.key,
        reason: result.reason,
        ...(result.blockedBy?.length ? { blockedBy: result.blockedBy } : {}),
      }),
    );
    return { success: false as const, error: result.reason };
  }
  if (!result.tokenKey) throw new Error("CAP_TOKEN_KEY_MISSING");
  await store.saveToken(result.tokenKey, result.scope, result.expires);
  return {
    success: true as const,
    token: result.token,
    expires: result.expires,
  };
}

/** A token's key in the store: its id and the SHA-256 of its secret part. */
async function tokenKeyOf(token: string) {
  const [id, part, extra] = token.split(":");
  if (!id || !part || extra !== undefined || token.length > 256) return null;
  return `${id}:${await sha256Hex(part)}`;
}

async function siteverify(env: CloudflareEnv, site: Site, body: unknown) {
  const { secret, response } = (body ?? {}) as {
    secret?: unknown;
    response?: unknown;
  };
  if (typeof secret !== "string" || !(await secretMatches(site, secret)))
    return json({ success: false, error: "invalid_secret" }, 403);
  const key = typeof response === "string" ? await tokenKeyOf(response) : null;
  const used = key ? await storeOf(env, site).useToken(key) : null;
  return used
    ? json({ success: true, scope: used.scope })
    : json({ success: false, error: "invalid_token" });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    const route = routeOf(url.pathname);
    const site = route ? sitesOf(env.CAP_SITES).get(route.siteKey) : undefined;
    if (!route || !site)
      return json({ success: false, error: "not_found" }, 404);
    const cors =
      route.action === "siteverify" ? {} : corsHeaders(site, request);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST")
      return json({ success: false, error: "method_not_allowed" }, 405, cors);
    if (route.action === "siteverify")
      return siteverify(env, site, await bodyOf(request));
    if (await limited(env, site, request))
      return json({ success: false, error: "rate_limited" }, 429, cors);
    if (route.action === "challenge")
      return json(await challenge(env, site, route.scope), 200, cors);
    const result = await redeem(env, site, route.scope, await bodyOf(request));
    return json(result, result.success ? 200 : 400, cors);
  },
} satisfies ExportedHandler<CloudflareEnv>;
