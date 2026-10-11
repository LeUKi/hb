import { env } from "cloudflare:test";
import {
  emptyActivityInput,
  type GlobalRedemptionResult,
  type LdcActivityInput,
  type ManagedActivity,
  type PasswordClaimInput,
  type TextActivityInput,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimActivity,
  completeClaimSubmission,
  findSubmission,
  prepareClaimSubmission,
  resumePendingActivityClaims,
} from "../src/activities/claim-service";
import { solveActivityPassword } from "../src/activities/password-service";
import { registerForDraw } from "../src/activities/registration-service";
import {
  createActivity,
  getManagedActivity,
  openActivity,
  prepareActivityOpening,
  updateActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import {
  createMerchant,
  listMerchants,
  repairPaymentCredential,
  updateMerchant,
} from "../src/payments/merchants";
import { requestMerchantCheck } from "../src/payments/recovery";
import {
  digestPassword,
  encryptString,
  sha256Hex,
} from "../src/security/crypto";

const origin = "https://hb.example.com";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  LDC_TIMED_DRAW_ENABLED: "true",
};
const denied = { status: 403, code: "OFFICIAL_CONNECT_REQUIRED" };
let password = "LiteFixture123";
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let lite: Actor;
let standard: Actor;
let merchantId: string;

async function actor(
  officialConnectVerified: boolean,
  loginProvider: "connect" | "liteauth",
): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id,
      externalId: BigInt(`0x${id.replaceAll("-", "").slice(0, 16)}`).toString(),
      username: `LiteTest_${id.slice(0, 8)}`,
      displayName: "账号资格测试",
      officialConnectVerified,
      createdAt: now,
      updatedAt: now,
    });
  await createDb(env.DB)
    .insert(sessions)
    .values({
      tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
      userId: id,
      loginProvider,
      csrfToken: csrf,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
  return { id, cookie: `hb_session=${token}`, csrf };
}

function request(path: string, user: Actor, method = "POST", body?: unknown) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        Cookie: user.cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": user.csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}

function submission(value = password): PasswordClaimInput {
  return { submissionId: crypto.randomUUID(), password: value };
}

function ldc(timed = false): LdcActivityInput {
  const { rewards: _rewards, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "账号资格 LDC 测试",
    rewardType: "ldc",
    passwords: [password, "SecondLite123"],
    merchantId,
    allocation: timed ? "random" : "sequential",
    forceDedicated: false,
    money: timed
      ? {
          mode: "timed_draw",
          totalAmount: "1.00",
          count: 2,
          participantLimit: null,
          countdownSeconds: 600,
          algorithm: "double_mean_v1",
          distributeFullPool: true,
        }
      : { mode: "fixed", totalAmount: "1.00", count: 4 },
  };
}

function text(): TextActivityInput {
  return {
    ...emptyActivityInput(),
    title: "账号资格文本测试",
    rewardType: "text",
    passwords: [password, "SecondLite123"],
    forceDedicated: false,
    rewards: [
      { id: crypto.randomUUID(), text: "PRIVATE-TEXT-ONE" },
      { id: crypto.randomUUID(), text: "PRIVATE-TEXT-TWO" },
    ],
  };
}

async function activity(
  input: LdcActivityInput | TextActivityInput = ldc(),
  author = owner,
  open = true,
): Promise<ManagedActivity> {
  const draft = await createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return open
    ? openActivity(bindings, draft.id, author.id, draft.version)
    : draft;
}

async function counts(activityId: string) {
  return env.DB.prepare(`SELECT claimed_count,registered_count,
    (SELECT COUNT(*) FROM claims WHERE activity_id=a.id) AS claims,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id=a.id) AS registrations,
    (SELECT COUNT(*) FROM redemption_submissions WHERE activity_id=a.id) AS submissions,
    (SELECT COUNT(*) FROM attempt_events WHERE activity_id=a.id) AS attempts,
    (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS payments,
    (SELECT COUNT(*) FROM payment_outbox o JOIN payment_tasks p ON p.id=o.task_id JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS outbox
    FROM activities a WHERE id=?`)
    .bind(activityId)
    .first();
}

async function forbidHttp(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: { code: denied.code },
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

/** Inject a record directly to verify restrictions independently of creation. */
async function syntheticLiteMerchant() {
  const id = crypto.randomUUID();
  const clientId = `lite_synthetic_${id}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO merchants
      (id,author_id,request_id,request_digest,client_id,label,mode,created_at,updated_at)
      VALUES (?,?,?,?,?,'资格边界测试','simulation',?,?)`).bind(
      id,
      lite.id,
      crypto.randomUUID(),
      await digestPassword(
        `synthetic-merchant:${id}`,
        bindings.PASSWORD_DIGEST_KEY,
      ),
      clientId,
      now,
      now,
    ),
    env.DB.prepare(`INSERT INTO merchant_credentials
      (id,merchant_id,version,ciphertext,client_id,created_at) VALUES (?,?,1,?,?,?)`).bind(
      crypto.randomUUID(),
      id,
      await encryptString(
        "FAKE-LITE-BOUNDARY-KEY",
        bindings,
        `merchant:${id}:credential:1`,
      ),
      clientId,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO simulation_controls(merchant_id,scenario,updated_at) VALUES (?,'normal',?)",
    ).bind(id, now),
  ]);
  return { id, clientId };
}

function deactivateBeforeBatch(userId: string) {
  const original = env.DB.batch.bind(env.DB);
  let once = true;
  return vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
    if (once) {
      once = false;
      await env.DB.prepare("UPDATE users SET active=0 WHERE id=?")
        .bind(userId)
        .run();
    }
    return original(statements);
  });
}

beforeEach(async () => {
  password = `Lite${crypto.randomUUID().slice(0, 8)}`;
  owner = await actor(true, "connect");
  lite = await actor(false, "liteauth");
  standard = await actor(true, "liteauth");
  merchantId = (
    await createMerchant(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      label: "资格测试模拟商户",
      clientId: `lite_boundary_${crypto.randomUUID()}`,
      secret: "FAKE-BOUNDARY-ONLY",
    })
  ).id;
});
afterEach(() => vi.restoreAllMocks());

describe("permanent Connect qualification across LDC business boundaries", () => {
  it("rejects creating LDC drafts through the service and HTTP without private or financial writes", async () => {
    const input = { requestId: crypto.randomUUID(), activity: ldc() };
    await expect(
      createActivity(bindings, lite.id, input),
    ).rejects.toMatchObject(denied);
    await forbidHttp(await request("/api/activities", lite, "POST", input));
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM activities WHERE author_id=?",
      )
        .bind(lite.id)
        .first(),
    ).toEqual({ count: 0 });
    expect(await listMerchants(bindings, lite.id)).toMatchObject({
      canCreate: false,
      canSimulate: false,
    });
  });

  it("does not infer qualification from a session claiming to use Connect", async () => {
    const unverified = await actor(false, "liteauth");
    // A real Connect session INSERT is durable login evidence for the rolling
    // deployment compatibility trigger. Spoof only an existing session label;
    // business guards must still use the permanent account qualification.
    await env.DB.prepare(
      "UPDATE sessions SET login_provider='connect' WHERE user_id=?",
    )
      .bind(unverified.id)
      .run();
    expect(
      await env.DB.prepare(
        "SELECT official_connect_verified FROM users WHERE id=?",
      )
        .bind(unverified.id)
        .first("official_connect_verified"),
    ).toBe(0);
    const saved = await activity();
    await forbidHttp(
      await request(
        `/api/activities/${saved.id}/claim`,
        unverified,
        "POST",
        submission(),
      ),
    );
    expect(await counts(saved.id)).toMatchObject({
      claims: 0,
      submissions: 0,
      payments: 0,
      outbox: 0,
    });
  });

  it("allows a LiteAuth session with prior official qualification to claim and register", async () => {
    const saved = await activity();
    expect(
      await claimActivity(bindings, saved.id, standard.id, submission()),
    ).toMatchObject({ result: "claimed", claim: { rewardType: "ldc" } });
    // This is a separate business operation after the account cooldown has elapsed.
    await env.DB.prepare(
      "UPDATE account_attempt_cooldowns SET next_allowed_at=0 WHERE user_id=?",
    )
      .bind(standard.id)
      .run();
    const timed = await activity(ldc(true));
    expect(
      await registerForDraw(bindings, timed.id, standard.id, submission()),
    ).toMatchObject({ result: "registered" });
    expect(await counts(timed.id)).toMatchObject({
      registrations: 1,
      claims: 0,
      payments: 0,
      outbox: 0,
    });
  });

  it("rejects changing a youth-owned text draft to LDC while preserving its inventory", async () => {
    const draft = await activity(text(), lite, false);
    await expect(
      updateActivity(bindings, draft.id, lite.id, {
        version: draft.version,
        activity: ldc(),
      }),
    ).rejects.toMatchObject(denied);
    await forbidHttp(
      await request(`/api/me/activities/${draft.id}`, lite, "PATCH", {
        version: draft.version,
        activity: ldc(),
      }),
    );
    const after = await getManagedActivity(bindings, draft.id, lite.id);
    expect(after.version).toBe(draft.version);
    expect(after.config).toEqual(draft.config);
  });

  it("blocks LDC publication and credential-check admission independently of the draft creation route", async () => {
    const draft = await activity(ldc(), owner, false);
    await env.DB.prepare("UPDATE activities SET author_id=? WHERE id=?")
      .bind(lite.id, draft.id)
      .run();
    await expect(
      openActivity(bindings, draft.id, lite.id, draft.version),
    ).rejects.toMatchObject(denied);
    await expect(
      prepareActivityOpening(bindings, draft.id, lite.id),
    ).rejects.toMatchObject(denied);
    await forbidHttp(
      await request(`/api/me/activities/${draft.id}/open`, lite, "POST", {
        version: draft.version,
      }),
    );
    expect(
      await env.DB.prepare(
        "SELECT opened_at,version FROM activities WHERE id=?",
      )
        .bind(draft.id)
        .first(),
    ).toEqual({ opened_at: null, version: draft.version });
  });

  it("rejects correct and incorrect LDC claims before recording password attempts", async () => {
    const saved = await activity({ ...ldc(), forceDedicated: true });
    const before = await counts(saved.id);
    await expect(
      prepareClaimSubmission(bindings, saved.id, lite.id, submission()),
    ).rejects.toMatchObject(denied);
    await forbidHttp(
      await request(
        `/api/activities/${saved.id}/claim`,
        lite,
        "POST",
        submission("WrongLite123"),
      ),
    );
    expect(await counts(saved.id)).toEqual(before);
  });

  it("rejects timed registration through its service and the ActivityDO route", async () => {
    const timed = await activity({ ...ldc(true), forceDedicated: true });
    const before = await counts(timed.id);
    await expect(
      registerForDraw(bindings, timed.id, lite.id, submission()),
    ).rejects.toMatchObject(denied);
    await forbidHttp(
      await request(
        `/api/activities/${timed.id}/claim`,
        lite,
        "POST",
        submission(),
      ),
    );
    expect(await counts(timed.id)).toEqual(before);
  });

  it("prevents an injected pending youth claim from allocating inventory during direct or compensating recovery", async () => {
    const saved = await activity();
    const input = submission();
    const id = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO redemption_submissions
      (id,activity_id,user_id,submission_id,fingerprint,purpose,outcome,matched_password_id,created_at,validated_at)
      SELECT ?,?,?,?,?,'claim','pending',id,?,? FROM activity_passwords WHERE activity_id=? ORDER BY position LIMIT 1`)
      .bind(
        id,
        saved.id,
        lite.id,
        input.submissionId,
        await digestPassword(
          `claim-request:${saved.id}:${input.password}`,
          bindings.PASSWORD_DIGEST_KEY,
        ),
        Date.now(),
        Date.now(),
        saved.id,
      )
      .run();
    const row = await findSubmission(bindings, lite.id, input.submissionId);
    if (!row) throw new Error("Missing injected submission");
    await expect(completeClaimSubmission(bindings, row)).rejects.toMatchObject(
      denied,
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await resumePendingActivityClaims(bindings, saved.id)).toBe(1);
    expect(log).toHaveBeenCalled();
    expect(await counts(saved.id)).toMatchObject({
      claims: 0,
      registrations: 0,
      submissions: 1,
      payments: 0,
      outbox: 0,
      claimed_count: 0,
    });
    expect(
      await env.DB.prepare(
        "SELECT outcome FROM redemption_submissions WHERE id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({ outcome: "pending" });
  });

  it("allows youth text publishing, self-claim, solving and idempotent replay without creating a payment", async () => {
    const saved = await activity(text(), lite);
    const input = submission();
    const claimed = await claimActivity(bindings, saved.id, lite.id, input);
    expect(claimed).toMatchObject({
      result: "claimed",
      claim: { rewardType: "text", text: "PRIVATE-TEXT-ONE" },
    });
    expect(await claimActivity(bindings, saved.id, lite.id, input)).toEqual(
      claimed,
    );
    await env.DB.prepare(
      "UPDATE account_attempt_cooldowns SET next_allowed_at=0 WHERE user_id=?",
    )
      .bind(lite.id)
      .run();
    expect(
      await solveActivityPassword(
        bindings,
        saved.id,
        lite.id,
        submission("SecondLite123"),
      ),
    ).toEqual({ outcome: "solved", passwordMatched: true });
    expect(await counts(saved.id)).toMatchObject({
      claims: 1,
      payments: 0,
      outbox: 0,
      claimed_count: 1,
    });
  });

  it("keeps every global match visible and leaves selection explicit when text and LDC share a password", async () => {
    const money = await activity();
    const textActivity = await activity(text());
    const response = await request(
      "/api/redemptions",
      lite,
      "POST",
      submission(),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as GlobalRedemptionResult;
    expect(result.result).toBe("multiple");
    expect(result.items.map((item) => item.id).sort()).toEqual(
      [money.id, textActivity.id].sort(),
    );
    expect(result.claimResult).toBeUndefined();
    expect(await counts(money.id)).toMatchObject({
      claims: 0,
      submissions: 0,
      payments: 0,
    });
    expect(await counts(textActivity.id)).toMatchObject({
      claims: 0,
      submissions: 0,
    });
    await forbidHttp(
      await request(
        `/api/activities/${money.id}/claim`,
        lite,
        "POST",
        submission(),
      ),
    );
    const claimed = await request(
      `/api/activities/${textActivity.id}/claim`,
      lite,
      "POST",
      submission(),
    );
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({
      result: "claimed",
      claim: { rewardType: "text" },
    });
  });

  it("preserves a single global candidate across rejection, account upgrade and a newly matching text activity", async () => {
    const money = await activity();
    const input = submission();
    await forbidHttp(await request("/api/redemptions", lite, "POST", input));
    const snapshot = await env.DB.prepare(
      "SELECT id,candidate_ids FROM global_redemptions WHERE user_id=? AND submission_id=?",
    )
      .bind(lite.id, input.submissionId)
      .first<{ id: string; candidate_ids: string }>();
    expect(snapshot?.candidate_ids).toBe(JSON.stringify([money.id]));
    const textActivity = await activity(text());
    await env.DB.prepare(
      "UPDATE users SET official_connect_verified=1 WHERE id=?",
    )
      .bind(lite.id)
      .run();
    const retry = await request("/api/redemptions", lite, "POST", input);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      id: snapshot?.id,
      result: "single",
      selectedActivityId: money.id,
      claimResult: { result: "claimed", claim: { rewardType: "ldc" } },
    });
    expect(await counts(textActivity.id)).toMatchObject({
      claims: 0,
      submissions: 0,
    });
  });

  it("returns a completed claim unchanged across account upgrade", async () => {
    const saved = await activity(text());
    const input = submission();
    const first = await claimActivity(bindings, saved.id, lite.id, input);
    await env.DB.prepare(
      "UPDATE users SET official_connect_verified=1 WHERE id=?",
    )
      .bind(lite.id)
      .run();
    expect(await claimActivity(bindings, saved.id, lite.id, input)).toEqual(
      first,
    );
    expect(await counts(saved.id)).toMatchObject({
      claims: 1,
      submissions: 1,
      payments: 0,
    });
  });

  it("blocks merchant creation through the service and HTTP", async () => {
    const input = {
      requestId: crypto.randomUUID(),
      label: "青春版不能配置",
      clientId: `lite_forbidden_${crypto.randomUUID()}`,
      secret: "FAKE-FORBIDDEN-ONLY",
    };
    await expect(
      createMerchant(bindings, lite.id, input),
    ).rejects.toMatchObject(denied);
    await forbidHttp(await request("/api/me/merchants", lite, "POST", input));
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchants WHERE author_id=?",
      )
        .bind(lite.id)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("blocks merchant changes, credential repair, verification, simulation controls and manual checks independently of creation", async () => {
    const merchant = await syntheticLiteMerchant();
    const input = {
      requestId: crypto.randomUUID(),
      version: 1,
      label: "禁止修改",
      clientId: merchant.clientId,
      secret: "FAKE-NEW-KEY",
    };
    await expect(
      updateMerchant(bindings, merchant.id, lite.id, input),
    ).rejects.toMatchObject(denied);
    await expect(
      requestMerchantCheck(bindings, merchant.id),
    ).rejects.toMatchObject(denied);
    await expect(
      repairPaymentCredential(
        bindings,
        merchant.id,
        lite.id,
        crypto.randomUUID(),
        { requestId: crypto.randomUUID(), version: 1, secret: "FAKE-REPAIR" },
      ),
    ).rejects.toMatchObject(denied);
    for (const path of ["check", "verify", "simulation"])
      await forbidHttp(
        await request(
          `/api/me/merchants/${merchant.id}/${path}`,
          lite,
          "POST",
          path === "simulation" ? { scenario: "normal" } : undefined,
        ),
      );
    await forbidHttp(
      await request(`/api/me/merchants/${merchant.id}`, lite, "PATCH", input),
    );
    const list = await listMerchants(bindings, lite.id);
    expect(list.items[0]).toMatchObject({
      publicationEligibility: { allowed: false, reason: denied.code },
      capabilities: {
        canExecutePayments: false,
        canCheck: false,
        canSimulate: false,
        canVerify: false,
      },
    });
    expect(
      await env.DB.prepare(
        "SELECT version,credential_version,manual_check_at FROM merchants WHERE id=?",
      )
        .bind(merchant.id)
        .first(),
    ).toEqual({ version: 1, credential_version: 1, manual_check_at: null });
  });

  it("rechecks qualification atomically before LDC draft and merchant creation", async () => {
    const create = deactivateBeforeBatch(owner.id);
    await expect(
      createActivity(bindings, owner.id, {
        requestId: crypto.randomUUID(),
        activity: ldc(),
      }),
    ).rejects.toMatchObject(denied);
    create.mockRestore();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM activities WHERE author_id=?",
      )
        .bind(owner.id)
        .first(),
    ).toEqual({ count: 0 });
    const fresh = await actor(true, "connect");
    deactivateBeforeBatch(fresh.id);
    await expect(
      createMerchant(bindings, fresh.id, {
        requestId: crypto.randomUUID(),
        label: "原子资格检查",
        clientId: `atomic_${fresh.id}`,
        secret: "FAKE-ATOMIC-KEY",
      }),
    ).rejects.toMatchObject(denied);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchants WHERE author_id=?",
      )
        .bind(fresh.id)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("rolls back claim validation if the account becomes unavailable before its admission batch", async () => {
    const saved = await activity({ ...ldc(), forceDedicated: true });
    const before = await counts(saved.id);
    deactivateBeforeBatch(standard.id);
    await expect(
      prepareClaimSubmission(bindings, saved.id, standard.id, submission()),
    ).rejects.toMatchObject(denied);
    expect(await counts(saved.id)).toEqual(before);
  });

  it("rolls back allocation, payment and Outbox if eligibility changes after durable validation", async () => {
    const saved = await activity();
    const admitted = await prepareClaimSubmission(
      bindings,
      saved.id,
      standard.id,
      submission(),
    );
    const before = await counts(saved.id);
    deactivateBeforeBatch(standard.id);
    await expect(
      completeClaimSubmission(bindings, admitted),
    ).rejects.toMatchObject(denied);
    expect(await counts(saved.id)).toEqual(before);
  });

  it("rolls back registration and its attempt if eligibility changes immediately before commit", async () => {
    const saved = await activity({ ...ldc(true), forceDedicated: true });
    const before = await counts(saved.id);
    deactivateBeforeBatch(standard.id);
    await expect(
      registerForDraw(bindings, saved.id, standard.id, submission()),
    ).rejects.toMatchObject(denied);
    expect(await counts(saved.id)).toEqual(before);
  });

  it("keeps a draft unopened if its author's eligibility changes before publication commits", async () => {
    const draft = await activity(ldc(), owner, false);
    deactivateBeforeBatch(owner.id);
    await expect(
      openActivity(bindings, draft.id, owner.id, draft.version),
    ).rejects.toMatchObject(denied);
    expect(
      await env.DB.prepare(
        "SELECT opened_at,version FROM activities WHERE id=?",
      )
        .bind(draft.id)
        .first(),
    ).toEqual({ opened_at: null, version: draft.version });
    expect(await counts(draft.id)).toMatchObject({
      claims: 0,
      registrations: 0,
      payments: 0,
      outbox: 0,
    });
  });

  it("rolls back the credential and permanent client registration together when eligibility changes before a merchant save", async () => {
    const correctedClientId = `atomic_corrected_${crypto.randomUUID()}`;
    deactivateBeforeBatch(owner.id);
    await expect(
      updateMerchant(bindings, merchantId, owner.id, {
        requestId: crypto.randomUUID(),
        version: 1,
        label: "原子保存边界",
        clientId: correctedClientId,
        secret: "FAKE-ATOMIC-REPLACEMENT",
      }),
    ).rejects.toMatchObject(denied);
    expect(
      await env.DB.prepare(
        "SELECT version,credential_version FROM merchants WHERE id=?",
      )
        .bind(merchantId)
        .first(),
    ).toEqual({ version: 1, credential_version: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchant_client_ids WHERE client_id=?",
      )
        .bind(correctedClientId)
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchant_credentials WHERE merchant_id=?",
      )
        .bind(merchantId)
        .first(),
    ).toEqual({ count: 1 });
  });
});
