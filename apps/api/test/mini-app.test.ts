import { env } from "cloudflare:test";
import {
  emptyActivityInput,
  type LdcActivityInput,
  type MiniHongbaoResponse,
  type MiniLiveMessage,
  type PublicRecipientList,
} from "@hb/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import {
  miniAppTrust,
  verifyPlatformRequest,
} from "../src/mini/platform-token";
import { createMerchant } from "../src/payments/merchants";
import { base64UrlEncode } from "../src/security/crypto";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import { resetMerchantHistory } from "./reset-merchant-history";

// 社区小程序 (docs/mini-app-design.md §7): the forum signs each request its
// mini app makes; 红包站 checks it as the forum's server SDK does, then
// reads, claims and keeps the live channel for whoever it names.

const origin = "https://hb.example.com";
const forum = "https://linux.do";
const appId = "01a19ba5-b9d2-766f-9fb9-b7eddc10e0c7";
let keys: CryptoKeyPair;
let kid: string;
let bindings: ApiBindings;
let ownerId: string;
let merchantId: string;

const encoder = new TextEncoder();
const part = (value: unknown) =>
  base64UrlEncode(encoder.encode(JSON.stringify(value)));

type Claims = Record<string, unknown>;

/** A token as the forum signs one for this endpoint, with any change. */
async function token(
  path: string,
  change: { claims?: Claims; header?: Claims; key?: CryptoKey } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const head = part({
    alg: "ES256",
    typ: "mini-app-access+jwt",
    kid,
    ...change.header,
  });
  const body = part({
    iss: forum,
    aud: origin,
    sub: "332940",
    app_id: appId,
    version: "0.1.0",
    channel: "sandbox",
    scopes: ["network.request"],
    // As the forum signs them (seen 2026-11-02): 5 s before, 900 s after.
    iat: now,
    nbf: now - 5,
    exp: now + 900,
    jti: crypto.randomUUID().replaceAll("-", ""),
    htm: "GET",
    htu: `${origin}${path}`,
    query_keys: ["id"],
    ...change.claims,
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    change.key ?? keys.privateKey,
    encoder.encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function person(externalId: string) {
  const id = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id,
      externalId,
      username: `mini_${externalId}`,
      displayName: `Mini ${externalId}`,
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

async function running(extra: Partial<LdcActivityInput> = {}) {
  const saved = await createActivity(bindings, ownerId, {
    requestId: crypto.randomUUID(),
    activity: {
      ...emptyActivityInput(),
      title: "社区里领的红包",
      beforeInfo: "说明写在这里",
      merchantId,
      passwords: ["社区里的口令"],
      allocation: "sequential",
      money: { mode: "fixed", totalAmount: "3.00", count: 3 },
      ...extra,
    },
  });
  return openActivity(bindings, saved.id, ownerId, saved.version);
}

function read(
  id: string,
  sub = "332940",
  headers: Record<string, string> = {},
) {
  const path = `/api/mini/hongbao?id=${id}`;
  return token("/api/mini/hongbao", { claims: { sub } }).then((jwt) =>
    app.request(
      `${origin}${path}`,
      {
        headers: { Origin: forum, Authorization: `Bearer ${jwt}`, ...headers },
      },
      bindings,
    ),
  );
}

async function claim(id: string, body: unknown, sub = "332940") {
  const jwt = await token("/api/mini/claim", {
    claims: { sub, htm: "POST" },
  });
  return app.request(
    `${origin}/api/mini/claim?id=${id}`,
    {
      method: "POST",
      headers: {
        Origin: forum,
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

function roster(id: string, kind: string) {
  return token("/api/mini/roster", {
    claims: { query_keys: ["id", "kind", "cursor"] },
  }).then((jwt) =>
    app.request(
      `${origin}/api/mini/roster?id=${id}&kind=${kind}`,
      { headers: { Origin: forum, Authorization: `Bearer ${jwt}` } },
      bindings,
    ),
  );
}

async function upgrade(
  id: string,
  change: { claims?: Claims; origin?: string } = {},
) {
  const jwt = await token("/api/mini/live", {
    claims: { scopes: ["network.websocket"], ...change.claims },
  });
  return app.request(
    `${origin}/api/mini/live?id=${id}&mini_app_token=${jwt}`,
    { headers: { Upgrade: "websocket", Origin: change.origin ?? forum } },
    bindings,
  );
}

async function connect(id: string, claims: Claims = {}) {
  const response = await upgrade(id, { claims });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("no WebSocket");
  const heard: MiniLiveMessage[] = [];
  const closed: number[] = [];
  socket.addEventListener("message", (event) =>
    heard.push(JSON.parse(String(event.data))),
  );
  socket.addEventListener("close", (event) => closed.push(event.code));
  socket.accept();
  return { heard, closed };
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = (await crypto.subtle.exportKey(
    "spki",
    keys.publicKey,
  )) as ArrayBuffer;
  kid = [...new Uint8Array(await crypto.subtle.digest("SHA-256", spki))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  bindings = {
    ...env,
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
});

beforeEach(async () => {
  await resetMerchantHistory(env.DB);
  await env.DB.batch(
    [
      "payment_outbox",
      "payment_attempts",
      "payment_tasks",
      "simulation_orders",
      "simulation_controls",
      "merchant_credentials",
      "attempt_events",
      "redemption_submissions",
      "claims",
      "reward_inventory",
      "activity_passwords",
      "activities",
      "merchants",
      "sessions",
      "users",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  ownerId = await person("1");
  merchantId = (
    await createMerchant(bindings, ownerId, {
      requestId: crypto.randomUUID(),
      clientId: `mini_${crypto.randomUUID()}`,
      label: "Local fixture",
      secret: "fake-only",
    })
  ).id;
});

describe("the forum's token", () => {
  const url = `${origin}/api/mini/hongbao?id=abc`;
  async function check(jwt: string, at = url, method = "GET") {
    const trust = await miniAppTrust(bindings);
    if (!trust) throw new Error("not set up");
    return verifyPlatformRequest(trust, {
      authorization: `Bearer ${jwt}`,
      scope: "network.request",
      method,
      url: at,
    });
  }

  it("takes the forum's JWKS as it serves it, each key by its kid", async () => {
    const forumKeys = JSON.stringify({
      keys: [
        {
          kty: "EC",
          crv: "P-256",
          use: "sig",
          alg: "ES256",
          kid: "217dfe8a1dd6eaa1047673483e345d6808c171af4f66a6da98c580f36c003a88",
          x: "pbVvvJPTHPqaWFO_BfVQU9ZsJ1cR-MNQfVQyGFgwyOI",
          y: "T2EVZVbVR4xjnxZUxCFAYkj1yTQI5LruEs8umXxrwf4",
        },
      ],
    });
    const trust = await miniAppTrust({
      ...bindings,
      MINI_APP_PUBLIC_KEY: forumKeys,
    });
    expect([...(trust?.keys.keys() ?? [])]).toEqual([
      "217dfe8a1dd6eaa1047673483e345d6808c171af4f66a6da98c580f36c003a88",
    ]);
  });

  it("names the LINUX DO id when everything matches", async () => {
    const identity = await check(await token("/api/mini/hongbao"));
    expect(identity.sub).toBe("332940");
    expect(identity.query_keys).toEqual(["id"]);
  });

  it("is refused for anything off: key, site, app, channel, time, method, address", async () => {
    const other = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const now = Math.floor(Date.now() / 1000);
    const offs = [
      await token("/api/mini/hongbao", { key: other.privateKey }),
      await token("/api/mini/hongbao", { header: { kid: "0".repeat(64) } }),
      await token("/api/mini/hongbao", { header: { alg: "HS256" } }),
      await token("/api/mini/hongbao", {
        claims: { aud: "https://evil.example" },
      }),
      await token("/api/mini/hongbao", {
        claims: { iss: "https://evil.example" },
      }),
      await token("/api/mini/hongbao", { claims: { app_id: "other" } }),
      await token("/api/mini/hongbao", { claims: { channel: "production" } }),
      await token("/api/mini/hongbao", { claims: { exp: now - 1 } }),
      await token("/api/mini/hongbao", { claims: { exp: now + 901 } }),
      await token("/api/mini/hongbao", { claims: { sub: "lafish" } }),
      await token("/api/mini/hongbao", {
        claims: { scopes: ["network.websocket"] },
      }),
      await token("/api/mini/hongbao", { claims: { htm: "POST" } }),
      await token("/api/mini/claim"),
      await token("/api/mini/hongbao", { claims: { query_keys: [] } }),
    ];
    for (const jwt of offs) await expect(check(jwt)).rejects.toThrow();
    const good = await token("/api/mini/hongbao");
    // A key it was not signed for, a repeated one, and a long value.
    for (const at of [
      `${url}&x=1`,
      `${url}&id=2`,
      `${origin}/api/mini/hongbao?id=${"a".repeat(201)}`,
    ])
      await expect(check(good, at)).rejects.toThrow();
  });
});

describe("社区小程序's routes", () => {
  it("are off until the forum's key is set, and answer the forum's CORS", async () => {
    const off = await app.request(
      `${origin}/api/mini/hongbao?id=${crypto.randomUUID()}`,
      { headers: { Origin: forum } },
      { ...bindings, MINI_APP_PUBLIC_KEY: undefined },
    );
    expect(off.status).toBe(503);
    expect(off.headers.get("Access-Control-Allow-Origin")).toBe(forum);
    const preflight = await app.request(
      `${origin}/api/mini/claim?id=x`,
      {
        method: "OPTIONS",
        headers: {
          Origin: forum,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      },
      bindings,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toMatch(
      /Authorization/i,
    );
    const elsewhere = await app.request(
      `${origin}/api/mini/hongbao?id=x`,
      { headers: { Origin: "https://evil.example" } },
      bindings,
    );
    expect(elsewhere.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const unsigned = await app.request(
      `${origin}/api/mini/hongbao?id=${crypto.randomUUID()}`,
      { headers: { Origin: forum } },
      bindings,
    );
    expect(unsigned.status).toBe(401);
  });

  it("reads a 红包 for anyone the forum names, without its code or page", async () => {
    const activity = await running();
    const response = await read(activity.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as MiniHongbaoResponse;
    expect(body.activity.title).toBe("社区里领的红包");
    expect(body.activity.beforeInfo).toBe("说明写在这里");
    expect(body.known).toBe(false);
    expect(body.participation).toEqual({ claim: null, registration: null });
  });

  it("makes an account for a first-timer from the forum's name, and records the claim as the mini app's", async () => {
    const activity = await running();
    const nameless = await claim(activity.id, {
      submissionId: crypto.randomUUID(),
      password: "社区里的口令",
    });
    expect(nameless.status).toBe(403);
    expect(
      ((await nameless.json()) as { error: { code: string } }).error.code,
    ).toBe("SIGN_IN_FIRST");

    const wrong = await claim(activity.id, {
      submissionId: crypto.randomUUID(),
      password: "这个口令不对",
      forumUser: { username: "forum_first", name: "社区新人" },
    });
    expect(((await wrong.json()) as { result: string }).result).toBe(
      "incorrect",
    );
    const account = await env.DB.prepare(
      "SELECT id, username, display_name, trust_level, profile_seen_at FROM users WHERE external_id='332940'",
    ).first<{
      id: string;
      username: string;
      display_name: string;
      trust_level: number | null;
      profile_seen_at: number | null;
    }>();
    expect(account).toMatchObject({
      username: "forum_first",
      display_name: "社区新人",
      trust_level: null,
      profile_seen_at: null,
    });
    await advanceAttemptCooldown(env.DB, account?.id ?? "");

    const right = await claim(activity.id, {
      submissionId: crypto.randomUUID(),
      password: "社区里的口令",
      forumUser: { username: "forum_first", name: "社区新人" },
    });
    const result = (await right.json()) as {
      result: string;
      claim: { id: string };
    };
    expect(result.result).toBe("claimed");
    expect(
      await env.DB.prepare("SELECT via FROM claims WHERE id=?")
        .bind(result.claim.id)
        .first("via"),
    ).toBe("mini");
  });

  it("does not make an account under a name another account here has", async () => {
    const activity = await running();
    await person("77");
    const taken = await claim(activity.id, {
      submissionId: crypto.randomUUID(),
      password: "社区里的口令",
      forumUser: { username: "MINI_77", name: "冒名" },
    });
    expect(taken.status).toBe(403);
    expect(
      ((await taken.json()) as { error: { code: string } }).error.code,
    ).toBe("SIGN_IN_FIRST");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE external_id='332940'",
      ).first("n"),
    ).toBe(0);
  });

  it("knows a first-timer by id alone in a 领取范围 until LINUX DO vouches for the name", async () => {
    const activity = await running({
      scope: { users: [{ username: "named_one", linuxDoId: null }] },
    });
    const body = () => ({
      submissionId: crypto.randomUUID(),
      password: "社区里的口令",
      forumUser: { username: "named_one", name: "被指定的人" },
    });
    const refused = await claim(activity.id, body());
    expect(refused.status).toBe(403);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("SIGN_IN_FIRST");
    // Signed in with LINUX DO since: the name is theirs.
    await env.DB.prepare(
      "UPDATE users SET profile_seen_at=?, trust_level=1 WHERE external_id='332940'",
    )
      .bind(Date.now())
      .run();
    const allowed = await claim(activity.id, body());
    expect(((await allowed.json()) as { result: string }).result).toBe(
      "claimed",
    );
  });

  it("claims, and the read has their claim after", async () => {
    const activity = await running();
    await person("332940");
    const response = await claim(activity.id, {
      submissionId: crypto.randomUUID(),
      password: "社区里的口令",
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      result: string;
      claim: { amount: string };
    };
    expect(result.result).toBe("claimed");
    expect(result.claim.amount).toBe("1.00");
    const body = (await (
      await read(activity.id)
    ).json()) as MiniHongbaoResponse;
    expect(body.known).toBe(true);
    expect(body.author).toBe(false);
    expect(body.participation.claim?.amount).toBe("1.00");
  });

  it("says when the 红包 is the reader's own, and reads its 名单 as 红包站 shows everyone", async () => {
    const activity = await running();
    const own = (await (
      await read(activity.id, "1")
    ).json()) as MiniHongbaoResponse;
    expect(own.author).toBe(true);
    await person("332940");
    await claim(activity.id, {
      submissionId: crypto.randomUUID(),
      password: "社区里的口令",
    });
    const response = await roster(activity.id, "claims");
    expect(response.status).toBe(200);
    const page = (await response.json()) as PublicRecipientList;
    expect(page.items.map((item) => item.username)).toEqual(["mini_332940"]);
    // Not the sender's view: no 口令, no payment.
    expect(page.items[0]).not.toHaveProperty("password");
    expect(page.items[0]).not.toHaveProperty("payment");
    expect(page.nextCursor).toBeNull();
    const signups = await roster(activity.id, "registrations");
    expect(((await signups.json()) as { items: unknown[] }).items).toEqual([]);
    expect((await roster(activity.id, "everyone")).status).toBe(400);
  });

  it("claims a 红包 without a 口令, and sends a human check's to 红包站", async () => {
    await person("332940");
    const direct = await running({
      participationMode: "direct",
      passwords: [],
    });
    const response = await claim(direct.id, {
      submissionId: crypto.randomUUID(),
    });
    expect(((await response.json()) as { result: string }).result).toBe(
      "claimed",
    );
    const checked = await running({
      participationMode: "direct",
      passwords: [],
      humanCheck: true,
    });
    const elsewhere = await claim(checked.id, {
      submissionId: crypto.randomUUID(),
    });
    expect(elsewhere.status).toBe(409);
  });
});

describe("社区小程序's live channel", () => {
  it("needs the forum's own handshake", async () => {
    const activity = await running();
    expect(
      (await upgrade(activity.id, { origin: "https://evil.example" })).status,
    ).toBe(401);
    expect(
      (await upgrade(activity.id, { claims: { scopes: ["network.request"] } }))
        .status,
    ).toBe(401);
  });

  it("pushes the lighter read and who is watching, and counts the forum's viewers", async () => {
    const activity = await running();
    const { heard } = await connect(activity.id);
    await vi.waitFor(() =>
      expect(heard.some((message) => message.type === "viewers")).toBe(true),
    );
    const first = heard.find((message) => message.type === "activity");
    if (first?.type !== "activity") throw new Error("no read");
    expect(first.activity.title).toBe("社区里领的红包");
    expect(first.activity).not.toHaveProperty("beforeInfo");
    expect(first.activity).not.toHaveProperty("rosterPreview");
    await person("40");
    await claim(
      activity.id,
      { submissionId: crypto.randomUUID(), password: "社区里的口令" },
      "40",
    );
    await vi.waitFor(
      () => {
        const last = heard
          .filter((message) => message.type === "activity")
          .at(-1);
        expect(
          last?.type === "activity" && last.activity.quantity.mode === "exact"
            ? last.activity.quantity.claimed
            : null,
        ).toBe(1);
      },
      { timeout: 3000 },
    );
  });

  it("closes a socket when its token ends", async () => {
    const activity = await running();
    const now = Math.floor(Date.now() / 1000);
    const { closed } = await connect(activity.id, {
      iat: now - 1,
      nbf: now - 1,
      exp: now + 2,
    });
    await vi.waitFor(() => expect(closed).toEqual([4000]), { timeout: 5000 });
  });
});
