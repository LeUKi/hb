// `npm run simulate -- --live` (协议第 9 节): the sandbox's fetch() goes out
// from this computer through here, held to the site's rules (network.mjs):
// only the addresses judge.js lists, GET and POST, 16 KB out, 10 seconds,
// 64 KB back, no redirect followed. The site's gateway also counts each
// judgment's requests; here the sandbox's own fetch() does.
import {
  allowedBy,
  NETWORK_LIMITS,
  NETWORK_REASONS,
  requestProblem,
} from "./network.mjs";

const USER_AGENT = "hb.lafi.sh-judge (+https://hb.lafi.sh/help/code)";

const base64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const part = (value) =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * X-Hb-Token (docs/judge-address-design.md §12.5): signed as the site's
 * gateway signs it, with the simulator's key for this run.
 */
async function tokenFor(token, address) {
  const key = await crypto.subtle.importKey(
    "jwk",
    token.jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const issuedAt = Math.floor(Date.now() / 1000);
  const signing = `${part({ alg: "ES256", typ: "JWT", kid: token.kid })}.${part(
    {
      iss: token.iss,
      aud: new URL(address).origin,
      hongbao: token.hongbao,
      sender: token.sender,
      iat: issuedAt,
      exp: issuedAt + 60,
      jti: crypto.randomUUID(),
    },
  )}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signing),
  );
  return `${signing}.${base64Url(new Uint8Array(signature))}`;
}

/** Turned down: why, for the sandbox's fetch() to throw. */
const refuse = (reason) =>
  new Response(null, {
    status: 599,
    headers: { "x-hb-refused": encodeURIComponent(reason) },
  });

/** The answer's body, up to the limit; null past it. */
async function readUpTo(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return body;
}

export default {
  async fetch(request, env) {
    const list = JSON.parse(env.LIST);
    const method = request.method.toUpperCase();
    const body =
      method === "GET"
        ? new Uint8Array(0)
        : new Uint8Array(await request.arrayBuffer());
    const problem = requestProblem(
      {
        method,
        address: request.url,
        headers: [...request.headers.keys()],
        bodyBytes: body.length,
      },
      list,
    );
    if (problem) return refuse(problem);
    const headers = new Headers(request.headers);
    headers.set("user-agent", USER_AGENT);
    headers.set("x-hb-hongbao", env.HONGBAO ?? "test");
    // 密钥 from keys.local.json, to their own address only (judge-key §5).
    for (const key of JSON.parse(env.KEYS ?? "[]"))
      if (allowedBy([key.to], request.url)) headers.set(key.header, key.value);
    const token = JSON.parse(env.TOKEN ?? "null");
    if (token && allowedBy(token.addresses, request.url))
      headers.set("x-hb-token", await tokenFor(token, request.url));
    let response;
    try {
      response = await fetch(request.url, {
        method,
        headers,
        ...(body.length > 0 ? { body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(NETWORK_LIMITS.requestMs),
      });
    } catch (error) {
      return refuse(
        error?.name === "TimeoutError"
          ? NETWORK_REASONS.timeout
          : NETWORK_REASONS.unreachable,
      );
    }
    let answer;
    try {
      answer = await readUpTo(response, NETWORK_LIMITS.responseBytes);
    } catch {
      return refuse(NETWORK_REASONS.timeout);
    }
    if (answer === null) return refuse(NETWORK_REASONS.responseTooBig);
    const back = new Headers(response.headers);
    back.delete("set-cookie");
    return new Response(
      [101, 204, 205, 304].includes(response.status) ? null : answer,
      {
        status: response.status,
        statusText: response.statusText,
        headers: back,
      },
    );
  },
};
