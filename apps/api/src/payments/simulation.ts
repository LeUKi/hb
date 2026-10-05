import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { simulationControls, simulationOrders } from "../db/schema";
import type { ApiBindings } from "../env";
import {
  type AdapterResult,
  ensureEvidenceMatchesTask,
  type PaymentAdapter,
  type PaymentTaskRow,
} from "./adapter";

export type SimulationOrder = typeof simulationOrders.$inferSelect;
export type SendResult =
  | { kind: "success"; order: SimulationOrder }
  | { kind: "rejected"; reason: "funds" | "quota" | "credentials" };

function assertSimulation(task: PaymentTaskRow) {
  if (task.mode !== "simulation" || !task.recipientId.startsWith("simulation:"))
    throw new Error("Payment mode is not supported");
}
async function scenario(env: ApiBindings, task: PaymentTaskRow) {
  return (
    (
      await createDb(env.DB)
        .select()
        .from(simulationControls)
        .where(eq(simulationControls.merchantId, task.merchantId))
        .get()
    )?.scenario ?? "normal"
  );
}
async function orderByKey(env: ApiBindings, task: PaymentTaskRow) {
  return createDb(env.DB)
    .select()
    .from(simulationOrders)
    .where(
      and(
        eq(simulationOrders.clientId, task.clientId),
        eq(simulationOrders.businessNo, task.businessNo),
      ),
    )
    .get();
}

/** Entirely local, persistent upstream simulator. No credentials or external fetch are used. */
export async function simulateSend(
  env: ApiBindings,
  task: PaymentTaskRow,
): Promise<SendResult> {
  assertSimulation(task);
  const existing = await orderByKey(env, task);
  if (existing) return { kind: "success", order: existing };
  const mode = await scenario(env, task);
  if (mode === "insufficient_funds")
    return { kind: "rejected", reason: "funds" };
  if (mode === "daily_limit") return { kind: "rejected", reason: "quota" };
  if (mode === "invalid_credentials")
    return { kind: "rejected", reason: "credentials" };
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO simulation_orders (id,client_id,business_no,recipient_id,amount_minor,visible_at,created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(client_id,business_no) DO NOTHING`)
    .bind(
      crypto.randomUUID(),
      task.clientId,
      task.businessNo,
      task.recipientId,
      mode === "conflict" ? task.amountMinor + 1 : task.amountMinor,
      mode === "query_delayed" ? now + 30_000 : now,
      now,
    )
    .run();
  if (
    mode === "response_lost" ||
    mode === "query_delayed" ||
    mode === "query_unavailable"
  )
    throw new Error("Simulated response lost");
  const order = await orderByKey(env, task);
  if (!order) throw new Error("Simulation order not persisted");
  return { kind: "success", order };
}

export async function simulateQuery(
  env: ApiBindings,
  task: PaymentTaskRow,
): Promise<SimulationOrder | null> {
  assertSimulation(task);
  const mode = await scenario(env, task);
  if (mode === "query_unavailable" || mode === "invalid_credentials")
    throw new Error("Simulated query unavailable");
  const order = await orderByKey(env, task);
  return order && order.visibleAt <= Date.now() ? order : null;
}

export function matchesOrder(task: PaymentTaskRow, order: SimulationOrder) {
  return (
    order.clientId === task.clientId &&
    order.businessNo === task.businessNo &&
    order.recipientId === task.recipientId &&
    order.amountMinor === task.amountMinor
  );
}

function evidenceFromOrder(order: SimulationOrder, source: "send" | "query") {
  return {
    source,
    clientId: order.clientId,
    businessNo: order.businessNo,
    recipientId: order.recipientId,
    amountMinor: order.amountMinor,
    externalOrderId: order.id,
    status: 1 as const,
  };
}

export function createSimulationPaymentAdapter(
  env: ApiBindings,
): PaymentAdapter {
  return {
    mode: "simulation",
    async send(task): Promise<AdapterResult> {
      const result = await simulateSend(env, task as PaymentTaskRow);
      if (result.kind === "rejected")
        return { kind: "waiting", reason: result.reason };
      const evidence = evidenceFromOrder(result.order, "send");
      return ensureEvidenceMatchesTask(task, evidence, "send")
        ? { kind: "confirmed", evidence }
        : { kind: "conflict", reason: "conflict" };
    },
    async query(task): Promise<AdapterResult> {
      const order = await simulateQuery(env, task as PaymentTaskRow);
      if (!order) return { kind: "not_found", reason: "checking_not_found" };
      const evidence = evidenceFromOrder(order, "query");
      return ensureEvidenceMatchesTask(task, evidence, "query")
        ? { kind: "confirmed", evidence }
        : { kind: "conflict", reason: "conflict" };
    },
  };
}
