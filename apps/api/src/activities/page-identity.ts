// 附带网页认人 (docs/page-identity-design.md): a short token this site signs
// for the 附带网页's own server, naming who is looking at the page (their
// LINUX DO id, username, name and level) and for which 红包 and which
// page. The server checks it with the keys published here; the page asks
// for one through the SDK once the viewer allowed it (page-bridge.ts).
import {
  ACTIVITY_LIMITS,
  type PageIdentity,
  pageIdentityRequestSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { requireProtectedMutation } from "../auth/session";
import type { ApiBindings, ApiContext } from "../env";
import { base64UrlEncode } from "../security/crypto";
import { attachedPagesOn } from "./attached-page";
import { ActivityError, activityNotFound } from "./errors";
import { ActivityValidationError } from "./routes";
import { configuration } from "./service";
import { findActivity } from "./storage";

/** Ten minutes: a token that leaked is good for no longer. */
const LIFETIME_SECONDS = 600;

type SigningKey = { kid: string; x: string; y: string; d: string };

/**
 * PAGE_IDENTITY_KEYS: private P-256 JWKs, the first one signing, the rest
 * published only (while tokens they signed may still be in use). None set:
 * nothing is signed, and nothing published.
 */
function keysOf(env: ApiBindings): SigningKey[] {
  try {
    const parsed: unknown = JSON.parse(env.PAGE_IDENTITY_KEYS ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (key): key is SigningKey =>
        typeof key === "object" &&
        key !== null &&
        key.kty === "EC" &&
        key.crv === "P-256" &&
        typeof key.kid === "string" &&
        typeof key.x === "string" &&
        typeof key.y === "string" &&
        typeof key.d === "string",
    );
  } catch {
    return [];
  }
}

/** The public keys, as a JWKS (GET /api/page-identity/keys). */
export function pageIdentityKeys(env: ApiBindings) {
  return {
    keys: keysOf(env).map(({ kid, x, y }) => ({
      kty: "EC" as const,
      crv: "P-256" as const,
      x,
      y,
      kid,
      alg: "ES256" as const,
      use: "sig" as const,
    })),
  };
}

/** Imported once per isolate, by key. */
const signers = new Map<string, Promise<CryptoKey>>();

function signerOf(key: SigningKey) {
  const id = `${key.kid} ${key.x}`;
  let signer = signers.get(id);
  if (!signer) {
    signer = crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: key.x, y: key.y, d: key.d, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    signers.set(id, signer);
  }
  return signer;
}

const encoder = new TextEncoder();
const part = (value: unknown) =>
  base64UrlEncode(encoder.encode(JSON.stringify(value)));

/**
 * These claims as a JWT signed with the first of PAGE_IDENTITY_KEYS — the
 * keys published here, also for the token the gateway adds to a 判定器's
 * requests (docs/judge-address-design.md §12). Null while none is set.
 */
export async function signClaims(
  env: ApiBindings,
  claims: Record<string, unknown>,
) {
  const [key] = keysOf(env);
  if (!key) return null;
  const signing = `${part({ alg: "ES256", typ: "JWT", kid: key.kid })}.${part(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await signerOf(key),
    encoder.encode(signing),
  );
  return `${signing}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Its 判定器 and version, in both tokens (docs/judge-address-design.md
 * §13.1); none for a 红包 without one.
 */
export function judgeClaims(
  row: { judge: string | null; judgeVersion: number | null } | null,
) {
  return row?.judge
    ? { judge: row.judge, judgeVersion: row.judgeVersion ?? 0 }
    : {};
}

/**
 * A token for the viewer on this 红包's 附带网页 (§2): only while it has
 * one that is shown (its switch on, not stopped by the 站长); `aud` is that
 * page's origin, whatever the page says. ES256: Web Crypto signs as JWS
 * wants it (r and s, 64 bytes).
 */
export async function signPageIdentity(
  env: ApiBindings,
  input: {
    issuer: string;
    activityId: string;
    userId: string;
    nonce?: string;
  },
): Promise<PageIdentity> {
  const [row, person, sender] = await Promise.all([
    findActivity(env, input.activityId),
    env.DB.prepare(
      "SELECT external_id AS id, username, display_name AS name, trust_level AS level FROM users WHERE id = ?",
    )
      .bind(input.userId)
      .first<{
        id: string;
        username: string;
        name: string;
        level: number | null;
      }>(),
    // Its sender, for a service that serves only its owner's 红包
    // (docs/judge-address-design.md §6), and its 判定器, for a server that
    // serves only its own (§13.1).
    env.DB.prepare(
      `SELECT u.external_id AS id, c.judge_id AS judge, c.judge_version AS judgeVersion
        FROM activities a JOIN users u ON u.id = a.author_id
          LEFT JOIN activity_code c ON c.activity_id = a.id
        WHERE a.id = ?`,
    )
      .bind(input.activityId)
      .first<{
        id: string;
        judge: string | null;
        judgeVersion: number | null;
      }>(),
  ]);
  if (!row) activityNotFound();
  if (!person) throw new ActivityError(401, "UNAUTHORIZED", "请先登录。");
  const pageUrl = configuration(row).pageUrl;
  if (!pageUrl || row.pageStoppedAt !== null || !(await attachedPagesOn(env)))
    throw new ActivityError(404, "PAGE_NOT_FOUND", "这个红包没有附带网页。");
  const issuedAt = Math.floor(Date.now() / 1000);
  const expires = issuedAt + LIFETIME_SECONDS;
  const user = {
    id: String(person.id),
    username: person.username,
    name: person.name,
    level: person.level,
  };
  const token = await signClaims(env, {
    iss: input.issuer,
    aud: new URL(pageUrl).origin,
    sub: user.id,
    username: user.username,
    name: user.name,
    level: user.level,
    hongbao: row.id,
    ...(sender ? { sender: String(sender.id) } : {}),
    ...judgeClaims(sender),
    iat: issuedAt,
    exp: expires,
    jti: crypto.randomUUID(),
    ...(input.nonce ? { nonce: input.nonce } : {}),
  });
  if (!token)
    throw new ActivityError(
      503,
      "IDENTITY_UNAVAILABLE",
      "身份暂时不可用，请稍后再试。",
    );
  return {
    token,
    expiresAt: new Date(expires * 1000).toISOString(),
    user,
  };
}

/**
 * GET /api/page-identity/keys: the keys a page's server checks tokens with,
 * anyone's to read. POST /api/activities/:id/page-identity: a token for the
 * viewer on that 红包's page, asked from this site's pages only.
 */
export const pageIdentityRoutes = new Hono<ApiContext>()
  .get("/page-identity/keys", (c) => {
    // Not cached here (the API answers no-store throughout): servers keep
    // them themselves, as JWT libraries do.
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(pageIdentityKeys(c.env));
  })
  .post(
    "/activities/:id/page-identity",
    bodyLimit({
      maxSize: ACTIVITY_LIMITS.requestBytes,
      onError: () => {
        throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容太大");
      },
    }),
    validator("json", (value) => {
      const parsed = pageIdentityRequestSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityValidationError(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      c.header("Cache-Control", "no-store");
      return c.json(
        await signPageIdentity(c.env, {
          issuer: c.env.APP_ORIGIN || new URL(c.req.url).origin,
          activityId: c.req.param("id"),
          userId: session.user.id,
          nonce: c.req.valid("json").nonce,
        }),
      );
    },
  );
