import { env } from "cloudflare:test";
import {
  type ClaimResult,
  emptyActivityInput,
  type LdcActivityInput,
} from "@hb/contracts";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimActivity,
  completeClaimSubmission,
  prepareClaimSubmission,
  resumePendingActivityClaims,
} from "../src/activities/claim-service";
import type { ActivityExecutionPolicy } from "../src/activities/execution-policy";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { paymentTasks, sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { ensureEvidenceMatchesTask } from "../src/payments/adapter";
import { createMerchant } from "../src/payments/merchants";
import { createRealPaymentAdapter } from "../src/payments/real-protocol";
import { runMerchantCycle } from "../src/payments/scheduler";
import { sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
const bindings: ApiBindings = { ...env, APP_ORIGIN: origin };

async function user(externalId?: string, username = "test-recipient") {
  const id = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      officialConnectVerified: true,
      id,
      externalId:
        externalId ??
        BigInt(`0x${id.replaceAll("-", "").slice(0, 15)}`).toString(),
      username,
      displayName: username,
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

async function fixture(options: { recipientId?: string; open?: boolean } = {}) {
  const authorId = await user();
  const recipientId = await user(options.recipientId);
  const merchant = await createMerchant(bindings, authorId, {
    requestId: crypto.randomUUID(),
    clientId: `mock_real_${crypto.randomUUID()}`,
    label: "真实分支模拟 HTTP 验收",
    secret: "mock-transport-secret",
    mode: "real",
  });
  const {
    rewards: _rewards,
    rewardType: _rewardType,
    ...base
  } = emptyActivityInput();
  const input: LdcActivityInput = {
    ...base,
    title: "真实分支本地验证",
    rewardType: "ldc",
    merchantId: merchant.id,
    money: { mode: "fixed", count: 1, totalAmount: "0.10" },
    passwords: ["correct123"],
    forceDedicated: true,
    afterClaimInfo: "分配后立即解锁",
  };
  const draft = await createActivity(bindings, authorId, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  // This nonserializable service dependency is scoped to one fixture activity.
  // Runtime callers deliberately omit it, even with acceptance network mode.
  const policy: ActivityExecutionPolicy = {
    canUseRealActivity: (id) => id === draft.id,
  };
  const activity =
    options.open === false
      ? draft
      : await openActivity(bindings, draft.id, authorId, draft.version, policy);
  return { activity, authorId, recipientId, merchant, policy };
}

function submission(submissionId = crypto.randomUUID()) {
  return { submissionId, password: "correct123" };
}

async function allocationCounts(activityId: string) {
  return env.DB.prepare(
    `SELECT claimed_count AS allocated,
      (SELECT COUNT(*) FROM claims WHERE activity_id=?) AS claims,
      (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=?) AS tasks,
      (SELECT COUNT(*) FROM payment_outbox o JOIN payment_tasks p ON p.id=o.task_id JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=?) AS outbox
      FROM activities WHERE id=?`,
  )
    .bind(activityId, activityId, activityId, activityId)
    .first();
}

async function paymentForClaim(claimId: string) {
  const task = await createDb(env.DB)
    .select()
    .from(paymentTasks)
    .where(eq(paymentTasks.claimId, claimId))
    .get();
  if (!task) throw new Error("Expected real claim payment task");
  return task;
}

function claimId(result: ClaimResult) {
  if (!("claim" in result)) throw new Error("Expected successful allocation");
  return result.claim.id;
}

afterEach(() => vi.restoreAllMocks());

describe("real activity claim implementation with injected service policy", () => {
  it("cannot open or allocate ordinary real activities through environment or HTTP options", async () => {
    const f = await fixture({ open: false });
    const runtime: ApiBindings = {
      ...bindings,
      APP_ENV: "local",
      LDC_NETWORK_MODE: "acceptance",
      LDC_ACCEPTANCE_ID: crypto.randomUUID(),
    };
    await expect(
      openActivity(runtime, f.activity.id, f.authorId, f.activity.version),
    ).rejects.toMatchObject({ code: "REAL_LDC_NOT_ENABLED" });
    expect(
      await env.DB.prepare(
        "SELECT opened_at,version,claimed_count FROM activities WHERE id=?",
      )
        .bind(f.activity.id)
        .first(),
    ).toEqual({
      opened_at: null,
      version: f.activity.version,
      claimed_count: 0,
    });
    await openActivity(
      bindings,
      f.activity.id,
      f.authorId,
      f.activity.version,
      f.policy,
    );
    await expect(
      claimActivity(runtime, f.activity.id, f.recipientId, submission()),
    ).rejects.toMatchObject({ code: "REAL_LDC_NOT_ENABLED" });

    const token = crypto.randomUUID();
    const csrf = crypto.randomUUID();
    const now = new Date();
    await createDb(env.DB)
      .insert(sessions)
      .values({
        tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
        userId: f.recipientId,
        csrfToken: csrf,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 3600000),
      });
    const response = await app.request(
      `${origin}/api/activities/${f.activity.id}/claim`,
      {
        method: "POST",
        headers: {
          Cookie: `hb_session=${token}`,
          Origin: origin,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(submission()),
      },
      runtime,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "REAL_LDC_NOT_ENABLED" },
    });
    expect(await allocationCounts(f.activity.id)).toEqual({
      allocated: 0,
      claims: 0,
      tasks: 0,
      outbox: 0,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM attempt_events WHERE activity_id=?",
      )
        .bind(f.activity.id)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("allocates once with frozen uint64 identity and amounts and exercises injected mock HTTP", async () => {
    const f = await fixture({ recipientId: "18446744073709551615" });
    const input = submission();
    const result = await claimActivity(
      bindings,
      f.activity.id,
      f.recipientId,
      input,
      f.policy,
    );
    expect(result).toMatchObject({
      result: "claimed",
      claim: {
        rewardType: "ldc",
        amount: "0.10",
        afterClaimInfo: "分配后立即解锁",
        payment: { mode: "real", status: "pending" },
      },
    });
    const task = await paymentForClaim(claimId(result));
    expect(task).toMatchObject({
      source: "claim",
      acceptanceId: null,
      mode: "real",
      recipientId: "18446744073709551615",
      recipientUsername: "test-recipient",
      clientId: f.merchant.clientId,
      amountMinor: 10,
    });
    await env.DB.prepare("UPDATE users SET username='renamed' WHERE id=?")
      .bind(f.recipientId)
      .run();
    expect(
      await claimActivity(
        bindings,
        f.activity.id,
        f.recipientId,
        input,
        f.policy,
      ),
    ).toEqual(result);
    expect(await paymentForClaim(claimId(result))).toEqual(task);
    expect(await allocationCounts(f.activity.id)).toEqual({
      allocated: 1,
      claims: 1,
      tasks: 1,
      outbox: 1,
    });

    const transport = vi.fn<typeof fetch>(async (url, init) => {
      const target = new URL(String(url));
      expect(target.origin).toBe("https://credit.example.invalid");
      if (init?.method === "POST") {
        expect(target.pathname).toBe("/lpay/distribute");
        expect(init.body).toContain('"user_id":18446744073709551615');
        expect(init.body).toContain('"username":"test-recipient"');
        expect(init.body).toContain('"amount":"0.10"');
        return Response.json({
          error_msg: "",
          data: { trade_no: "MOCK-TRADE", out_trade_no: task.businessNo },
        });
      }
      expect(target.pathname).toBe("/epay/api.php");
      expect(target.searchParams.get("out_trade_no")).toBe(task.businessNo);
      return Response.json({
        code: 1,
        pid: task.clientId,
        out_trade_no: task.businessNo,
        trade_no: "MOCK-TRADE",
        money: "0.10",
        status: 1,
      });
    });
    const adapter = createRealPaymentAdapter({
      baseUrl: "https://credit.example.invalid",
      fetch: transport,
    });
    const context = {
      credentialVersion: 1,
      clientSecret: "mock-transport-secret",
    };
    const sent = await adapter.send(task, context);
    expect(sent.kind).toBe("sent");
    if (sent.kind !== "sent") throw new Error("Expected acknowledgment");
    expect(ensureEvidenceMatchesTask(task, sent.evidence, "send")).toBe(true);
    const checked = await adapter.query(
      { ...task, externalOrderId: sent.evidence.externalOrderId ?? null },
      context,
    );
    expect(checked.kind).toBe("confirmed");
    if (checked.kind !== "confirmed") throw new Error("Expected query proof");
    expect(ensureEvidenceMatchesTask(task, checked.evidence, "query")).toBe(
      true,
    );
    expect(checked.evidence).not.toHaveProperty("recipientId");
    expect(transport).toHaveBeenCalledTimes(2);

    // Injecting HTTP transport is not a runtime send authorization.
    await expect(
      runMerchantCycle(
        {
          ...bindings,
          APP_ENV: "local",
          LDC_NETWORK_MODE: "acceptance",
          LDC_ACCEPTANCE_ID: task.id,
        },
        f.merchant.id,
        { adapterFactory: () => adapter },
      ),
    ).resolves.toEqual({ processed: false, nextRunAt: null });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("keeps pending real claims blocked for recovery without the scoped dependency", async () => {
    const f = await fixture();
    const admitted = await prepareClaimSubmission(
      bindings,
      f.activity.id,
      f.recipientId,
      submission(),
      f.policy,
    );
    await expect(
      completeClaimSubmission(bindings, admitted),
    ).rejects.toMatchObject({ code: "REAL_LDC_NOT_ENABLED" });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await resumePendingActivityClaims(bindings, f.activity.id);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(await allocationCounts(f.activity.id)).toEqual({
      allocated: 0,
      claims: 0,
      tasks: 0,
      outbox: 0,
    });
    const another = await fixture({ open: false });
    await expect(
      openActivity(
        bindings,
        another.activity.id,
        another.authorId,
        another.activity.version,
        f.policy,
      ),
    ).rejects.toMatchObject({ code: "REAL_LDC_NOT_ENABLED" });
    expect(
      await completeClaimSubmission(bindings, admitted, f.policy),
    ).toMatchObject({ result: "claimed", claim: { amount: "0.10" } });
  });

  it("continues to reject author self-claim before attempts or allocation", async () => {
    const f = await fixture();
    await expect(
      claimActivity(
        bindings,
        f.activity.id,
        f.authorId,
        submission(),
        f.policy,
      ),
    ).rejects.toMatchObject({ code: "SELF_CLAIM_FORBIDDEN" });
    expect(await allocationCounts(f.activity.id)).toEqual({
      allocated: 0,
      claims: 0,
      tasks: 0,
      outbox: 0,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM attempt_events WHERE activity_id=?",
      )
        .bind(f.activity.id)
        .first(),
    ).toEqual({ count: 0 });
  });

  it.each(["recipient-name", "000100001", "0", "18446744073709551616"])(
    "refuses unverified stable identity %s before allocating",
    async (recipientId) => {
      const f = await fixture({ recipientId });
      await expect(
        claimActivity(
          bindings,
          f.activity.id,
          f.recipientId,
          submission(),
          f.policy,
        ),
      ).rejects.toMatchObject({ code: "RECIPIENT_IDENTITY_UNVERIFIED" });
      expect(await allocationCounts(f.activity.id)).toEqual({
        allocated: 0,
        claims: 0,
        tasks: 0,
        outbox: 0,
      });
    },
  );

  it.each(["payment_tasks", "payment_outbox"])(
    "rolls allocation back on %s failure and reuses the original pending submission",
    async (table) => {
      const f = await fixture();
      const admitted = await prepareClaimSubmission(
        bindings,
        f.activity.id,
        f.recipientId,
        submission(),
        f.policy,
      );
      await env.DB.prepare(
        `CREATE TRIGGER fail_real_claim BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END`,
      ).run();
      try {
        await expect(
          completeClaimSubmission(bindings, admitted, f.policy),
        ).rejects.toThrow();
        expect(await allocationCounts(f.activity.id)).toEqual({
          allocated: 0,
          claims: 0,
          tasks: 0,
          outbox: 0,
        });
        expect(
          await env.DB.prepare(
            "SELECT outcome,claim_id FROM redemption_submissions WHERE id=?",
          )
            .bind(admitted.id)
            .first(),
        ).toEqual({ outcome: "pending", claim_id: null });
        expect(
          await env.DB.prepare(
            "SELECT matched,claim_id FROM attempt_events WHERE submission_row_id=?",
          )
            .bind(admitted.id)
            .first(),
        ).toEqual({ matched: 1, claim_id: null });
      } finally {
        await env.DB.prepare("DROP TRIGGER fail_real_claim").run();
      }
      const result = await completeClaimSubmission(
        bindings,
        admitted,
        f.policy,
      );
      expect(result).toMatchObject({
        result: "claimed",
        claim: { amount: "0.10", payment: { mode: "real" } },
      });
      expect(await allocationCounts(f.activity.id)).toEqual({
        allocated: 1,
        claims: 1,
        tasks: 1,
        outbox: 1,
      });
    },
  );

  it("creates only one real task when two validated claimants race for the final reward", async () => {
    const f = await fixture();
    const otherUser = await user();
    const admitted = await Promise.all(
      [f.recipientId, otherUser].map((userId) =>
        prepareClaimSubmission(
          bindings,
          f.activity.id,
          userId,
          submission(),
          f.policy,
        ),
      ),
    );
    const results = await Promise.all(
      admitted.map((row) => completeClaimSubmission(bindings, row, f.policy)),
    );
    expect(results.map((result) => result.result).sort()).toEqual([
      "claimed",
      "ended",
    ]);
    expect(await allocationCounts(f.activity.id)).toEqual({
      allocated: 1,
      claims: 1,
      tasks: 1,
      outbox: 1,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS attempts,COUNT(claim_id) AS successful FROM attempt_events WHERE activity_id=?",
      )
        .bind(f.activity.id)
        .first(),
    ).toEqual({ attempts: 2, successful: 1 });
  });
});
