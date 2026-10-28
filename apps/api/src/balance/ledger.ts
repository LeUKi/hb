// 🐟额 accounts, their records, an admin's 调整 and the 站长's own. An
// account only moves by its entries (balance_entries; triggers in migration
// 0029 apply them).
import {
  amountToMinor,
  BALANCE_LIMITS,
  type BalanceAdjustmentInput,
  type BalanceCheckout,
  type BalanceTopup,
  type BalanceTransfer,
  type BalanceWithdrawal,
  formatAmount,
  type OwnerAdjustmentInput,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import type { ApiBindings } from "../env";
import { sha256Hex } from "../security/crypto";
import { checkoutPage } from "./checkouts";
import { balanceError } from "./errors";
import { readPlatformAppRow } from "./platform-app";
import { type TopupRow, topupView } from "./topups";
import { type TransferRow, transferViews } from "./transfers";
import { type WithdrawalRow, withdrawalView } from "./withdrawals";

export type BalanceAccountView = {
  availableMinor: number;
  lockedMinor: number;
  /** Of what is locked: 转出中, and 发出未领 (in 🐟额红包 not taken yet). */
  withdrawingMinor: number;
  unclaimedMinor: number;
};

export async function readAccount(
  env: ApiBindings,
  userId: string,
): Promise<BalanceAccountView> {
  const row = await env.DB.prepare(
    `SELECT available_minor AS availableMinor,locked_minor AS lockedMinor,
      COALESCE((SELECT SUM(remaining_minor) FROM balance_locks WHERE user_id=?1 AND status='active' AND purpose='withdrawal'),0) AS withdrawingMinor,
      COALESCE((SELECT SUM(remaining_minor) FROM balance_locks WHERE user_id=?1 AND status='active' AND purpose='activity'),0) AS unclaimedMinor
    FROM balance_accounts WHERE user_id=?1`,
  )
    .bind(userId)
    .first<BalanceAccountView>();
  return (
    row ?? {
      availableMinor: 0,
      lockedMinor: 0,
      withdrawingMinor: 0,
      unclaimedMinor: 0,
    }
  );
}

/**
 * What the 站长 holds in 🐟额 (balance-design §15): the platform app's
 * settings warn of it when its Client ID changes. Null with no platform app.
 */
export async function ownerHolding(env: ApiBindings) {
  const platform = await readPlatformAppRow(env);
  if (!platform) return null;
  const { availableMinor, lockedMinor } = await readAccount(
    env,
    platform.author_id,
  );
  return { availableMinor, lockedMinor };
}

/**
 * A 🐟额红包 in 明细: 发红包 (its total locked), 红包结束退回 (what was left),
 * 取消定时退回 (its 定时开放 taken back or failed, before it opened), or
 * 领到红包 (a share). The amount is signed as 可用 moved.
 */
export type BalanceHongbaoView = {
  id: string;
  kind: "sent" | "refund" | "untimed" | "received";
  amountMinor: number;
  activityId: string;
  title: string;
  createdAt: number;
};

export type BalanceAdjustmentView = {
  id: string;
  direction: "add" | "deduct";
  amountMinor: number;
  reason: string;
  createdAt: number;
};

/** One line of 明细: a 转入 or 转出 (whatever its state) or an admin's 调整. */
export type BalanceRecord =
  | { type: "topup"; createdAt: number; topup: BalanceTopup }
  | { type: "withdrawal"; createdAt: number; withdrawal: BalanceWithdrawal }
  | {
      type: "adjustment";
      createdAt: number;
      adjustment: BalanceAdjustmentView;
    }
  | { type: "hongbao"; createdAt: number; hongbao: BalanceHongbaoView }
  | { type: "transfer"; createdAt: number; transfer: BalanceTransfer }
  /** Paid at 对方的收银台: a 转账 that never passes 🐟额 (the payer's only). */
  | { type: "checkout"; createdAt: number; checkout: BalanceCheckout };

export type BalanceRecordFilter =
  | "all"
  | "topup"
  | "withdrawal"
  | "adjustment"
  | "hongbao"
  | "transfer";

const PAGE_SIZE = 20;

type Cursor = { time: number; id: string };

export function decodeRecordCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as Cursor;
    if (
      Number.isSafeInteger(parsed.time) &&
      typeof parsed.id === "string" &&
      /^[a-f0-9-]{36}$/i.test(parsed.id)
    )
      return parsed;
  } catch {
    // Falls through to the error below.
  }
  throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
}

function encodeRecordCursor(cursor: Cursor) {
  return btoa(JSON.stringify(cursor));
}

/** 明细, newest first, 20 at a time. */
export async function listRecords(
  env: ApiBindings,
  userId: string,
  filter: BalanceRecordFilter,
  cursor?: string,
) {
  const before = decodeRecordCursor(cursor);
  // A 转账 to a Credit account is its sender's 转出 too: it reads as the 转账.
  const page = (table: "topups" | "withdrawals" | "adjustments") =>
    env.DB.prepare(
      `SELECT * FROM balance_${table} WHERE user_id=?
        ${table === "withdrawals" ? "AND NOT EXISTS(SELECT 1 FROM balance_transfers t WHERE t.withdrawal_id=balance_withdrawals.id)" : ""}
        AND (?=0 OR created_at<? OR (created_at=? AND id<?))
      ORDER BY created_at DESC,id DESC LIMIT ?`,
    ).bind(
      userId,
      before ? 1 : 0,
      before?.time ?? 0,
      before?.time ?? 0,
      before?.id ?? "",
      PAGE_SIZE + 1,
    );
  const [topups, withdrawals, adjustments, hongbao, transfers] =
    await env.DB.batch<Record<string, unknown>>([
      page("topups"),
      page("withdrawals"),
      page("adjustments"),
      env.DB.prepare(
        `SELECT e.id,e.kind,e.available_delta_minor,e.created_at,a.id AS activity_id,a.title,
        (e.kind='unlock' AND (a.opened_at IS NULL OR e.created_at<a.opened_at)) AS untimed
      FROM balance_entries e JOIN balance_locks l ON l.id=e.lock_id JOIN activities a ON a.id=l.activity_id
      WHERE e.user_id=? AND l.purpose='activity' AND e.kind IN ('lock','unlock','hongbao')
        AND (?=0 OR e.created_at<? OR (e.created_at=? AND e.id<?))
      ORDER BY e.created_at DESC,e.id DESC LIMIT ?`,
      ).bind(
        userId,
        before ? 1 : 0,
        before?.time ?? 0,
        before?.time ?? 0,
        before?.id ?? "",
        PAGE_SIZE + 1,
      ),
      // 转账 out (either way), and in (to 🐟额; a Credit one never passes it).
      env.DB.prepare(
        `SELECT * FROM balance_transfers WHERE (from_user_id=?1 OR (to_user_id=?1 AND destination='balance'))
        AND (?2=0 OR created_at<?3 OR (created_at=?3 AND id<?4))
      ORDER BY created_at DESC,id DESC LIMIT ?5`,
      ).bind(
        userId,
        before ? 1 : 0,
        before?.time ?? 0,
        before?.id ?? "",
        PAGE_SIZE + 1,
      ),
    ]);
  const records: BalanceRecord[] = [];
  if (filter === "all" || filter === "topup")
    for (const row of (topups?.results ?? []) as unknown as TopupRow[])
      records.push({
        type: "topup",
        createdAt: row.created_at,
        topup: topupView(row),
      });
  if (filter === "all" || filter === "withdrawal")
    for (const row of (withdrawals?.results ??
      []) as unknown as WithdrawalRow[])
      records.push({
        type: "withdrawal",
        createdAt: row.created_at,
        withdrawal: withdrawalView(row),
      });
  if (filter === "all" || filter === "adjustment")
    for (const row of (adjustments?.results ?? []) as Record<string, unknown>[])
      records.push({
        type: "adjustment",
        createdAt: Number(row.created_at),
        adjustment: adjustmentView(row),
      });
  if (filter === "all" || filter === "hongbao")
    for (const row of (hongbao?.results ?? []) as Record<string, unknown>[])
      records.push({
        type: "hongbao",
        createdAt: Number(row.created_at),
        hongbao: {
          id: String(row.id),
          kind:
            row.kind === "lock"
              ? "sent"
              : row.kind === "unlock"
                ? Number(row.untimed) === 1
                  ? "untimed"
                  : "refund"
                : "received",
          amountMinor: Number(row.available_delta_minor),
          activityId: String(row.activity_id),
          title: String(row.title),
          createdAt: Number(row.created_at),
        },
      });
  if (filter === "all" || filter === "transfer") {
    const rows = (transfers?.results ?? []) as unknown as TransferRow[];
    for (const transfer of await transferViews(env, rows, userId))
      records.push({
        type: "transfer",
        createdAt: transfer.createdAt,
        transfer,
      });
    for (const checkout of await checkoutPage(
      env,
      userId,
      before,
      PAGE_SIZE + 1,
    ))
      records.push({
        type: "checkout",
        createdAt: checkout.createdAt,
        checkout,
      });
  }
  const id = (record: BalanceRecord) =>
    record.type === "topup"
      ? record.topup.id
      : record.type === "withdrawal"
        ? record.withdrawal.id
        : record.type === "hongbao"
          ? record.hongbao.id
          : record.type === "transfer"
            ? record.transfer.id
            : record.type === "checkout"
              ? record.checkout.id
              : record.adjustment.id;
  records.sort((left, right) =>
    right.createdAt !== left.createdAt
      ? right.createdAt - left.createdAt
      : id(right).localeCompare(id(left)),
  );
  const items = records.slice(0, PAGE_SIZE);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      records.length > PAGE_SIZE && last
        ? encodeRecordCursor({ time: last.createdAt, id: id(last) })
        : null,
  };
}

function adjustmentView(row: Record<string, unknown>): BalanceAdjustmentView {
  return {
    id: String(row.id),
    direction: row.direction === "deduct" ? "deduct" : "add",
    amountMinor: Number(row.amount_minor),
    reason: String(row.reason),
    createdAt: Number(row.created_at),
  };
}

/**
 * An admin's 补加 or 扣回, reason required and shown to the person. A
 * 扣回 may take 可用 below 0 (a 转入 Credit has since refunded); nothing
 * else can.
 */
export async function adjustBalance(
  env: ApiBindings,
  adminUserId: string,
  userId: string,
  input: BalanceAdjustmentInput,
) {
  if (userId === adminUserId)
    balanceError(403, "BALANCE_SELF_ADMIN", "管理员不能调整自己的🐟额");
  return writeAdjustment(env, adminUserId, userId, input, false);
}

/**
 * The 站长's 补加 or 扣回 of their own 🐟 (balance-design §15): only the
 * account that set up the platform app, whose LDC stands behind it; at most
 * 2000 🐟 at a time, and a 扣回 never past 可用.
 */
export async function adjustOwnBalance(
  env: ApiBindings,
  userId: string,
  input: OwnerAdjustmentInput,
) {
  const platform = await readPlatformAppRow(env);
  if (platform?.author_id !== userId)
    balanceError(403, "BALANCE_NOT_OWNER", "只有站长能给自己补加或扣回🐟。");
  if (amountToMinor(input.amount) > BALANCE_LIMITS.ownerAdjustMaxMinor)
    balanceError(
      400,
      "OWNER_ADJUSTMENT_TOO_LARGE",
      `一次最多 ${formatAmount(BALANCE_LIMITS.ownerAdjustMaxMinor)} 🐟。`,
    );
  return writeAdjustment(
    env,
    userId,
    userId,
    {
      ...input,
      reason: input.direction === "add" ? "给自己补加" : "给自己扣回",
    },
    true,
  );
}

/**
 * One adjustment and its 明细 line, once per request. `withinAvailable`
 * makes a 扣回 stop at 可用 (checked in the same batch as it is written).
 */
async function writeAdjustment(
  env: ApiBindings,
  actorUserId: string,
  userId: string,
  input: BalanceAdjustmentInput,
  withinAvailable: boolean,
) {
  const digest = await sha256Hex(
    `balance-adjustment:${JSON.stringify({ userId, direction: input.direction, amount: input.amount, reason: input.reason })}`,
  );
  const previous = await env.DB.prepare(
    "SELECT * FROM balance_adjustments WHERE request_id=?",
  )
    .bind(input.requestId)
    .first<Record<string, unknown>>();
  if (previous) {
    if (previous.request_digest !== digest)
      balanceError(
        409,
        "ADJUSTMENT_REQUEST_REUSED",
        "同一次调整不能换内容，请重新填写。",
      );
    return adjustmentView(previous);
  }
  const user = await env.DB.prepare("SELECT id FROM users WHERE id=?")
    .bind(userId)
    .first();
  if (!user) balanceError(404, "USER_NOT_FOUND", "没有找到这个用户");
  const amountMinor = amountToMinor(input.amount);
  const limited = withinAvailable && input.direction === "deduct";
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO balance_adjustments (id,user_id,direction,amount_minor,reason,actor_user_id,request_id,request_digest,created_at)
        SELECT ?,?,?,?,?,?,?,?,?
        WHERE ?=0 OR COALESCE((SELECT available_minor FROM balance_accounts WHERE user_id=?),0) >= ?`,
      ).bind(
        id,
        userId,
        input.direction,
        amountMinor,
        input.reason,
        actorUserId,
        input.requestId,
        digest,
        now,
        limited ? 1 : 0,
        userId,
        amountMinor,
      ),
      env.DB.prepare(
        `INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,adjustment_id,created_at)
        SELECT ?,?,'adjustment',?,0,?,? WHERE EXISTS(SELECT 1 FROM balance_adjustments WHERE id=?)`,
      ).bind(
        crypto.randomUUID(),
        userId,
        input.direction === "add" ? amountMinor : -amountMinor,
        id,
        now,
        id,
      ),
    ]);
  } catch (error) {
    const winner = await env.DB.prepare(
      "SELECT * FROM balance_adjustments WHERE request_id=?",
    )
      .bind(input.requestId)
      .first<Record<string, unknown>>();
    if (winner?.request_digest === digest) return adjustmentView(winner);
    throw error;
  }
  if (limited) {
    const written = await env.DB.prepare(
      "SELECT 1 FROM balance_adjustments WHERE id=?",
    )
      .bind(id)
      .first();
    if (!written) {
      const { availableMinor } = await readAccount(env, userId);
      balanceError(
        409,
        "BALANCE_INSUFFICIENT",
        `可用只有 ${formatAmount(Math.max(0, availableMinor))} 🐟，最多扣回这么多。`,
      );
    }
  }
  console.info(
    JSON.stringify({
      event: "balance_adjusted",
      adjustmentId: id,
      direction: input.direction,
      self: actorUserId === userId,
    }),
  );
  return adjustmentView({
    id,
    direction: input.direction,
    amount_minor: amountMinor,
    reason: input.reason,
    created_at: now,
  });
}
