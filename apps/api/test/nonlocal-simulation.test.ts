import { env } from "cloudflare:test";
import { emptyActivityInput, type LdcActivityInput } from "@hb/contracts";
import { describe, expect, it } from "vitest";
import {
  claimActivity,
  completeClaimSubmission,
  prepareClaimSubmission,
} from "../src/activities/claim-service";
import {
  createActivity,
  getManagedActivity,
  getPublicActivity,
  openActivity,
  updateActivity,
} from "../src/activities/service";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";

const local = { ...env, APP_ENV: "local" } as ApiBindings;
const externalEnvironments = ["staging", "production", undefined] as const;
function external(APP_ENV: (typeof externalEnvironments)[number]) {
  return { ...env, APP_ENV, LDC_NETWORK_MODE: "live" } as ApiBindings;
}
async function actor() {
  const id = crypto.randomUUID(),
    now = new Date();
  await createDb(env.DB).insert(users).values({
    id,
    externalId: id,
    username: id,
    displayName: "simulation test",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
async function fixture(open = true) {
  const owner = await actor(),
    recipient = await actor();
  const merchant = await createMerchant(local, owner, {
    requestId: crypto.randomUUID(),
    mode: "simulation",
    clientId: `sim_${crypto.randomUUID()}`,
    label: "isolated simulation",
    secret: "test-only",
  });
  const { rewardType: _type, ...base } = emptyActivityInput();
  const input: LdcActivityInput = {
    ...base,
    title: "historical simulation",
    rewardType: "ldc",
    merchantId: merchant.id,
    passwords: ["Correct123"],
    forceDedicated: true,
    joinSquare: true,
    money: { mode: "fixed", count: 3, totalAmount: "0.30" },
  };
  const draft = await createActivity(local, owner, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  const activity = open
    ? await openActivity(local, draft.id, owner, draft.version)
    : draft;
  return { owner, recipient, merchant, input, activity };
}
async function counts(id: string) {
  return env.DB.prepare(`SELECT claimed_count AS allocated,
    (SELECT COUNT(*) FROM redemption_submissions WHERE activity_id=?) AS submissions,
    (SELECT COUNT(*) FROM attempt_events WHERE activity_id=?) AS events,
    (SELECT COUNT(*) FROM claims WHERE activity_id=?) AS claims,
    (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=?) AS tasks
    FROM activities WHERE id=?`)
    .bind(id, id, id, id, id)
    .first();
}
const submit = () => ({
  submissionId: crypto.randomUUID(),
  password: "Correct123",
});

describe("nonlocal historical simulation isolation", () => {
  it.each(externalEnvironments)(
    "does not validate or allocate new simulation claims in %s",
    async (mode) => {
      const f = await fixture();
      await expect(
        claimActivity(external(mode), f.activity.id, f.recipient, submit()),
      ).rejects.toMatchObject({ code: "SIMULATION_NOT_AVAILABLE" });
      expect(await counts(f.activity.id)).toEqual({
        allocated: 0,
        submissions: 0,
        events: 0,
        claims: 0,
        tasks: 0,
      });
    },
  );
  it("does not resume a locally validated simulation submission outside local", async () => {
    const f = await fixture(),
      input = submit();
    const pending = await prepareClaimSubmission(
      local,
      f.activity.id,
      f.recipient,
      input,
    );
    for (const mode of externalEnvironments)
      await expect(
        completeClaimSubmission(external(mode), pending),
      ).rejects.toMatchObject({ code: "SIMULATION_NOT_AVAILABLE" });
    expect(await counts(f.activity.id)).toEqual({
      allocated: 0,
      submissions: 1,
      events: 1,
      claims: 0,
      tasks: 0,
    });
    const result = await completeClaimSubmission(local, pending);
    expect(result.result).toBe("claimed");
    expect(await counts(f.activity.id)).toEqual({
      allocated: 1,
      submissions: 1,
      events: 1,
      claims: 1,
      tasks: 1,
    });
  });
  it("preserves reward reads and submission replay after moving out of local", async () => {
    const f = await fixture(),
      input = submit();
    const original = await claimActivity(
      local,
      f.activity.id,
      f.recipient,
      input,
    );
    for (const mode of externalEnvironments) {
      expect(
        await claimActivity(external(mode), f.activity.id, f.recipient, input),
      ).toEqual(original);
      const again = await claimActivity(
        external(mode),
        f.activity.id,
        f.recipient,
        submit(),
      );
      expect(again.result).toBe("already_claimed");
      if ("claim" in original && "claim" in again)
        expect(again.claim.id).toBe(original.claim.id);
      expect(
        await getPublicActivity(external(mode), f.activity.id),
      ).toMatchObject({ id: f.activity.id, paymentMode: "simulation" });
    }
    const saved = (await counts(f.activity.id)) as {
      allocated: number;
      events: number;
      claims: number;
      tasks: number;
    };
    expect(saved).toMatchObject({
      allocated: 1,
      events: 1,
      claims: 1,
      tasks: 1,
    });
  });
  it.each(externalEnvironments)(
    "rejects new simulation drafts and rebindings in %s",
    async (mode) => {
      const f = await fixture(false),
        runtime = external(mode);
      await expect(
        createActivity(runtime, f.owner, {
          requestId: crypto.randomUUID(),
          activity: f.input,
        }),
      ).rejects.toMatchObject({ code: "SIMULATION_NOT_AVAILABLE" });
      await expect(
        updateActivity(runtime, f.activity.id, f.owner, {
          version: f.activity.version,
          activity: { ...f.input, title: "changed" },
        }),
      ).rejects.toMatchObject({ code: "SIMULATION_NOT_AVAILABLE" });
      expect(
        await getManagedActivity(runtime, f.activity.id, f.owner),
      ).toMatchObject({ version: f.activity.version, title: f.input.title });
      const second = await createActivity(local, f.owner, {
        requestId: crypto.randomUUID(),
        activity: { ...f.input, title: "second LDC draft" },
      });
      await expect(
        updateActivity(runtime, second.id, f.owner, {
          version: second.version,
          activity: f.input,
        }),
      ).rejects.toMatchObject({ code: "SIMULATION_NOT_AVAILABLE" });
      expect(
        await getManagedActivity(runtime, second.id, f.owner),
      ).toMatchObject({ version: second.version, rewardType: "ldc" });
    },
  );
});
