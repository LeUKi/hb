import { env } from "cloudflare:test";
import {
  type ActivityInput,
  type ClaimResult,
  type CreatedPersonalToken,
  emptyActivityInput,
  type LdcActivityInput,
  type PersonalToken,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { sha256Hex } from "../src/security/crypto";
import {
  type Actor,
  actor,
  bindings,
  give,
  origin,
  plus,
  settings,
} from "./code-fixtures";

// 个人令牌 (docs/personal-token-design.md): one account's token, good for its
// own records, 领取, 口令兑换 and 附带网页认人, and for nothing else.

let owner: Actor;
let alice: Actor;
let merchantId: string;

type Answer = {
  status: number;
  body: Record<string, unknown> & { error?: { code: string } };
};

async function call(
  method: string,
  path: string,
  options: {
    user?: Actor;
    token?: string;
    authorization?: string;
    body?: unknown;
    withOrigin?: boolean;
    env?: ApiBindings;
  } = {},
): Promise<Answer & { headers: Headers }> {
  const headers: Record<string, string> = {};
  if (options.user) {
    headers.Cookie = options.user.cookie;
    headers["X-CSRF-Token"] = options.user.csrf;
  }
  if (options.withOrigin ?? options.user !== undefined) headers.Origin = origin;
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.authorization) headers.Authorization = options.authorization;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await app.request(
    `${origin}${path}`,
    {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    },
    options.env ?? bindings,
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Answer["body"]) : {},
  };
}

async function newToken(user: Actor, name = "脚本", lifetimeDays = 30) {
  const made = await call("POST", "/api/me/personal-tokens", {
    user,
    body: { name, lifetimeDays },
  });
  expect(made.status).toBe(200);
  return made.body as unknown as CreatedPersonalToken;
}

function ldc(extra: Partial<LdcActivityInput> = {}): LdcActivityInput {
  return {
    ...emptyActivityInput(),
    title: "令牌能领的红包",
    participationMode: "direct",
    passwords: [],
    merchantId,
    money: { mode: "fixed", totalAmount: "2.00", count: 2 },
    ...extra,
  };
}

async function opened(activity: ActivityInput) {
  const draft = await createActivity(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    activity,
  });
  return openActivity(bindings, draft.id, owner.id, draft.version);
}

beforeEach(async () => {
  [owner, alice] = await Promise.all([actor(), actor()]);
  const merchant = await createMerchant(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    clientId: `token_${owner.id.replaceAll("-", "")}`,
    label: "本地模拟商户",
    secret: "LOCAL-ONLY",
  });
  merchantId = merchant.id;
  await env.DB.prepare(`UPDATE attempt_rate_limits SET home_interval_seconds=5,
    activity_interval_seconds=2 WHERE id='global'`).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("个人令牌的管理", () => {
  it("is made by anyone signed in, shown once, and only its digest is kept", async () => {
    const { token, personalToken } = await newToken(alice);
    expect(token).toMatch(/^hbp_[A-Za-z0-9_-]{32}$/);
    expect(personalToken).toMatchObject({
      name: "脚本",
      lastFour: token.slice(-4),
      status: "active",
      useCount: 0,
      lastUsedAt: null,
    });
    expect(personalToken.expiresAt - personalToken.createdAt).toBe(
      30 * 86_400_000,
    );
    const row = await env.DB.prepare(
      "SELECT token_hash FROM personal_tokens WHERE id=?",
    )
      .bind(personalToken.id)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await sha256Hex(`personal-token:${token}`));
    const listed = await call("GET", "/api/me/personal-tokens", {
      user: alice,
    });
    expect(JSON.stringify(listed.body)).not.toContain(token);
    expect(listed.body).toMatchObject({
      items: [{ id: personalToken.id }],
      max: 10,
    });
  });

  it("takes only the lifetimes on offer and a short name", async () => {
    for (const body of [
      { name: "x", lifetimeDays: 7 },
      { name: "x", lifetimeDays: 366 },
      { name: "", lifetimeDays: 30 },
      { name: "一".repeat(21), lifetimeDays: 30 },
    ]) {
      const refused = await call("POST", "/api/me/personal-tokens", {
        user: alice,
        body,
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error?.code).toBe("INVALID_PERSONAL_TOKEN_INPUT");
    }
  });

  it("keeps ten in use at most, and a stop is final", async () => {
    const made: CreatedPersonalToken[] = [];
    for (let i = 0; i < 10; i++) made.push(await newToken(alice, `t${i}`));
    const eleventh = await call("POST", "/api/me/personal-tokens", {
      user: alice,
      body: { name: "多一个", lifetimeDays: 30 },
    });
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.error?.code).toBe("PERSONAL_TOKEN_LIMIT");

    const first = made[0] as CreatedPersonalToken;
    const stopped = await call(
      "POST",
      `/api/me/personal-tokens/${first.personalToken.id}/revoke`,
      { user: alice },
    );
    expect((stopped.body.personalToken as PersonalToken).status).toBe(
      "revoked",
    );
    expect(
      (await call("GET", "/api/session", { token: first.token })).status,
    ).toBe(401);
    // A stop is final, in the database too.
    await expect(
      env.DB.prepare("UPDATE personal_tokens SET revoked_at=NULL WHERE id=?")
        .bind(first.personalToken.id)
        .run(),
    ).rejects.toThrow(/winds down/);
    await expect(
      env.DB.prepare("DELETE FROM personal_tokens WHERE id=?")
        .bind(first.personalToken.id)
        .run(),
    ).rejects.toThrow(/permanent/);
    // Stopping one makes room for another.
    expect((await newToken(alice, "补上")).token).toMatch(/^hbp_/);
  });

  it("is someone else's to stop only by an admin, with the reason they will read", async () => {
    const { token, personalToken } = await newToken(alice);
    const notMine = await call(
      "POST",
      `/api/me/personal-tokens/${personalToken.id}/revoke`,
      { user: owner },
    );
    expect(notMine.status).toBe(404);
    const notAdmin = await call(
      "POST",
      `/api/admin/personal-tokens/${personalToken.id}/revoke`,
      { user: owner, body: { reason: "滥用" } },
    );
    expect(notAdmin.status).toBe(403);
    const asAdmin = { ...bindings, ADMIN_LINUX_DO_IDS: owner.externalId };
    const stopped = await call(
      "POST",
      `/api/admin/personal-tokens/${personalToken.id}/revoke`,
      { user: owner, body: { reason: "滥用" }, env: asAdmin },
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.personalToken).toMatchObject({
      status: "admin_revoked",
      revokeReason: "滥用",
    });
    expect((await call("GET", "/api/session", { token })).status).toBe(401);
  });

  it("can never manage tokens itself", async () => {
    const { token, personalToken } = await newToken(alice);
    for (const [method, path, body] of [
      ["GET", "/api/me/personal-tokens", undefined],
      ["POST", "/api/me/personal-tokens", { name: "再来", lifetimeDays: 365 }],
      ["POST", `/api/me/personal-tokens/${personalToken.id}/revoke`, undefined],
    ] as const) {
      const refused = await call(method, path, { token, body });
      expect(refused.status).toBe(403);
      expect(refused.body.error?.code).toBe("PERSONAL_TOKEN_NOT_ALLOWED");
    }
  });
});

describe("个人令牌能做的事", () => {
  it("reads who it stands for, with no CSRF token and no cookie set", async () => {
    const { token } = await newToken(alice);
    const session = await call("GET", "/api/session", { token });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({
      user: { id: alice.id },
      csrfToken: null,
    });
    expect(session.headers.get("Set-Cookie")).toBeNull();
    const claims = await call("GET", "/api/me/claims", { token });
    expect(claims.status).toBe(200);
    // Its last use, at most once a minute.
    await call("GET", "/api/me/claims", { token });
    const row = await env.DB.prepare(
      "SELECT use_count,last_used_at FROM personal_tokens WHERE user_id=?",
    )
      .bind(alice.id)
      .first<{ use_count: number; last_used_at: number | null }>();
    expect(row?.use_count).toBe(1);
    expect(row?.last_used_at).toEqual(expect.any(Number));
  });

  it("is a 401 when wrong, run out, or its account is stopped, and never falls back to the cookie", async () => {
    for (const authorization of [
      "Bearer hbp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "Bearer hbk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "Bearer nonsense",
    ]) {
      // alice's cookie rides along: still refused.
      const refused = await call("GET", "/api/me/claims", {
        user: alice,
        authorization,
      });
      expect(refused.status).toBe(401);
      expect(refused.body.error?.code).toBe("INVALID_PERSONAL_TOKEN");
    }
    // Run out: made long ago, its time past.
    const old = `hbp_${"b".repeat(32)}`;
    await env.DB.prepare(
      `INSERT INTO personal_tokens (id,user_id,name,token_hash,last_four,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?)`,
    )
      .bind(
        crypto.randomUUID(),
        alice.id,
        "旧的",
        await sha256Hex(`personal-token:${old}`),
        old.slice(-4),
        Date.now() - 40 * 86_400_000,
        Date.now() - 10 * 86_400_000,
      )
      .run();
    expect((await call("GET", "/api/session", { token: old })).status).toBe(
      401,
    );
    const listed = await call("GET", "/api/me/personal-tokens", {
      user: alice,
    });
    expect(listed.body.items).toEqual([
      expect.objectContaining({ status: "expired" }),
    ]);
    // A stopped account's tokens stop with it.
    const { token } = await newToken(alice);
    await env.DB.prepare("UPDATE users SET active=0 WHERE id=?")
      .bind(alice.id)
      .run();
    expect((await call("GET", "/api/session", { token })).status).toBe(401);
  });

  it("领取 without Origin or CSRF, while the cookie still needs both", async () => {
    const activity = await opened(ldc());
    const { token } = await newToken(alice);
    // The cookie without its Origin: refused as before.
    const cookieOnly = await call(
      "POST",
      `/api/activities/${activity.id}/claim`,
      {
        user: alice,
        withOrigin: false,
        body: {
          submissionId: crypto.randomUUID(),
          participationMode: "direct",
        },
      },
    );
    expect(cookieOnly.status).toBe(403);
    const claimed = await call("POST", `/api/activities/${activity.id}/claim`, {
      token,
      body: { submissionId: crypto.randomUUID(), participationMode: "direct" },
    });
    expect(claimed.status).toBe(200);
    expect((claimed.body as unknown as ClaimResult).result).toBe("claimed");
    // Its claim is the account's own, seen with the cookie too.
    const mine = await call("GET", `/api/activities/${activity.id}/claim`, {
      user: alice,
    });
    expect(mine.body.claim).not.toBeNull();
    // The same account's cooldown: another claim at once waits.
    const other = await opened(ldc({ title: "第二个" }));
    const tooSoon = await call("POST", `/api/activities/${other.id}/claim`, {
      token,
      body: { submissionId: crypto.randomUUID(), participationMode: "direct" },
    });
    expect(tooSoon.status).toBe(429);
  });

  it("does not skip a human check", async () => {
    const activity = await opened(ldc({ humanCheck: true }));
    const { token } = await newToken(alice);
    const asked = await call("POST", `/api/activities/${activity.id}/claim`, {
      token,
      body: { submissionId: crypto.randomUUID(), participationMode: "direct" },
    });
    expect(asked.status).toBe(403);
    expect(asked.body.error?.code).toBe("HUMAN_CHECK_REQUIRED");
  });

  it("reaches 口令兑换, and no write that is the page's alone", async () => {
    const { token } = await newToken(alice);
    const discover = await call("POST", "/api/redemptions/discover", {
      token,
      body: { submissionId: crypto.randomUUID(), password: "没有这个口令123" },
    });
    // Past the door: what it finds is the service's answer, not a refusal of the token.
    expect([401, 403]).not.toContain(discover.status);
    // Making a 红包 is the page's: a token alone is refused.
    const create = await call("POST", "/api/activities", {
      token,
      body: { requestId: crypto.randomUUID(), activity: ldc() },
    });
    expect([401, 403]).toContain(create.status);
    // So is 🐟额's own list of transfers, which tokens do not read.
    const transfers = await call("GET", "/api/me/balance/api-keys", { token });
    expect(transfers.status).toBe(401);
  });
});

describe("个人令牌与附带网页", () => {
  it("asks for the page's signed identity, as the account", async () => {
    const admin = await actor();
    await settings({ hongbao_enabled: 1, page_enabled: 1 });
    await plus(owner);
    await give(admin, owner, "5.00");
    const { rewardType: _type, ...base } = emptyActivityInput();
    const activity = await opened({
      ...base,
      title: "带网页的红包",
      rewardType: "ldc",
      funding: "balance",
      merchantId: "",
      participationMode: "direct",
      passwords: [],
      money: { mode: "fixed", totalAmount: "1.00", count: 2 },
      pageUrl: "https://game.example.com/play",
    } as ActivityInput);
    const { token } = await newToken(alice);
    const signed = await call(
      "POST",
      `/api/activities/${activity.id}/page-identity`,
      {
        token,
        body: { nonce: "abc12345-xyz" },
      },
    );
    expect(signed.status).toBe(200);
    expect(signed.body.user).toMatchObject({ id: alice.externalId });
    expect(signed.body.token).toEqual(expect.any(String));
  });
});
