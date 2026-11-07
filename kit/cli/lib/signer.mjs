// 认人 in the kit (docs/page-identity-design.md §4; docs/judge-address-
// design.md §12.5): a P-256 key made for this run, signing as the site does
// (ES256 JWT) — the page's hb.identity() tokens here, the X-Hb-Token on a
// judgment's requests in the gateway (gateway.mjs, with `key`); its public
// half is published at /api/page-identity/keys, and 红包信息 (§13.4) at
// /api/hongbao/test.

import { splitParams, TEST_HONGBAO_ID } from "../../runtime/index.mjs";
import { fingerprintOf } from "./files.mjs";
import { yuan } from "./words.mjs";

export const base64Url = (bytes) =>
  Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export async function localSigner() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const kid = `local-${crypto.randomUUID().slice(0, 8)}`;
  const { x, y } = await crypto.subtle.exportKey("jwk", publicKey);
  const part = (value) =>
    base64Url(new TextEncoder().encode(JSON.stringify(value)));
  return {
    publicKey: { kty: "EC", crv: "P-256", x, y, kid, alg: "ES256", use: "sig" },
    /** For the gateway, which signs in workerd: never leaves this computer. */
    key: { kid, jwk: await crypto.subtle.exportKey("jwk", privateKey) },
    /** A viewer's token for the page (ten minutes), as the site's. */
    async identity({ iss, aud, user, hongbao, sender, nonce }) {
      const issuedAt = Math.floor(Date.now() / 1000);
      const expires = issuedAt + 600;
      const signing = `${part({ alg: "ES256", typ: "JWT", kid })}.${part({
        iss,
        aud,
        sub: user.id,
        username: user.username,
        name: user.name,
        level: user.level,
        hongbao,
        sender,
        judge: LOCAL_JUDGE.id,
        judgeVersion: LOCAL_JUDGE.version,
        iat: issuedAt,
        exp: expires,
        jti: crypto.randomUUID(),
        ...(nonce ? { nonce } : {}),
      })}`;
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        new TextEncoder().encode(signing),
      );
      return {
        token: `${signing}.${base64Url(new Uint8Array(signature))}`,
        expiresAt: new Date(expires * 1000).toISOString(),
        user,
      };
    },
  };
}

/** The 红包's sender in the kit, as the tokens' `sender` (judge-address §6). */
export const SENDER_ID = "10000";

/** Its 判定器 in the kit, as the tokens' `judge` (judge-address §13.4). */
export const LOCAL_JUDGE = Object.freeze({ id: "test", version: 0 });

/** Where the kit answers 红包信息, as the site's /api/hongbao/:id. */
export const INFO_PATH = `/api/hongbao/${TEST_HONGBAO_ID}`;

/**
 * 红包信息 as the kit answers it (judge-address §13.2, §13.4): the params
 * everyone sees — all of them once over, as `values` never has a 密钥 —
 * and the played 红包's pool and times (§13.7), `hongbao` as the judge is
 * given it (分, milliseconds) and `unclaimed` in 分.
 */
export function localInfo({
  code,
  declarations,
  values,
  ended,
  hongbao,
  unclaimed,
}) {
  return {
    id: TEST_HONGBAO_ID,
    status: ended ? "ended" : "active",
    paused: false,
    sender: SENDER_ID,
    judge: { ...LOCAL_JUDGE },
    fingerprint: fingerprintOf(code),
    params: ended ? values : splitParams(declarations, values).shown,
    unit: "LDC",
    pool: yuan(hongbao.total),
    unclaimed: yuan(unclaimed),
    openedAt: new Date(hongbao.openedAt).toISOString(),
    deadlineAt: new Date(hongbao.endsAt).toISOString(),
    // 模拟器不分领取范围：谁都能领
    scope: null,
  };
}

/**
 * `npm run simulate -- --live` (judge-address §12.5): the public half
 * published at http://127.0.0.1:8730/api/page-identity/keys while it runs,
 * as the simulator publishes it — another port when that one is taken —
 * and 红包信息 from `info()` once it has some (§13.4). `{ origin, close }`.
 */
export async function serveKeys(
  signer,
  { port = 8730, info = () => null } = {},
) {
  const { createServer } = await import("node:http");
  const answer = (response, body) =>
    response
      .writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
      })
      .end(JSON.stringify(body));
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/page-identity/keys")
      return answer(response, { keys: [signer.publicKey] });
    const shown = info();
    if (request.method === "GET" && request.url === INFO_PATH && shown)
      return answer(response, shown);
    response.writeHead(404).end();
  });
  const listen = (at) =>
    new Promise((done, failed) => {
      server.once("error", failed);
      server.listen(at, "127.0.0.1", () => {
        server.off("error", failed);
        done(server.address().port);
      });
    });
  let bound;
  try {
    bound = await listen(port);
  } catch {
    bound = await listen(0);
  }
  return {
    origin: `http://127.0.0.1:${bound}`,
    close: () =>
      new Promise((done) => {
        // A service that read the keys may keep its connection open.
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
