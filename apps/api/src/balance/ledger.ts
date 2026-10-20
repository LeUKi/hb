// 🐟额 accounts, their records, and an admin's 调整. An account only moves
// by its entries (balance_entries; triggers in migration 0029 apply them).
import {
  amountToMinor,
  type BalanceAdjustmentInput,
  type BalanceTopup,
  type BalanceWithdrawal,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import type { ApiBindings } from "../env";
import { sha256Hex } from "../security/crypto";
import { balanceError } from "./errors";
import { type TopupRow, topupView } from "./topups";
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
 * A 🐟额红包 in 明细: 发红包 (its total locked), 红包结束退回 (what was left),
 * or 领到红包 (a share). The amount is signed as 可用 moved.
 */
export type BalanceHongbaoView = {
  id: string;
  kind: "sent" | "refund" | "received";
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
  | { type: "hongbao"; createdAt: number; hongbao: BalanceHongbaoView };

export type BalanceRecordFilter =
  | "all"
  | "topup"
  | "withdrawal"
  | "adjustment"
  | "hongbao";

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
  const page = (table: "topups" | "withdrawals" | "adjustments") =>
    env.DB.prepare(
      `SELECT * FROM balance_${table} WHERE user_id=?
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
  const [topups, withdrawals, adjustments, hongbao] = await env.DB.batch<
    Record<string, unknown>
  >([
    page("topups"),
    page("withdrawals"),
    page("adjustments"),
    env.DB.prepare(
      `SELECT e.id,e.kind,e.available_delta_minor,e.created_at,a.id AS activity_id,a.title
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
                ? "refund"
                : "received",
          amountMinor: Number(row.available_delta_minor),
          activityId: String(row.activity_id),
          title: String(row.title),
          createdAt: Number(row.created_at),
        },
      });
  const id = (record: BalanceRecord) =>
    record.type === "topup"
      ? record.topup.id
      : record.type === "withdrawal"
        ? record.withdrawal.id
        : record.type === "hongbao"
          ? record.hongbao.id
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
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO balance_adjustments (id,user_id,direction,amount_minor,reason,actor_user_id,request_id,request_digest,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        userId,
        input.direction,
        amountMinor,
        input.reason,
        adminUserId,
        input.requestId,
        digest,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,adjustment_id,created_at)
        VALUES (?,?,'adjustment',?,0,?,?)`,
      ).bind(
        crypto.randomUUID(),
        userId,
        input.direction === "add" ? amountMinor : -amountMinor,
        id,
        now,
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
  console.info(
    JSON.stringify({
      event: "balance_adjusted",
      adjustmentId: id,
      direction: input.direction,
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
