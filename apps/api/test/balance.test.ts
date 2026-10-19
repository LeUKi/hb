// 站内🐟额, step one: settings, the platform app, 转入 against a fake
// Credit, 调整, and what the database itself refuses.
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { epaySignature } from "../src/payments/real-protocol";
import { sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
// The Client ID registry is permanent: each test's platform app has its own.
let CLIENT_ID = "hb_balance_platform_0";
const SECRET = "platform-secret-key";

type Actor = { id: string; externalId: string; cookie: string; csrf: string };

let counter = 0;
async function actor(username = "fish"): Promise<Actor> {
  const id = crypto.randomUUID();
  counter += 1;
  const externalId = String(
    880_000 + counter * 7 + Math.floor(Math.random() * 7),
  );
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id,
      externalId,
      username: `${username}${counter}`,
      displayName: username,
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
  return { id, externalId, cookie: `hb_session=${token}`, csrf };
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

async function call(
  method: string,
  path: string,
  who?: Actor,
  body?: unknown,
  ctx = createExecutionContext(),
) {
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
  return { status: response.status, json: (await response.json()) as never };
}

/** A small Credit: EPay orders by 业务号, its cashier, and the order query. */
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
  const calls = { submits: 0, queries: 0 };
  let submitOverride: (() => Response) | null = null;
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
      calls.submits += 1;
      if (submitOverride) return submitOverride();
      const form = Object.fromEntries(
        new URLSearchParams(String(init?.body ?? "")),
      );
      const { sign, sign_type: _signType, ...params } = form;
      if (
        !params.pid?.startsWith("hb_balance_platform_") ||
        sign !== (await epaySignature(params, SECRET))
      )
        return json({ error_msg: "签名验证失败", data: null }, 401);
      const existing = orders.get(params.out_trade_no ?? "");
      if (existing && existing.money !== params.money)
        return json(
          { error_msg: "同一业务订单号的订单信息不一致", data: null },
          409,
        );
      if (existing?.status === 1)
        return json({ error_msg: "订单状态不允许支付", data: null }, 400);
      const order = existing ?? {
        pid: params.pid,
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
          Location: `https://credit.linux.do/paying?order_no=${encodeURIComponent(`sealed-${order.tradeNo}`)}`,
        },
      });
    }
    if (url.pathname === "/epay/api.php") {
      calls.queries += 1;
      if (
        !url.searchParams.get("pid")?.startsWith("hb_balance_platform_") ||
        url.searchParams.get("key") !== SECRET
      )
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
    calls,
    pay(businessNo: string) {
      const order = orders.get(businessNo);
      if (!order) throw new Error("No such order");
      order.status = 1;
    },
    dispute(businessNo: string) {
      const order = orders.get(businessNo);
      if (order) order.status = 0;
    },
    refuseSubmit(response: () => Response) {
      submitOverride = response;
    },
  };
}

/** An admin, the platform app (key checked), and 转入 open to `tester`. */
async function openForTester(
  options: { feePercent?: number; credit?: ReturnType<typeof fakeCredit> } = {},
) {
  const admin = await actor("admin");
  admins = [admin.externalId];
  const tester = await actor("tester");
  const credit = options.credit ?? fakeCredit();
  const saved = await call("PUT", "/admin/balance/platform-app", admin, {
    requestId: crypto.randomUUID(),
    label: "🐟额",
    clientId: CLIENT_ID,
    secret: SECRET,
  });
  expect(saved.status).toBe(200);
  const settings = await call("GET", "/admin/balance/settings", admin);
  const version = (settings.json as { settings: { version: number } }).settings
    .version;
  const patched = await call("PATCH", "/admin/balance/settings", admin, {
    expectedVersion: version,
    topupEnabled: true,
    withdrawEnabled: false,
    topupFeePercent: options.feePercent ?? 12,
    withdrawFeePercent: 12,
    withdrawMaxMinor: 100_000,
    allowlistEnabled: true,
    allowlist: [tester.externalId],
  });
  expect(patched.status).toBe(200);
  return {
    admin,
    tester,
    credit,
    settingsVersion: (patched.json as { settings: { version: number } })
      .settings.version,
  };
}

type TopupJson = {
  topup: {
    id: string;
    businessNo: string;
    status: string;
    flag: string | null;
    debitMinor: number;
    feeMinor: number;
    creditMinor: number;
  };
  cashierUrl: string | null;
};

beforeEach(() => {
  CLIENT_ID = `hb_balance_platform_${crypto.randomUUID().slice(0, 8)}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  admins = [];
  // One platform app at a time: retire this test's before the next.
  await env.DB.prepare(
    "UPDATE merchants SET usage_status='legacy' WHERE kind='platform'",
  ).run();
});

describe("EPay signature", () => {
  it("signs the non-empty fields in name order, the key appended, as MD5", async () => {
    expect(
      await epaySignature(
        {
          pid: "1001",
          type: "epay",
          out_trade_no: "hb.lafi.sh_in_0123456789abcdef0123456789abcdef",
          return_url: "https://hb.example.com/balance/x",
          name: "站内🐟额转入 · hb.lafi.sh",
          money: "1.00",
          notify_url: "",
        },
        "secret-key",
      ),
    ).toBe("bedf9471f5d6968417b0b9fb9d7b5c1f");
  });
});

describe("站内🐟额 settings and the platform app", () => {
  it("starts closed, changes by version, and only an admin changes it", async () => {
    const admin = await actor("admin");
    admins = [admin.externalId];
    const member = await actor("member");
    const read = await call("GET", "/admin/balance/settings", admin);
    expect(read.status).toBe(200);
    const { settings } = read.json as {
      settings: {
        version: number;
        topupEnabled: boolean;
        allowlistEnabled: boolean;
      };
    };
    expect(settings).toMatchObject({
      topupEnabled: false,
      allowlistEnabled: true,
    });
    expect((await call("GET", "/admin/balance/settings", member)).status).toBe(
      403,
    );
    const next = {
      expectedVersion: settings.version,
      topupEnabled: true,
      withdrawEnabled: false,
      topupFeePercent: 10,
      withdrawFeePercent: 12,
      withdrawMaxMinor: 100_000,
      allowlistEnabled: true,
      allowlist: [member.externalId, member.externalId],
    };
    expect(
      (await call("PATCH", "/admin/balance/settings", member, next)).status,
    ).toBe(403);
    const saved = await call("PATCH", "/admin/balance/settings", admin, next);
    expect(saved.status).toBe(200);
    expect(
      (saved.json as { settings: { allowlist: string[] } }).settings.allowlist,
    ).toEqual([member.externalId]);
    // Someone else changed it in between: the old version is turned down.
    const stale = await call("PATCH", "/admin/balance/settings", admin, next);
    expect(stale.status).toBe(409);
    expect((stale.json as { error: { code: string } }).error.code).toBe(
      "BALANCE_SETTINGS_CONFLICT",
    );
    const changes = await call("GET", "/admin/balance/settings", admin);
    expect(
      (changes.json as { recentChanges: { nextVersion: number }[] })
        .recentChanges[0]?.nextVersion,
    ).toBe(settings.version + 1);
  });

  it("keeps the platform app out of the admin's own merchants, and checks its key", async () => {
    const admin = await actor("admin");
    admins = [admin.externalId];
    fakeCredit();
    const created = await call("PUT", "/admin/balance/platform-app", admin, {
      requestId: crypto.randomUUID(),
      label: "🐟额",
      clientId: CLIENT_ID,
      secret: SECRET,
    });
    expect(created.status).toBe(200);
    const read = await call("GET", "/admin/balance/settings", admin);
    expect(
      (
        read.json as {
          platformApp: { credentialVerification: { status: string } };
        }
      ).platformApp.credentialVerification.status,
    ).toBe("passed");
    const own = await call("GET", "/me/merchants", admin);
    expect(own.json as { items: unknown[]; canCreate: boolean }).toMatchObject({
      items: [],
      canCreate: true,
    });
    // A new key is a new credential version; a new Client ID needs its key.
    const app1 = (created.json as { platformApp: { version: number } })
      .platformApp;
    const rekeyed = await call("PUT", "/admin/balance/platform-app", admin, {
      requestId: crypto.randomUUID(),
      version: app1.version,
      label: "🐟额 平台",
      clientId: CLIENT_ID,
      secret: `${SECRET}-2`,
    });
    expect(rekeyed.json).toMatchObject({
      platformApp: {
        label: "🐟额 平台",
        credentialVersion: 2,
        version: app1.version + 1,
      },
    });
    expect(
      (
        await call("PUT", "/admin/balance/platform-app", admin, {
          requestId: crypto.randomUUID(),
          version: app1.version + 1,
          label: "🐟额 平台",
          clientId: `${CLIENT_ID}_next`,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", "/admin/balance/platform-app", admin, {
          requestId: crypto.randomUUID(),
          version: app1.version,
          label: "stale",
          clientId: CLIENT_ID,
        })
      ).status,
    ).toBe(409);
    // A second one cannot be made beside it.
    const second = await call("PUT", "/admin/balance/platform-app", admin, {
      requestId: crypto.randomUUID(),
      label: "again",
      clientId: "another_platform",
      secret: SECRET,
    });
    expect(second.status).toBe(409);
  });
});

describe("转入", () => {
  it("is hidden from people off the allowlist", async () => {
    const { admin } = await openForTester();
    const outsider = await actor("outsider");
    expect((await call("GET", "/me/balance", outsider)).status).toBe(404);
    const session = await call("GET", "/session", outsider);
    expect((session.json as { balance: boolean }).balance).toBe(false);
    expect((await call("GET", "/session", admin)).json).toMatchObject({
      balance: false,
    });
  });

  it("goes to Credit's cashier, and arrives once when Credit says paid", async () => {
    const { tester, credit, settingsVersion } = await openForTester();
    expect((await call("GET", "/session", tester)).json).toMatchObject({
      balance: true,
    });
    const started = await call("POST", "/me/balance/topups", tester, {
      requestId: crypto.randomUUID(),
      settingsVersion,
      by: "credit",
      amount: "100",
    });
    expect(started.status).toBe(200);
    const { topup, cashierUrl } = started.json as TopupJson;
    expect(topup).toMatchObject({
      status: "pending",
      debitMinor: 11_364,
      feeMinor: 1364,
      creditMinor: 10_000,
    });
    expect(topup.businessNo).toMatch(/^hb\.lafi\.sh_in_[0-9a-f]{32}$/);
    expect(cashierUrl).toMatch(
      /^https:\/\/credit\.linux\.do\/paying\?order_no=/,
    );
    const order = credit.orders.get(topup.businessNo);
    expect(order).toMatchObject({
      money: "113.64",
      name: "站内🐟额转入 · hb.lafi.sh",
      returnUrl: `${origin}/balance/${topup.id}`,
    });

    // Not paid yet: still waiting, nothing in 🐟额.
    expect(
      (
        (await call("POST", `/me/balance/topups/${topup.id}/check`, tester))
          .json as TopupJson
      ).topup.status,
    ).toBe("pending");
    credit.pay(topup.businessNo);
    // Within 3 s of the last check, Credit is not asked again.
    const soon = await call(
      "POST",
      `/me/balance/topups/${topup.id}/check`,
      tester,
    );
    expect((soon.json as TopupJson).topup.status).toBe("pending");
    await env.DB.prepare(
      "UPDATE balance_topups SET check_claimed_at=0 WHERE id=?",
    )
      .bind(topup.id)
      .run();
    const checked = await call(
      "POST",
      `/me/balance/topups/${topup.id}/check`,
      tester,
    );
    expect((checked.json as TopupJson).topup.status).toBe("credited");
    // The page's own check, and the admin's, add nothing more.
    await env.DB.prepare(
      "UPDATE balance_topups SET check_claimed_at=0 WHERE id=?",
    )
      .bind(topup.id)
      .run();
    await call("POST", "/me/balance/topups/check-open", tester);
    const page = await call("GET", "/me/balance", tester);
    expect(page.json).toMatchObject({
      account: { availableMinor: 10_000, lockedMinor: 0 },
      openTopups: 0,
      items: [{ type: "topup", topup: { id: topup.id, status: "credited" } }],
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM balance_entries WHERE topup_id=?",
      )
        .bind(topup.id)
        .first("count"),
    ).toBe(1);
  });

  it("answers the same request with the same 转入, and goes back to the same order", async () => {
    const { tester, credit, settingsVersion } = await openForTester();
    const body = {
      requestId: crypto.randomUUID(),
      settingsVersion,
      by: "debit",
      amount: "100",
    };
    const first = (await call("POST", "/me/balance/topups", tester, body))
      .json as TopupJson;
    const again = (await call("POST", "/me/balance/topups", tester, body))
      .json as TopupJson;
    expect(again.topup.id).toBe(first.topup.id);
    expect(first.topup).toMatchObject({
      debitMinor: 10_000,
      creditMinor: 8800,
    });
    const paid = await call(
      "POST",
      `/me/balance/topups/${first.topup.id}/pay`,
      tester,
    );
    expect((paid.json as TopupJson).cashierUrl).toBe(first.cashierUrl);
    expect(credit.orders.size).toBe(1);
    expect(
      (
        await call("POST", "/me/balance/topups", tester, {
          ...body,
          amount: "101",
        })
      ).status,
    ).toBe(409);
  });

  it("refuses what it should: paused, a changed rate, out of range, the owner, too often", async () => {
    const { admin, tester, settingsVersion } = await openForTester();
    const start = (who: Actor, amount = "10", version = settingsVersion) =>
      call("POST", "/me/balance/topups", who, {
        requestId: crypto.randomUUID(),
        settingsVersion: version,
        by: "debit",
        amount,
      });
    expect((await start(tester, "10", settingsVersion - 1)).status).toBe(409);
    expect((await start(tester, "0.99")).status).toBe(400);
    expect((await start(tester, "2000.01")).status).toBe(400);
    // The platform app's owner: Credit will not let them pay themselves.
    await env.DB.prepare(
      "UPDATE balance_settings SET allowlist=json_array(?,?) WHERE id='global'",
    )
      .bind(tester.externalId, admin.externalId)
      .run();
    expect((await start(admin)).status).toBe(403);
    await env.DB.prepare(
      `INSERT INTO balance_topups (id,user_id,merchant_id,client_id,credential_version,business_no,debit_minor,fee_minor,credit_minor,fee_percent,settings_version,order_name,return_url,status,request_id,request_digest,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),?,id,client_id,1,'hb.lafi.sh_in_'||lower(hex(randomblob(16))),100,12,88,12,1,'x','x','unpaid',lower(hex(randomblob(16))),'d',?,?
      FROM merchants, (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<30) SELECT i FROM n)
      WHERE kind='platform' AND usage_status='current'`,
    )
      .bind(tester.id, Date.now(), Date.now())
      .run();
    expect((await start(tester)).status).toBe(429);
    await env.DB.prepare(
      "UPDATE balance_settings SET topup_enabled=0 WHERE id='global'",
    ).run();
    const paused = await start(tester);
    expect((paused.json as { error: { message: string } }).error.message).toBe(
      "转入暂停",
    );
  });

  it("checks Credit before calling a turned-down order 未完成", async () => {
    const { tester, credit, settingsVersion } = await openForTester();
    credit.refuseSubmit(
      () =>
        new Response(JSON.stringify({ error_msg: "订单已过期", data: null }), {
          status: 400,
        }),
    );
    const refused = (
      await call("POST", "/me/balance/topups", tester, {
        requestId: crypto.randomUUID(),
        settingsVersion,
        by: "debit",
        amount: "5",
      })
    ).json as TopupJson;
    expect(refused.cashierUrl).toBeNull();
    expect(refused.topup.status).toBe("unpaid");
    expect(credit.calls.queries).toBeGreaterThan(0);

    credit.refuseSubmit(
      () =>
        new Response(
          JSON.stringify({
            error_msg: "同一业务订单号的订单信息不一致",
            data: null,
          }),
          { status: 409 },
        ),
    );
    const conflicted = (
      await call("POST", "/me/balance/topups", tester, {
        requestId: crypto.randomUUID(),
        settingsVersion,
        by: "debit",
        amount: "6",
      })
    ).json as TopupJson;
    expect(conflicted.topup).toMatchObject({
      status: "unpaid",
      flag: "mismatch",
    });
  });

  it("turns 未完成 after its ten minutes, and still arrives if Credit later says paid", async () => {
    const { tester, credit, settingsVersion } = await openForTester();
    const { topup } = (
      await call("POST", "/me/balance/topups", tester, {
        requestId: crypto.randomUUID(),
        settingsVersion,
        by: "debit",
        amount: "20",
      })
    ).json as TopupJson;
    const past = Date.now() - 11 * 60_000;
    await env.DB.prepare(
      "UPDATE balance_topups SET submitted_at=?,check_claimed_at=0 WHERE id=?",
    )
      .bind(past, topup.id)
      .run();
    const late = await call(
      "POST",
      `/me/balance/topups/${topup.id}/check`,
      tester,
    );
    expect((late.json as TopupJson).topup.status).toBe("unpaid");
    expect(
      (await call("POST", `/me/balance/topups/${topup.id}/pay`, tester)).status,
    ).toBe(409);
    credit.pay(topup.businessNo);
    // 重新查询 on a 未完成 one waits 30 s between real checks.
    await env.DB.prepare(
      "UPDATE balance_topups SET check_claimed_at=? WHERE id=?",
    )
      .bind(Date.now() - 31_000, topup.id)
      .run();
    const found = await call(
      "POST",
      `/me/balance/topups/${topup.id}/check`,
      tester,
    );
    expect((found.json as TopupJson).topup.status).toBe("credited");
  });
});

describe("网站管理 · 🐟额", () => {
  it("flags a credited one Credit no longer calls paid, clears it when paid again, and confirms by hand once", async () => {
    const { admin, tester, credit, settingsVersion } = await openForTester();
    const { topup } = (
      await call("POST", "/me/balance/topups", tester, {
        requestId: crypto.randomUUID(),
        settingsVersion,
        by: "debit",
        amount: "30",
      })
    ).json as TopupJson;
    credit.pay(topup.businessNo);
    await env.DB.prepare(
      "UPDATE balance_topups SET check_claimed_at=0 WHERE id=?",
    )
      .bind(topup.id)
      .run();
    await call("POST", `/admin/balance/topups/${topup.id}/check`, admin);
    credit.dispute(topup.businessNo);
    await env.DB.prepare(
      "UPDATE balance_topups SET check_claimed_at=0 WHERE id=?",
    )
      .bind(topup.id)
      .run();
    const disputed = await call(
      "POST",
      `/admin/balance/topups/${topup.id}/check`,
      admin,
    );
    expect((disputed.json as TopupJson).topup).toMatchObject({
      status: "credited",
      flag: "reversed",
    });
    // Never taken back for it: only a flag.
    expect(
      (await call("GET", `/admin/balance/users/${tester.id}`, admin)).json,
    ).toMatchObject({
      account: { availableMinor: 2640 },
    });
    const attention = await call(
      "GET",
      "/admin/balance/topups?view=attention",
      admin,
    );
    expect(
      (attention.json as { items: { topup: { id: string } }[] }).items.map(
        (i) => i.topup.id,
      ),
    ).toContain(topup.id);
    credit.pay(topup.businessNo);
    await env.DB.prepare(
      "UPDATE balance_topups SET check_claimed_at=0 WHERE id=?",
    )
      .bind(topup.id)
      .run();
    const settled = await call(
      "POST",
      `/admin/balance/topups/${topup.id}/check`,
      admin,
    );
    expect((settled.json as TopupJson).topup.flag).toBeNull();

    // A 转入 Credit never calls paid (a dispute refused at once): by hand.
    credit.refuseSubmit(
      () =>
        new Response(JSON.stringify({ error_msg: "订单已过期", data: null }), {
          status: 400,
        }),
    );
    const { topup: stuck } = (
      await call("POST", "/me/balance/topups", tester, {
        requestId: crypto.randomUUID(),
        settingsVersion,
        by: "debit",
        amount: "10",
      })
    ).json as TopupJson;
    expect(
      (
        await call("POST", `/admin/balance/topups/${stuck.id}/confirm`, admin, {
          reason: "",
        })
      ).status,
    ).toBe(400);
    const confirmed = await call(
      "POST",
      `/admin/balance/topups/${stuck.id}/confirm`,
      admin,
      {
        reason: "Credit 后台核对过",
      },
    );
    expect((confirmed.json as TopupJson).topup.status).toBe("credited");
    expect(
      (
        await call("POST", `/admin/balance/topups/${stuck.id}/confirm`, admin, {
          reason: "again",
        })
      ).status,
    ).toBe(409);
    const detail = await call(
      "GET",
      `/admin/balance/topups/${stuck.id}`,
      admin,
    );
    expect(detail.json).toMatchObject({
      creditedByAdmin: { reason: "Credit 后台核对过" },
    });
    expect(
      (await call("GET", `/admin/balance/users/${tester.id}`, admin)).json,
    ).toMatchObject({
      account: { availableMinor: 2640 + 880 },
    });
  });

  it("adjusts with a reason the person sees, below zero only by 扣回, once per request", async () => {
    const admin = await actor("admin");
    admins = [admin.externalId];
    const member = await actor("member");
    const deduct = {
      requestId: crypto.randomUUID(),
      direction: "deduct",
      amount: "3.50",
      reason: "Credit 退款后扣回",
    };
    const first = await call(
      "POST",
      `/admin/balance/users/${member.id}/adjustments`,
      admin,
      deduct,
    );
    expect(first.status).toBe(200);
    expect(
      (
        await call(
          "POST",
          `/admin/balance/users/${member.id}/adjustments`,
          admin,
          deduct,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          "POST",
          `/admin/balance/users/${member.id}/adjustments`,
          admin,
          {
            ...deduct,
            amount: "4",
          },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          "POST",
          `/admin/balance/users/${admin.id}/adjustments`,
          admin,
          {
            ...deduct,
            requestId: crypto.randomUUID(),
          },
        )
      ).status,
    ).toBe(403);
    const balance = await call(
      "GET",
      `/admin/balance/users/${member.id}`,
      admin,
    );
    expect(balance.json).toMatchObject({
      account: { availableMinor: -350, lockedMinor: 0 },
      items: [
        {
          type: "adjustment",
          adjustment: {
            direction: "deduct",
            amountMinor: 350,
            reason: "Credit 退款后扣回",
          },
        },
      ],
    });
    const overview = await call("GET", "/admin/balance/overview", admin);
    expect(overview.json).toMatchObject({
      negative: { count: expect.any(Number) },
    });
    expect(
      (overview.json as { negative: { count: number } }).negative.count,
    ).toBeGreaterThan(0);
  });

  it("keeps entries and 转入 as the database says: append-only, final, never below 0 but by 扣回", async () => {
    const member = await actor("member");
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO balance_adjustments (id,user_id,direction,amount_minor,reason,actor_user_id,request_id,request_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "adj-db-1",
        member.id,
        "add",
        100,
        "seed",
        "admin",
        crypto.randomUUID(),
        "d",
        now,
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,adjustment_id,created_at) VALUES ('entry-db-1',?,'adjustment',100,0,'adj-db-1',?)",
    )
      .bind(member.id, now)
      .run();
    await expect(
      env.DB.prepare(
        "UPDATE balance_entries SET available_delta_minor=1 WHERE id='entry-db-1'",
      ).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("DELETE FROM balance_entries WHERE id='entry-db-1'").run(),
    ).rejects.toThrow(/append-only/);
    // A lock larger than 可用 would take it below 0: refused.
    await expect(
      env.DB.prepare(
        "INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,created_at) VALUES ('entry-db-2',?,'lock',-200,200,'lock-x',?)",
      )
        .bind(member.id, now)
        .run(),
    ).rejects.toThrow(/BALANCE_INSUFFICIENT/);
    expect(
      await env.DB.prepare(
        "SELECT available_minor FROM balance_accounts WHERE user_id=?",
      )
        .bind(member.id)
        .first("available_minor"),
    ).toBe(100);
  });
});
