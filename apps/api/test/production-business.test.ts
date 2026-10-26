import { env } from "cloudflare:test";
import { emptyActivityInput, type LdcActivityInput } from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import {
  createActivity,
  getManagedActivity,
  openActivity,
} from "../src/activities/service";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { readMerchantImpact } from "../src/payments/configuration";
import {
  createMerchant,
  getMerchant,
  listMerchants,
  updateMerchant,
} from "../src/payments/merchants";

const runtime: ApiBindings = {
  ...env,
  APP_ENV: "production",
  LDC_NETWORK_MODE: "live",
  APP_ORIGIN: "https://meme.example.test",
};
async function actor() {
  const id = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id,
      externalId: BigInt(`0x${id.replaceAll("-", "").slice(0, 15)}`).toString(),
      username: `User_${id.slice(0, 8)}`,
      displayName: "Test",
      createdAt: now,
      updatedAt: now,
    });
  return id;
}
async function fixture() {
  const author = await actor();
  const recipient = await actor();
  const payload = {
    requestId: crypto.randomUUID(),
    mode: "real" as const,
    clientId: `mock_${crypto.randomUUID()}`,
    label: "Production fixture",
    secret: "TEST-ONLY-NOT-A-REAL-CREDENTIAL",
  };
  const merchant = await createMerchant(runtime, author, payload);
  const base = emptyActivityInput();
  const input: LdcActivityInput = {
    ...base,
    rewardType: "ldc",
    merchantId: merchant.id,
    title: "Ordinary activity",
    forceDedicated: true,
    joinSquare: true,
    passwords: ["Correct123"],
    money: { mode: "fixed", totalAmount: "0.30", count: 3 },
  };
  const activity = await createActivity(runtime, author, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return { author, recipient, merchant, activity, payload, input };
}
async function verified(id: string, checkedAt = Date.now()) {
  await env.DB.prepare(
    "UPDATE merchant_credentials SET verification_status='passed',verification_checked_at=? WHERE merchant_id=? AND version=(SELECT credential_version FROM merchants WHERE id=?)",
  )
    .bind(checkedAt, id, id)
    .run();
}
async function enabled() {
  await env.DB.prepare(
    "UPDATE platform_controls SET version=version+1,allow_real_open=1,allow_real_claim=1,allow_real_send=1,updated_at=? WHERE id='global'",
  )
    .bind(Date.now())
    .run();
}
const submit = () => ({
  submissionId: crypto.randomUUID(),
  password: "Correct123",
});
beforeEach(enabled);
afterEach(() => vi.restoreAllMocks());

describe("production business authorization without activity test bypass", () => {
  it("allows one current merchant under concurrent creation and preserves request replay", async () => {
    const author = await actor();
    const common = {
      mode: "real" as const,
      label: "Only one",
      secret: "TEST-SECRET",
    };
    const inputs = [0, 1].map(() => ({
      ...common,
      requestId: crypto.randomUUID(),
      clientId: `mock_${crypto.randomUUID()}`,
    }));
    const results = await Promise.allSettled(
      inputs.map((input) => createMerchant(runtime, author, input)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "MERCHANT_ALREADY_EXISTS" });
    const index = results.findIndex((r) => r.status === "fulfilled");
    const winningInput = inputs[index];
    if (!winningInput) throw new Error("No creation succeeded");
    const replay = await createMerchant(runtime, author, winningInput);
    const list = await listMerchants(runtime, author);
    expect(list).toMatchObject({
      canCreate: false,
      currentMerchantId: replay.id,
      canSimulate: false,
    });
    expect(list.items).toHaveLength(1);
  });
  it("does not offer simulation on staging or production", async () => {
    const author = await actor();
    for (const APP_ENV of ["staging", "production"])
      await expect(
        createMerchant({ ...runtime, APP_ENV }, author, {
          requestId: crypto.randomUUID(),
          clientId: `mock_${crypto.randomUUID()}`,
          label: "Sim",
          secret: "fake",
          mode: "simulation",
        }),
      ).rejects.toMatchObject({ code: "SIMULATION_NOT_AVAILABLE" });
  });
  it("requires fresh current credential verification and leaves a rejected opening unchanged", async () => {
    const f = await fixture();
    await expect(
      openActivity(runtime, f.activity.id, f.author, 1),
    ).rejects.toMatchObject({ code: "MERCHANT_CREDENTIALS_UNVERIFIED" });
    await verified(f.merchant.id, Date.now() - 600001);
    await expect(
      openActivity(runtime, f.activity.id, f.author, 1),
    ).rejects.toMatchObject({ code: "MERCHANT_CREDENTIALS_UNVERIFIED" });
    expect(
      await getManagedActivity(runtime, f.activity.id, f.author),
    ).toMatchObject({ version: 1, openedAt: null });
    await verified(f.merchant.id);
    const opened = await openActivity(runtime, f.activity.id, f.author, 1);
    expect(opened.status).toBe("active");
    await updateMerchant(runtime, f.merchant.id, f.author, {
      confirmationToken: (await readMerchantImpact(runtime, f.merchant))
        .confirmationToken,
      version: f.merchant.version,
      label: "Rotated",
      secret: "NEW-FAKE-SECRET",
    });
    expect(
      await openActivity(runtime, f.activity.id, f.author, 1),
    ).toMatchObject({
      openedAt: opened.openedAt,
      deadlineAt: opened.deadlineAt,
      version: opened.version,
    });
  });
  it("continues allocating after credential rotation and authentication rejection", async () => {
    const f = await fixture();
    await verified(f.merchant.id);
    await openActivity(runtime, f.activity.id, f.author, 1);
    await updateMerchant(runtime, f.merchant.id, f.author, {
      confirmationToken: (await readMerchantImpact(runtime, f.merchant))
        .confirmationToken,
      version: 1,
      label: "Rotated",
      secret: "NEW-FAKE-SECRET",
    });
    await env.DB.prepare(
      "UPDATE merchant_credentials SET verification_status='rejected' WHERE merchant_id=? AND version=2",
    )
      .bind(f.merchant.id)
      .run();
    const result = await claimActivity(
      runtime,
      f.activity.id,
      f.recipient,
      submit(),
    );
    expect(result.result).toBe("claimed");
    const task = await env.DB.prepare(
      "SELECT p.source,p.mode,p.amount_minor,p.recovery_policy,p.first_send_at,p.parameter_digest,p.recipient_id FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=?",
    )
      .bind(f.activity.id)
      .first<Record<string, unknown>>();
    expect(task).toMatchObject({
      source: "claim",
      mode: "real",
      amount_minor: 10,
      recovery_policy: "claim_same_order_v1",
      first_send_at: null,
    });
    expect(task?.parameter_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (await getMerchant(runtime, f.merchant.id, f.author))
        .publicationEligibility.allowed,
    ).toBe(false);
  });
  it("returns the original reward when new allocations have been stopped", async () => {
    const f = await fixture();
    await verified(f.merchant.id);
    await openActivity(runtime, f.activity.id, f.author, 1);
    const first = await claimActivity(
      runtime,
      f.activity.id,
      f.recipient,
      submit(),
    );
    const paused = { ...runtime, LDC_STOP_NEW_CLAIMS: "true" };
    const again = await claimActivity(
      paused,
      f.activity.id,
      f.recipient,
      submit(),
    );
    expect(again.result).toBe("already_claimed");
    if ("claim" in first && "claim" in again)
      expect(again.claim.id).toBe(first.claim.id);
    await expect(
      claimActivity(paused, f.activity.id, await actor(), submit()),
    ).rejects.toMatchObject({ code: "REAL_LDC_CLAIMS_PAUSED" });
  });
  it("gives the sender a share of a real 红包 without a payment task (自领)", async () => {
    // docs/self-claim-design.md: Credit pays no one to themselves, and the
    // share never leaves the merchant.
    const f = await fixture();
    await verified(f.merchant.id);
    await openActivity(runtime, f.activity.id, f.author, 1);
    expect(
      await claimActivity(runtime, f.activity.id, f.author, submit()),
    ).toMatchObject({ result: "claimed", claim: { self: true } });
    expect(
      await env.DB.prepare(
        "SELECT claimed_count,(SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=activities.id) AS payments FROM activities WHERE id=?",
      )
        .bind(f.activity.id)
        .first(),
    ).toEqual({ claimed_count: 1, payments: 0 });
  });
  it("rolls an opening back if a credential rotates after the eligibility read", async () => {
    const f = await fixture();
    await verified(f.merchant.id);
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      // The private snapshot reads through batch before the actual CAS; rotate immediately afterwards.
      const result = await batch(statements);
      await env.DB.prepare(
        "UPDATE merchants SET credential_version=credential_version+1 WHERE id=?",
      )
        .bind(f.merchant.id)
        .run();
      return result;
    });
    await expect(
      openActivity(runtime, f.activity.id, f.author, 1),
    ).rejects.toBeDefined();
    expect(
      await env.DB.prepare(
        "SELECT version,opened_at,claimed_count FROM activities WHERE id=?",
      )
        .bind(f.activity.id)
        .first(),
    ).toEqual({ version: 1, opened_at: null, claimed_count: 0 });
  });
  it("reports a conflict when a replacement credential passes before the opening CAS", async () => {
    const f = await fixture();
    await verified(f.merchant.id);
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      const result = await batch(statements);
      await updateMerchant(runtime, f.merchant.id, f.author, {
        confirmationToken: (await readMerchantImpact(runtime, f.merchant))
          .confirmationToken,
        version: 1,
        label: "Rechecked during opening",
        secret: "REPLACEMENT-TEST-SECRET",
      });
      await verified(f.merchant.id);
      return result;
    });
    await expect(
      openActivity(runtime, f.activity.id, f.author, 1),
    ).rejects.toMatchObject({ status: 409, code: "ACTIVITY_CONFLICT" });
    expect(
      await getManagedActivity(runtime, f.activity.id, f.author),
    ).toMatchObject({ version: 1, openedAt: null });
    expect(
      (await openActivity(runtime, f.activity.id, f.author, 1)).status,
    ).toBe("active");
  });
});
