import type { PaymentMode } from "@hb/contracts";
import { and, eq, lte, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { merchants, paymentTasks } from "../db/schema";
import type { ApiBindings } from "../env";
import {
  allowsRealSending,
  isLocalSimulation,
  readPlatformControls,
} from "../runtime/controls";
import { merchantObject } from "../runtime/objects";
import {
  type AdapterResult,
  ensureEvidenceMatchesTask,
  type PaymentAdapterFactory,
  type PaymentTaskRow,
} from "./adapter";
import {
  merchantOwnsClientId,
  synchronizeMerchantPaymentIdentities,
} from "./identity";
import {
  ordinaryPaymentSql,
  realQueryDecision,
  realSendDecision,
  runtimeRealPolicy,
} from "./policy";
import { quotaResumeAt } from "./quota";
import { createRealPaymentAdapter } from "./real-protocol";
import { realMerchantNextDue, runRealMerchantCycle } from "./recovery";
import { createSimulationPaymentAdapter } from "./simulation";

const LEASE_MS = 30_000;
export type PaymentWake = { type: "payment.wake"; taskId: string };
export type CycleResult = {
  processed: boolean;
  nextRunAt: number | null;
  /** A task whose status or reason this cycle changed (what its page shows). */
  moved?: string;
};
export type MerchantCycleOptions = {
  adapterFactory?: PaymentAdapterFactory;
};

type MerchantRow = typeof merchants.$inferSelect;

function backoff(attempt: number) {
  const base = Math.min(300_000, 1000 * 2 ** Math.min(attempt, 8));
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return Math.ceil(base * (0.75 + ((random[0] ?? 0) / 2 ** 32) * 0.5));
}
async function loadTask(env: ApiBindings, id: string) {
  return createDb(env.DB)
    .select()
    .from(paymentTasks)
    .where(eq(paymentTasks.id, id))
    .get();
}

/** Shared by the alarm snapshot and Cron so delivered Outbox entries never lose responsibility. */
async function runnableTaskSql(env: ApiBindings) {
  const policy = runtimeRealPolicy(env);
  const conditions: string[] = [];
  const values: string[] = [];
  if (isLocalSimulation(env)) conditions.push("p.mode='simulation'");
  if (
    env.APP_ENV === "production" &&
    (policy.networkMode === "live" || policy.networkMode === "verify")
  ) {
    const sendEnabled = allowsRealSending(env, await readPlatformControls(env));
    conditions.push(
      `(p.mode='real' AND ${ordinaryPaymentSql("p")} AND (p.first_send_at IS NOT NULL${sendEnabled ? " OR p.first_send_at IS NULL" : ""}))`,
    );
  }
  if (
    policy.appEnv !== "local" ||
    (policy.networkMode !== "verify" && policy.networkMode !== "acceptance")
  )
    return { condition: conditions.join(" OR ") || "0", values };
  const pendingAcceptance =
    policy.networkMode === "acceptance" && policy.acceptanceId
      ? " OR a.id=?"
      : "";
  conditions.push(
    `(p.mode='real' AND p.source='acceptance' AND a.id IS NOT NULL AND (a.send_consumed_at IS NOT NULL${pendingAcceptance}))`,
  );
  if (pendingAcceptance && policy.acceptanceId)
    values.push(policy.acceptanceId);
  return { condition: conditions.join(" OR "), values };
}

async function nextDue(
  env: ApiBindings,
  merchantId: string,
): Promise<number | null> {
  const merchant = await createDb(env.DB)
    .select()
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .get();
  if (!merchant) return null;
  if (merchant.mode === "real") return realMerchantNextDue(env, merchantId);
  if (merchant.activeTaskId) {
    const active = await loadTask(env, merchant.activeTaskId);
    if (!active || active.status === "attention") return null;
    if (merchant.leaseUntil && merchant.leaseUntil > Date.now())
      return merchant.leaseUntil;
    if (active.status === "confirmed") return null;
    if (active.mode === "real") {
      const decision = needsRealQuery(active)
        ? await realQueryDecision(env, active)
        : await realSendDecision(env, active);
      if (!decision.allowed) return null;
    }
    return Math.max(Date.now() + 100, active.nextRunAt);
  }
  const runnable = await runnableTaskSql(env);
  return (
    (
      await env.DB.prepare(
        `SELECT MIN(p.next_run_at) AS due FROM payment_tasks p
         LEFT JOIN payment_acceptances a ON a.id=p.acceptance_id
         WHERE p.merchant_id=? AND p.status IN ('pending','waiting','reconciling','sending') AND (${runnable.condition})`,
      )
        .bind(merchantId, ...runnable.values)
        .first<{ due: number | null }>()
    )?.due ?? null
  );
}

function defaultAdapterFactory(env: ApiBindings): PaymentAdapterFactory {
  return (mode: PaymentMode) => {
    if (mode === "simulation") return createSimulationPaymentAdapter(env);
    if (mode === "real")
      return createRealPaymentAdapter({
        fetch: (input, init) => fetch(input, init),
      });
    return null;
  };
}

function needsRealQuery(task: PaymentTaskRow) {
  return (
    task.attemptCount > 0 ||
    task.unknownOutcome ||
    task.sendAcknowledgedAt !== null ||
    task.status === "sending" ||
    task.status === "reconciling"
  );
}

function isSendOperation(task: PaymentTaskRow) {
  return task.status !== "reconciling" && task.status !== "sending";
}

/** Claims a short durable lease. Network work occurs outside this database transaction. */
export async function runMerchantCycle(
  env: ApiBindings,
  merchantId: string,
  options: MerchantCycleOptions = {},
): Promise<CycleResult> {
  const db = createDb(env.DB);
  const now = Date.now();
  let merchant = (await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .get()) as MerchantRow | undefined;
  if (!merchant) return { processed: false, nextRunAt: null };
  const merchantMode = merchant.mode;
  if (merchantMode === "real") {
    const adapter = (options.adapterFactory ?? defaultAdapterFactory(env))(
      "real",
    );
    if (adapter?.mode !== "real")
      throw new Error("Unsupported payment channel");
    return runRealMerchantCycle(env, merchantId, adapter);
  }
  if (!isLocalSimulation(env)) return { processed: false, nextRunAt: null };
  if (merchant.leaseUntil && merchant.leaseUntil > now)
    return { processed: false, nextRunAt: merchant.leaseUntil };
  if (merchant.activeTaskId && merchant.leaseToken) {
    // A lost process cannot tell whether its last send reached the upstream.
    const recovered = await env.DB.batch([
      env.DB.prepare(`UPDATE payment_tasks SET status='reconciling',unknown_outcome=1,reason='interrupted',next_run_at=?,updated_at=?
        WHERE id=? AND status IN ('sending','reconciling') AND EXISTS(SELECT 1 FROM merchants WHERE id=? AND lease_token=? AND lease_until<=?)`).bind(
        now,
        now,
        merchant.activeTaskId,
        merchantId,
        merchant.leaseToken,
        now,
      ),
      env.DB.prepare(
        `UPDATE payment_attempts SET outcome='unknown',reason='interrupted',finished_at=? WHERE task_id=? AND token=? AND outcome='started'`,
      ).bind(now, merchant.activeTaskId, merchant.leaseToken),
      env.DB.prepare(
        `UPDATE merchants SET lease_token=NULL,lease_until=NULL,paused_reason='unknown' WHERE id=? AND lease_token=? AND lease_until<=?`,
      ).bind(merchantId, merchant.leaseToken, now),
    ]);
    if (recovered[0]?.meta.changes)
      console.info(
        JSON.stringify({
          event: "ldc_payment_interrupted",
          taskId: merchant.activeTaskId,
          merchantId,
          reason: "interrupted",
        }),
      );
    merchant = (await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .get()) as MerchantRow | undefined;
    if (!merchant) return { processed: false, nextRunAt: null };
  }
  const task = merchant.activeTaskId
    ? await loadTask(env, merchant.activeTaskId)
    : ((await db
        .select()
        .from(paymentTasks)
        .where(
          and(
            eq(paymentTasks.merchantId, merchantId),
            // Fixed literals let SQLite use the matching partial index.
            sql`${paymentTasks.status} IN ('pending','waiting','reconciling','sending')`,
            lte(paymentTasks.nextRunAt, now),
          ),
        )
        .orderBy(paymentTasks.createdAt, paymentTasks.id)
        .limit(1)
        .get()) as PaymentTaskRow | undefined);
  if (
    !task ||
    task.status === "attention" ||
    task.status === "confirmed" ||
    task.nextRunAt > now
  )
    return { processed: false, nextRunAt: await nextDue(env, merchantId) };
  if (
    task.merchantId !== merchantId ||
    !(await merchantOwnsClientId(env, merchantId, task.clientId)) ||
    task.mode !== merchantMode ||
    (task.mode === "simulation" && !task.recipientId.startsWith("simulation:"))
  )
    throw new Error("Payment identity mismatch");
  const adapterFactory = options.adapterFactory ?? defaultAdapterFactory(env);
  const adapter = adapterFactory(task.mode);
  if (!adapter || adapter.mode !== task.mode)
    throw new Error("Unsupported payment channel");
  const operation = isSendOperation(task) ? "send" : "query";
  const token = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const credentialVersion = merchant.credentialVersion;
  try {
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`UPDATE merchants SET version=CASE WHEN (lease_until IS NULL OR lease_until<=?) AND (active_task_id IS NULL OR active_task_id=?) THEN version ELSE NULL END,
        active_task_id=?,lease_token=?,lease_until=?,updated_at=? WHERE id=?`).bind(
        now,
        task.id,
        task.id,
        token,
        now + LEASE_MS,
        now,
        merchantId,
      ),
      env.DB.prepare(`UPDATE payment_tasks SET amount_minor=CASE WHEN status=? AND next_run_at<=? AND attempt_count=? AND reconciliation_count=? AND unknown_outcome=?
        THEN amount_minor ELSE NULL END,
        status=?,attempt_count=attempt_count+?,reconciliation_count=reconciliation_count+?,updated_at=? WHERE id=?`).bind(
        task.status,
        now,
        task.attemptCount,
        task.reconciliationCount,
        Number(task.unknownOutcome),
        operation === "send" ? "sending" : "reconciling",
        Number(operation === "send"),
        Number(operation === "query"),
        now,
        task.id,
      ),
      env.DB.prepare(
        `INSERT INTO payment_attempts (id,task_id,token,operation,outcome,credential_version,started_at,client_id,identity_correction_version) VALUES (?,?,?,?,'started',?,?,?,0)`,
      ).bind(
        attemptId,
        task.id,
        token,
        operation,
        credentialVersion,
        now,
        task.clientId,
      ),
    ];
    await env.DB.batch(statements);
  } catch (error) {
    const updated = await loadTask(env, task.id);
    if (
      updated &&
      (updated.status !== task.status ||
        updated.attemptCount !== task.attemptCount ||
        updated.reconciliationCount !== task.reconciliationCount ||
        updated.unknownOutcome !== task.unknownOutcome)
    )
      return { processed: false, nextRunAt: await nextDue(env, merchantId) };
    const current = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .get();
    if (
      current?.leaseToken !== token &&
      (current?.leaseToken || current?.activeTaskId)
    )
      return { processed: false, nextRunAt: await nextDue(env, merchantId) };
    throw error;
  }
  let status: PaymentTaskRow["status"] = "reconciling";
  let reason: string | null = "unknown";
  let externalOrderId: string | null = null;
  let httpStatus: number | null = null;
  let unknownOutcome = task.unknownOutcome;
  let retainActive = true;
  let outcome: "succeeded" | "rejected" | "unknown" = "unknown";
  let nextRunAt =
    Date.now() + backoff(task.attemptCount + task.reconciliationCount + 1);
  try {
    const applyResult = (result: AdapterResult, phase: "send" | "query") => {
      httpStatus = result.httpStatus ?? null;
      if (
        result.kind === "confirmed" &&
        ensureEvidenceMatchesTask(task, result.evidence, phase)
      ) {
        status = "confirmed";
        reason = null;
        externalOrderId = result.evidence.externalOrderId ?? null;
        unknownOutcome = false;
        retainActive = false;
        outcome = "succeeded";
        return;
      }
      if (
        result.kind === "confirmed" ||
        result.kind === "sent" ||
        result.kind === "conflict" ||
        (result.kind === "waiting" &&
          task.mode === "simulation" &&
          task.unknownOutcome)
      ) {
        status = result.kind === "waiting" ? "reconciling" : "attention";
        reason = "conflict";
        unknownOutcome = true;
        outcome = result.kind === "waiting" ? "unknown" : "rejected";
        return;
      }
      if (result.kind === "waiting") {
        status = "waiting";
        reason = result.reason;
        outcome = "rejected";
        // The daily limit holds the whole merchant until the day turns: it
        // keeps this task, and the rest queue behind it (quota.ts).
        retainActive = result.reason === "quota";
        nextRunAt =
          result.reason === "quota"
            ? quotaResumeAt(Date.now())
            : Date.now() + 30_000;
        return;
      }
      if (result.kind === "not_found" && phase === "query") {
        status = "pending";
        reason = "checking_not_found";
        unknownOutcome = true;
        outcome = "succeeded";
        return;
      }
      status = "reconciling";
      reason = result.reason ?? "unknown";
      unknownOutcome = true;
      outcome = "unknown";
    };
    if (operation === "query") {
      applyResult(
        await adapter.query(task, {
          credentialVersion,
        }),
        "query",
      );
    } else {
      applyResult(
        await adapter.send(task, {
          credentialVersion,
        }),
        "send",
      );
    }
  } catch {
    status = "reconciling";
    reason = "unknown";
    unknownOutcome = true;
  }
  const finishedAt = Date.now();
  const saved = await env.DB.batch([
    env.DB.prepare(`UPDATE payment_tasks SET status=?,reason=?,unknown_outcome=?,external_order_id=COALESCE(?,external_order_id),next_run_at=?,updated_at=?,confirmed_at=?
      WHERE id=? AND EXISTS(SELECT 1 FROM merchants WHERE id=? AND lease_token=?)`).bind(
      status,
      reason,
      Number(unknownOutcome),
      externalOrderId,
      nextRunAt,
      finishedAt,
      (status as string) === "confirmed" ? finishedAt : null,
      task.id,
      merchantId,
      token,
    ),
    env.DB.prepare(
      `UPDATE payment_attempts SET outcome=?,reason=?,http_status=?,finished_at=? WHERE id=? AND EXISTS(SELECT 1 FROM merchants WHERE id=? AND lease_token=?)`,
    ).bind(
      outcome,
      reason,
      httpStatus,
      finishedAt,
      attemptId,
      merchantId,
      token,
    ),
    env.DB.prepare(
      `UPDATE merchants SET active_task_id=?,lease_token=NULL,lease_until=NULL,paused_reason=?,updated_at=? WHERE id=? AND lease_token=?`,
    ).bind(
      retainActive ? task.id : null,
      reason,
      finishedAt,
      merchantId,
      token,
    ),
  ]);
  const moved =
    Boolean(saved[0]?.meta.changes) &&
    (status !== task.status || reason !== task.reason);
  if (saved[0]?.meta.changes) {
    console.info(
      JSON.stringify({
        event: "ldc_payment_attempt",
        taskId: task.id,
        merchantId,
        mode: task.mode,
        operation,
        credentialVersion,
        outcome,
        status,
        reason,
        httpStatus,
      }),
    );
  }
  return {
    processed: true,
    nextRunAt: await nextDue(env, merchantId),
    ...(moved ? { moved: task.id } : {}),
  };
}

export async function wakePayment(env: ApiBindings, taskId: string) {
  let task = await loadTask(env, taskId);
  if (!task) return;
  if (task.mode === "simulation" && !isLocalSimulation(env)) return;
  if (task.status === "confirmed") {
    const probe = await env.DB.prepare(
      "SELECT task_id FROM payment_duplicate_probes WHERE task_id=? AND (status IN ('pending','sending','reconciling') OR (status='awaiting_evidence' AND protocol_verified_at IS NULL))",
    )
      .bind(taskId)
      .first();
    if (!probe) return;
  }
  if (task.mode === "real") {
    if (task.source === "claim") {
      const merchant = await createDb(env.DB)
        .select()
        .from(merchants)
        .where(eq(merchants.id, task.merchantId))
        .get();
      if (merchant) {
        await synchronizeMerchantPaymentIdentities(env, merchant);
        task = await loadTask(env, taskId);
        if (!task) return;
      }
    }
    const decision = needsRealQuery(task)
      ? await realQueryDecision(env, task)
      : await realSendDecision(env, task);
    if (!decision.allowed) return;
  }
  const stub = merchantObject(env, task.clientId);
  const response = await stub.fetch(
    "https://merchant.internal/internal/payments/run",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchantId: task.merchantId }),
    },
  );
  await response.arrayBuffer();
  if (!response.ok) throw new Error("Merchant wake failed");
}

export async function flushPaymentOutbox(env: ApiBindings, taskId?: string) {
  const pending = await env.DB.prepare(
    `SELECT id,task_id FROM payment_outbox WHERE delivered_at IS NULL ${taskId ? "AND task_id=?" : ""} ORDER BY created_at,id LIMIT 20`,
  )
    .bind(...(taskId ? [taskId] : []))
    .all<{ id: string; task_id: string }>();
  for (const item of pending.results) {
    try {
      await env.PAYMENT_QUEUE.send({
        type: "payment.wake",
        taskId: item.task_id,
      } satisfies PaymentWake);
      await env.DB.prepare(
        `UPDATE payment_outbox SET delivered_at=? WHERE id=? AND delivered_at IS NULL`,
      )
        .bind(Date.now(), item.id)
        .run();
    } catch {
      console.error("payment_outbox_delivery_failed", { outboxId: item.id });
    }
  }
  return pending.results.length;
}

export async function sweepPayments(env: ApiBindings) {
  await flushPaymentOutbox(env);
  const runnable = await runnableTaskSql(env);
  // A merchant held by the daily limit (quota.ts) sends nothing until its
  // payment's resume time, whatever has queued behind it; from then on that
  // payment is due itself.
  const page = await env.DB.prepare(
    `SELECT DISTINCT m.id,m.client_id,m.recovery_scanned_at
      FROM payment_tasks p JOIN merchants m ON m.id=p.merchant_id
      LEFT JOIN payment_acceptances a ON a.id=p.acceptance_id
      WHERE ((p.status IN ('pending','waiting','reconciling','sending') AND p.next_run_at<=?)
        OR (p.status='confirmed' AND EXISTS(SELECT 1 FROM payment_duplicate_probes d WHERE d.task_id=p.id AND (d.status IN ('pending','sending','reconciling') OR (d.status='awaiting_evidence' AND d.protocol_verified_at IS NULL)) AND d.next_run_at<=?)))
        AND NOT EXISTS(SELECT 1 FROM payment_tasks h WHERE h.id=m.active_task_id AND m.paused_reason='quota' AND h.status='waiting' AND h.reason='quota' AND h.next_run_at>?)
        AND (${runnable.condition})
      ORDER BY m.recovery_scanned_at,m.id LIMIT 20`,
  )
    .bind(Date.now(), Date.now(), Date.now(), ...runnable.values)
    .all<{ id: string; client_id: string; recovery_scanned_at: number }>();
  if (!page.results.length) return 0;
  // Advance the bounded batch before waking it. Failed or protected merchants
  // must not monopolize every sweep; equal clock ticks still advance the order.
  await env.DB.prepare(
    `UPDATE merchants SET recovery_scanned_at=MAX(recovery_scanned_at+1,?)
      WHERE id IN (SELECT value FROM json_each(?))`,
  )
    .bind(Date.now(), JSON.stringify(page.results.map((row) => row.id)))
    .run();
  let processed = 0;
  for (let i = 0; i < page.results.length; i += 5) {
    await Promise.all(
      page.results.slice(i, i + 5).map(async (row) => {
        try {
          const response = await merchantObject(env, row.client_id).fetch(
            "https://merchant.internal/internal/payments/run",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ merchantId: row.id }),
            },
          );
          await response.arrayBuffer();
          if (!response.ok) throw new Error();
          processed++;
        } catch {
          console.error("merchant_recovery_failed", { merchantId: row.id });
        }
      }),
    );
  }
  return processed;
}
