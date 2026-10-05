import {
  ACTIVITY_LIMITS,
  amountToMinor,
  type TimedDrawMoney,
} from "@hb/contracts";
import type { ApiBindings } from "../env";
import { claimPaymentParameterDigest } from "../payments/policy";
import { assertUint64Decimal } from "../payments/real-protocol";
import { timedDrawMoney } from "./draw-storage";
import { databaseNow } from "./lifecycle";
import { generateRandomAmounts, randomIntegerInclusive } from "./random-money";
import { type ActivityRow, findActivity, type InventoryRow } from "./storage";

type Winner = {
  registrationId: string;
  userId: string;
  passwordId: string;
  ordinal: number;
  recipientId: string;
  claimId: string;
  taskId: string;
  outboxId: string;
  inventoryId: string;
  amountMinor: number;
};
export type DrawPlan = {
  policy: "timed_draw_v1";
  inventory: InventoryRow[];
  winners: Winner[];
};
type PlanRow = {
  participant_count: number;
  payload: string;
  created_at: number;
};

function hasControlCharacter(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Floyd sampling is O(winner count), even when participation has no configured cap. */
export function sampleOrdinals(population: number, count: number): number[] {
  if (
    !Number.isSafeInteger(population) ||
    population < 0 ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > population ||
    count > ACTIVITY_LIMITS.rewards
  )
    throw new Error("Invalid drawing population");
  const selected = new Set<number>();
  for (let value = population - count + 1; value <= population; value++) {
    const candidate = Number(randomIntegerInclusive(1n, BigInt(value)));
    selected.add(selected.has(candidate) ? value : candidate);
  }
  return [...selected];
}

export function drawAmounts(money: TimedDrawMoney, participantCount: number) {
  const count = Math.min(participantCount, money.count);
  if (count === 0) return { amounts: [], assignedPositions: [] };
  const poolCount =
    money.distributeFullPool && count < money.count ? count : money.count;
  const amounts = generateRandomAmounts({
    mode: "random",
    algorithm: money.algorithm,
    totalAmount: money.totalAmount,
    count: poolCount,
  });
  const assignedPositions = sampleOrdinals(poolCount, count).map(
    (ordinal) => ordinal - 1,
  );
  for (let index = assignedPositions.length - 1; index > 0; index--) {
    const target = Number(randomIntegerInclusive(0n, BigInt(index)));
    [assignedPositions[index], assignedPositions[target]] = [
      assignedPositions[target] as number,
      assignedPositions[index] as number,
    ];
  }
  return { amounts, assignedPositions };
}

async function loadPlan(env: ApiBindings, activityId: string) {
  return env.DB.prepare(
    "SELECT participant_count,payload,created_at FROM activity_draw_plans WHERE activity_id=?",
  )
    .bind(activityId)
    .first<PlanRow>();
}

/** Database time, not an Alarm delivery timestamp, closes eligibility. */
export async function closeDueDraw(env: ApiBindings, activityId: string) {
  await env.DB.prepare(`UPDATE activities SET draw_state='settling',
    draw_closed_at=COALESCE(ended_at,deadline), draw_reason=CASE WHEN end_reason='manual' THEN 'manual' ELSE 'deadline' END,
    ended_at=COALESCE(ended_at,deadline),end_reason=COALESCE(end_reason,'expired'),
    version=version+1,updated_at=${databaseNow}
    WHERE id=? AND deleted_at IS NULL AND opened_at IS NOT NULL AND draw_state='waiting'
      AND (deadline<=${databaseNow} OR ended_at IS NOT NULL)`)
    .bind(activityId)
    .run();
}

export async function saveDrawPlan(env: ApiBindings, activityId: string) {
  const existing = await loadPlan(env, activityId);
  if (existing) return existing;
  const activity = await findActivity(env, activityId);
  if (activity?.drawState !== "settling") return null;
  const money = timedDrawMoney(activity);
  if (!money) throw new Error("Drawing activity has no timed configuration");
  const count = Math.min(activity.registeredCount, money.count);
  const ordinals = sampleOrdinals(activity.registeredCount, count);
  const entries =
    await env.DB.prepare(`SELECT id,user_id,password_id,ordinal,recipient_id FROM activity_registrations
    WHERE activity_id=? AND ordinal IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) ORDER BY ordinal`)
      .bind(activityId, JSON.stringify(ordinals))
      .all<{
        id: string;
        user_id: string;
        password_id: string;
        ordinal: number;
        recipient_id: string;
      }>();
  if (entries.results.length !== count)
    throw new Error("Drawing population is inconsistent");
  const { amounts, assignedPositions } = drawAmounts(
    money,
    activity.registeredCount,
  );
  const now = Date.now();
  const inventory: InventoryRow[] = amounts.map((amountMinor, position) => ({
    id: crypto.randomUUID(),
    activityId,
    position,
    kind: "ldc",
    ciphertext: null,
    amountMinor,
    createdAt: now,
  }));
  const plan: DrawPlan = {
    policy: "timed_draw_v1",
    inventory,
    winners: entries.results.map((entry, index) => {
      const reward = inventory[assignedPositions[index] ?? -1];
      if (!reward?.amountMinor)
        throw new Error("Drawing assignment is incomplete");
      return {
        registrationId: entry.id,
        userId: entry.user_id,
        passwordId: entry.password_id,
        ordinal: entry.ordinal,
        recipientId: entry.recipient_id,
        claimId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        outboxId: crypto.randomUUID(),
        inventoryId: reward.id,
        amountMinor: reward.amountMinor,
      };
    }),
  };
  try {
    await env.DB.prepare(`INSERT INTO activity_draw_plans(activity_id,participant_count,payload,created_at)
      SELECT id,registered_count,?,${databaseNow} FROM activities WHERE id=? AND draw_state='settling' AND registered_count=?`)
      .bind(JSON.stringify(plan), activityId, activity.registeredCount)
      .run();
  } catch (error) {
    const winner = await loadPlan(env, activityId);
    if (winner) return winner;
    throw error;
  }
  const saved = await loadPlan(env, activityId);
  if (!saved) throw new Error("Drawing plan was not saved");
  return saved;
}

function validatePlan(
  activity: ActivityRow,
  plan: DrawPlan,
  participantCount: number,
) {
  const money = timedDrawMoney(activity);
  const winnerCount = money ? Math.min(participantCount, money.count) : -1;
  if (
    !money ||
    plan.policy !== "timed_draw_v1" ||
    plan.winners.length !== winnerCount ||
    participantCount !== activity.registeredCount
  )
    throw new Error("Invalid saved drawing plan");
  const poolCount =
    winnerCount === 0
      ? 0
      : money.distributeFullPool && winnerCount < money.count
        ? winnerCount
        : money.count;
  if (
    plan.inventory.length !== poolCount ||
    (poolCount > 0 &&
      plan.inventory.reduce(
        (sum, item) => sum + BigInt(item.amountMinor ?? 0),
        0n,
      ) !== BigInt(amountToMinor(money.totalAmount)))
  )
    throw new Error("Invalid saved drawing pool");
  const rewards = new Map(plan.inventory.map((item) => [item.id, item]));
  if (
    rewards.size !== poolCount ||
    new Set(plan.winners.map((winner) => winner.userId)).size !== winnerCount ||
    new Set(plan.winners.map((winner) => winner.inventoryId)).size !==
      winnerCount
  )
    throw new Error("Duplicate saved drawing assignment");
  for (const [index, reward] of plan.inventory.entries())
    if (
      reward.activityId !== activity.id ||
      reward.position !== index ||
      reward.kind !== "ldc" ||
      reward.ciphertext !== null ||
      !Number.isSafeInteger(reward.amountMinor) ||
      (reward.amountMinor ?? 0) <= 0
    )
      throw new Error("Invalid saved drawing reward");
  for (const winner of plan.winners)
    if (rewards.get(winner.inventoryId)?.amountMinor !== winner.amountMinor)
      throw new Error("Invalid saved drawing amount");
}

/** Bounded JSON bulk writes preserve the entire prize/payment/outbox publication in one D1 transaction. */
export async function publishDrawPlan(env: ApiBindings, activityId: string) {
  for (let retry = 0; retry < 4; retry++) {
    const activity = await findActivity(env, activityId);
    if (activity?.drawState !== "settling") return false;
    const saved = await loadPlan(env, activityId);
    if (!saved) return false;
    const plan = JSON.parse(saved.payload) as DrawPlan;
    validatePlan(activity, plan, saved.participant_count);
    if (!activity.merchantId || !activity.paymentMode)
      throw new Error("Drawing merchant is missing");
    const merchant = await env.DB.prepare(
      "SELECT client_id FROM merchants WHERE id=? AND author_id=? AND mode=?",
    )
      .bind(activity.merchantId, activity.authorId, activity.paymentMode)
      .first<{ client_id: string }>();
    if (!merchant) throw new Error("Drawing merchant is inconsistent");
    const profiles =
      await env.DB.prepare(`SELECT u.id,u.username,u.external_id FROM users u
      WHERE u.id IN (SELECT json_extract(value,'$.userId') FROM json_each(?))`)
        .bind(JSON.stringify(plan.winners))
        .all<{ id: string; username: string; external_id: string }>();
    const users = new Map(profiles.results.map((user) => [user.id, user]));
    const winners = await Promise.all(
      plan.winners.map(async (winner) => {
        const user = users.get(winner.userId);
        const recipientId =
          activity.paymentMode === "simulation"
            ? `simulation:${user?.external_id}`
            : user?.external_id;
        if (
          !user ||
          recipientId !== winner.recipientId ||
          !user.username ||
          hasControlCharacter(user.username)
        )
          throw new Error("Drawing recipient is inconsistent");
        if (activity.paymentMode === "real")
          assertUint64Decimal(winner.recipientId);
        const businessNo = `hb_${winner.claimId.replaceAll("-", "")}`;
        const recoveryPolicy =
          activity.paymentMode === "real"
            ? ("claim_same_order_v1" as const)
            : null;
        const parameterDigest = recoveryPolicy
          ? await claimPaymentParameterDigest({
              id: winner.taskId,
              claimId: winner.claimId,
              source: "claim",
              acceptanceId: null,
              merchantId: activity.merchantId as string,
              clientId: merchant.client_id,
              businessNo,
              recipientId: winner.recipientId,
              recipientUsername: user.username,
              amountMinor: winner.amountMinor,
              mode: "real",
              recoveryPolicy,
            })
          : null;
        return {
          ...winner,
          recipientUsername: user.username,
          businessNo,
          recoveryPolicy,
          parameterDigest,
        };
      }),
    );
    const payload = JSON.stringify(winners);
    const statements = [
      env.DB.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM activities a JOIN activity_draw_plans d ON d.activity_id=a.id
        WHERE a.id=? AND a.draw_state='settling' AND a.deleted_at IS NULL AND a.registered_count=d.participant_count AND d.payload=?
        AND a.merchant_id=? AND a.payment_mode=? AND a.claimed_count=0
        AND NOT EXISTS(SELECT 1 FROM reward_inventory WHERE activity_id=a.id))
        AND (SELECT COUNT(*) FROM json_each(?) w JOIN users u ON u.id=json_extract(w.value,'$.userId')
          JOIN activity_registrations r ON r.id=json_extract(w.value,'$.registrationId')
          WHERE u.username=json_extract(w.value,'$.recipientUsername') AND r.activity_id=?
          AND r.user_id=u.id AND r.recipient_id=json_extract(w.value,'$.recipientId') AND r.password_id=json_extract(w.value,'$.passwordId'))=?
        THEN '{}' ELSE '' END) AS draw_publication_guard`).bind(
        activityId,
        saved.payload,
        activity.merchantId,
        activity.paymentMode,
        payload,
        activityId,
        winners.length,
      ),
      env.DB.prepare(`INSERT INTO reward_inventory(id,activity_id,position,kind,ciphertext,amount_minor,created_at)
        SELECT json_extract(value,'$.id'),?,json_extract(value,'$.position'),'ldc',NULL,json_extract(value,'$.amountMinor'),${databaseNow}
        FROM json_each(?, '$.inventory')`).bind(activityId, saved.payload),
      env.DB.prepare(`INSERT INTO claims(id,activity_id,user_id,inventory_id,password_id,claimed_at)
        SELECT json_extract(value,'$.claimId'),?,json_extract(value,'$.userId'),json_extract(value,'$.inventoryId'),json_extract(value,'$.passwordId'),${databaseNow}
        FROM json_each(?)`).bind(activityId, payload),
      env.DB.prepare(`INSERT INTO payment_tasks(id,claim_id,source,acceptance_id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,mode,status,next_run_at,created_at,updated_at,recovery_policy,parameter_digest)
        SELECT json_extract(value,'$.taskId'),json_extract(value,'$.claimId'),'claim',NULL,?,
        (SELECT client_id FROM merchants WHERE id=? AND author_id=? AND mode=?),
        json_extract(value,'$.businessNo'),json_extract(value,'$.recipientId'),json_extract(value,'$.recipientUsername'),json_extract(value,'$.amountMinor'),?,
        'pending',${databaseNow},${databaseNow},${databaseNow},json_extract(value,'$.recoveryPolicy'),json_extract(value,'$.parameterDigest') FROM json_each(?)`).bind(
        activity.merchantId,
        activity.merchantId,
        activity.authorId,
        activity.paymentMode,
        activity.paymentMode,
        payload,
      ),
      env.DB.prepare(`INSERT INTO payment_outbox(id,task_id,created_at)
        SELECT json_extract(value,'$.outboxId'),json_extract(value,'$.taskId'),${databaseNow} FROM json_each(?)`).bind(
        payload,
      ),
      env.DB.prepare(`UPDATE attempt_events SET claim_id=(SELECT json_extract(w.value,'$.claimId') FROM json_each(?) w
        JOIN redemption_submissions s ON s.registration_id=json_extract(w.value,'$.registrationId') AND s.outcome='registered'
        WHERE s.id=attempt_events.submission_row_id)
        WHERE activity_id=? AND submission_row_id IN (SELECT s.id FROM redemption_submissions s
          JOIN json_each(?) w ON s.registration_id=json_extract(w.value,'$.registrationId') WHERE s.outcome='registered')`).bind(
        payload,
        activityId,
        payload,
      ),
      env.DB.prepare(`UPDATE activities SET claimed_count=?,draw_state=?,draw_published_at=${databaseNow},
        version=version+1,updated_at=${databaseNow} WHERE id=? AND draw_state='settling'`).bind(
        winners.length,
        winners.length ? "completed" : "empty",
        activityId,
      ),
    ];
    try {
      await env.DB.batch(statements);
      return true;
    } catch (error) {
      const current = await findActivity(env, activityId);
      if (current?.drawState === "completed" || current?.drawState === "empty")
        return false;
      const changed = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM users u JOIN json_each(?) w ON u.id=json_extract(w.value,'$.userId') WHERE u.username!=json_extract(w.value,'$.recipientUsername')`,
      )
        .bind(payload)
        .first<{ count: number }>();
      if (changed?.count) continue;
      throw error;
    }
  }
  throw new Error(
    "Drawing publication is waiting for stable recipient profiles",
  );
}

export async function refreshTimedDraw(env: ApiBindings, activityId: string) {
  const activity = await findActivity(env, activityId);
  if (
    !activity ||
    !timedDrawMoney(activity) ||
    activity.openedAt === null ||
    activity.drawState === "completed" ||
    activity.drawState === "empty"
  )
    return false;
  await closeDueDraw(env, activityId);
  await saveDrawPlan(env, activityId);
  return publishDrawPlan(env, activityId);
}
