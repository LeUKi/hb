// 打赏 (docs/tip-design.md): 打赏卡 made and kept by their owner, shown to
// anyone, and tips through them — at Credit 站 into the owner's 商户 (an
// order this site makes and checks), or from 🐟额 as a 转账.
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
import { sweepTips } from "../src/tips/service";

const origin = "https://hb.example.com";
let CLIENT_ID = "hb_tip_platform_0";
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
/** Cap's siteverify as this test wants it (the default stub answers 503). */
let capAnswer: ((token: string) => unknown) | null = null;
const bindings = () =>
  ({
    ...env,
    APP_ORIGIN: origin,
    APP_ENV: "production",
    LDC_NETWORK_MODE: "live",
    ADMIN_LINUX_DO_IDS: admins.join(","),
    ...(capAnswer
      ? {
          CAP: {
            fetch: async (_input: unknown, init?: RequestInit) => {
              const body = JSON.parse(String(init?.body ?? "{}")) as {
                response: string;
              };
              return Response.json(capAnswer?.(body.response));
            },
          } as unknown as Fetcher,
        }
      : {}),
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

/** The 站长 with 打赏 and 免密打赏 on (or not), an `owner` and a `fan`. */
async function open(
  options: { tipEnabled?: boolean; passwordFree?: boolean } = {},
) {
  const admin = await actor("admin");
  admins = [admin.externalId];
  const owner = await actor("owner");
  const fan = await actor("fan");
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
    transferEnabled: true,
    tipEnabled: options.tipEnabled ?? true,
    tipPasswordFreeEnabled: options.passwordFree ?? true,
  });
  expect(patched.status).toBe(200);
  return { admin, owner, fan, credit };
}

const cardInput = (patch: Record<string, unknown> = {}) => ({
  name: "个人页",
  style: "standard",
  palette: "lake",
  prompt: "觉得有用的话，请我喝杯咖啡",
  amounts: [
    { amount: "1", label: "" },
    { amount: "5", label: "咖啡" },
    { amount: "10", label: "" },
  ],
  defaultIndex: 1,
  allowOther: true,
  goal: null,
  showRecent: true,
  showTop: true,
  link: { kind: "none" },
  ...patch,
});

type CardJson = {
  card: { code: string; version: number; active: boolean; goal: unknown };
};

async function newCard(who: Actor, patch: Record<string, unknown> = {}) {
  const made = await call("POST", "/me/tips/cards", who, cardInput(patch));
  expect(made.status).toBe(200);
  return (made.json as CardJson).card;
}

type TipJson = {
  tip: { id: string; status: string; method: string; amountMinor: number };
  payUrl: string | null;
};

const tip = (
  card: { code: string; version: number },
  who: Actor | undefined,
  body: Record<string, unknown>,
) =>
  call("POST", `/tip/${card.code}`, who, {
    requestId: crypto.randomUUID(),
    cardVersion: card.version,
    amount: "5",
    method: "checkout",
    ...body,
  });

async function fund(admin: Actor, who: Actor, amount: string) {
  await env.DB.prepare(
    "INSERT INTO balance_members (user_id,created_at) VALUES (?,?)",
  )
    .bind(who.id, Date.now())
    .run();
  const added = await call(
    "POST",
    `/admin/balance/users/${who.id}/adjustments`,
    admin,
    {
      requestId: crypto.randomUUID(),
      direction: "add",
      amount,
      reason: "测试用",
    },
  );
  expect(added.status).toBe(200);
}

const available = async (userId: string) =>
  (
    await env.DB.prepare(
      "SELECT available_minor AS available FROM balance_accounts WHERE user_id=?",
    )
      .bind(userId)
      .first<{ available: number }>()
  )?.available ?? 0;

beforeEach(() => {
  CLIENT_ID = `hb_tip_platform_${crypto.randomUUID().slice(0, 8)}`;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  admins = [];
  capAnswer = null;
  await env.DB.prepare(
    "UPDATE merchants SET usage_status='legacy' WHERE kind='platform'",
  ).run();
});

describe("打赏卡", () => {
  it("are made, changed and stopped by their owner; 3 switched on, 30 with PLUS", async () => {
    const { admin, owner } = await open();
    const first = await newCard(owner);
    expect(first.code).toMatch(/^[2-9a-zA-Z]{6}$/);
    await newCard(owner, { name: "帖子" });
    await newCard(owner, { name: "另一个帖子" });
    const fourth = await call("POST", "/me/tips/cards", owner, cardInput());
    expect(fourth.status).toBe(409);
    expect(code(fourth).code).toBe("TIP_CARDS_FULL");

    const stopped = await call(
      "POST",
      `/me/tips/cards/${first.code}/stop`,
      owner,
    );
    expect((stopped.json as CardJson).card.active).toBe(false);
    await newCard(owner, { name: "补上" });
    const restart = await call(
      "POST",
      `/me/tips/cards/${first.code}/start`,
      owner,
    );
    expect(code(restart).code).toBe("TIP_CARDS_FULL");

    await fund(admin, owner, "1.00");
    expect(
      (await call("POST", `/me/tips/cards/${first.code}/start`, owner)).status,
    ).toBe(200);
    const mine = (await call("GET", "/me/tips", owner)).json as {
      used: number;
      limit: number;
    };
    expect(mine).toMatchObject({ used: 4, limit: 30 });

    const changed = await call("PATCH", `/me/tips/cards/${first.code}`, owner, {
      ...cardInput({
        goal: "300",
        link: { kind: "topic", topicUrl: "https://linux.do/t/topic/3112382/5" },
      }),
      expectedVersion: first.version + 2,
    });
    expect(changed.status).toBe(200);
    const goal = (changed.json as CardJson & { card: { link: unknown } }).card;
    expect(goal.goal).toEqual({ amountMinor: 30000, reachedMinor: 0 });
    expect(goal.link).toEqual({
      kind: "topic",
      topicId: "3112382",
      title: null,
      url: "https://linux.do/t/3112382",
    });
    const stale = await call("PATCH", `/me/tips/cards/${first.code}`, owner, {
      ...cardInput(),
      expectedVersion: first.version,
    });
    expect(code(stale).code).toBe("TIP_CARD_CONFLICT");
    const simpleGoal = await call(
      "POST",
      "/me/tips/cards",
      owner,
      cardInput({ style: "simple", goal: "10" }),
    );
    expect(simpleGoal.status).toBe(400);
  });

  it("show anyone the card and what this viewer may pay with", async () => {
    const { admin, owner, fan, credit } = await open();
    const card = await newCard(owner);
    const asGuest = (await call("GET", `/tip/${card.code}`)).json as {
      card: { owner: { username: string }; amounts: unknown[] };
      viewer: {
        signedIn: boolean;
        methods: { checkout: { reason: string | null }; balance: unknown };
        capEndpoint: string | null;
      };
    };
    expect(asGuest.card.owner.username).toBe(owner.username);
    expect(asGuest.card.amounts).toHaveLength(3);
    expect(asGuest.viewer.signedIn).toBe(false);
    expect(asGuest.viewer.methods.checkout.reason).toBe("no_merchant");
    expect(asGuest.viewer.capEndpoint).toContain(`/scope/tip:${card.code}/`);

    await merchantFor(owner, credit);
    await fund(admin, fan, "20.00");
    const asFan = (await call("GET", `/tip/${card.code}`, fan)).json as {
      viewer: {
        methods: {
          checkout: { available: boolean };
          balance: unknown;
          merchant: unknown;
        };
        capEndpoint: string | null;
      };
    };
    expect(asFan.viewer.methods.checkout.available).toBe(true);
    expect(asFan.viewer.methods.balance).toEqual({ availableMinor: 2000 });
    expect(asFan.viewer.methods.merchant).toBeNull();
    expect(asFan.viewer.capEndpoint).toBeNull();
    const asOwner = (await call("GET", `/tip/${card.code}`, owner)).json as {
      viewer: { own: boolean; methods: { balance: unknown } };
    };
    expect(asOwner.viewer.own).toBe(true);
  });
});

describe("打赏 at Credit 站", () => {
  it("orders on the owner's 商户, is checked, and then counts on the card", async () => {
    const { owner, fan, credit } = await open();
    await merchantFor(owner, credit);
    const card = await newCard(owner, { goal: "300" });
    const requestId = crypto.randomUUID();
    const made = await tip(card, fan, { requestId, message: "谢谢分享" });
    expect(made.status).toBe(200);
    const first = made.json as TipJson;
    expect(first.tip).toMatchObject({
      status: "pending",
      method: "checkout",
      amountMinor: 500,
    });
    expect(first.payUrl).toMatch(
      /^https:\/\/credit\.linux\.do\/paying\?order_no=/,
    );
    const order = [...credit.orders.values()][0];
    expect(order?.name).toBe(`打赏 · @${fan.username} · hb.lafi.sh`);
    expect(order?.returnUrl).toBe(
      `${origin}/%E2%98%95/${card.code}/%F0%9F%A7%BE/${first.tip.id}`,
    );

    const again = (await tip(card, fan, { requestId, message: "谢谢分享" }))
      .json as TipJson;
    expect(again.tip.id).toBe(first.tip.id);
    expect(again.payUrl).toBe(first.payUrl);
    const reused = await tip(card, fan, { requestId, amount: "10" });
    expect(code(reused).code).toBe("TIP_REQUEST_REUSED");

    const waiting = (
      await call("POST", `/tip/${card.code}/tips/${first.tip.id}/check`)
    ).json as TipJson;
    expect(waiting.tip.status).toBe("pending");
    credit.pay(order?.outTradeNo ?? "");
    await env.DB.prepare("UPDATE tips SET check_claimed_at=0 WHERE id=?")
      .bind(first.tip.id)
      .run();
    const paid = (
      await call("POST", `/tip/${card.code}/tips/${first.tip.id}/check`)
    ).json as TipJson;
    expect(paid.tip.status).toBe("done");

    const shown = (await call("GET", `/tip/${card.code}`)).json as {
      card: {
        tipperCount: number;
        goal: { reachedMinor: number };
        recent: {
          person: { username: string };
          message: string;
          amountMinor: number;
        }[];
        top: { rank: number; amountMinor: number }[];
      };
    };
    expect(shown.card.tipperCount).toBe(1);
    expect(shown.card.goal.reachedMinor).toBe(500);
    expect(shown.card.recent[0]).toMatchObject({
      person: { username: fan.username },
      message: "谢谢分享",
      amountMinor: 500,
    });
    expect(shown.card.top[0]).toMatchObject({ rank: 1, amountMinor: 500 });

    const received = (await call("GET", "/me/tips/list/in?range=all", owner))
      .json as {
      tips: { direction: string; counterpart: { username: string } }[];
      stats: { count: number; people: number; amountMinor: number };
    };
    expect(received.stats).toEqual({ count: 1, people: 1, amountMinor: 500 });
    expect(received.tips[0]?.counterpart.username).toBe(fan.username);
    const given = (await call("GET", "/me/tips/list/out?range=all", fan)).json as {
      tips: { direction: string; card: { name: string | null } }[];
    };
    expect(given.tips[0]).toMatchObject({
      direction: "out",
      card: { name: null },
    });

    const receipt = (
      await call("GET", `/tip/${card.code}/tips/${first.tip.id}`)
    ).json as {
      receipt: { status: string; amountMinor: number };
    };
    expect(receipt.receipt).toMatchObject({ status: "done", amountMinor: 500 });
  });

  it("lets guests pay only at Credit 站, each link after Cap", async () => {
    const { owner, credit } = await open();
    await merchantFor(owner, credit);
    const card = await newCard(owner);
    capAnswer = (token) =>
      token === "good"
        ? { success: true, scope: `tip:${card.code}` }
        : token === "other"
          ? { success: true, scope: "tip:else" }
          : { success: false };
    expect(code(await tip(card, undefined, {})).code).toBe("TIP_HUMAN_CHECK");
    expect(code(await tip(card, undefined, { capToken: "bad" })).code).toBe(
      "TIP_HUMAN_CHECK",
    );
    expect(code(await tip(card, undefined, { capToken: "other" })).code).toBe(
      "TIP_HUMAN_CHECK",
    );
    expect(
      code(await tip(card, undefined, { method: "balance", capToken: "good" }))
        .code,
    ).toBe("TIP_SIGN_IN");
    const made = await tip(card, undefined, {
      capToken: "good",
      message: "路过",
    });
    expect(made.status).toBe(200);
    expect((made.json as TipJson).payUrl).not.toBeNull();
    expect([...credit.orders.values()][0]?.name).toBe("打赏 · hb.lafi.sh");
  });

  it("is checked once more after 15 minutes, and paid later still counts", async () => {
    const { owner, fan, credit } = await open();
    await merchantFor(owner, credit);
    const card = await newCard(owner);
    const made = (await tip(card, fan, {})).json as TipJson;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000);
    // Other tests' links wait too: at least this one is asked about.
    expect((await sweepTips(bindings())).checked).toBeGreaterThanOrEqual(1);
    const status = async () =>
      (
        await env.DB.prepare("SELECT status FROM tips WHERE id=?")
          .bind(made.tip.id)
          .first<{ status: string }>()
      )?.status;
    expect(await status()).toBe("unpaid");
    credit.pay([...credit.orders.values()][0]?.outTradeNo ?? "");
    vi.spyOn(Date, "now").mockReturnValue(now + 17 * 60_000);
    await call("POST", `/tip/${card.code}/tips/${made.tip.id}/check`);
    expect(await status()).toBe("done");
  });

  it("refuses a changed card, an amount not on it, one's own card, a stopped card and a closed switch", async () => {
    const { owner, fan, credit, admin } = await open();
    await merchantFor(owner, credit);
    const card = await newCard(owner, { allowOther: false });
    expect(
      code(await tip(card, fan, { cardVersion: card.version + 1 })).code,
    ).toBe("TIP_CARD_CHANGED");
    expect(code(await tip(card, fan, { amount: "7" })).code).toBe(
      "TIP_AMOUNT_INVALID",
    );
    expect(code(await tip(card, owner, {})).code).toBe("TIP_SELF");
    await call("POST", `/me/tips/cards/${card.code}/stop`, owner);
    const stopped = (await call("GET", `/tip/${card.code}`)).json as CardJson;
    expect(code(await tip(stopped.card, fan, {})).code).toBe(
      "TIP_CARD_STOPPED",
    );
    const settings = (await call("GET", "/admin/balance/settings", admin))
      .json as { settings: Record<string, unknown> };
    const {
      version,
      updatedAt: _u,
      ...rest
    } = settings.settings as { version: number; updatedAt: number };
    await call("PATCH", "/admin/balance/settings", admin, {
      ...rest,
      expectedVersion: version,
      tipEnabled: false,
    });
    const paused = (await call("GET", `/tip/${card.code}`, fan)).json as {
      viewer: { paused: boolean };
    };
    expect(paused.viewer.paused).toBe(true);
    expect(
      code(await call("POST", "/me/tips/cards", owner, cardInput())).code,
    ).toBe("TIP_DISABLED");
  });
});

describe("打赏 from 🐟额", () => {
  it("is a 转账 to the owner's 🐟额, written with the tip, for 🐟额 PLUS", async () => {
    const { admin, owner, fan } = await open();
    const card = await newCard(owner);
    await fund(admin, fan, "20.00");
    const made = await tip(card, fan, {
      method: "balance",
      amount: "10",
      message: "支持",
    });
    expect(made.status).toBe(200);
    expect((made.json as TipJson).tip).toMatchObject({
      status: "done",
      method: "balance",
      amountMinor: 1000,
    });
    expect(await available(fan.id)).toBe(1000);
    expect(await available(owner.id)).toBe(1000);
    const transfer = await env.DB.prepare(
      "SELECT t.remark,t.destination FROM balance_transfers t JOIN tips p ON p.transfer_id=t.id WHERE p.id=?",
    )
      .bind((made.json as TipJson).tip.id)
      .first<{ remark: string; destination: string }>();
    expect(transfer).toEqual({ remark: "打赏", destination: "balance" });

    const stranger = await actor("stranger");
    expect(code(await tip(card, stranger, { method: "balance" })).code).toBe(
      "TIP_BALANCE_NOT_ALLOWED",
    );
    expect(
      code(await tip(card, fan, { method: "balance", amount: "20" })).code,
    ).toBe("BALANCE_INSUFFICIENT");
  });

  it("is closed with 免密打赏", async () => {
    const { admin, owner, fan } = await open({ passwordFree: false });
    const card = await newCard(owner);
    await fund(admin, fan, "20.00");
    const view = (await call("GET", `/tip/${card.code}`, fan)).json as {
      viewer: { methods: { balance: unknown } };
    };
    expect(view.viewer.methods.balance).toBeNull();
    expect(code(await tip(card, fan, { method: "balance" })).code).toBe(
      "TIP_PASSWORD_FREE_OFF",
    );
  });

  it("lets the owner hide a 留言, the amount still counting", async () => {
    const { admin, owner, fan } = await open();
    const card = await newCard(owner);
    await fund(admin, fan, "20.00");
    const made = (await tip(card, fan, { method: "balance", message: "广告" }))
      .json as TipJson;
    const hidden = await call(
      "POST",
      `/me/tips/${made.tip.id}/message`,
      owner,
      { hidden: true },
    );
    expect(hidden.status).toBe(200);
    const shown = (await call("GET", `/tip/${card.code}`)).json as {
      card: {
        recent: {
          message: string | null;
          messageHidden: boolean;
          amountMinor: number;
        }[];
      };
    };
    expect(shown.card.recent[0]).toMatchObject({
      message: null,
      messageHidden: true,
      amountMinor: 500,
    });
    expect(
      code(
        await call("POST", `/me/tips/${made.tip.id}/message`, fan, {
          hidden: true,
        }),
      ).code,
    ).toBe("TIP_NOT_FOUND");
  });
});
