// 转账 through 对方的收银台 (docs/balance-design.md §16): ordered with the
// recipient's LDC 商户, paid at Credit 站 from the payer's own account;
// nothing passes 🐟额. Who may, what is refused, and how an order is checked.
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import {
  merchantCredentials,
  merchants,
  sessions,
  users,
} from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { epaySignature } from "../src/payments/real-protocol";
import { encryptString, sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
let CLIENT_ID = "hb_checkout_platform_0";
const SECRET = "platform-secret-key";
const MERCHANT_SECRET = "friend-merchant-secret";

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
    770_000 + counter * 13 + Math.floor(Math.random() * 13),
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
    ADMIN_LINUX_DO_IDS: admins.join(","),
  }) satisfies ApiBindings;

type Called = { status: number; json: never };

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
    json: (await response.json().catch(() => null)) as never,
  };
}

const code = (result: Called) =>
  (result.json as { error: { code: string; message: string } }).error;

/** Credit 站's cashier and its order query, for any app with its secret. */
function fakeCredit() {
  type Order = {
    pid: string;
    outTradeNo: string;
    money: string;
    name: string;
    returnUrl: string;
    status: 0 | 1;
    tradeNo: string;
  };
  const orders = new Map<string, Order>();
  const secrets = new Map<string, string>([[CLIENT_ID, SECRET]]);
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
    if (url.pathname === "/epay/pay/submit.php") {
      const form = Object.fromEntries(
        new URLSearchParams(String(init?.body ?? "")),
      );
      const { sign, sign_type: _signType, ...params } = form;
      const secret = secrets.get(params.pid ?? "");
      if (!secret || sign !== (await epaySignature(params, secret)))
        return json({ error_msg: "签名验证失败", data: null }, 401);
      const existing = orders.get(params.out_trade_no ?? "");
      const order = existing ?? {
        pid: params.pid ?? "",
        outTradeNo: params.out_trade_no ?? "",
        money: params.money ?? "",
        name: params.name ?? "",
        returnUrl: params.return_url ?? "",
        status: 0 as const,
        tradeNo: `credit_${orders.size + 1}`,
      };
      orders.set(order.outTradeNo, order);
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://credit.linux.do/paying?order_no=sealed-${order.tradeNo}`,
        },
      });
    }
    if (url.pathname === "/epay/api.php") {
      const pid = url.searchParams.get("pid") ?? "";
      if (!secrets.has(pid) || url.searchParams.get("key") !== secrets.get(pid))
        return json({ code: -1, msg: "商户信息不存在" }, 400);
      const order = orders.get(url.searchParams.get("out_trade_no") ?? "");
      if (!order) return json({ code: -1, msg: "订单不存在或已完成" }, 404);
      return json({
        code: 1,
        msg: "查询订单号成功！",
        pid: order.pid,
        out_trade_no: order.outTradeNo,
        trade_no: order.tradeNo,
        money: order.money,
        status: order.status,
      });
    }
    throw new Error(`Unexpected path ${url.pathname}`);
  });
  return {
    orders,
    secrets,
    pay(businessNo: string) {
      const order = orders.get(businessNo);
      if (!order) throw new Error("No such order");
      order.status = 1;
    },
  };
}

/** `who`'s current LDC 商户, its credential checked (or not). */
async function merchantFor(
  who: Actor,
  credit: ReturnType<typeof fakeCredit>,
  options: { passed?: boolean } = {},
) {
  const id = crypto.randomUUID();
  const clientId = `friend_app_${id.slice(0, 8)}`;
  const now = Date.now();
  await createDb(env.DB).insert(merchants).values({
    id,
    authorId: who.id,
    clientId,
    mode: "real",
    label: "朋友的商户",
    requestId: crypto.randomUUID(),
    requestDigest: "test",
    createdAt: now,
    updatedAt: now,
  });
  await createDb(env.DB)
    .insert(merchantCredentials)
    .values({
      id: crypto.randomUUID(),
      merchantId: id,
      clientId,
      version: 1,
      ciphertext: await encryptString(
        MERCHANT_SECRET,
        env,
        `merchant:${id}:credential:1`,
      ),
      verificationStatus: options.passed === false ? "unverified" : "passed",
      verificationCheckedAt: now - 1,
      createdAt: now - 1,
    });
  credit.secrets.set(clientId, MERCHANT_SECRET);
  return { id, clientId };
}

/** The 站长, 转账 open, a PLUS `payer` and a `friend` who has been here. */
async function open(options: { transferEnabled?: boolean } = {}) {
  const admin = await actor("admin");
  admins = [admin.externalId];
  const payer = await actor("payer");
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
  const read = settings.json as { settings: { version: number } };
  const patched = await call("PATCH", "/admin/balance/settings", admin, {
    expectedVersion: read.settings.version,
    topupEnabled: false,
    withdrawEnabled: true,
    topupFeePercent: 12,
    withdrawFeePercent: 12,
    withdrawMaxMinor: 2000,
    transferEnabled: options.transferEnabled ?? true,
  });
  expect(patched.status).toBe(200);
  await env.DB.prepare(
    "INSERT INTO balance_members (user_id,created_at) VALUES (?,?)",
  )
    .bind(payer.id, Date.now())
    .run();
  return { admin, payer, friend, credit };
}

const to = (who: Actor) => ({
  toUserId: who.externalId,
  toUsername: who.username,
});

type CheckoutJson = {
  checkout: {
    id: string;
    direction: string;
    status: string;
    amountMinor: number;
    remark: string | null;
    businessNo: string;
    externalOrderId: string | null;
    counterpart: { username: string; userId: string };
  };
  cashierUrl: string | null;
};

const lookup = async (who: Actor, username: string) =>
  (
    (
      await call(
        "GET",
        `/me/balance/recipients?username=${encodeURIComponent(username)}`,
        who,
      )
    ).json as { checkoutBlock: string | null }
  ).checkoutBlock;

beforeEach(() => {
  CLIENT_ID = `hb_checkout_platform_${crypto.randomUUID().slice(0, 8)}`;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  admins = [];
  await env.DB.prepare(
    "UPDATE merchants SET usage_status='legacy' WHERE kind='platform'",
  ).run();
});

describe("转账 through 对方的收银台", () => {
  it("says, once the recipient is found, whether their 收银台 can take it", async () => {
    const { payer, friend, credit } = await open();
    expect(await lookup(payer, friend.username)).toBe("no_merchant");
    const other = await actor("other");
    await merchantFor(other, credit, { passed: false });
    expect(await lookup(payer, other.username)).toBe("unverified");
    await merchantFor(friend, credit);
    expect(await lookup(payer, friend.username)).toBeNull();
  });

  it("orders with the recipient's 商户, paid at Credit 站 and checked; 🐟额 untouched", async () => {
    const { payer, friend, credit } = await open();
    const merchant = await merchantFor(friend, credit);
    const requestId = crypto.randomUUID();
    const made = await call("POST", "/me/balance/checkouts", payer, {
      requestId,
      ...to(friend),
      amount: "100.00",
      remark: "饭钱",
    });
    expect(made.status).toBe(200);
    const { checkout, cashierUrl } = made.json as CheckoutJson;
    expect(cashierUrl).toMatch(/^https:\/\/credit\.linux\.do\/paying/);
    expect(checkout).toMatchObject({
      direction: "out",
      status: "pending",
      amountMinor: 10_000,
      remark: "饭钱",
      counterpart: { username: friend.username, userId: friend.externalId },
    });
    expect(checkout.businessNo).toMatch(/^hb\.lafi\.sh_tr_[0-9a-f]{32}$/);
    const order = credit.orders.get(checkout.businessNo);
    expect(order).toMatchObject({
      pid: merchant.clientId,
      money: "100.00",
      name: `转账 · @${payer.username} · hb.lafi.sh`,
      returnUrl: `${origin}/balance/pay/${checkout.id}`,
    });
    // The same request again: the same one, the same order.
    const again = await call("POST", "/me/balance/checkouts", payer, {
      requestId,
      ...to(friend),
      amount: "100.00",
      remark: "饭钱",
    });
    expect((again.json as CheckoutJson).checkout.id).toBe(checkout.id);
    expect(credit.orders.size).toBe(1);
    expect(
      code(
        await call("POST", "/me/balance/checkouts", payer, {
          requestId,
          ...to(friend),
          amount: "99.00",
        }),
      ).code,
    ).toBe("CHECKOUT_REQUEST_REUSED");

    // In the payer's 明细 under 转账; their 🐟额 has nothing of it.
    const records = await call("GET", "/me/balance?filter=transfer", payer);
    expect((records.json as { items: { type: string }[] }).items).toEqual([
      expect.objectContaining({ type: "checkout" }),
    ]);
    // Not the recipient's to open; not in 收到的付款 before it is paid.
    expect(
      (await call("GET", `/me/balance/checkouts/${checkout.id}`, friend))
        .status,
    ).toBe(404);
    const received = () =>
      call("GET", "/me/balance/checkouts/received", friend).then(
        (result) =>
          (result.json as { items: CheckoutJson["checkout"][] }).items,
      );
    expect(await received()).toHaveLength(0);

    credit.pay(checkout.businessNo);
    const checked = await call(
      "POST",
      `/me/balance/checkouts/${checkout.id}/check`,
      payer,
    );
    expect((checked.json as CheckoutJson).checkout).toMatchObject({
      status: "paid",
      externalOrderId: "credit_1",
    });
    expect(await received()).toEqual([
      expect.objectContaining({
        id: checkout.id,
        direction: "in",
        amountMinor: 10_000,
        remark: "饭钱",
        counterpart: expect.objectContaining({ username: payer.username }),
      }),
    ]);
    // Paid is final, and it stays.
    await expect(
      env.DB.prepare("UPDATE balance_checkouts SET status='unpaid' WHERE id=?")
        .bind(checkout.id)
        .run(),
    ).rejects.toThrow(/forward/);
    await expect(
      env.DB.prepare("DELETE FROM balance_checkouts WHERE id=?")
        .bind(checkout.id)
        .run(),
    ).rejects.toThrow(/permanent/);
  });

  it("refuses those without PLUS, a closed switch, no 商户, oneself and amounts out of range", async () => {
    const { payer, friend, credit } = await open();
    const send = (who: Actor, recipient: Actor, amount = "10.00") =>
      call("POST", "/me/balance/checkouts", who, {
        requestId: crypto.randomUUID(),
        ...to(recipient),
        amount,
      });
    expect(code(await send(payer, friend))).toMatchObject({
      code: "CHECKOUT_BLOCKED",
      message: "对方还没有配置 LDC 商户",
    });
    await merchantFor(friend, credit);
    expect(code(await send(friend, payer)).code).toBe("TRANSFER_NOT_ALLOWED");
    expect(code(await send(payer, payer)).code).toBe("SELF_TRANSFER");
    for (const amount of ["0.99", "2000.01"])
      expect(code(await send(payer, friend, amount))).toMatchObject({
        code: "AMOUNT_OUT_OF_RANGE",
        message: "付多少要在 1.00 到 2000.00 LDC 之间。",
      });
    expect(
      code(
        await call("POST", "/me/balance/checkouts", payer, {
          requestId: crypto.randomUUID(),
          toUserId: "1",
          toUsername: friend.username,
          amount: "10.00",
        }),
      ).code,
    ).toBe("RECIPIENT_NOT_FOUND");
    expect((await send(payer, friend)).status).toBe(200);
  });

  it("is closed with 转账", async () => {
    const { payer, friend, credit } = await open({ transferEnabled: false });
    await merchantFor(friend, credit);
    expect(
      code(
        await call("POST", "/me/balance/checkouts", payer, {
          requestId: crypto.randomUUID(),
          ...to(friend),
          amount: "10.00",
        }),
      ).code,
    ).toBe("TRANSFER_DISABLED");
  });

  it("turns 未完成 after its ten minutes, and paid later all the same; either page checks it", async () => {
    const { payer, friend, credit } = await open();
    await merchantFor(friend, credit);
    const made = await call("POST", "/me/balance/checkouts", payer, {
      requestId: crypto.randomUUID(),
      ...to(friend),
      amount: "20.00",
    });
    const { checkout } = made.json as CheckoutJson;
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start + 11 * 60_000);
    const late = await call(
      "POST",
      `/me/balance/checkouts/${checkout.id}/check`,
      payer,
    );
    expect((late.json as CheckoutJson).checkout.status).toBe("unpaid");
    expect(
      code(
        await call("POST", `/me/balance/checkouts/${checkout.id}/pay`, payer),
      ).code,
    ).toBe("CHECKOUT_CLOSED");
    // Paid after all: the recipient's 商户 page, opened, finds it.
    credit.pay(checkout.businessNo);
    vi.spyOn(Date, "now").mockReturnValue(start + 12 * 60_000);
    const opened = await call(
      "POST",
      "/me/balance/checkouts/received/check-open",
      friend,
    );
    expect(opened.json).toEqual({ paid: 1 });
    expect(
      (
        (await call("GET", `/me/balance/checkouts/${checkout.id}`, payer))
          .json as CheckoutJson
      ).checkout.status,
    ).toBe("paid");
  });
});
