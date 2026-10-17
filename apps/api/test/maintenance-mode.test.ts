import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { handleQueueMessage } from "../src/queue";
import {
  activityObject,
  merchantObject,
  objectNames,
} from "../src/runtime/objects";
import { runScheduled } from "../src/scheduled";

// docs/d1-apac-migration.md: 维护模式 stops every write while D1 moves, and
// DO_LOCATION_HINT / DO_NAME_PREFIX place and rename Durable Objects.

const origin = "https://hb.example.com";
const maintenance: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  MAINTENANCE_MODE: "true",
};
const renamed: ApiBindings = {
  ...env,
  DO_NAME_PREFIX: "apac:",
  DO_LOCATION_HINT: "apac",
};
const alarmed: DurableObjectStub[] = [];

/** Runs `action` in the object as if it had been deployed with `bindings`. */
function inObject<T>(
  stub: DurableObjectStub,
  bindings: ApiBindings,
  action: (
    instance: {
      alarm(): Promise<unknown>;
      fetch(request: Request): Promise<Response>;
    },
    state: DurableObjectState,
  ) => Promise<T>,
) {
  alarmed.push(stub);
  return runInDurableObject(stub, async (instance, state) => {
    (instance as unknown as { env: ApiBindings }).env = bindings;
    return action(instance as never, state);
  });
}

afterEach(async () => {
  for (const stub of alarmed.splice(0))
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  vi.restoreAllMocks();
});

async function merchantFixture() {
  const userId = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id: userId,
      externalId: String(80_000 + Math.floor(Math.random() * 10_000)),
      username: `Moving${userId.slice(0, 6)}`,
      displayName: "迁移商户",
      createdAt: now,
      updatedAt: now,
    });
  const clientId = `move_${userId.replaceAll("-", "")}`;
  const merchant = await createMerchant(env, userId, {
    requestId: crypto.randomUUID(),
    clientId,
    label: "迁移测试商户",
    secret: "LOCAL-ONLY",
  });
  return { merchantId: merchant.id, clientId };
}

describe("Durable Object placement", () => {
  it("names the long-lived objects with the prefix, and a 红包's by its id", () => {
    expect(objectNames.creation(env, "u1")).toBe("activity-create:u1");
    expect(objectNames.globalRedemption(renamed, "u1")).toBe(
      "apac:global-redemption:u1",
    );
    expect(objectNames.maintenance(renamed)).toBe("apac:maintenance:v1");
    expect(objectNames.merchant(renamed, "client")).toBe("apac:client");
    expect(
      activityObject(renamed, "11111111-1111-4111-8111-111111111111").id.equals(
        env.ACTIVITY_DO.idFromName("11111111-1111-4111-8111-111111111111"),
      ),
    ).toBe(true);
    expect(
      merchantObject(renamed, "client").id.equals(
        env.MERCHANT_DO.idFromName("apac:client"),
      ),
    ).toBe(true);
  });

  it("asks for the hinted place only when one is set", () => {
    const get = vi.fn();
    const namespace = {
      idFromName: (name: string) => ({ name }),
      get,
    };
    activityObject(
      { ...env, ACTIVITY_DO: namespace } as unknown as ApiBindings,
      "a",
    );
    activityObject(
      {
        ...renamed,
        ACTIVITY_DO: namespace,
      } as unknown as ApiBindings,
      "a",
    );
    activityObject(
      {
        ...env,
        DO_LOCATION_HINT: "nowhere",
        ACTIVITY_DO: namespace,
      } as unknown as ApiBindings,
      "a",
    );
    expect(get.mock.calls).toEqual([
      [{ name: "a" }],
      [{ name: "a" }, { locationHint: "apac" }],
      [{ name: "a" }],
    ]);
  });

  it("lets a renamed merchant object run, and an old one clear itself and stop", async () => {
    const { merchantId, clientId } = await merchantFixture();
    const old = env.MERCHANT_DO.get(env.MERCHANT_DO.idFromName(clientId));
    await inObject(old, renamed, async (instance, state) => {
      await state.storage.put("merchantId", merchantId);
      await state.storage.setAlarm(Date.now() + 3_600_000);
      const refused = await instance.fetch(
        new Request("https://merchant.internal/internal/payments/run", {
          method: "POST",
          body: JSON.stringify({ merchantId }),
        }),
      );
      expect(refused.status).toBe(400);
      await instance.alarm();
      expect(await state.storage.get("merchantId")).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    const current = env.MERCHANT_DO.get(
      env.MERCHANT_DO.idFromName(`apac:${clientId}`),
    );
    await inObject(current, renamed, async (instance, state) => {
      const ran = await instance.fetch(
        new Request("https://merchant.internal/internal/payments/run", {
          method: "POST",
          body: JSON.stringify({ merchantId }),
        }),
      );
      expect(ran.status).toBe(200);
      await instance.alarm();
      expect(await state.storage.get("merchantId")).toBe(merchantId);
    });
  });
});

describe("维护模式", () => {
  it("answers every API request but the health check with 503", async () => {
    const health = await app.request(`${origin}/api/health`, {}, maintenance);
    expect(health.status).toBe(200);
    for (const [path, method] of [
      ["/api/session", "GET"],
      ["/api/activities/11111111-1111-4111-8111-111111111111/claim", "POST"],
      ["/api/me/merchants", "GET"],
    ]) {
      const response = await app.request(
        `${origin}${path}`,
        { method, headers: { Origin: origin } },
        maintenance,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(await response.json()).toEqual({
        error: { code: "MAINTENANCE", message: "系统维护中，请稍后再试。" },
      });
    }
  });

  it("sends a page opened at the API to the start page", async () => {
    for (const headers of [
      { "Sec-Fetch-Mode": "navigate" },
      { Accept: "text/html,application/xhtml+xml" },
    ] as Record<string, string>[]) {
      const response = await app.request(
        `${origin}/api/auth/login?returnTo=%2Fme`,
        { headers },
        maintenance,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const posted = await app.request(
      `${origin}/api/auth/logout`,
      { method: "POST", headers: { "Sec-Fetch-Mode": "navigate" } },
      maintenance,
    );
    expect(posted.status).toBe(503);
  });

  it("skips the cron's run without waking its object", async () => {
    const untouched = new Proxy(
      {},
      {
        get() {
          throw new Error("maintenance mode woke an object");
        },
      },
    );
    await runScheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now() } as ScheduledController,
      { ...maintenance, ACTIVITY_DO: untouched } as unknown as ApiBindings,
      {} as ExecutionContext,
    );
  });

  it("keeps every queued message waiting", async () => {
    const retry = vi.fn();
    const ack = vi.fn();
    const result = await handleQueueMessage(
      {
        body: { type: "payment.wake", taskId: "t1" },
        retry,
        ack,
      } as unknown as Message<unknown>,
      maintenance,
    );
    expect(result).toBe("retry");
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 600 });
    expect(ack).not.toHaveBeenCalled();
  });

  it("puts a 红包's and a merchant's alarm off by a minute", async () => {
    for (const stub of [
      env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(crypto.randomUUID())),
      env.MERCHANT_DO.get(env.MERCHANT_DO.idFromName("move_alarm")),
    ])
      await inObject(stub, maintenance, async (instance, state) => {
        await state.storage.put("merchantId", "not-read-in-maintenance");
        const before = Date.now();
        await instance.alarm();
        const next = await state.storage.getAlarm();
        expect(next).toBeGreaterThanOrEqual(before + 60_000);
        expect(next).toBeLessThan(before + 61_000);
      });
  });
});
