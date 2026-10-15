import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  emptyActivityInput,
  formatAmount,
  type LdcActivityInput,
} from "@hb/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DrawPlan,
  drawAmounts,
  publishDrawPlan,
  sampleOrdinals,
  saveDrawPlan,
} from "../src/activities/draw-service";
import { createActivity, openActivity } from "../src/activities/service";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { createRealPaymentAdapter } from "../src/payments/real-protocol";
import { runMerchantCycle } from "../src/payments/scheduler";

const live: ApiBindings = {
  ...env,
  APP_ENV: "production",
  LDC_NETWORK_MODE: "live",
  LDC_TIMED_DRAW_ENABLED: "true",
  LDC_STOP_NEW_OPENINGS: "false",
  LDC_STOP_NEW_CLAIMS: "false",
  LDC_STOP_SENDS: "false",
};
const nowSql = "CAST(unixepoch('now')*1000 AS INTEGER)";

async function fixture(prizes: number, population = prizes) {
  const authorId = crypto.randomUUID();
  const suffix = authorId.replaceAll("-", "");
  const people = Array.from({ length: population }, (_, i) => ({
    id: crypto.randomUUID(),
    registrationId: crypto.randomUUID(),
    externalId: (
      BigInt(`0x${suffix.slice(0, 12)}`) * 2000n +
      BigInt(i + 1)
    ).toString(),
    username: `draw_${i}_${suffix.slice(0, 6)}`,
    ordinal: i + 1,
  }));
  const author = {
    id: authorId,
    externalId: `a_${suffix}`,
    username: `owner_${suffix}`,
  };
  await env.DB.prepare(`INSERT INTO users(id,provider,external_id,username,display_name,created_at,updated_at)
    SELECT json_extract(value,'$.id'),'linux_do',json_extract(value,'$.externalId'),json_extract(value,'$.username'),json_extract(value,'$.username'),${nowSql},${nowSql} FROM json_each(?)`)
    .bind(JSON.stringify([author, ...people]))
    .run();
  const merchant = await createMerchant(env, authorId, {
    requestId: crypto.randomUUID(),
    clientId: `draw_real_${suffix}`,
    label: "test draw",
    mode: "real",
    secret: "draw-test-only-secret",
  });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE merchant_credentials SET verification_status='passed',verification_checked_at=${nowSql} WHERE merchant_id=?`,
    ).bind(merchant.id),
    env.DB.prepare(
      "UPDATE platform_controls SET version=version+1,allow_real_open=1,allow_real_claim=1,allow_real_send=1 WHERE id='global'",
    ),
  ]);
  const common = emptyActivityInput();
  const config: LdcActivityInput = {
    ...common,
    rewardType: "ldc",
    title: "bulk timed test",
    merchantId: merchant.id,
    passwords: ["DrawBulk123"],
    allocation: "random",
    money: {
      mode: "timed_draw",
      count: prizes,
      totalAmount: formatAmount(prizes),
      algorithm: "bounded_mean_v1",
      participantLimit: population,
      countdownSeconds: 3600,
      distributeFullPool: true,
    },
  };
  const draft = await createActivity(live, authorId, {
    requestId: crypto.randomUUID(),
    activity: config,
  });
  const activity = await openActivity(live, draft.id, authorId, draft.version);
  const password = await env.DB.prepare(
    "SELECT id FROM activity_passwords WHERE activity_id=?",
  )
    .bind(activity.id)
    .first<{ id: string }>();
  if (!password) throw new Error("fixture password missing");
  // Capacity fixture uses the real registration constraints. An isolated AFTER
  // trigger performs the same count/close updates so 1001 entries can be seeded
  // in one SQL statement without spending thousands of fixture queries.
  const trigger = `fixture_draw_count_${suffix}`;
  await env.DB.batch([
    env.DB.prepare(`CREATE TRIGGER ${trigger} AFTER INSERT ON activity_registrations WHEN NEW.activity_id='${activity.id}' BEGIN
      UPDATE activities SET registered_count=registered_count+1,
      draw_state=CASE WHEN registered_count+1=${population} THEN 'settling' ELSE draw_state END,
      draw_closed_at=CASE WHEN registered_count+1=${population} THEN ${nowSql} ELSE NULL END,
      draw_reason=CASE WHEN registered_count+1=${population} THEN 'full' ELSE NULL END,
      ended_at=CASE WHEN registered_count+1=${population} THEN ${nowSql} ELSE NULL END,
      end_reason=CASE WHEN registered_count+1=${population} THEN 'exhausted' ELSE NULL END
      WHERE id=NEW.activity_id;
    END`),
    env.DB.prepare(`INSERT INTO activity_registrations(id,activity_id,user_id,password_id,ordinal,recipient_id,registered_at)
      SELECT json_extract(value,'$.registrationId'),?,json_extract(value,'$.id'),?,json_extract(value,'$.ordinal'),json_extract(value,'$.externalId'),${nowSql}
      FROM json_each(?) ORDER BY CAST(json_extract(value,'$.ordinal') AS INTEGER)`).bind(
      activity.id,
      password.id,
      JSON.stringify(people),
    ),
    env.DB.prepare(`DROP TRIGGER ${trigger}`),
  ]);
  const saved = await saveDrawPlan(live, activity.id);
  if (!saved) throw new Error("fixture plan missing");
  return {
    activity,
    merchant,
    people,
    saved,
    plan: JSON.parse(saved.payload) as DrawPlan,
  };
}

async function counts(id: string) {
  return env.DB.prepare(`SELECT draw_state,draw_published_at,registered_count,claimed_count,
    (SELECT COUNT(*) FROM reward_inventory WHERE activity_id=a.id) AS inventory,
    (SELECT COUNT(*) FROM claims WHERE activity_id=a.id) AS claims,
    (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS tasks,
    (SELECT COUNT(*) FROM payment_outbox o JOIN payment_tasks p ON p.id=o.task_id JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS outbox
    FROM activities a WHERE id=?`)
    .bind(id)
    .first();
}

afterEach(() => vi.restoreAllMocks());

describe("durable draw bulk publication", () => {
  it("shuffles assignment independently even when every participant wins", () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      if (array)
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(
          0,
        );
      return array;
    });
    const result = drawAmounts(
      {
        mode: "timed_draw",
        algorithm: "double_mean_v1",
        totalAmount: "0.30",
        count: 3,
        participantLimit: 3,
        countdownSeconds: 60,
        distributeFullPool: true,
      },
      3,
    );
    expect(result.assignedPositions).toEqual([1, 2, 0]);
    expect(result.amounts.reduce((a, b) => a + b, 0)).toBe(30);
    expect(sampleOrdinals(Number.MAX_SAFE_INTEGER, 1)).toEqual([1]);
    expect(() => sampleOrdinals(2000, 1001)).toThrow();
    expect(() => sampleOrdinals(3, 1.5)).toThrow();
  });
  it("atomically rolls back 1000 winners from 1001 entrants and resumes the identical plan after DO restart", async () => {
    const f = await fixture(1000, 1001);
    expect(f.plan.winners).toHaveLength(1000);
    expect(new Set(f.plan.winners.map((w) => w.userId)).size).toBe(1000);
    expect(new Set(f.plan.winners.map((w) => w.inventoryId)).size).toBe(1000);
    expect(f.plan.winners.reduce((total, w) => total + w.amountMinor, 0)).toBe(
      1000,
    );
    expect(new TextEncoder().encode(f.saved.payload).length).toBeLessThan(
      2 * 1024 * 1024,
    );
    await env.DB.prepare(`CREATE TRIGGER fixture_draw_outbox_failure BEFORE INSERT ON payment_outbox
      WHEN EXISTS(SELECT 1 FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE p.id=NEW.task_id AND c.activity_id='${f.activity.id}')
      BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END`).run();
    const batch = vi.spyOn(env.DB, "batch");
    await expect(publishDrawPlan(live, f.activity.id)).rejects.toThrow();
    expect(await counts(f.activity.id)).toMatchObject({
      draw_state: "settling",
      draw_published_at: null,
      registered_count: 1001,
      claimed_count: 0,
      inventory: 0,
      claims: 0,
      tasks: 0,
      outbox: 0,
    });
    expect(batch.mock.calls[0]?.[0].length).toBeLessThanOrEqual(10);
    expect((await saveDrawPlan(live, f.activity.id))?.payload).toBe(
      f.saved.payload,
    );
    batch.mockRestore();
    await env.DB.prepare("DROP TRIGGER fixture_draw_outbox_failure").run();
    const stub = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(f.activity.id));
    await runInDurableObject(stub, async () => {});
    await evictDurableObject(stub);
    const start = performance.now();
    const response = await stub.fetch(
      `https://activity.internal/internal/activities/${f.activity.id}/refresh`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(performance.now() - start).toBeLessThan(30_000);
    expect(await counts(f.activity.id)).toMatchObject({
      draw_state: "completed",
      registered_count: 1001,
      claimed_count: 1000,
      inventory: 1000,
      claims: 1000,
      tasks: 1000,
      outbox: 1000,
    });
    const ids = await env.DB.prepare(
      "SELECT p.id,p.claim_id,p.business_no,p.recipient_id,p.amount_minor FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=? ORDER BY p.id",
    )
      .bind(f.activity.id)
      .all();
    await Promise.all([
      publishDrawPlan(live, f.activity.id),
      publishDrawPlan(live, f.activity.id),
    ]);
    expect(
      (
        await env.DB.prepare(
          "SELECT p.id,p.claim_id,p.business_no,p.recipient_id,p.amount_minor FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=? ORDER BY p.id",
        )
          .bind(f.activity.id)
          .all()
      ).results,
    ).toEqual(ids.results);
    expect((await saveDrawPlan(live, f.activity.id))?.payload).toBe(
      f.saved.payload,
    );
  }, 60_000);

  it("retries a concurrent Connect rename without changing the saved winners, amounts or task IDs", async () => {
    const f = await fixture(1);
    const person = f.people[0];
    if (!person) throw new Error("missing participant");
    const originalBatch = env.DB.batch.bind(env.DB);
    let calls = 0;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (calls++ === 0)
        await env.DB.prepare(
          "UPDATE users SET username='RenamedWinner' WHERE id=?",
        )
          .bind(person.id)
          .run();
      return originalBatch(statements);
    });
    expect(await publishDrawPlan(live, f.activity.id)).toBe(true);
    expect(calls).toBe(2);
    const task = await env.DB.prepare("SELECT * FROM payment_tasks WHERE id=?")
      .bind(f.plan.winners[0]?.taskId)
      .first();
    expect(task).toMatchObject({
      recipient_id: person.externalId,
      recipient_username: "RenamedWinner",
      amount_minor: 1,
      recovery_policy: "claim_same_order_v1",
      status: "pending",
    });
    expect((await saveDrawPlan(live, f.activity.id))?.payload).toBe(
      f.saved.payload,
    );
    expect(await counts(f.activity.id)).toMatchObject({
      claims: 1,
      tasks: 1,
      outbox: 1,
    });
  });

  it("settles admitted participants with intake stopped, then pays only through normal live policy and injected HTTP", async () => {
    const f = await fixture(1);
    const stopped: ApiBindings = {
      ...live,
      LDC_TIMED_DRAW_ENABLED: "false",
      LDC_STOP_NEW_OPENINGS: "true",
      LDC_STOP_NEW_CLAIMS: "true",
      LDC_STOP_SENDS: "true",
    };
    expect(await publishDrawPlan(stopped, f.activity.id)).toBe(true);
    let sendCount = 0;
    const winner = f.plan.winners[0];
    if (!winner) throw new Error("missing winner");
    const businessNo = `hb_${winner.claimId.replaceAll("-", "")}`;
    const transport = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url));
        if (init?.method === "POST") {
          sendCount++;
          expect(path.hostname).toBe("credit.example.invalid");
          expect(path.pathname).toBe("/lpay/distribute");
          expect(init.body).toContain(`"out_trade_no":"${businessNo}"`);
          return Response.json({
            error_msg: "",
            data: { trade_no: "TIMED-TRADE", out_trade_no: businessNo },
          });
        }
        return Response.json({
          code: 1,
          pid: f.merchant.clientId,
          out_trade_no: businessNo,
          trade_no: "TIMED-TRADE",
          money: "0.01",
          status: 1,
        });
      },
    );
    const adapter = createRealPaymentAdapter({
      baseUrl: "https://credit.example.invalid",
      fetch: transport,
    });
    await runMerchantCycle(stopped, f.merchant.id, {
      adapterFactory: () => adapter,
    });
    expect(transport).not.toHaveBeenCalled();
    await runMerchantCycle(live, f.merchant.id, {
      adapterFactory: () => adapter,
    });
    await env.DB.prepare(
      "UPDATE payment_tasks SET next_run_at=0,next_query_at=0 WHERE id=?",
    )
      .bind(winner.taskId)
      .run();
    await runMerchantCycle(live, f.merchant.id, {
      adapterFactory: () => adapter,
    });
    expect(
      await env.DB.prepare(
        "SELECT status,attempt_count,business_no,amount_minor FROM payment_tasks WHERE id=?",
      )
        .bind(winner.taskId)
        .first(),
    ).toEqual({
      status: "confirmed",
      attempt_count: 1,
      business_no: businessNo,
      amount_minor: 1,
    });
    await runMerchantCycle(live, f.merchant.id, {
      adapterFactory: () => adapter,
    });
    expect(sendCount).toBe(1);
  });
});
