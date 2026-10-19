// 站内🐟额, step two: 转出 through the payment queue against a fake Credit,
// and what the database refuses about locks and endings.
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { settleEndedWithdrawals } from "../src/balance/withdrawal-settlement";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { runMerchantCycle } from "../src/payments/scheduler";
import { sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
// The Client ID registry is permanent: each test's platform app has its own.
let CLIENT_ID = "hb_withdraw_platform_0";
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
    770_000 + counter * 7 + Math.floor(Math.random() * 7),
  );
  const username = `${name}${counter}`;
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB).insert(users).values({
    id,
    externalId,
    username,
    displayName: name,
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

async function call(method: string, path: string, who?: Actor, body?: unknown) {
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
  return { status: response.status, json: (await response.json()) as never };
}

type Distribute = "ok" | "recipient" | "quota" | "timeout";

/** Credit's distribute and order query, the platform app's key checked. */
function fakeCredit() {
  type Order = { outTradeNo: string; money: string; tradeNo: string };
  const orders = new Map<string, Order>();
  const sent: Record<string, unknown>[] = [];
  let next: Distribute = "ok";
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
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      if (auth !== `Basic ${btoa(`${CLIENT_ID}:${SECRET}`)}`)
        return json({ error_msg: "认证失败", data: null }, 401);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      if (next === "timeout") throw new Error("timeout");
      if (next === "recipient")
        return json({ error_msg: "收款人不存在", data: null }, 400);
      if (next === "quota")
        return json({ error_msg: "已超过每日限额", data: null }, 400);
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
      if (
        url.searchParams.get("pid") !== CLIENT_ID ||
        url.searchParams.get("key") !== SECRET
      )
        return json({ code: -1, msg: "商户信息不存在" }, 400);
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
    orders,
    sent,
    next(kind: Distribute) {
      next = kind;
    },
  };
}

/** An admin, the platform app, 转出 open to `tester`, who has 50 🐟. */
async function openWithdrawals(
  options: {
    withdrawEnabled?: boolean;
    maxMinor?: number;
    /** The admin (the platform app's owner) on the allowlist too. */
    ownerListed?: boolean;
  } = {},
) {
  const admin = await actor("admin");
  admins = [admin.externalId];
  const tester = await actor("tester");
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
    withdrawMaxMinor: options.maxMinor ?? 100_000,
    allowlistEnabled: true,
    allowlist: [
      tester.externalId,
      ...(options.ownerListed ? [admin.externalId] : []),
    ],
  });
  expect(patched.status).toBe(200);
  const added = await call(
    "POST",
    `/admin/balance/users/${tester.id}/adjustments`,
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
    tester,
    credit,
    platformId: read.platformApp.id,
    settingsVersion: (patched.json as { settings: { version: number } })
      .settings.version,
  };
}

type WithdrawalJson = {
  withdrawal: {
    id: string;
    businessNo: string;
    status: string;
    debitMinor: number;
    feeMinor: number;
    creditMinor: number;
    recipientUsername: string;
    failure: string | null;
    wait: string | null;
    resumeAt: number | null;
  };
};

async function account(userId: string) {
  return env.DB.prepare(
    "SELECT available_minor AS available,locked_minor AS locked FROM balance_accounts WHERE user_id=?",
  )
    .bind(userId)
    .first<{ available: number; locked: number }>();
}

async function task(withdrawalId: string) {
  return env.DB.prepare(
    "SELECT id,status,reason,send_block_reason,unknown_outcome,merchant_id FROM payment_tasks WHERE withdrawal_id=?",
  )
    .bind(withdrawalId)
    .first<{
      id: string;
      status: string;
      reason: string | null;
      send_block_reason: string | null;
      unknown_outcome: number;
      merchant_id: string;
    }>();
}

/** The platform app's payment cycle, its next step due now. */
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

beforeEach(async () => {
  CLIENT_ID = `hb_withdraw_platform_${crypto.randomUUID().slice(0, 8)}`;
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

describe("转出", () => {
  it("locks its 🐟, queues the payment, and takes them once Credit confirms it", async () => {
    const { tester, credit, platformId, settingsVersion } =
      await openWithdrawals();
    const asked = await call("POST", "/me/balance/withdrawals", tester, {
      requestId: crypto.randomUUID(),
      settingsVersion,
      by: "debit",
      amount: "10.00",
    });
    expect(asked.status).toBe(200);
    const { withdrawal } = asked.json as WithdrawalJson;
    expect(withdrawal).toMatchObject({
      status: "sending",
      debitMinor: 1000,
      feeMinor: 120,
      creditMinor: 880,
      recipientUsername: tester.username,
      wait: "queued",
    });
    expect(withdrawal.businessNo).toMatch(/^hb\.lafi\.sh_out_[0-9a-f]{32}$/);
    expect(await account(tester.id)).toEqual({ available: 4000, locked: 1000 });
    expect(await task(withdrawal.id)).toMatchObject({ status: "pending" });

    // Sent: the whole amount, to the person, with its own remark.
    await cycle(platformId);
    expect(credit.sent).toEqual([
      expect.objectContaining({
        amount: "10.00",
        out_trade_no: withdrawal.businessNo,
        username: tester.username,
        remark: "hb.lafi.sh 站内🐟额转出",
      }),
    ]);
    expect((await task(withdrawal.id))?.status).toBe("reconciling");
    const checking = await call(
      "GET",
      `/me/balance/withdrawals/${withdrawal.id}`,
      tester,
    );
    expect((checking.json as WithdrawalJson).withdrawal).toMatchObject({
      status: "sending",
      wait: "checking",
    });

    // Confirmed at Credit: 已发放, and the locked 🐟 are gone.
    await cycle(platformId);
    expect((await task(withdrawal.id))?.status).toBe("confirmed");
    expect(await account(tester.id)).toEqual({ available: 4000, locked: 0 });
    const done = await call(
      "GET",
      `/me/balance/withdrawals/${withdrawal.id}`,
      tester,
    );
    expect((done.json as WithdrawalJson).withdrawal).toMatchObject({
      status: "sent",
      wait: null,
    });
    const lock = await env.DB.prepare(
      "SELECT status,remaining_minor FROM balance_locks WHERE withdrawal_id=?",
    )
      .bind(withdrawal.id)
      .first();
    expect(lock).toEqual({ status: "spent", remaining_minor: 0 });
    const records = await call("GET", "/me/balance?filter=withdrawal", tester);
    expect(
      (records.json as { items: { type: string }[] }).items.map(
        (item) => item.type,
      ),
    ).toEqual(["withdrawal"]);
  });

  it("is 未发出 when Credit has no such account, and its 🐟 come back", async () => {
    const { tester, credit, platformId, settingsVersion } =
      await openWithdrawals();
    credit.next("recipient");
    const asked = await call("POST", "/me/balance/withdrawals", tester, {
      requestId: crypto.randomUUID(),
      settingsVersion,
      by: "credit",
      amount: "8.80",
    });
    const { withdrawal } = asked.json as WithdrawalJson;
    expect(withdrawal.debitMinor).toBe(1000);
    await cycle(platformId);
    expect(await task(withdrawal.id)).toMatchObject({
      status: "failed",
      send_block_reason: "recipient",
      unknown_outcome: 0,
    });
    expect(await account(tester.id)).toEqual({ available: 5000, locked: 0 });
    const read = await call(
      "GET",
      `/me/balance/withdrawals/${withdrawal.id}`,
      tester,
    );
    expect((read.json as WithdrawalJson).withdrawal).toMatchObject({
      status: "failed",
      failure: "recipient",
      wait: null,
    });
    // Nothing held up behind it.
    const merchant = await env.DB.prepare(
      "SELECT active_task_id FROM merchants WHERE id=?",
    )
      .bind(platformId)
      .first();
    expect(merchant).toEqual({ active_task_id: null });

    // Asked again later (say, after a first visit to Credit): it goes.
    credit.next("ok");
    const again = await call("POST", "/me/balance/withdrawals", tester, {
      requestId: crypto.randomUUID(),
      settingsVersion,
      by: "debit",
      amount: "10.00",
    });
    const second = (again.json as WithdrawalJson).withdrawal;
    await cycle(platformId);
    await cycle(platformId);
    expect((await task(second.id))?.status).toBe("confirmed");
    expect(await account(tester.id)).toEqual({ available: 4000, locked: 0 });
  });

  it("waits out Credit's daily limit 发放中, saying when it goes on", async () => {
    const { tester, credit, platformId, settingsVersion } =
      await openWithdrawals();
    credit.next("quota");
    const asked = await call("POST", "/me/balance/withdrawals", tester, {
      requestId: crypto.randomUUID(),
      settingsVersion,
      by: "debit",
      amount: "10.00",
    });
    const { withdrawal } = asked.json as WithdrawalJson;
    await cycle(platformId);
    expect(await task(withdrawal.id)).toMatchObject({
      status: "waiting",
      reason: "quota",
    });
    const read = await call(
      "GET",
      `/me/balance/withdrawals/${withdrawal.id}`,
      tester,
    );
    const view = (read.json as WithdrawalJson).withdrawal;
    expect(view).toMatchObject({ status: "sending", wait: "quota" });
    expect(view.resumeAt).toBeGreaterThan(Date.now());
    expect(await account(tester.id)).toEqual({ available: 4000, locked: 1000 });
  });

  it("keeps an unclear send 发放中 and never sends it twice", async () => {
    const { tester, credit, platformId, settingsVersion } =
      await openWithdrawals();
    credit.next("timeout");
    const asked = await call("POST", "/me/balance/withdrawals", tester, {
      requestId: crypto.randomUUID(),
      settingsVersion,
      by: "debit",
      amount: "10.00",
    });
    const { withdrawal } = asked.json as WithdrawalJson;
    await cycle(platformId);
    expect(await task(withdrawal.id)).toMatchObject({
      status: "reconciling",
      unknown_outcome: 1,
    });
    // Credit has no order: still not sent again until the query says so.
    credit.next("ok");
    await cycle(platformId);
    expect(credit.sent).toHaveLength(1);
    expect(await account(tester.id)).toEqual({ available: 4000, locked: 1000 });
  });

  it("refuses what it cannot do, and takes the same request once", async () => {
    const { admin, tester, settingsVersion } = await openWithdrawals({
      maxMinor: 2000,
      ownerListed: true,
    });
    const ask = (who: Actor, amount: string, extra: object = {}) =>
      call("POST", "/me/balance/withdrawals", who, {
        requestId: crypto.randomUUID(),
        settingsVersion,
        by: "debit",
        amount,
        ...extra,
      });
    const code = (result: { json: never }) =>
      (result.json as { error: { code: string } }).error.code;
    expect(code(await ask(tester, "0.99"))).toBe("BALANCE_WITHDRAW_RANGE");
    expect(code(await ask(tester, "20.01"))).toBe("BALANCE_WITHDRAW_RANGE");
    expect(
      code(
        await ask(tester, "10.00", { settingsVersion: settingsVersion - 1 }),
      ),
    ).toBe("BALANCE_SETTINGS_CHANGED");
    // 可用 covers it, or nothing is made.
    await ask(tester, "20.00");
    await ask(tester, "20.00");
    const short = await ask(tester, "20.00");
    expect(short.status).toBe(409);
    expect(code(short)).toBe("BALANCE_INSUFFICIENT");
    expect(await account(tester.id)).toEqual({ available: 1000, locked: 4000 });
    // The platform app's owner: Credit cannot pay itself.
    expect(code(await ask(admin, "1.00"))).toBe("BALANCE_SELF");
    // Not on the allowlist.
    const stranger = await actor("stranger");
    expect(code(await ask(stranger, "1.00"))).toBe("BALANCE_NOT_OPEN");
    // The same request twice is one 转出; with other numbers it is refused.
    const requestId = crypto.randomUUID();
    const once = await ask(tester, "5.00", { requestId });
    const twice = await ask(tester, "5.00", { requestId });
    expect((twice.json as WithdrawalJson).withdrawal.id).toBe(
      (once.json as WithdrawalJson).withdrawal.id,
    );
    expect(code(await ask(tester, "4.00", { requestId }))).toBe(
      "WITHDRAWAL_REQUEST_REUSED",
    );
  });

  it("is refused while 转出 is off, and the platform app keeps its Client ID while one is 发放中", async () => {
    const { admin, tester, settingsVersion } = await openWithdrawals({
      withdrawEnabled: false,
    });
    const paused = await call("POST", "/me/balance/withdrawals", tester, {
      requestId: crypto.randomUUID(),
      settingsVersion,
      by: "debit",
      amount: "1.00",
    });
    expect((paused.json as { error: { code: string } }).error.code).toBe(
      "BALANCE_WITHDRAW_PAUSED",
    );
    const read = (await call("GET", "/admin/balance/settings", admin)).json as {
      settings: { version: number };
      platformApp: { version: number };
    };
    const opened = await call("PATCH", "/admin/balance/settings", admin, {
      expectedVersion: read.settings.version,
      topupEnabled: false,
      withdrawEnabled: true,
      topupFeePercent: 12,
      withdrawFeePercent: 12,
      withdrawMaxMinor: 100_000,
      allowlistEnabled: true,
      allowlist: [tester.externalId],
    });
    const version = (opened.json as { settings: { version: number } }).settings
      .version;
    expect(
      (
        await call("POST", "/me/balance/withdrawals", tester, {
          requestId: crypto.randomUUID(),
          settingsVersion: version,
          by: "debit",
          amount: "1.00",
        })
      ).status,
    ).toBe(200);
    const moved = await call("PUT", "/admin/balance/platform-app", admin, {
      requestId: crypto.randomUUID(),
      version: read.platformApp.version,
      label: "🐟额",
      clientId: `${CLIENT_ID}_next`,
      secret: SECRET,
    });
    expect(moved.status).toBe(409);
    expect((moved.json as { error: { code: string } }).error.code).toBe(
      "PLATFORM_APP_BUSY",
    );
  });

  it("is ended by the sweep if its payment ended without it", async () => {
    const { tester, platformId, settingsVersion } = await openWithdrawals();
    const asked = await call("POST", "/me/balance/withdrawals", tester, {
      requestId: crypto.randomUUID(),
      settingsVersion,
      by: "debit",
      amount: "10.00",
    });
    const { withdrawal } = asked.json as WithdrawalJson;
    // A payment confirmed some other way than the cycle (never expected).
    await env.DB.prepare(
      "UPDATE payment_tasks SET status='confirmed',confirmed_at=?,first_send_at=? WHERE withdrawal_id=?",
    )
      .bind(Date.now(), Date.now(), withdrawal.id)
      .run();
    expect(await settleEndedWithdrawals(env)).toBe(1);
    expect(await account(tester.id)).toEqual({ available: 4000, locked: 0 });
    expect(await settleEndedWithdrawals(env)).toBe(0);
    expect(platformId).toBeTruthy();
  });
});

describe("网站管理 · 🐟额", () => {
  it("shows a held 转出 under 待处理, in the overview, and in 概览's cards", async () => {
    const { admin, tester, credit, platformId, settingsVersion } =
      await openWithdrawals();
    type Overview = {
      heldMinor: number;
      sending: { count: number; minor: number };
      attention: { withdrawals: number };
      mismatches: number;
    };
    const read = async () =>
      (await call("GET", "/admin/balance/overview", admin)).json as Overview;
    const before = await read();
    credit.next("quota");
    const asked = await call("POST", "/me/balance/withdrawals", tester, {
      requestId: crypto.randomUUID(),
      settingsVersion,
      by: "debit",
      amount: "10.00",
    });
    const { withdrawal } = asked.json as WithdrawalJson;
    await cycle(platformId);
    // Still held for everyone: 代存合计 does not move; 转出中 does.
    expect(await read()).toEqual({
      ...before,
      sending: {
        count: before.sending.count + 1,
        minor: before.sending.minor + 1000,
      },
      attention: {
        ...before.attention,
        withdrawals: before.attention.withdrawals + 1,
      },
      mismatches: 0,
    });
    const attention = await call("GET", "/admin/balance/attention", admin);
    expect(
      (attention.json as { items: { type: string; id: string }[] }).items,
    ).toContainEqual(
      expect.objectContaining({ type: "withdrawal", id: withdrawal.id }),
    );
    const detail = await call(
      "GET",
      `/admin/balance/withdrawals/${withdrawal.id}`,
      admin,
    );
    expect(detail.json).toMatchObject({
      withdrawal: { status: "sending", wait: "quota" },
      user: { id: tester.id },
      payment: { status: "waiting", reason: "quota" },
      recipientId: tester.externalId,
      attempts: [{ operation: "send", outcome: "rejected", reason: "quota" }],
    });
    const site = await call("GET", "/admin/overview", admin);
    expect(
      (site.json as { warnings: { balanceWithdrawals: number } }).warnings
        .balanceWithdrawals,
    ).toBe(before.attention.withdrawals + 1);
    // Members see none of it.
    expect(
      (await call("GET", "/admin/balance/attention", tester)).status,
    ).toBe(403);
  });
});

describe("what the database refuses", () => {
  it("ends a 转出 only as its payment does, and a lock only winds down", async () => {
    const { tester, settingsVersion } = await openWithdrawals();
    const asked = await call("POST", "/me/balance/withdrawals", tester, {
      requestId: crypto.randomUUID(),
      settingsVersion,
      by: "debit",
      amount: "10.00",
    });
    const { withdrawal } = asked.json as WithdrawalJson;
    const now = Date.now();
    await expect(
      env.DB.prepare(
        "UPDATE balance_withdrawals SET status='sent',sent_at=? WHERE id=?",
      )
        .bind(now, withdrawal.id)
        .run(),
    ).rejects.toThrow(/ends only as its payment does/);
    await expect(
      env.DB.prepare("UPDATE balance_withdrawals SET debit_minor=1 WHERE id=?")
        .bind(withdrawal.id)
        .run(),
    ).rejects.toThrow();
    const lock = await env.DB.prepare(
      "SELECT id FROM balance_locks WHERE withdrawal_id=?",
    )
      .bind(withdrawal.id)
      .first<{ id: string }>();
    // Given back for less than it holds: refused.
    await expect(
      env.DB.prepare(
        "INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,created_at) VALUES (?,?,'unlock',1,-1,?,?)",
      )
        .bind(crypto.randomUUID(), tester.id, lock?.id, now)
        .run(),
    ).rejects.toThrow(/lock entry mismatch/);
    await expect(
      env.DB.prepare(
        "UPDATE balance_locks SET remaining_minor=remaining_minor+1 WHERE id=?",
      )
        .bind(lock?.id)
        .run(),
    ).rejects.toThrow();
    // 未发出 only for a refusal with no order: an unclear one is not.
    await expect(
      env.DB.prepare(
        "UPDATE payment_tasks SET status='failed',unknown_outcome=1,send_block_reason='recipient' WHERE withdrawal_id=?",
      )
        .bind(withdrawal.id)
        .run(),
    ).rejects.toThrow(/cannot be cleared/);
    await expect(
      env.DB.prepare("DELETE FROM balance_withdrawals WHERE id=?")
        .bind(withdrawal.id)
        .run(),
    ).rejects.toThrow();
  });
});

describe("migration 0030", () => {
  it("rebuilds payment_tasks with every trigger that reads it still there", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND (tbl_name='payment_tasks' OR sql LIKE '%payment_tasks%') ORDER BY name",
    ).all<{ name: string }>();
    expect(rows.results.map((row) => row.name)).toEqual([
      "balance_withdrawals_status_final",
      "payment_claim_policy_immutable",
      "payment_claim_policy_insert",
      "payment_duplicate_probes_insert_guard",
      "payment_identity_corrections_insert_guard",
      "payment_identity_corrections_invalidate",
      "payment_retry_grants_insert_guard",
      "payment_tasks_immutable_identity",
      "payment_tasks_insert_consistency",
      "payment_tasks_no_replace",
      "payment_tasks_real_evidence_sticky",
      "payment_username_corrections_insert_guard",
      "payment_username_corrections_resume",
    ]);
    const broken = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(broken.results).toEqual([]);
  });
});
