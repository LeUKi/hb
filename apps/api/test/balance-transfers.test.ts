// 🐟额 转账 and the open API (docs/balance-design.md §16): to someone's
// 🐟额 at once, or to their Credit account as a 转出 to them; from the page
// or an 开放接口密钥; and what the database refuses about either.
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { type ActivityInput, emptyActivityInput } from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { runMerchantCycle } from "../src/payments/scheduler";
import { sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
let CLIENT_ID = "hb_transfer_platform_0";
const SECRET = "platform-secret-key";

type Actor = {
  id: string;
  externalId: string;
  username: string;
  cookie: string;
  csrf: string;
};

let counter = 0;
async function actor(name = "fish"): Promise<Actor> {
  const id = crypto.randomUUID();
  counter += 1;
  const externalId = String(
    880_000 + counter * 11 + Math.floor(Math.random() * 11),
  );
  const username = `${name}${counter}`;
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id,
      externalId,
      username,
      displayName: `${name}昵称`,
      createdAt: now,
      updatedAt: now,
    });
  await createDb(env.DB)
    .insert(sessions)
    .values({
      tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
      userId: id,
      csrfToken: csrf,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 600_000),
    });
  return { id, externalId, username, cookie: `hb_session=${token}`, csrf };
}

let admins: string[] = [];
const bindings = () =>
  ({
    ...env,
    APP_ORIGIN: origin,
    APP_ENV: "production",
    LDC_NETWORK_MODE: "live",
    LDC_STOP_SENDS: "false",
    ADMIN_LINUX_DO_IDS: admins.join(","),
  }) satisfies ApiBindings;

type Called = {
  status: number;
  json: never;
  headers: Headers;
};

async function call(
  method: string,
  path: string,
  who?: Actor,
  body?: unknown,
): Promise<Called> {
  const ctx = createExecutionContext();
  const response = await app.request(
    `${origin}/api${path}`,
    {
      method,
      headers: {
        ...(who ? { Cookie: who.cookie, "X-CSRF-Token": who.csrf } : {}),
        ...(method === "GET" ? {} : { Origin: origin }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    bindings(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return {
    status: response.status,
    json: (await response.json()) as never,
    headers: response.headers,
  };
}

/** The open API, as a site's server calls it: a key, no cookie, no Origin. */
async function open(
  method: string,
  path: string,
  key?: string,
  body?: unknown,
) {
  const ctx = createExecutionContext();
  const response = await app.request(
    `${origin}/api/open${path}`,
    {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        "CF-Connecting-IP": "203.0.113.7",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    bindings(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return {
    status: response.status,
    json: (await response.json()) as never,
    headers: response.headers,
  };
}

/** Credit's distribute and order query, for 转账 to a Credit account. */
function fakeCredit() {
  type Order = { outTradeNo: string; money: string; tradeNo: string };
  const orders = new Map<string, Order>();
  const sent: Record<string, unknown>[] = [];
  let next: "ok" | "recipient" = "ok";
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.origin !== "https://credit.linux.do")
      throw new Error(`Unexpected request ${url.origin}`);
    if (url.pathname === "/lpay/distribute") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      if (next === "recipient")
        return json({ error_msg: "收款人不存在", data: null }, 400);
      const order = {
        outTradeNo: String(body.out_trade_no),
        money: String(body.amount),
        tradeNo: `credit_${orders.size + 1}`,
      };
      orders.set(order.outTradeNo, order);
      return json({
        error_msg: "",
        data: { out_trade_no: order.outTradeNo, trade_no: order.tradeNo },
      });
    }
    if (url.pathname === "/epay/api.php") {
      const order = orders.get(url.searchParams.get("out_trade_no") ?? "");
      if (!order) return json({ code: -1, msg: "订单不存在或已完成" }, 404);
      return json({
        code: 1,
        msg: "查询订单号成功！",
        pid: CLIENT_ID,
        out_trade_no: order.outTradeNo,
        trade_no: order.tradeNo,
        money: order.money,
        status: 1,
      });
    }
    throw new Error(`Unexpected path ${url.pathname}`);
  });
  return {
    sent,
    next(kind: "ok" | "recipient") {
      next = kind;
    },
  };
}

async function member(who: Actor) {
  await env.DB.prepare(
    "INSERT INTO balance_members (user_id,created_at) VALUES (?,?)",
  )
    .bind(who.id, Date.now())
    .run();
}

async function account(userId: string) {
  return env.DB.prepare(
    "SELECT available_minor AS available,locked_minor AS locked FROM balance_accounts WHERE user_id=?",
  )
    .bind(userId)
    .first<{ available: number; locked: number }>();
}

/**
 * The 站长 (admin, with the platform app), 转账 and 转出 open, a PLUS
 * `sender` holding 50 🐟 and a `friend` who has been here.
 */
async function openTransfers(
  options: { transferEnabled?: boolean; withdrawEnabled?: boolean } = {},
) {
  const admin = await actor("admin");
  admins = [admin.externalId];
  const sender = await actor("sender");
  const friend = await actor("friend");
  const credit = fakeCredit();
  const saved = await call("PUT", "/admin/balance/platform-app", admin, {
    requestId: crypto.randomUUID(),
    label: "🐟额",
    clientId: CLIENT_ID,
    secret: SECRET,
  });
  expect(saved.status).toBe(200);
  const settings = await call("GET", "/admin/balance/settings", admin);
  const read = settings.json as {
    settings: { version: number };
    platformApp: { id: string };
  };
  const patched = await call("PATCH", "/admin/balance/settings", admin, {
    expectedVersion: read.settings.version,
    topupEnabled: false,
    withdrawEnabled: options.withdrawEnabled ?? true,
    topupFeePercent: 12,
    withdrawFeePercent: 12,
    withdrawMaxMinor: 2000,
    transferEnabled: options.transferEnabled ?? true,
  });
  expect(patched.status).toBe(200);
  await member(sender);
  const added = await call(
    "POST",
    `/admin/balance/users/${sender.id}/adjustments`,
    admin,
    {
      requestId: crypto.randomUUID(),
      direction: "add",
      amount: "50.00",
      reason: "测试用",
    },
  );
  expect(added.status).toBe(200);
  return {
    admin,
    sender,
    friend,
    credit,
    platformId: read.platformApp.id,
    settingsVersion: (patched.json as { settings: { version: number } })
      .settings.version,
  };
}

const to = (who: Actor) => ({
  toUserId: who.externalId,
  toUsername: who.username,
});

async function cycle(platformId: string) {
  await env.DB.prepare(
    `UPDATE payment_tasks SET next_run_at=0,next_query_at=CASE WHEN next_query_at IS NULL THEN NULL ELSE 0 END,
      next_send_at=CASE WHEN next_send_at IS NULL THEN NULL ELSE 0 END
    WHERE merchant_id=? AND status IN ('pending','sending','reconciling','waiting')`,
  )
    .bind(platformId)
    .run();
  return runMerchantCycle(bindings(), platformId);
}

type TransferJson = {
  transfer: {
    id: string;
    direction: string;
    destination: string;
    amountMinor: number;
    status: string;
    remark: string | null;
    counterpart: { username: string; userId: string };
    withdrawal: { id: string; status: string; failure: string | null } | null;
  };
};

async function newKey(
  who: Actor,
  name = "网站",
  dailyLimit: string | null = null,
) {
  const made = await call("POST", "/me/balance/api-keys", who, {
    name,
    dailyLimit,
  });
  expect(made.status).toBe(200);
  return made.json as { key: { id: string; lastFour: string }; token: string };
}

beforeEach(async () => {
  CLIENT_ID = `hb_transfer_platform_${crypto.randomUUID().slice(0, 8)}`;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await env.DB.prepare(
    "UPDATE platform_controls SET version=version+1,allow_real_send=1,updated_at=? WHERE id='global'",
  )
    .bind(Date.now())
    .run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  admins = [];
  await env.DB.prepare(
    "UPDATE merchants SET usage_status='legacy' WHERE kind='platform'",
  ).run();
});

describe("转账 to 🐟额", () => {
  it("moves 🐟 at once, shows on both sides, and the same request twice is one 转账", async () => {
    const { sender, friend } = await openTransfers();
    const requestId = crypto.randomUUID();
    const body = {
      requestId,
      ...to(friend),
      destination: "balance",
      amount: "12.34",
      remark: "午饭钱",
    };
    const made = await call("POST", "/me/balance/transfers", sender, body);
    expect(made.status).toBe(200);
    const { transfer } = made.json as TransferJson;
    expect(transfer).toMatchObject({
      direction: "out",
      destination: "balance",
      amountMinor: 1234,
      status: "sent",
      remark: "午饭钱",
      counterpart: { username: friend.username, userId: friend.externalId },
      withdrawal: null,
    });
    expect(await account(sender.id)).toEqual({ available: 3766, locked: 0 });
    expect(await account(friend.id)).toEqual({ available: 1234, locked: 0 });

    const again = await call("POST", "/me/balance/transfers", sender, body);
    expect((again.json as TransferJson).transfer.id).toBe(transfer.id);
    const changed = await call("POST", "/me/balance/transfers", sender, {
      ...body,
      amount: "1.00",
    });
    expect(changed.status).toBe(409);
    expect(changed.json).toMatchObject({
      error: { code: "TRANSFER_REQUEST_REUSED" },
    });
    expect(await account(sender.id)).toEqual({ available: 3766, locked: 0 });

    // 明细: “转给 @friend” and “@sender 转来”, under 转账 as well.
    const mine = await call("GET", "/me/balance?filter=transfer", sender);
    expect((mine.json as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        type: "transfer",
        transfer: expect.objectContaining({
          id: transfer.id,
          direction: "out",
        }),
      }),
    ]);
    const theirs = await call("GET", "/me/balance", friend);
    expect(theirs.status).toBe(200);
    expect((theirs.json as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        type: "transfer",
        transfer: expect.objectContaining({
          direction: "in",
          counterpart: expect.objectContaining({ username: sender.username }),
        }),
      }),
    ]);
    // Either side opens it; anyone else finds nothing.
    expect(
      (await call("GET", `/me/balance/transfers/${transfer.id}`, friend))
        .status,
    ).toBe(200);
    const stranger = await actor("stranger");
    expect(
      (await call("GET", `/me/balance/transfers/${transfer.id}`, stranger))
        .status,
    ).toBe(404);
  });

  it("is only for PLUS, while the switch is on, to someone else who has been here", async () => {
    const { admin, sender, friend, settingsVersion } = await openTransfers();
    const send = (who: Actor, extra: Record<string, unknown> = {}) =>
      call("POST", "/me/balance/transfers", who, {
        requestId: crypto.randomUUID(),
        ...to(friend),
        destination: "balance",
        amount: "1.00",
        ...extra,
      });
    expect((await send(friend, to(sender))).json).toMatchObject({
      error: { code: "TRANSFER_NOT_ALLOWED" },
    });
    expect((await send(sender, to(sender))).json).toMatchObject({
      error: { code: "SELF_TRANSFER" },
    });
    expect(
      (await send(sender, { toUsername: "someone_else" })).json,
    ).toMatchObject({ error: { code: "RECIPIENT_NOT_FOUND" } });
    expect((await send(sender, { amount: "50.01" })).json).toMatchObject({
      error: { code: "BALANCE_INSUFFICIENT" },
    });
    await call("PATCH", "/admin/balance/settings", admin, {
      expectedVersion: settingsVersion,
      topupEnabled: false,
      withdrawEnabled: true,
      topupFeePercent: 12,
      withdrawFeePercent: 12,
      withdrawMaxMinor: 2000,
      transferEnabled: false,
    });
    expect((await send(sender)).json).toMatchObject({
      error: { code: "TRANSFER_DISABLED" },
    });
    expect(await account(sender.id)).toEqual({ available: 5000, locked: 0 });
    expect(await account(friend.id)).toBeNull();
  });

  it("finds who to send to by username, and says who cannot take a Credit one", async () => {
    const { admin, sender, friend } = await openTransfers();
    const found = await call(
      "GET",
      `/me/balance/recipients?username=@${friend.username.toUpperCase()}`,
      sender,
    );
    expect(found.json).toEqual({
      user: {
        userId: friend.externalId,
        username: friend.username,
        displayName: "friend昵称",
        avatarUrl: null,
      },
      self: false,
      owner: false,
      /** No LDC 商户: 对方的收银台 cannot be chosen. */
      checkoutBlock: "no_merchant",
    });
    const owner = await call(
      "GET",
      `/me/balance/recipients?username=${admin.username}`,
      sender,
    );
    expect(owner.json).toMatchObject({ owner: true });
    expect(
      (await call("GET", `/me/balance/recipients?username=nobody_here`, sender))
        .json,
    ).toMatchObject({ user: null });
    expect(
      (
        await call(
          "GET",
          `/me/balance/recipients?username=${sender.username}`,
          friend,
        )
      ).status,
    ).toBe(403);
  });

  it("refuses entries that do not match their 转账, and keeps 转账 as they are", async () => {
    const { admin, sender, friend } = await openTransfers();
    const before = (
      (await call("GET", "/admin/balance/overview", admin)).json as {
        today: { transfers: number; transferredMinor: number };
      }
    ).today;
    const made = await call("POST", "/me/balance/transfers", sender, {
      requestId: crypto.randomUUID(),
      ...to(friend),
      destination: "balance",
      amount: "2.00",
    });
    const { transfer } = made.json as TransferJson;
    await expect(
      env.DB.prepare(
        `INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,transfer_id,created_at)
        VALUES (?,?,'transfer_in',200,0,?,?)`,
      )
        .bind(crypto.randomUUID(), friend.id, transfer.id, Date.now())
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE balance_transfers SET amount_minor=1 WHERE id=?")
        .bind(transfer.id)
        .run(),
    ).rejects.toThrow(/fixed/);
    await expect(
      env.DB.prepare("DELETE FROM balance_transfers WHERE id=?")
        .bind(transfer.id)
        .run(),
    ).rejects.toThrow(/permanent/);
    const overview = await call("GET", "/admin/balance/overview", admin);
    expect(overview.json).toMatchObject({
      mismatches: 0,
      today: {
        transfers: before.transfers + 1,
        transferredMinor: before.transferredMinor + 200,
      },
    });
  });
});

describe("转账 to a Credit account", () => {
  it("is a 转出 to them: locked, sent with its own remark, then taken", async () => {
    const { sender, friend, credit, platformId } = await openTransfers();
    const made = await call("POST", "/me/balance/transfers", sender, {
      requestId: crypto.randomUUID(),
      ...to(friend),
      destination: "credit",
      amount: "10.00",
      remark: "只在本站显示",
    });
    expect(made.status).toBe(200);
    const { transfer } = made.json as TransferJson;
    expect(transfer).toMatchObject({
      destination: "credit",
      status: "sending",
      withdrawal: { status: "sending" },
    });
    expect(await account(sender.id)).toEqual({ available: 4000, locked: 1000 });
    await cycle(platformId);
    expect(credit.sent).toEqual([
      expect.objectContaining({
        amount: "10.00",
        user_id: Number(friend.externalId),
        username: friend.username,
        remark: `hb.lafi.sh 🐟额转账 @${sender.username}`,
      }),
    ]);
    await cycle(platformId);
    const read = await call(
      "GET",
      `/me/balance/transfers/${transfer.id}`,
      sender,
    );
    expect((read.json as TransferJson).transfer).toMatchObject({
      status: "sent",
    });
    expect(await account(sender.id)).toEqual({ available: 4000, locked: 0 });
    // Not a 转出 in 明细, and nothing in the recipient's 🐟额.
    const records = await call("GET", "/me/balance?filter=withdrawal", sender);
    expect((records.json as { items: unknown[] }).items).toEqual([]);
    expect(await account(friend.id)).toBeNull();
  });

  it("leaves a 🐟额红包's lock check alone once a 转出 has been taken", async () => {
    const { admin, sender, friend, platformId } = await openTransfers();
    await env.DB.prepare(
      "UPDATE balance_settings SET hongbao_enabled=1,version=version+1 WHERE id='global'",
    ).run();
    await env.DB.prepare(
      "UPDATE platform_controls SET version=version+1,allow_real_open=1,updated_at=? WHERE id='global'",
    )
      .bind(Date.now())
      .run();
    const { rewardType: _type, ...base } = emptyActivityInput();
    const saved = await createActivity(bindings(), sender.id, {
      requestId: crypto.randomUUID(),
      activity: {
        ...base,
        title: "🐟额红包",
        rewardType: "ldc",
        funding: "balance",
        merchantId: "",
        passwords: ["FishPassword"],
        allocation: "sequential",
        money: { mode: "fixed", totalAmount: "3.00", count: 3 },
      } satisfies ActivityInput,
    });
    await openActivity(bindings(), saved.id, sender.id, saved.version);
    const made = await call("POST", "/me/balance/transfers", sender, {
      requestId: crypto.randomUUID(),
      ...to(friend),
      destination: "credit",
      amount: "2.00",
    });
    expect(made.status).toBe(200);
    await cycle(platformId);
    await cycle(platformId);
    expect(
      (made.json as TransferJson).transfer.id &&
        (
          await call(
            "GET",
            `/me/balance/transfers/${(made.json as TransferJson).transfer.id}`,
            sender,
          )
        ).json,
    ).toMatchObject({ transfer: { status: "sent" } });
    const overview = await call("GET", "/admin/balance/overview", admin);
    expect(overview.json).toMatchObject({ mismatches: 0 });
  });

  it("gives the 🐟 back when Credit refuses the recipient", async () => {
    const { sender, friend, credit, platformId } = await openTransfers();
    credit.next("recipient");
    const made = await call("POST", "/me/balance/transfers", sender, {
      requestId: crypto.randomUUID(),
      ...to(friend),
      destination: "credit",
      amount: "5.00",
    });
    const { transfer } = made.json as TransferJson;
    await cycle(platformId);
    const read = await call(
      "GET",
      `/me/balance/transfers/${transfer.id}`,
      sender,
    );
    expect((read.json as TransferJson).transfer).toMatchObject({
      status: "not_sent",
      withdrawal: { status: "failed", failure: "recipient" },
    });
    expect(await account(sender.id)).toEqual({ available: 5000, locked: 0 });
  });

  it("keeps 转出's limits, its switch, and never pays the 站长's account", async () => {
    const { admin, sender, friend, settingsVersion } = await openTransfers();
    const send = (extra: Record<string, unknown>) =>
      call("POST", "/me/balance/transfers", sender, {
        requestId: crypto.randomUUID(),
        ...to(friend),
        destination: "credit",
        amount: "1.00",
        ...extra,
      });
    expect((await send({ amount: "0.99" })).json).toMatchObject({
      error: { code: "AMOUNT_OUT_OF_RANGE" },
    });
    expect((await send({ amount: "20.01" })).json).toMatchObject({
      error: { code: "AMOUNT_OUT_OF_RANGE" },
    });
    expect((await send(to(admin))).json).toMatchObject({
      error: { code: "RECIPIENT_IS_OWNER" },
    });
    await call("PATCH", "/admin/balance/settings", admin, {
      expectedVersion: settingsVersion,
      topupEnabled: false,
      withdrawEnabled: false,
      topupFeePercent: 12,
      withdrawFeePercent: 12,
      withdrawMaxMinor: 2000,
      transferEnabled: true,
    });
    expect((await send({})).json).toMatchObject({
      error: { code: "WITHDRAW_DISABLED" },
    });
    // To 🐟额 still goes.
    expect((await send({ destination: "balance" })).status).toBe(200);
  });
});

describe("开放接口密钥", () => {
  it("is shown once, stored as a digest, at most ten in use, and stops for good", async () => {
    const { sender, friend } = await openTransfers();
    const { key, token } = await newKey(sender, "我的网站", "20.00");
    expect(token).toMatch(/^hbk_[A-Za-z0-9_-]{32}$/);
    expect(key.lastFour).toBe(token.slice(-4));
    const stored = await env.DB.prepare(
      "SELECT token_hash FROM balance_api_keys WHERE id=?",
    )
      .bind(key.id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).not.toContain(token);
    expect((await open("GET", "/balance", token)).status).toBe(200);
    for (let index = 1; index < 10; index += 1)
      await newKey(sender, `k${index}`);
    const eleventh = await call("POST", "/me/balance/api-keys", sender, {
      name: "多的",
      dailyLimit: null,
    });
    expect(eleventh.json).toMatchObject({ error: { code: "API_KEY_LIMIT" } });
    const stopped = await call(
      "POST",
      `/me/balance/api-keys/${key.id}/revoke`,
      sender,
    );
    expect(stopped.json).toMatchObject({ key: { status: "revoked" } });
    expect((await open("GET", "/balance", token)).json).toMatchObject({
      error: { code: "INVALID_API_KEY" },
    });
    // Only PLUS may make one.
    expect(
      (
        await call("POST", "/me/balance/api-keys", friend, {
          name: "x",
          dailyLimit: null,
        })
      ).json,
    ).toMatchObject({ error: { code: "TRANSFER_NOT_ALLOWED" } });
  });

  it("an admin stops someone's key with a reason they will read", async () => {
    const { admin, sender } = await openTransfers();
    const { key, token } = await newKey(sender);
    const stopped = await call(
      "POST",
      `/admin/balance/api-keys/${key.id}/revoke`,
      admin,
      { reason: "被拿去刷了" },
    );
    expect(stopped.json).toMatchObject({
      key: { status: "admin_revoked", revokeReason: "被拿去刷了" },
    });
    expect((await open("GET", "/balance", token)).status).toBe(401);
    const listed = await call("GET", "/me/balance/api-keys", sender);
    expect((listed.json as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ id: key.id, status: "admin_revoked" }),
    ]);
  });
});

describe("open API", () => {
  it("transfers once per 转账单号, answers 试转 without moving anything, and counts the key", async () => {
    const { sender, friend } = await openTransfers();
    const { key, token } = await newKey(sender, "网站", "15.00");
    const body = { outTransferNo: "order-1", ...to(friend), amount: "10.00" };
    const tried = await open("POST", "/balance/transfers", token, {
      ...body,
      dryRun: true,
    });
    expect(tried.json).toMatchObject({
      transfer: { id: null, dryRun: true, destination: "balance" },
    });
    expect(await account(friend.id)).toBeNull();

    const made = await open("POST", "/balance/transfers", token, body);
    expect(made.status).toBe(200);
    expect(made.headers.get("X-RateLimit-Remaining")).toBe("599");
    const { transfer } = made.json as {
      transfer: { id: string; status: string; to: { userId: string } };
    };
    expect(transfer).toMatchObject({
      status: "sent",
      to: { userId: friend.externalId },
    });
    const again = await open("POST", "/balance/transfers", token, body);
    expect((again.json as { transfer: { id: string } }).transfer.id).toBe(
      transfer.id,
    );
    expect(
      (
        await open("POST", "/balance/transfers", token, {
          ...body,
          amount: "1.00",
        })
      ).json,
    ).toMatchObject({ error: { code: "OUT_TRANSFER_NO_CONFLICT" } });
    // 15 a day: 10 sent, 6 more is over.
    expect(
      (
        await open("POST", "/balance/transfers", token, {
          ...body,
          outTransferNo: "order-2",
          amount: "6.00",
        })
      ).json,
    ).toMatchObject({ error: { code: "DAILY_LIMIT_EXCEEDED" } });
    expect(await account(friend.id)).toEqual({ available: 1000, locked: 0 });

    const balance = await open("GET", "/balance", token);
    expect(balance.json).toMatchObject({
      owner: { userId: sender.externalId, username: sender.username },
      available: "40.00",
      canTransfer: true,
      reason: null,
      toCredit: { canTransfer: true, minAmount: "1.00", maxAmount: "20.00" },
      apiKey: { name: "网站", dailyLimit: "15.00", usedToday: "10.00" },
    });
    const byNo = await open("GET", "/balance/transfers/out/order-1", token);
    expect((byNo.json as { transfer: { id: string } }).transfer.id).toBe(
      transfer.id,
    );
    expect(
      (await open("GET", "/balance/transfers/out/order-9", token)).status,
    ).toBe(404);
    const detail = await call("GET", `/me/balance/api-keys/${key.id}`, sender);
    expect(detail.json).toMatchObject({
      key: {
        transferCount: 1,
        transferTotalMinor: 1000,
        lastTransferIp: "203.0.113.7",
      },
      totals: { today: { count: 1, totalMinor: 1000 } },
    });
    // 明细 names the key on the sender's side only.
    const mine = await call("GET", "/me/balance?filter=transfer", sender);
    expect((mine.json as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        transfer: expect.objectContaining({
          apiKeyName: "网站",
          outTransferNo: "order-1",
        }),
      }),
    ]);
  });

  it("runs a batch one by one, each on its own, and 试转 counts the earlier ones", async () => {
    const { sender, friend } = await openTransfers();
    const other = await actor("other");
    const { token } = await newKey(sender);
    const items = [
      { outTransferNo: "b-1", ...to(friend), amount: "30.00" },
      { outTransferNo: "b-2", ...to(other), amount: "30.00" },
      {
        outTransferNo: "b-3",
        toUserId: "1",
        toUsername: "nobody",
        amount: "1.00",
      },
      { outTransferNo: "b-4", ...to(other), amount: "20.00" },
    ];
    const tried = await open("POST", "/balance/transfers/batch", token, {
      transfers: items,
      dryRun: true,
    });
    const triedResults = (tried.json as { results: Record<string, unknown>[] })
      .results;
    expect(triedResults.map((result) => result.error ?? "ok")).toEqual([
      "ok",
      expect.objectContaining({ code: "BALANCE_INSUFFICIENT" }),
      expect.objectContaining({ code: "RECIPIENT_NOT_FOUND" }),
      "ok",
    ]);
    expect(await account(sender.id)).toEqual({ available: 5000, locked: 0 });

    const ran = await open("POST", "/balance/transfers/batch", token, {
      transfers: items,
    });
    const results = (ran.json as { results: Record<string, unknown>[] })
      .results;
    expect(results.map((result) => result.error ?? "ok")).toEqual([
      "ok",
      expect.objectContaining({ code: "BALANCE_INSUFFICIENT" }),
      expect.objectContaining({ code: "RECIPIENT_NOT_FOUND" }),
      "ok",
    ]);
    expect(await account(sender.id)).toEqual({ available: 0, locked: 0 });
    // Sent again whole: the done ones come back as they were.
    const again = await open("POST", "/balance/transfers/batch", token, {
      transfers: items,
    });
    expect(
      (again.json as { results: { transfer?: { id: string } }[] }).results[0]
        ?.transfer?.id,
    ).toBe((results[0] as { transfer: { id: string } }).transfer.id);
    expect(await account(other.id)).toEqual({ available: 2000, locked: 0 });
  });

  it("lists the key's own 转账 out and everything in, filtered and paged", async () => {
    const { sender, friend } = await openTransfers();
    await member(friend);
    const { token } = await newKey(sender);
    const { token: friendToken } = await newKey(friend);
    for (const no of ["l-1", "l-2", "l-3"])
      await open("POST", "/balance/transfers", token, {
        outTransferNo: no,
        ...to(friend),
        amount: "1.00",
      });
    await open("POST", "/balance/transfers", friendToken, {
      outTransferNo: "back",
      ...to(sender),
      amount: "0.50",
      remark: "退你",
    });
    const page = await open("GET", "/balance/transfers?limit=2", token);
    const first = page.json as {
      items: { outTransferNo: string | null; direction: string }[];
      nextCursor: string;
    };
    expect(first.items.map((item) => item.direction)).toEqual(["in", "out"]);
    const rest = await open(
      "GET",
      `/balance/transfers?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      token,
    );
    expect(
      (rest.json as { items: { outTransferNo: string }[] }).items.map(
        (item) => item.outTransferNo,
      ),
    ).toEqual(["l-2", "l-1"]);
    const incoming = await open(
      "GET",
      `/balance/transfers?direction=in&counterpartUserId=${friend.externalId}`,
      token,
    );
    expect(incoming.json).toMatchObject({
      items: [{ direction: "in", remark: "退你", amount: "0.50" }],
    });
    const bad = await open("GET", "/balance/transfers?direction=up", token);
    expect(bad.json).toMatchObject({
      error: { code: "INVALID_REQUEST", issues: [{ path: "direction" }] },
    });
    // The other key's 转账 out are not this key's to read.
    const theirs = await open(
      "GET",
      "/balance/transfers?direction=out",
      friendToken,
    );
    expect(
      (theirs.json as { items: { outTransferNo: string }[] }).items.map(
        (item) => item.outTransferNo,
      ),
    ).toEqual(["back"]);
  });

  it("stops a key at 600 in a minute, with Retry-After", async () => {
    const { sender, friend } = await openTransfers();
    const { key, token } = await newKey(sender);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<600)
      INSERT INTO balance_transfers (id,from_user_id,to_user_id,destination,amount_minor,api_key_id,out_transfer_no,
        request_digest,recipient_external_id,recipient_username,created_at)
      SELECT lower(hex(randomblob(16))),?,?,'balance',1,?,'fill-'||i,'x',?,?,? FROM n`,
    )
      .bind(
        sender.id,
        friend.id,
        key.id,
        friend.externalId,
        friend.username,
        Date.now(),
      )
      .run();
    const refused = await open("POST", "/balance/transfers", token, {
      outTransferNo: "over",
      ...to(friend),
      amount: "1.00",
    });
    expect(refused.status).toBe(429);
    expect(refused.json).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("serves its description to anyone, and nothing else without a key", async () => {
    const doc = await open("GET", "/openapi.json");
    expect(doc.status).toBe(200);
    expect(doc.json).toMatchObject({
      openapi: "3.1.0",
      paths: { "/balance/transfers/batch": expect.anything() },
    });
    expect((await open("GET", "/balance")).json).toMatchObject({
      error: { code: "INVALID_API_KEY" },
    });
    expect((await open("GET", "/balance", "hbk_x")).status).toBe(401);
  });
});

describe("🐟额 PLUS", () => {
  it("tells members what it adds, and others only how many things", async () => {
    const { sender, friend, admin } = await openTransfers();
    await call("POST", "/me/balance/transfers", sender, {
      requestId: crypto.randomUUID(),
      ...to(friend),
      destination: "balance",
      amount: "1.00",
    });
    const mine = await call("GET", "/me/balance", sender);
    expect(mine.json).toMatchObject({
      access: { transfer: true },
      plus: {
        plus: true,
        owner: false,
        features: expect.arrayContaining([
          { name: "开放接口", text: "接入网站或程序" },
          { name: "附带网页", text: "在红包页旁边放一个自己的网页" },
        ]),
        featureCount: 6,
      },
    });
    const theirs = await call("GET", "/me/balance", friend);
    expect(theirs.json).toMatchObject({
      access: { transfer: false },
      plus: { plus: false, features: null, featureCount: 6 },
    });
    expect(JSON.stringify(theirs.json)).not.toContain("接入网站或程序");
    // The 站长: their own first line.
    const owner = await call("GET", "/me/balance", admin);
    expect(owner.json).toMatchObject({
      plus: {
        plus: true,
        owner: true,
        features: expect.arrayContaining([
          { name: "补加和扣回", text: "给自己记🐟" },
        ]),
      },
    });
    const session = await call("GET", "/session", sender);
    expect(session.json).toMatchObject({ user: { balancePlus: true } });
    const me = await call("GET", "/me", friend);
    expect(me.json).toMatchObject({ user: { linuxDoId: friend.externalId } });
  });
});
