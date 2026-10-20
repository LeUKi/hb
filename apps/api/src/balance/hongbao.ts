// 🐟额红包 (docs/balance-design.md §14): opening locks the author's 🐟, each
// claim moves one share from that lock into its claimant's 可用, and the
// end gives back what is left. Every statement here joins the batch of the
// 红包 write it belongs to; the triggers of migration 0033 hold the rest.
import {
  formatAmount,
  type LdcActivityInput,
  type LdcOpeningBlockedReason,
  ldcTotalMinor,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import type { ApiBindings } from "../env";
import { isLocalSimulation } from "../runtime/controls";
import { readBalanceSettings } from "./settings";

/** Its payment mode follows the environment's, as a merchant's would. */
export function balancePaymentMode(env: ApiBindings) {
  return isLocalSimulation(env) ? ("simulation" as const) : ("real" as const);
}

async function availableMinor(env: ApiBindings, userId: string) {
  const row = await env.DB.prepare(
    "SELECT available_minor FROM balance_accounts WHERE user_id=?",
  )
    .bind(userId)
    .first<{ available_minor: number }>();
  return row?.available_minor ?? 0;
}

/** May this person choose 🐟额 for a 红包 at all: the switch, and some 🐟. */
export async function canFundHongbao(env: ApiBindings, userId: string) {
  const [settings, available] = await Promise.all([
    readBalanceSettings(env),
    availableMinor(env, userId),
  ]);
  return settings.hongbaoEnabled && available >= 1;
}

/** Making or switching a draft to 🐟额 needs the same as choosing it. */
export async function requireBalanceFunding(env: ApiBindings, userId: string) {
  const [settings, available] = await Promise.all([
    readBalanceSettings(env),
    availableMinor(env, userId),
  ]);
  if (!settings.hongbaoEnabled)
    throw new ActivityError(
      409,
      "BALANCE_HONGBAO_PAUSED",
      "🐟额红包暂时关闭。",
    );
  if (available < 1)
    throw new ActivityError(
      409,
      "BALANCE_INSUFFICIENT",
      "🐟额里没有可用，不能用🐟额发红包。",
    );
}

/** Why a 🐟额红包 cannot open now, beyond what every 红包 is checked for. */
export async function balanceOpeningBlocked(
  env: ApiBindings,
  authorId: string,
  config: Pick<LdcActivityInput, "money">,
): Promise<LdcOpeningBlockedReason | undefined> {
  const [settings, available] = await Promise.all([
    readBalanceSettings(env),
    availableMinor(env, authorId),
  ]);
  if (!settings.hongbaoEnabled) return "BALANCE_HONGBAO_PAUSED";
  if (available < ldcTotalMinor(config as LdcActivityInput))
    return "BALANCE_INSUFFICIENT";
  return undefined;
}

/** In 🐟额's own unit, as the form's line has it (balance-design §14). */
export async function insufficientMessage(env: ApiBindings, authorId: string) {
  const available = Math.max(0, await availableMinor(env, authorId));
  return `🐟额可用只有 ${formatAmount(available)} 🐟，不够发这个红包。`;
}

/** Opening: the whole total leaves 可用 into the 红包's own lock. */
export function lockStatements(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  totalMinor: number,
  now: number,
) {
  const lockId = crypto.randomUUID();
  return [
    env.DB.prepare(`INSERT INTO balance_locks
      (id,user_id,purpose,activity_id,amount_minor,remaining_minor,status,created_at,updated_at)
      VALUES (?,?,'activity',?,?,?,'active',?,?)`).bind(
      lockId,
      authorId,
      activityId,
      totalMinor,
      totalMinor,
      now,
      now,
    ),
    env.DB.prepare(`INSERT INTO balance_entries
      (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,created_at)
      VALUES (?,?,'lock',?,?,?,?)`).bind(
      crypto.randomUUID(),
      authorId,
      -totalMinor,
      totalMinor,
      lockId,
      now,
    ),
  ];
}

/**
 * One claim: its share leaves the lock, then reaches the claimant. With no
 * open lock the deduct has no lock_id and the whole batch fails, so a claim
 * never stands without its 🐟.
 */
export function claimStatements(
  env: ApiBindings,
  activityId: string,
  claimId: string,
  claimantId: string,
  inventoryId: string,
) {
  return [
    env.DB.prepare(`INSERT INTO balance_entries
      (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,claim_id,created_at)
      VALUES (?,(SELECT author_id FROM activities WHERE id=?),'deduct',0,
        -(SELECT amount_minor FROM reward_inventory WHERE id=? AND activity_id=?),
        (SELECT id FROM balance_locks WHERE activity_id=? AND status='active'),?,${databaseNow})`).bind(
      crypto.randomUUID(),
      activityId,
      inventoryId,
      activityId,
      activityId,
      claimId,
    ),
    env.DB.prepare(`INSERT INTO balance_entries
      (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,claim_id,created_at)
      VALUES (?,?,'hongbao',(SELECT amount_minor FROM reward_inventory WHERE id=? AND activity_id=?),0,
        (SELECT lock_id FROM balance_entries WHERE claim_id=? AND kind='deduct'),?,${databaseNow})`).bind(
      crypto.randomUUID(),
      claimantId,
      inventoryId,
      activityId,
      claimId,
      claimId,
    ),
  ];
}

/**
 * A drawing's winners, as claimStatements for each, from the published
 * payload ({claimId, userId, amountMinor, deductId, creditId}).
 */
export function drawStatements(
  env: ApiBindings,
  activityId: string,
  payload: string,
) {
  return [
    env.DB.prepare(`INSERT INTO balance_entries
      (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,claim_id,created_at)
      SELECT json_extract(w.value,'$.deductId'),l.user_id,'deduct',0,-json_extract(w.value,'$.amountMinor'),
        l.id,json_extract(w.value,'$.claimId'),${databaseNow}
      FROM json_each(?) w JOIN balance_locks l ON l.activity_id=? AND l.status='active'`).bind(
      payload,
      activityId,
    ),
    env.DB.prepare(`INSERT INTO balance_entries
      (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,claim_id,created_at)
      SELECT json_extract(w.value,'$.creditId'),json_extract(w.value,'$.userId'),'hongbao',
        json_extract(w.value,'$.amountMinor'),0,
        (SELECT lock_id FROM balance_entries WHERE claim_id=json_extract(w.value,'$.claimId') AND kind='deduct'),
        json_extract(w.value,'$.claimId'),${databaseNow}
      FROM json_each(?) w`).bind(payload),
  ];
}

/**
 * The end: what nobody took goes back to 可用 (红包结束退回). Only once the
 * 红包 has ended, a draw's prizes being out; a no-op otherwise, and when
 * done before, so any write that may end a 红包 can carry it.
 */
export function refundStatement(env: ApiBindings, activityId: string) {
  return env.DB.prepare(`INSERT INTO balance_entries
    (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,created_at)
    SELECT ?,l.user_id,'unlock',l.remaining_minor,-l.remaining_minor,l.id,${databaseNow}
    FROM balance_locks l JOIN activities a ON a.id=l.activity_id
    WHERE l.activity_id=? AND l.purpose='activity' AND l.status='active' AND l.remaining_minor>0
      AND a.ended_at IS NOT NULL AND (a.draw_state IS NULL OR a.draw_state IN ('completed','empty'))`).bind(
    crypto.randomUUID(),
    activityId,
  );
}
