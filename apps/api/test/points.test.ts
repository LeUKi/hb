import { env } from "cloudflare:test";
import {
  type ActivityInput,
  type ClaimDetail,
  emptyActivityInput,
  type LdcMoney,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import {
  createActivity,
  getManagedActivity,
  openActivity,
} from "../src/activities/service";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { removeKey, saveKey } from "../src/points/keys";
import {
  resendPointsPayment,
  runPointsPayment,
  sweepPointsPayments,
} from "../src/points/payments";
import { runSelfTest } from "../src/points/self-test";
import {
  createSystem,
  pauseSystem,
  reviewSystem,
  submitSystem,
} from "../src/points/systems";
import { sha256Hex } from "../src/security/crypto";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import {
  check,
  actor as codeActor,
  coded,
  plus as codePlus,
  judgeSettings,
} from "./code-fixtures";

// 三方积分 (docs/third-party-points-design.md): an issuer's points paid per
// claim through its three endpoints, with no queued waits.

const origin = "https://hb.example.com";
const bindings: ApiBindings = { ...env, APP_ORIGIN: origin };
type Actor = { id: string; externalId: string; username: string };

async function actor(): Promise<Actor> {
  const id = crypto.randomUUID();
  const externalId = String(800_000 + Math.floor(Math.random() * 1_000_000));
  const username = `p_${id.slice(0, 8)}`;
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId,
    username,
    displayName: username,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${crypto.randomUUID()}`),
    userId: id,
    csrfToken: crypto.randomUUID(),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(Date.now() + 3600000),
  });
  return { id, externalId, username };
}

/** A stand-in issuer keeping to protocol 1 (§3). */
class Issuer {
  step = 100;
  down = false;
  keys = new Map<string, string>();
  accounts = new Map<string, { username: string; available: number }>();
  orders = new Map<string, { tradeNo: string; amount: number; to: string }>();
  calls: string[] = [];
  open(id: string, username: string, available: number, key?: string) {
    this.accounts.set(id, { username, available });
    if (key) this.keys.set(key, id);
  }
  answer(path: string, key: string, body: Record<string, unknown>) {
    const owner = this.keys.get(key);
    if (!owner) return { result: "key_invalid" };
    const account = this.accounts.get(owner);
    if (!account) return { result: "key_invalid" };
    if (path === "balance")
      return {
        result: "ok",
        account: { id: Number(owner), username: account.username },
        available: String(account.available),
      };
    const no = String(body.out_trade_no);
    if (path === "query") {
      const order = this.orders.get(no);
      return order
        ? {
            result: "ok",
            trade_no: order.tradeNo,
            amount: String(order.amount),
            to: { id: Number(order.to) },
          }
        : { result: "not_found" };
    }
    const amount = Number(body.amount);
    const to = String((body.to as { id: number }).id);
    const existing = this.orders.get(no);
    if (existing)
      return existing.amount === amount && existing.to === to
        ? {
            result: "ok",
            trade_no: existing.tradeNo,
            amount: String(amount),
            to: { id: Number(to) },
          }
        : { result: "conflict" };
    if (!Number.isSafeInteger(amount) || amount % this.step !== 0)
      return { result: "bad_request" };
    const recipient = this.accounts.get(to);
    if (!recipient) return { result: "no_recipient" };
    if (account.available < amount) return { result: "insufficient" };
    account.available -= amount;
    recipient.available += amount;
    const tradeNo = `S${this.orders.size + 1}`;
    this.orders.set(no, { tradeNo, amount, to });
    return {
      result: "ok",
      trade_no: tradeNo,
      amount: String(amount),
      to: { id: Number(to) },
    };
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.split("/").at(-1) ?? "";
    this.calls.push(path);
    if (this.down) throw new TypeError("network down");
    const key = (request.headers.get("Authorization") ?? "").replace(
      "Bearer ",
      "",
    );
    const body = (await request.json()) as Record<string, unknown>;
    return Response.json(this.answer(path, key, body));
  };
}

let issuer: Issuer;
let owner: Actor;
let admin: Actor;
let sender: Actor;
let systemId: string;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  issuer = new Issuer();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.startsWith("https://stars.test/")) return issuer.fetch(input, init);
    return realFetch(input, init);
  }) as typeof fetch;
  vi.spyOn(env.PAYMENT_QUEUE, "send").mockResolvedValue({
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  } as never);
  owner = await actor();
  admin = await actor();
  sender = await actor();
  await env.DB.prepare(
    "INSERT INTO balance_members (user_id,created_at) VALUES (?,?)",
  )
    .bind(owner.id, Date.now())
    .run();
  await env.DB.prepare(
    "UPDATE points_settings SET enabled=1,version=version+1 WHERE id='global'",
  ).run();
  await env.DB.prepare(
    "UPDATE points_systems SET status='retired' WHERE status<>'retired'",
  ).run();
  const system = await createSystem(bindings, owner.id, {
    name: "星星",
    unit: "星星",
    step: 100,
    issuerName: "星星小站",
    baseUrl: "https://stars.test/hb/",
    intro: "",
    keyGuide: "",
    noRecipient: "",
    arrival: "",
    notAllowed: "",
    insufficient: "",
    keyInvalid: "",
    rate: 10,
  });
  systemId = system.id;
  issuer.open(owner.externalId, owner.username, 1_000_00, "owner-test-key");
  issuer.open(sender.externalId, sender.username, 100_00, "sender-key");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function online() {
  const test = await runSelfTest(bindings, owner.id, systemId, {
    testKey: "owner-test-key",
    testRecipientId: Number(owner.externalId),
  });
  expect(test.passed).toBe(true);
  await submitSystem(bindings, owner.id, systemId);
  await reviewSystem(bindings, admin.id, systemId, {
    approve: true,
    note: "",
  });
  await saveKey(bindings, sender.id, systemId, "sender-key");
}

function points(money: LdcMoney): ActivityInput {
  const { rewardType: _t, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "星星红包",
    rewardType: "ldc",
    funding: "points",
    merchantId: "",
    pointsSystemId: systemId,
    passwords: ["StarPassword"],
    allocation: money.mode === "random" ? "random" : "sequential",
    money,
  } satisfies ActivityInput;
}

async function opened(money: LdcMoney) {
  const saved = await createActivity(bindings, sender.id, {
    requestId: crypto.randomUUID(),
    activity: points(money),
  });
  return openActivity(bindings, saved.id, sender.id, saved.version);
}

async function claim(activityId: string, user: Actor) {
  const result = await claimActivity(bindings, activityId, user.id, {
    submissionId: crypto.randomUUID(),
    password: "StarPassword",
  });
  await advanceAttemptCooldown(env.DB, user.id);
  return result as { result: string; claim: ClaimDetail };
}

async function payout(claimId: string) {
  return env.DB.prepare("SELECT * FROM points_payments WHERE claim_id=?")
    .bind(claimId)
    .first<{
      id: string;
      status: string;
      reason: string | null;
      misses: number;
      next_run_at: number | null;
    }>();
}

/** Run a payout as if its time had come. */
async function run(id: string) {
  await env.DB.prepare("UPDATE points_payments SET next_run_at=? WHERE id=?")
    .bind(Date.now() - 1, id)
    .run();
  return runPointsPayment(bindings, id);
}

describe("接入自检 (§4)", () => {
  it("passes an issuer keeping to the protocol, spending one 最小单位", async () => {
    const result = await runSelfTest(bindings, owner.id, systemId, {
      testKey: "owner-test-key",
      testRecipientId: Number(owner.externalId),
    });
    expect(result.steps.map((step) => [step.n, step.ok])).toEqual(
      Array.from({ length: 11 }, (_, index) => [index + 1, true]),
    );
    expect(result.passed).toBe(true);
    // Paid to oneself: the account is as it was.
    expect(issuer.accounts.get(owner.externalId)?.available).toBe(1_000_00);
  });
  it("stops at the first step an issuer gets wrong", async () => {
    const original = issuer.answer.bind(issuer);
    // An issuer that sends twice for the same order number.
    issuer.answer = (path, key, body) =>
      path === "transfer" && body.amount === "100"
        ? {
            result: "ok",
            trade_no: `X${Math.random()}`,
            amount: "100",
            to: body.to as never,
          }
        : original(path, key, body);
    const result = await runSelfTest(bindings, owner.id, systemId, {
      testKey: "owner-test-key",
      testRecipientId: Number(owner.externalId),
    });
    expect(result.passed).toBe(false);
    expect(result.steps.at(-1)?.n).toBe(5);
    await expect(submitSystem(bindings, owner.id, systemId)).rejects.toThrow(
      "先跑通接入自检",
    );
  });
});

describe("三方积分红包", () => {
  it("pays each claim through the issuer, in whole 最小单位", async () => {
    await online();
    const hongbao = await opened({
      mode: "fixed",
      totalAmount: "30",
      count: 3,
    });
    expect(hongbao.funding).toBe("points");
    const managed = await getManagedActivity(bindings, hongbao.id, sender.id);
    expect(managed.points).toMatchObject({
      name: "星星",
      unit: "星星",
      step: 100,
      host: "stars.test",
    });
    const first = await actor();
    issuer.open(first.externalId, first.username, 0);
    const claimed = await claim(hongbao.id, first);
    expect(claimed.result).toBe("claimed");
    expect(claimed.claim.payment?.id).toMatch(/^pp_/);
    expect(claimed.claim.activity.points?.unit).toBe("星星");
    expect(await run(claimed.claim.payment?.id ?? "")).toBe("confirmed");
    expect(issuer.accounts.get(first.externalId)?.available).toBe(1000);
    expect(issuer.accounts.get(sender.externalId)?.available).toBe(9000);
    // 自领 pays nothing.
    const own = await claim(hongbao.id, sender);
    expect(own.claim.payment).toBeUndefined();
  });

  it("is claimed and paid where real LDC claims are off (Stage, or the 站长's pause)", async () => {
    // Outside local, a 三方积分红包 keeps payment_mode 'real'; Credit's
    // switches are not its gate (its own are the site switch and the
    // system's state).
    const staged: ApiBindings = { ...bindings, APP_ENV: "staging" };
    await online();
    const saved = await createActivity(staged, sender.id, {
      requestId: crypto.randomUUID(),
      activity: points({ mode: "fixed", totalAmount: "30", count: 3 }),
    });
    const hongbao = await openActivity(
      staged,
      saved.id,
      sender.id,
      saved.version,
    );
    const mode = await env.DB.prepare(
      "SELECT payment_mode FROM activities WHERE id=?",
    )
      .bind(hongbao.id)
      .first<string>("payment_mode");
    expect(mode).toBe("real");
    const first = await actor();
    issuer.open(first.externalId, first.username, 0);
    const claimed = (await claimActivity(staged, hongbao.id, first.id, {
      submissionId: crypto.randomUUID(),
      password: "StarPassword",
    })) as { result: string; claim: ClaimDetail };
    expect(claimed.result).toBe("claimed");
    expect(await run(claimed.claim.payment?.id ?? "")).toBe("confirmed");
    expect(issuer.accounts.get(first.externalId)?.available).toBe(1000);
  });

  it("refuses money that is not whole 最小单位, and an opening 额度 cannot cover", async () => {
    await online();
    await expect(
      createActivity(bindings, sender.id, {
        requestId: crypto.randomUUID(),
        activity: points({ mode: "fixed", totalAmount: "3", count: 2 }),
      }),
    ).rejects.toThrow("平分");
    const saved = await createActivity(bindings, sender.id, {
      requestId: crypto.randomUUID(),
      activity: points({ mode: "fixed", totalAmount: "300", count: 3 }),
    });
    await expect(
      openActivity(bindings, saved.id, sender.id, saved.version),
    ).rejects.toThrow("额度不够");
  });

  it("ends the 红包 at once on 额度不够 and stops its other payouts", async () => {
    await online();
    const hongbao = await opened({
      mode: "fixed",
      totalAmount: "60",
      count: 3,
    });
    const [a, b] = [await actor(), await actor()];
    issuer.open(a.externalId, a.username, 0);
    issuer.open(b.externalId, b.username, 0);
    const first = await claim(hongbao.id, a);
    const second = await claim(hongbao.id, b);
    // The sender spent elsewhere meanwhile.
    const account = issuer.accounts.get(sender.externalId);
    if (account) account.available = 500;
    expect(await run(first.claim.payment?.id ?? "")).toBe("failed");
    const row = await env.DB.prepare(
      "SELECT ended_at,end_reason,points_stop_reason FROM activities WHERE id=?",
    )
      .bind(hongbao.id)
      .first<{
        ended_at: number | null;
        end_reason: string;
        points_stop_reason: string;
      }>();
    expect(row?.ended_at).not.toBeNull();
    expect(row).toMatchObject({
      end_reason: "points",
      points_stop_reason: "insufficient",
    });
    const calls = issuer.calls.length;
    expect((await payout(second.claim.id))?.status).toBe("failed");
    expect((await payout(second.claim.id))?.reason).toBe("stopped");
    expect(issuer.calls.length).toBe(calls);
  });

  it("gives 找不到收款人 one resend within five minutes", async () => {
    await online();
    const hongbao = await opened({
      mode: "fixed",
      totalAmount: "30",
      count: 3,
    });
    const stranger = await actor();
    const claimed = await claim(hongbao.id, stranger);
    const id = claimed.claim.payment?.id ?? "";
    expect(await run(id)).toBe("held");
    // Opened an account in time, and sent again.
    issuer.open(stranger.externalId, stranger.username, 0);
    await resendPointsPayment(bindings, stranger.id, claimed.claim.id);
    expect(await runPointsPayment(bindings, id)).toBe("confirmed");
    await expect(
      resendPointsPayment(bindings, stranger.id, claimed.claim.id),
    ).rejects.toThrow();
  });

  it("tries a payout with no answer three times, then settles it by a last query", async () => {
    await online();
    const hongbao = await opened({
      mode: "fixed",
      totalAmount: "30",
      count: 3,
    });
    const a = await actor();
    issuer.open(a.externalId, a.username, 0);
    const claimed = await claim(hongbao.id, a);
    const id = claimed.claim.payment?.id ?? "";
    issuer.down = true;
    expect(await run(id)).toBe("retry");
    expect(await run(id)).toBe("retry");
    expect(await run(id)).toBe("retry");
    expect((await payout(claimed.claim.id))?.misses).toBe(3);
    expect(await run(id)).toBe("final");
    issuer.down = false;
    // Nothing there: 未发出, never paid twice.
    expect(await run(id)).toBe("failed");
    expect((await payout(claimed.claim.id))?.reason).toBe("network");
  });

  it("stops claims before a share is taken while its system is paused", async () => {
    await online();
    const hongbao = await opened({
      mode: "fixed",
      totalAmount: "30",
      count: 3,
    });
    await pauseSystem(bindings, admin.id, systemId, true);
    const a = await actor();
    await expect(claim(hongbao.id, a)).rejects.toThrow("暂时发不出");
  });

  it("ends the sender's 红包 when the key is removed", async () => {
    await online();
    const hongbao = await opened({
      mode: "fixed",
      totalAmount: "30",
      count: 3,
    });
    await removeKey(bindings, sender.id, systemId);
    const row = await env.DB.prepare(
      "SELECT end_reason,points_stop_reason FROM activities WHERE id=?",
    )
      .bind(hongbao.id)
      .first();
    expect(row).toMatchObject({
      end_reason: "points",
      points_stop_reason: "key_removed",
    });
  });

  it("splits 拼手气 in whole 最小单位", async () => {
    await online();
    const hongbao = await opened({
      mode: "random",
      algorithm: "double_mean_v1",
      totalAmount: "50",
      count: 5,
    });
    const rows = await env.DB.prepare(
      "SELECT amount_minor FROM reward_inventory WHERE activity_id=?",
    )
      .bind(hongbao.id)
      .all<{ amount_minor: number }>();
    expect(rows.results).toHaveLength(5);
    expect(rows.results.every((row) => row.amount_minor % 100 === 0)).toBe(
      true,
    );
    expect(rows.results.reduce((sum, row) => sum + row.amount_minor, 0)).toBe(
      5000,
    );
  });

  it("sweeps a lapsed 找不到收款人 to 未发出", async () => {
    await online();
    const hongbao = await opened({
      mode: "fixed",
      totalAmount: "30",
      count: 3,
    });
    const stranger = await actor();
    const claimed = await claim(hongbao.id, stranger);
    expect(await run(claimed.claim.payment?.id ?? "")).toBe("held");
    await env.DB.prepare(
      "UPDATE points_payments SET resend_until=? WHERE claim_id=?",
    )
      .bind(Date.now() - 1, claimed.claim.id)
      .run();
    await sweepPointsPayments(bindings);
    expect((await payout(claimed.claim.id))?.status).toBe("failed");
  });
});

describe("代码判定的三方积分红包 (§10)", () => {
  const GAME = `export const meta = { name: "星星游戏", points: true };
export function judge(s, tools) {
  const [verb, arg] = s.input.split(" ");
  if (verb === "add") return { add: Number(arg) };
  if (verb === "cash") return { settle: true };
  if (verb === "show")
    return { message: [s.hongbao.total, s.hongbao.unclaimed, s.hongbao.step, s.hongbao.unit, s.player.pending, tools.money.format(s.player.pending)].join("/") };
  return {};
}`;
  const TESTS = JSON.stringify({
    tests: [{ name: "加", input: "add 3", expect: { pending: 3 } }],
  });

  async function codedSender() {
    const sender = await codeActor();
    await codePlus(sender);
    await judgeSettings({ enabled: 1 });
    issuer.open(sender.externalId, "coder", 100_00, "coder-key");
    await saveKey(bindings, sender.id, systemId, "coder-key");
    return sender;
  }

  function input(code: string, judgeId: string): ActivityInput {
    return {
      ...coded({ totalAmount: "10" }, { code, tests: TESTS, judgeId }),
      funding: "points",
      merchantId: "",
      pointsSystemId: systemId,
    };
  }

  it("counts in 最小单位 for a judge that declares meta.points, and pays in 分", async () => {
    await online();
    const sender = await codedSender();
    const deployed = (await check(sender, GAME, TESTS, { name: "星星游戏" }))
      .body.check;
    expect(deployed).toMatchObject({ passed: true });
    const saved = await createActivity(bindings, sender.id, {
      requestId: crypto.randomUUID(),
      activity: input(GAME, deployed.judge?.id ?? ""),
    });
    const hongbao = await openActivity(
      bindings,
      saved.id,
      sender.id,
      saved.version,
    );
    const player = await codeActor();
    issuer.open(player.externalId, "player", 0);
    const play = async (text: string) => {
      const result = await claimActivity(bindings, hongbao.id, player.id, {
        submissionId: crypto.randomUUID(),
        participationMode: "code",
        input: text,
      });
      await advanceAttemptCooldown(env.DB, player.id);
      return result as Record<string, unknown>;
    };
    // 3 steps of 1 星星 = 300 分.
    expect(await play("add 3")).toMatchObject({
      moved: { added: "3.00", pending: "3.00" },
    });
    expect((await play("show")).message).toBe("10/7/1/星星/3/3");
    const cashed = (await play("cash")) as {
      settled: { claim: ClaimDetail };
    };
    const id = cashed.settled.claim.payment?.id ?? "";
    expect(id).toMatch(/^pp_/);
    expect(await run(id)).toBe("confirmed");
    expect(issuer.accounts.get(player.externalId)?.available).toBe(300);
  });

  it("refuses a judge that does not declare meta.points", async () => {
    await online();
    const sender = await codedSender();
    const plain = GAME.replace(", points: true", "");
    const deployed = (await check(sender, plain, TESTS, { name: "普通游戏" }))
      .body.check;
    expect(deployed).toMatchObject({ passed: true });
    const saved = await createActivity(bindings, sender.id, {
      requestId: crypto.randomUUID(),
      activity: input(plain, deployed.judge?.id ?? ""),
    });
    await expect(
      openActivity(bindings, saved.id, sender.id, saved.version),
    ).rejects.toMatchObject({ code: "JUDGE_NOT_FOR_POINTS" });
  });
});
