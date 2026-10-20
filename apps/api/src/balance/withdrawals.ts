// 转出 (docs/balance-design.md §5): 🐟 back to the person's own Credit
// account, sent by the platform app. Asking for one locks its 🐟, makes the
// 转出 and its payment in one batch; the payment queue sends it like a 红包's
// payment (no review), and its end comes back with the payment's result
// (withdrawal-settlement.ts).
import {
  amountToMinor,
  BALANCE_LIMITS,
  type BalanceWithdrawal,
  type CreateWithdrawalInput,
  formatAmount,
  quoteWithdraw,
  type WithdrawalFailure,
  type WithdrawalWait,
} from "@hb/contracts";
import { databaseNow } from "../activities/lifecycle";
import type { ApiBindings } from "../env";
import { claimPaymentParameterDigest } from "../payments/identity";
import { quotaHolds } from "../payments/quota";
import { reachesCredit } from "../runtime/controls";
import { sha256Hex } from "../security/crypto";
import { balanceError } from "./errors";
import { readPlatformAppRow } from "./platform-app";
import { readBalanceSettings, requireBalanceEntry } from "./settings";

/** A constant, like a claim's: `hb.lafi.sh_out_<32 hex>`, 47 characters. */
const BUSINESS_PREFIX = "hb.lafi.sh_out_";

export type WithdrawalRow = {
  id: string;
  user_id: string;
  merchant_id: string;
  client_id: string;
  business_no: string;
  recipient_id: string;
  recipient_username: string;
  debit_minor: number;
  fee_minor: number;
  credit_minor: number;
  fee_percent: number;
  settings_version: number;
  status: "sending" | "sent" | "failed";
  failure_reason: WithdrawalFailure | null;
  request_id: string;
  request_digest: string;
  created_at: number;
  sent_at: number | null;
  failed_at: number | null;
  updated_at: number;
};

/** What its payment says while it is 发放中. */
export type WithdrawalPayment = {
  id: string;
  status: string;
  reason: string | null;
  unknownOutcome: boolean;
  externalOrderId: string | null;
  nextSendAt: number | null;
  nextRunAt: number;
};

function waitOf(
  payment: WithdrawalPayment,
  hold: number | undefined,
): { wait: WithdrawalWait; resumeAt: number | null } {
  if (payment.status === "attention")
    return { wait: "attention", resumeAt: null };
  if (
    payment.unknownOutcome ||
    payment.status === "reconciling" ||
    payment.status === "sending"
  )
    return { wait: "checking", resumeAt: null };
  if (payment.status === "waiting") {
    if (payment.reason === "quota")
      return {
        wait: "quota",
        resumeAt: payment.nextSendAt ?? payment.nextRunAt,
      };
    if (payment.reason === "funds" || payment.reason === "credentials")
      return { wait: payment.reason, resumeAt: null };
  }
  // Its turn has not come: behind another the daily limit holds, perhaps.
  if (hold !== undefined) return { wait: "quota", resumeAt: hold };
  return { wait: "queued", resumeAt: null };
}

export function withdrawalView(
  row: WithdrawalRow,
  payment?: WithdrawalPayment | null,
  hold?: number,
): BalanceWithdrawal {
  const waiting =
    row.status === "sending" && payment ? waitOf(payment, hold) : null;
  return {
    id: row.id,
    businessNo: row.business_no,
    externalOrderId: payment?.externalOrderId ?? null,
    status: row.status,
    debitMinor: row.debit_minor,
    feeMinor: row.fee_minor,
    creditMinor: row.credit_minor,
    feePercent: row.fee_percent,
    recipientUsername: row.recipient_username,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    failedAt: row.failed_at,
    failure: row.failure_reason,
    wait: waiting?.wait ?? (row.status === "sending" ? "queued" : null),
    resumeAt: waiting?.resumeAt ?? null,
  };
}

export function readWithdrawal(env: ApiBindings, id: string) {
  return env.DB.prepare("SELECT * FROM balance_withdrawals WHERE id=?")
    .bind(id)
    .first<WithdrawalRow>();
}

export async function readWithdrawalPayment(
  env: ApiBindings,
  withdrawalId: string,
) {
  const row = await env.DB.prepare(
    `SELECT id,status,reason,unknown_outcome,external_order_id,next_send_at,next_run_at,merchant_id
    FROM payment_tasks WHERE withdrawal_id=?`,
  )
    .bind(withdrawalId)
    .first<{
      id: string;
      status: string;
      reason: string | null;
      unknown_outcome: number;
      external_order_id: string | null;
      next_send_at: number | null;
      next_run_at: number;
      merchant_id: string;
    }>();
  if (!row) return null;
  return {
    payment: {
      id: row.id,
      status: row.status,
      reason: row.reason,
      unknownOutcome: row.unknown_outcome === 1,
      externalOrderId: row.external_order_id,
      nextSendAt: row.next_send_at,
      nextRunAt: row.next_run_at,
    } satisfies WithdrawalPayment,
    merchantId: row.merchant_id,
  };
}

/** One 转出 with what its payment is waiting on. */
export async function withdrawalDetail(env: ApiBindings, row: WithdrawalRow) {
  const found = await readWithdrawalPayment(env, row.id);
  const hold =
    row.status === "sending" && found
      ? (await quotaHolds(env, [found.merchantId])).get(found.merchantId)
      : undefined;
  return withdrawalView(row, found?.payment ?? null, hold);
}

export async function ownedWithdrawal(
  env: ApiBindings,
  userId: string,
  id: string,
) {
  const row = await readWithdrawal(env, id);
  if (!row || row.user_id !== userId)
    balanceError(404, "WITHDRAWAL_NOT_FOUND", "没有找到这笔转出");
  return row;
}

/**
 * Asks for a 转出: its 🐟 locked, the 转出 made and its payment queued, in
 * one batch. Returns the payment to wake (the caller flushes its outbox).
 */
export async function createWithdrawal(
  env: ApiBindings,
  userId: string,
  input: CreateWithdrawalInput,
  isAdmin = false,
): Promise<{ withdrawal: BalanceWithdrawal; taskId: string | null }> {
  // 转出 needs no invitation: only 🐟 to send.
  await requireBalanceEntry(env, userId, isAdmin);
  const digest = await sha256Hex(
    `balance-withdrawal:${JSON.stringify({ settingsVersion: input.settingsVersion, by: input.by, amount: input.amount })}`,
  );
  const byRequest = () =>
    env.DB.prepare(
      "SELECT * FROM balance_withdrawals WHERE user_id=? AND request_id=?",
    )
      .bind(userId, input.requestId)
      .first<WithdrawalRow>();
  const previous = await byRequest();
  if (previous) {
    if (previous.request_digest !== digest)
      balanceError(
        409,
        "WITHDRAWAL_REQUEST_REUSED",
        "同一次转出不能换数量，请重新填写。",
      );
    return { withdrawal: await withdrawalDetail(env, previous), taskId: null };
  }
  const settings = await readBalanceSettings(env);
  if (!settings.withdrawEnabled)
    balanceError(409, "BALANCE_WITHDRAW_PAUSED", "转出暂停");
  if (settings.version !== input.settingsVersion)
    balanceError(
      409,
      "BALANCE_SETTINGS_CHANGED",
      "分发费率或上限刚刚改了，请看一下新的数量再确认。",
    );
  if (!reachesCredit(env))
    balanceError(503, "BALANCE_WITHDRAW_UNAVAILABLE", "这个环境不能转出。");
  const platform = await readPlatformAppRow(env);
  if (!platform)
    balanceError(
      503,
      "BALANCE_WITHDRAW_UNAVAILABLE",
      "转出还没准备好，请稍后再试。",
    );
  if (platform.author_id === userId)
    balanceError(
      403,
      "BALANCE_SELF",
      "Credit 不能分发给自己，站长的账号不能转出。",
    );
  const recipient = await env.DB.prepare(
    "SELECT external_id,username FROM users WHERE id=? AND provider='linux_do'",
  )
    .bind(userId)
    .first<{ external_id: string; username: string }>();
  if (!recipient?.username)
    balanceError(409, "BALANCE_RECIPIENT_MISSING", "读不到你的社区账号。");

  const amountMinor = amountToMinor(input.amount);
  const quote = quoteWithdraw(
    settings.withdrawFeePercent,
    input.by === "debit"
      ? { debitMinor: amountMinor }
      : { creditMinor: amountMinor },
  );
  if (quote.debitMinor < BALANCE_LIMITS.withdrawMinMinor)
    balanceError(
      400,
      "BALANCE_WITHDRAW_RANGE",
      `一笔转出至少 ${formatAmount(BALANCE_LIMITS.withdrawMinMinor)} 🐟。`,
    );
  if (quote.debitMinor > settings.withdrawMaxMinor)
    balanceError(
      400,
      "BALANCE_WITHDRAW_RANGE",
      `一笔转出最多 ${formatAmount(settings.withdrawMaxMinor)} 🐟。`,
    );
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM balance_withdrawals WHERE user_id=? AND created_at>?",
  )
    .bind(userId, Date.now() - 60 * 60_000)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= BALANCE_LIMITS.withdrawalsPerHour)
    balanceError(
      429,
      "BALANCE_WITHDRAW_TOO_FREQUENT",
      "转出太频繁了，请过一会儿再试。",
    );

  const plan = newWithdrawalPlan({
    userId,
    recipient,
    platform,
    quote,
    settings,
    requestId: input.requestId,
    digest,
  });
  const { id } = plan;
  const { head, tail } = await withdrawalStatements(env, plan);
  const taskId = plan.taskId;
  try {
    await env.DB.batch([...head, ...tail]);
  } catch (error) {
    // The same request, sent twice at once: the one that got in.
    const winner = await byRequest();
    if (winner?.request_digest === digest)
      return { withdrawal: await withdrawalDetail(env, winner), taskId: null };
    if (String(error).includes("BALANCE_INSUFFICIENT"))
      balanceError(409, "BALANCE_INSUFFICIENT", "可用的🐟不够。");
    const latest = await readBalanceSettings(env);
    if (!latest.withdrawEnabled)
      balanceError(409, "BALANCE_WITHDRAW_PAUSED", "转出暂停");
    if (latest.version !== settings.version)
      balanceError(
        409,
        "BALANCE_SETTINGS_CHANGED",
        "分发费率或上限刚刚改了，请看一下新的数量再确认。",
      );
    throw error;
  }
  console.info(
    JSON.stringify({ event: "balance_withdrawal_created", withdrawalId: id }),
  );
  const row = await readWithdrawal(env, id);
  if (!row) throw new Error("Withdrawal missing after creation");
  return { withdrawal: await withdrawalDetail(env, row), taskId };
}

/** One 转出's ids and what it is made of (createWithdrawal, or a 转账's). */
export type WithdrawalPlan = {
  id: string;
  lockId: string;
  taskId: string;
  businessNo: string;
  /** Whose 🐟 it takes. */
  userId: string;
  /** The Credit account it goes to: its owner's, or a 转账's recipient's. */
  recipient: { external_id: string; username: string };
  platform: { id: string; client_id: string };
  quote: { debitMinor: number; feeMinor: number; creditMinor: number };
  settings: { version: number; withdrawFeePercent: number };
  requestId: string;
  digest: string;
  now: number;
};

export function newWithdrawalPlan(
  input: Omit<
    WithdrawalPlan,
    "id" | "lockId" | "taskId" | "businessNo" | "now"
  >,
): WithdrawalPlan {
  const id = crypto.randomUUID();
  return {
    ...input,
    id,
    lockId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    businessNo: `${BUSINESS_PREFIX}${id.replaceAll("-", "")}`,
    now: Date.now(),
  };
}

/**
 * A 转出's statements: the 转出, its lock and the lock's entry (head), then
 * its payment and the payment's wake (tail). A 转账 to a Credit account
 * writes itself between the two, so its payment's checks find it.
 */
export async function withdrawalStatements(
  env: ApiBindings,
  plan: WithdrawalPlan,
) {
  const { id, lockId, taskId, businessNo, userId, recipient, platform, quote } =
    plan;
  const { settings, now } = plan;
  const parameterDigest = await claimPaymentParameterDigest({
    id: taskId,
    source: "withdrawal",
    claimId: null,
    acceptanceId: null,
    merchantId: platform.id,
    clientId: platform.client_id,
    businessNo,
    recipientId: recipient.external_id,
    recipientUsername: recipient.username,
    amountMinor: quote.debitMinor,
    mode: "real",
    recoveryPolicy: "withdrawal_same_order_v1",
  });
  return {
    head: [
      // Made only under the settings read, with 转出 still open: otherwise
      // the lock below has nothing to hold and the batch falls through.
      env.DB.prepare(
        `INSERT INTO balance_withdrawals (id,user_id,merchant_id,client_id,business_no,recipient_id,
          recipient_username,debit_minor,fee_minor,credit_minor,fee_percent,settings_version,
          request_id,request_digest,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM balance_settings WHERE id='global' AND version=? AND withdraw_enabled=1)`,
      ).bind(
        id,
        userId,
        platform.id,
        platform.client_id,
        businessNo,
        recipient.external_id,
        recipient.username,
        quote.debitMinor,
        quote.feeMinor,
        quote.creditMinor,
        settings.withdrawFeePercent,
        settings.version,
        plan.requestId,
        plan.digest,
        now,
        now,
        settings.version,
      ),
      env.DB.prepare(
        `INSERT INTO balance_locks (id,user_id,purpose,withdrawal_id,amount_minor,remaining_minor,status,created_at,updated_at)
        VALUES (?,?,'withdrawal',?,?,?,'active',?,?)`,
      ).bind(lockId, userId, id, quote.debitMinor, quote.debitMinor, now, now),
      // 可用 must cover it (balance_entries_available_guard).
      env.DB.prepare(
        `INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,created_at)
        VALUES (?,?,'lock',?,?,?,?)`,
      ).bind(
        crypto.randomUUID(),
        userId,
        -quote.debitMinor,
        quote.debitMinor,
        lockId,
        now,
      ),
    ],
    tail: [
      env.DB.prepare(
        `INSERT INTO payment_tasks (id,source,withdrawal_id,merchant_id,client_id,business_no,recipient_id,
          recipient_username,amount_minor,mode,status,next_run_at,created_at,updated_at,recovery_policy,parameter_digest)
        VALUES (?,'withdrawal',?,?,?,?,?,?,?,'real','pending',${databaseNow},${databaseNow},${databaseNow},'withdrawal_same_order_v1',?)`,
      ).bind(
        taskId,
        id,
        platform.id,
        platform.client_id,
        businessNo,
        recipient.external_id,
        recipient.username,
        quote.debitMinor,
        parameterDigest,
      ),
      env.DB.prepare(
        `INSERT INTO payment_outbox (id,task_id,created_at) VALUES (?,?,${databaseNow})`,
      ).bind(crypto.randomUUID(), taskId),
    ],
  };
}
