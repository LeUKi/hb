import { env } from "cloudflare:test";
import {
  emptyActivityInput,
  type LdcActivityInput,
  type PaymentMode,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { readMerchantImpact } from "../src/payments/configuration";
import { createMerchant, updateMerchant } from "../src/payments/merchants";
import { sha256Hex } from "../src/security/crypto";

const origin = "https://opening.example.test";
const realRuntime: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  APP_ENV: "production",
  LDC_NETWORK_MODE: "live",
};
const localRuntime: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  APP_ENV: "local",
  LDC_NETWORK_MODE: "disabled",
};

async function fixture(mode: PaymentMode = "real") {
  const authorId = crypto.randomUUID();
  const now = new Date();
  const token = crypto.randomUUID();
  const csrfToken = crypto.randomUUID();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id: authorId,
    externalId: BigInt(
      `0x${authorId.replaceAll("-", "").slice(0, 15)}`,
    ).toString(),
    username: `Opening_${authorId.slice(0, 8)}`,
    displayName: "Opening fixture",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: authorId,
    csrfToken,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 3600000),
  });
  const runtime = mode === "real" ? realRuntime : localRuntime;
  const merchant = await createMerchant(runtime, authorId, {
    requestId: crypto.randomUUID(),
    clientId: `opening_${crypto.randomUUID()}`,
    label: "Opening fixture",
    mode,
    secret: "TEST-ONLY-OPENING-CREDENTIAL",
  });
  const base = emptyActivityInput();
  const input: LdcActivityInput = {
    ...base,
    rewardType: "ldc",
    merchantId: merchant.id,
    title: "Opening expectation fixture",
    passwords: ["Correct123"],
    money: { mode: "fixed", totalAmount: "0.30", count: 3 },
  };
  const activity = await createActivity(runtime, authorId, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  await verified(merchant.id);
  return { runtime, authorId, merchant, activity, token, csrfToken };
}

async function verified(merchantId: string) {
  await env.DB.prepare(`UPDATE merchant_credentials
    SET verification_status='passed',verification_checked_at=?
    WHERE merchant_id=? AND version=(SELECT credential_version FROM merchants WHERE id=?)`)
    .bind(Date.now(), merchantId, merchantId)
    .run();
}

async function rotate(f: Awaited<ReturnType<typeof fixture>>) {
  const merchant = await updateMerchant(f.runtime, f.merchant.id, f.authorId, {
    confirmationToken: (await readMerchantImpact(f.runtime, f.merchant))
      .confirmationToken,
    version: f.merchant.version,
    label: f.merchant.label,
    secret: "TEST-ONLY-ROTATED-OPENING-CREDENTIAL",
  });
  await verified(merchant.id);
  return merchant;
}

async function snapshot(id: string) {
  const [activity, inventory] = await Promise.all([
    env.DB.prepare("SELECT * FROM activities WHERE id=?").bind(id).first(),
    env.DB.prepare(
      "SELECT * FROM reward_inventory WHERE activity_id=? ORDER BY position",
    )
      .bind(id)
      .all(),
  ]);
  return { activity, inventory: inventory.results };
}

function httpOpen(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  return app.request(
    `${origin}/api/me/activities/${f.activity.id}/open`,
    {
      method: "POST",
      headers: {
        Cookie: `hb_session=${f.token}`,
        Origin: origin,
        "X-CSRF-Token": f.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: f.activity.version,
        merchantId: f.merchant.id,
        credentialVersion: f.merchant.credentialVersion,
        ...overrides,
      }),
    },
    f.runtime,
  );
}

beforeEach(async () => {
  // Only publication is exercised. No allocations or payment sends are enabled.
  await env.DB.prepare(`UPDATE platform_controls
    SET version=version+1,allow_real_open=1,allow_real_claim=0,allow_real_send=0,updated_at=?
    WHERE id='global'`)
    .bind(Date.now())
    .run();
});
afterEach(() => vi.restoreAllMocks());

describe("activity opening expectations", () => {
  it("rejects a stale merchant expectation without changing the draft or saved inventory", async () => {
    const f = await fixture();
    const before = await snapshot(f.activity.id);
    await expect(
      openActivity(
        f.runtime,
        f.activity.id,
        f.authorId,
        f.activity.version,
        undefined,
        {
          merchantId: crypto.randomUUID(),
          credentialVersion: f.merchant.credentialVersion,
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: "ACTIVITY_CONFLICT" });
    expect(await snapshot(f.activity.id)).toEqual(before);
  });

  it("rejects a stale credential expectation even when the replacement credential already passed verification", async () => {
    const f = await fixture();
    const current = await rotate(f);
    expect(current.credentialVersion).toBe(f.merchant.credentialVersion + 1);
    const before = await snapshot(f.activity.id);
    await expect(
      openActivity(
        f.runtime,
        f.activity.id,
        f.authorId,
        f.activity.version,
        undefined,
        {
          merchantId: f.merchant.id,
          credentialVersion: f.merchant.credentialVersion,
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: "ACTIVITY_CONFLICT" });
    expect(await snapshot(f.activity.id)).toEqual(before);
    const opened = await openActivity(
      f.runtime,
      f.activity.id,
      f.authorId,
      f.activity.version,
      undefined,
      {
        merchantId: current.id,
        credentialVersion: current.credentialVersion,
      },
    );
    expect(opened.status).toBe("active");
  });

  it("carries stale merchant and credential expectations through HTTP and ActivityDO", async () => {
    const f = await fixture("simulation");
    const before = await snapshot(f.activity.id);
    const wrongMerchant = await httpOpen(f, {
      merchantId: crypto.randomUUID(),
    });
    expect(wrongMerchant.status).toBe(409);
    expect(await wrongMerchant.json()).toMatchObject({
      error: { code: "ACTIVITY_CONFLICT" },
    });
    expect(await snapshot(f.activity.id)).toEqual(before);
    const current = await rotate(f);
    const staleCredential = await httpOpen(f);
    expect(staleCredential.status).toBe(409);
    expect(await staleCredential.json()).toMatchObject({
      error: { code: "ACTIVITY_CONFLICT" },
    });
    expect(await snapshot(f.activity.id)).toEqual(before);
    const opened = await httpOpen(f, {
      credentialVersion: current.credentialVersion,
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
      activity: { status: "active" },
    });
  });

  it("rolls the whole opening back when a credential rotates and passes between validation and the D1 CAS", async () => {
    const f = await fixture();
    const before = await snapshot(f.activity.id);
    const originalBatch = env.DB.batch.bind(env.DB);
    // The first batch reads private configuration after eligibility was checked.
    // Persist a genuine, freshly verified rotation before the final opening CAS.
    const raced = vi
      .spyOn(env.DB, "batch")
      .mockImplementationOnce(async (statements) => {
        const result = await originalBatch(statements);
        await rotate(f);
        return result;
      });
    await expect(
      openActivity(
        f.runtime,
        f.activity.id,
        f.authorId,
        f.activity.version,
        undefined,
        {
          merchantId: f.merchant.id,
          credentialVersion: f.merchant.credentialVersion,
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: "ACTIVITY_CONFLICT" });
    expect(raced).toHaveBeenCalled();
    expect(await snapshot(f.activity.id)).toEqual(before);
    expect(
      await env.DB.prepare(
        "SELECT credential_version FROM merchants WHERE id=?",
      )
        .bind(f.merchant.id)
        .first("credential_version"),
    ).toBe(f.merchant.credentialVersion + 1);
    const opened = await openActivity(
      f.runtime,
      f.activity.id,
      f.authorId,
      f.activity.version,
      undefined,
      {
        merchantId: f.merchant.id,
        credentialVersion: f.merchant.credentialVersion + 1,
      },
    );
    expect(opened.status).toBe("active");
    expect((await snapshot(f.activity.id)).inventory).toEqual(before.inventory);
  });

  it("replays an already-opened HTTP activity before rejecting old expectations and preserves its original times", async () => {
    const f = await fixture("simulation");
    const initial = await httpOpen(f);
    expect(initial.status).toBe(200);
    const opened = await initial.json();
    await rotate(f);
    const before = await snapshot(f.activity.id);
    const replay = await httpOpen(f, { merchantId: crypto.randomUUID() });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(opened);
    expect(await snapshot(f.activity.id)).toEqual(before);
  });

  it("replays a real opening with old merchant, credential and activity versions without restarting its duration", async () => {
    const f = await fixture();
    const opened = await openActivity(
      f.runtime,
      f.activity.id,
      f.authorId,
      f.activity.version,
      undefined,
      {
        merchantId: f.merchant.id,
        credentialVersion: f.merchant.credentialVersion,
      },
    );
    await rotate(f);
    const before = await snapshot(f.activity.id);
    const replayed = await openActivity(
      f.runtime,
      f.activity.id,
      f.authorId,
      f.activity.version,
      undefined,
      {
        merchantId: crypto.randomUUID(),
        credentialVersion: f.merchant.credentialVersion,
      },
    );
    expect(replayed).toEqual(opened);
    expect(await snapshot(f.activity.id)).toEqual(before);
  });

  it("preserves the fifth argument's test policy and never mistakes it for an opening expectation", async () => {
    const f = await fixture();
    const disabled = {
      ...f.runtime,
      APP_ENV: "local",
      LDC_NETWORK_MODE: "disabled",
    };
    const policy = { canUseRealActivity: (id: string) => id === f.activity.id };
    const network = vi.spyOn(globalThis, "fetch");
    const opened = await openActivity(
      disabled,
      f.activity.id,
      f.authorId,
      f.activity.version,
      policy,
    );
    expect(opened.status).toBe("active");
    expect(network).not.toHaveBeenCalled();
  });
});
