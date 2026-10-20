// 转账 (docs/balance-design.md §16): 🐟 from a 🐟额 PLUS member (or the
// 站长) to someone who has been here, to their 🐟额 at once (two entries)
// or to their Credit account (a 转出 to them, withdrawals.ts). From the page
// (a request id) or an open API key (the caller's 转账单号); each is one
// batch, guarded as it is written, and the same request twice is the same
// 转账. A 试转 runs the same checks and writes nothing.
import {
  BALANCE_LIMITS,
  type BalanceTransfer,
  type BalanceTransferParty,
  formatAmount,
  quoteWithdraw,
  type TransferDestination,
  type TransferStatus,
  type WithdrawalFailure,
} from "@hb/contracts";
import type { ApiBindings } from "../env";
import { reachesCredit } from "../runtime/controls";
import { sha256Hex } from "../security/crypto";
import type { ApiKeyRow } from "./api-keys";
import { startOfBeijingDay } from "./day";
import { balanceError, RateLimitedError } from "./errors";
import { readAccount } from "./ledger";
import { readPlatformAppRow } from "./platform-app";
import { readBalanceSettings } from "./settings";
import {
  newWithdrawalPlan,
  type WithdrawalRow,
  withdrawalStatements,
  withdrawalView,
} from "./withdrawals";

export type TransferRow = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  destination: TransferDestination;
  withdrawal_id: string | null;
  amount_minor: number;
  api_key_id: string | null;
  out_transfer_no: string | null;
  request_id: string | null;
  request_digest: string;
  remark: string | null;
  recipient_external_id: string;
  recipient_username: string;
  created_at: number;
};

/** One 转账 as asked for, from the page or the open API. */
export type TransferInput = {
  toUserId: string;
  toUsername: string;
  destination: TransferDestination;
  amountMinor: number;
  remark?: string | undefined;
};

export type TransferOrigin =
  | { kind: "page"; requestId: string }
  | {
      kind: "key";
      key: ApiKeyRow;
      outTransferNo: string;
      ip: string | null;
    };

/**
 * What a 批量试转 has already counted: the earlier ones in the batch, as if
 * they had gone through, so each answers as it would in a real run.
 */
export type TransferTally = {
  spentMinor: number;
  keyTodayMinor: number;
  keyMinuteCount: number;
  creditHourCount: number;
};

export const emptyTally = (): TransferTally => ({
  spentMinor: 0,
  keyTodayMinor: 0,
  keyMinuteCount: 0,
  creditHourCount: 0,
});

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Who may 转账 (and hold open API keys): an active account that opened
 * 🐟额 PLUS by invitation, or the 站长 (the platform app's author).
 */
export async function transferAccess(env: ApiBindings, userId: string) {
  const row = await env.DB.prepare(
    `SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND active=1) AS active,
      EXISTS(SELECT 1 FROM balance_members WHERE user_id=?1) AS member,
      EXISTS(SELECT 1 FROM merchants WHERE kind='platform' AND usage_status='current' AND author_id=?1) AS owner`,
  )
    .bind(userId)
    .first<{ active: number; member: number; owner: number }>();
  const active = row?.active === 1;
  const member = row?.member === 1;
  const owner = row?.owner === 1;
  return { allowed: active && (member || owner), member, owner, active };
}

/** The same guard, inside a write: ?1 is the sender. */
const SENDER_ALLOWED = `EXISTS(SELECT 1 FROM users WHERE id=?1 AND active=1)
  AND (EXISTS(SELECT 1 FROM balance_members WHERE user_id=?1)
    OR EXISTS(SELECT 1 FROM merchants WHERE kind='platform' AND usage_status='current' AND author_id=?1))`;

export type Recipient = {
  id: string;
  external_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

/** Someone who has been here, by LINUX DO ID and username (any case). */
export function findRecipient(
  env: ApiBindings,
  externalId: string,
  username: string,
) {
  return env.DB.prepare(
    `SELECT id,external_id,username,display_name,avatar_url FROM users
    WHERE provider='linux_do' AND external_id=? AND lower(username)=? AND active=1`,
  )
    .bind(externalId, username.toLowerCase())
    .first<Recipient>();
}

/** Someone who has been here, by username: the transfer dialog's search. */
export function findRecipientByUsername(env: ApiBindings, username: string) {
  return env.DB.prepare(
    `SELECT id,external_id,username,display_name,avatar_url FROM users
    WHERE provider='linux_do' AND lower(username)=? AND active=1
    ORDER BY last_login_at DESC LIMIT 1`,
  )
    .bind(username.toLowerCase())
    .first<Recipient>();
}

function transferDigest(input: TransferInput) {
  return sha256Hex(
    `balance-transfer:${JSON.stringify({
      toUserId: input.toUserId,
      toUsername: input.toUsername.toLowerCase(),
      destination: input.destination,
      amountMinor: input.amountMinor,
      remark: input.remark ?? null,
    })}`,
  );
}

function findPrevious(
  env: ApiBindings,
  senderId: string,
  origin: TransferOrigin,
) {
  return origin.kind === "page"
    ? env.DB.prepare(
        "SELECT * FROM balance_transfers WHERE from_user_id=? AND request_id=?",
      )
        .bind(senderId, origin.requestId)
        .first<TransferRow>()
    : env.DB.prepare(
        "SELECT * FROM balance_transfers WHERE api_key_id=? AND out_transfer_no=?",
      )
        .bind(origin.key.id, origin.outTransferNo)
        .first<TransferRow>();
}

function reused(origin: TransferOrigin): never {
  if (origin.kind === "page")
    balanceError(
      409,
      "TRANSFER_REQUEST_REUSED",
      "同一次转账不能换内容，请重新填写。",
    );
  balanceError(409, "OUT_TRANSFER_NO_CONFLICT", "单号已用过");
}

/** How long until the oldest of `times` leaves a window of `windowMs`. */
function secondsUntilRoom(oldest: number | null, windowMs: number) {
  if (oldest === null) return 1;
  return Math.max(1, Math.ceil((oldest + windowMs - Date.now()) / 1000));
}

/** The open API's 每分钟 600 笔: how many are left, and when one frees. */
export async function keyMinuteUse(env: ApiBindings, keyId: string) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count,MIN(created_at) AS oldest FROM balance_transfers
    WHERE api_key_id=? AND created_at>?`,
  )
    .bind(keyId, Date.now() - MINUTE_MS)
    .first<{ count: number; oldest: number | null }>();
  const count = row?.count ?? 0;
  return {
    count,
    remaining: Math.max(0, BALANCE_LIMITS.apiTransfersPerMinute - count),
    resetSeconds: secondsUntilRoom(row?.oldest ?? null, MINUTE_MS),
  };
}

/** What a key has sent today (北京时间). */
export async function keyTodayMinor(env: ApiBindings, keyId: string) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_minor),0) AS total FROM balance_transfers WHERE api_key_id=? AND created_at>=?",
  )
    .bind(keyId, startOfBeijingDay())
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Why a 转账 to a Credit account cannot be made now, if it cannot. */
export async function creditBlock(env: ApiBindings) {
  const settings = await readBalanceSettings(env);
  if (!settings.withdrawEnabled)
    return {
      code: "WITHDRAW_DISABLED",
      message: "转出暂停中，不能发到 Credit",
    } as const;
  if (!reachesCredit(env) || !(await readPlatformAppRow(env)))
    return {
      code: "TRANSFER_CREDIT_UNAVAILABLE",
      message: "现在发不了 Credit，请稍后再试。",
    } as const;
  return null;
}

/**
 * Everything a 转账 must pass before it is written, in the order its
 * errors are told; a 试转 stops here. `tally` adds the batch's earlier ones.
 */
async function checkTransfer(
  env: ApiBindings,
  senderId: string,
  input: TransferInput,
  origin: TransferOrigin,
  tally: TransferTally = emptyTally(),
) {
  if (!(await transferAccess(env, senderId)).allowed)
    balanceError(403, "TRANSFER_NOT_ALLOWED", "开通🐟额 PLUS 才能转账。");
  const settings = await readBalanceSettings(env);
  if (!settings.transferEnabled)
    balanceError(403, "TRANSFER_DISABLED", "转账暂时关闭");
  const recipient = await findRecipient(env, input.toUserId, input.toUsername);
  if (!recipient) balanceError(404, "RECIPIENT_NOT_FOUND", "收款人不存在");
  if (recipient.id === senderId)
    balanceError(400, "SELF_TRANSFER", "不能转给自己");
  let platform: Awaited<ReturnType<typeof readPlatformAppRow>> = null;
  if (input.destination === "credit") {
    const blocked = await creditBlock(env);
    if (blocked)
      balanceError(
        blocked.code === "WITHDRAW_DISABLED" ? 403 : 503,
        blocked.code,
        blocked.message,
      );
    if (
      input.amountMinor < BALANCE_LIMITS.withdrawMinMinor ||
      input.amountMinor > settings.withdrawMaxMinor
    )
      balanceError(
        400,
        "AMOUNT_OUT_OF_RANGE",
        `发到 Credit 至少 ${formatAmount(BALANCE_LIMITS.withdrawMinMinor)} 🐟，单笔不超过 ${formatAmount(settings.withdrawMaxMinor)} 🐟`,
      );
    platform = await readPlatformAppRow(env);
    if (!platform)
      balanceError(
        503,
        "TRANSFER_CREDIT_UNAVAILABLE",
        "现在发不了 Credit，请稍后再试。",
      );
    if (platform.author_id === recipient.id)
      balanceError(
        400,
        "RECIPIENT_IS_OWNER",
        "站长的 Credit 账户收不了平台应用的发放",
      );
    const hour = await env.DB.prepare(
      `SELECT COUNT(*) AS count,MIN(created_at) AS oldest FROM balance_withdrawals
      WHERE user_id=? AND created_at>?`,
    )
      .bind(senderId, Date.now() - HOUR_MS)
      .first<{ count: number; oldest: number | null }>();
    if (
      (hour?.count ?? 0) + tally.creditHourCount >=
      BALANCE_LIMITS.withdrawalsPerHour
    )
      throw new RateLimitedError(
        secondsUntilRoom(hour?.oldest ?? null, HOUR_MS),
        `发到 Credit 的转账和转出每小时最多 ${BALANCE_LIMITS.withdrawalsPerHour} 笔`,
      );
  }
  const { availableMinor } = await readAccount(env, senderId);
  if (availableMinor - tally.spentMinor < input.amountMinor)
    balanceError(409, "BALANCE_INSUFFICIENT", "可用不足");
  if (origin.kind === "key") {
    const minute = await keyMinuteUse(env, origin.key.id);
    if (
      minute.count + tally.keyMinuteCount >=
      BALANCE_LIMITS.apiTransfersPerMinute
    )
      throw new RateLimitedError(minute.resetSeconds);
    if (origin.key.daily_limit_minor !== null) {
      const today = await keyTodayMinor(env, origin.key.id);
      if (
        today + tally.keyTodayMinor + input.amountMinor >
        origin.key.daily_limit_minor
      )
        balanceError(409, "DAILY_LIMIT_EXCEEDED", "已超过这个密钥的每日上限");
    }
  }
  return { settings, recipient, platform };
}

/** What a 转账 that went through counts for the rest of its batch. */
export function countIn(tally: TransferTally, input: TransferInput) {
  tally.spentMinor += input.amountMinor;
  tally.keyTodayMinor += input.amountMinor;
  tally.keyMinuteCount += 1;
  if (input.destination === "credit") tally.creditHourCount += 1;
}

/**
 * A 试转: the same checks, nothing written. Answers what the 转账 would be
 * (no id), or the first reason it would not go through.
 */
export async function dryRunTransfer(
  env: ApiBindings,
  senderId: string,
  input: TransferInput,
  origin: TransferOrigin,
  tally: TransferTally,
) {
  const previous = await findPrevious(env, senderId, origin);
  if (previous) {
    if (previous.request_digest !== (await transferDigest(input)))
      reused(origin);
    return { row: previous, dryRun: false as const };
  }
  const { recipient } = await checkTransfer(
    env,
    senderId,
    input,
    origin,
    tally,
  );
  countIn(tally, input);
  const row: TransferRow = {
    id: "",
    from_user_id: senderId,
    to_user_id: recipient.id,
    destination: input.destination,
    withdrawal_id: null,
    amount_minor: input.amountMinor,
    api_key_id: origin.kind === "key" ? origin.key.id : null,
    out_transfer_no: origin.kind === "key" ? origin.outTransferNo : null,
    request_id: origin.kind === "page" ? origin.requestId : null,
    request_digest: "",
    remark: input.remark ?? null,
    recipient_external_id: recipient.external_id,
    recipient_username: recipient.username,
    created_at: Date.now(),
  };
  return { row, dryRun: true as const };
}

/**
 * Makes a 转账. Returns it, and the payment to wake when it goes to a
 * Credit account (the caller flushes its outbox). The same request again
 * returns the first one; a different one under the same number is refused.
 */
export async function makeTransfer(
  env: ApiBindings,
  senderId: string,
  input: TransferInput,
  origin: TransferOrigin,
): Promise<{ row: TransferRow; taskId: string | null }> {
  const digest = await transferDigest(input);
  const previous = await findPrevious(env, senderId, origin);
  if (previous) {
    if (previous.request_digest !== digest) reused(origin);
    return { row: previous, taskId: null };
  }
  const { settings, recipient, platform } = await checkTransfer(
    env,
    senderId,
    input,
    origin,
  );
  const id = crypto.randomUUID();
  const now = Date.now();
  const key = origin.kind === "key" ? origin.key : null;
  // Rechecked as it is written: the switch, the sender, the key's limits.
  const guard = env.DB.prepare(
    `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM balance_settings WHERE id='global' AND transfer_enabled=1)
      AND ${SENDER_ALLOWED}
      AND (?2 IS NULL OR ((SELECT COUNT(*) FROM balance_transfers WHERE api_key_id=?2 AND created_at>?3) < ?4
        AND NOT EXISTS(SELECT 1 FROM balance_api_keys k WHERE k.id=?2 AND k.daily_limit_minor IS NOT NULL
          AND COALESCE((SELECT SUM(t.amount_minor) FROM balance_transfers t WHERE t.api_key_id=k.id AND t.created_at>=?5),0)+?6 > k.daily_limit_minor)))
    THEN '{}' ELSE '' END) AS transfer_guard`,
  ).bind(
    senderId,
    key?.id ?? null,
    now - MINUTE_MS,
    BALANCE_LIMITS.apiTransfersPerMinute,
    startOfBeijingDay(now),
    input.amountMinor,
  );
  let withdrawalId: string | null = null;
  let taskId: string | null = null;
  let around: { head: D1PreparedStatement[]; tail: D1PreparedStatement[] } = {
    head: [],
    tail: [],
  };
  if (input.destination === "credit" && platform) {
    const plan = newWithdrawalPlan({
      userId: senderId,
      recipient: {
        external_id: recipient.external_id,
        username: recipient.username,
      },
      platform,
      quote: quoteWithdraw(settings.withdrawFeePercent, {
        debitMinor: input.amountMinor,
      }),
      settings,
      requestId: id,
      digest,
    });
    withdrawalId = plan.id;
    taskId = plan.taskId;
    around = await withdrawalStatements(env, plan);
  }
  const insert = env.DB.prepare(
    `INSERT INTO balance_transfers (id,from_user_id,to_user_id,destination,withdrawal_id,amount_minor,
      api_key_id,out_transfer_no,request_id,request_digest,remark,recipient_external_id,recipient_username,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id,
    senderId,
    recipient.id,
    input.destination,
    withdrawalId,
    input.amountMinor,
    key?.id ?? null,
    origin.kind === "key" ? origin.outTransferNo : null,
    origin.kind === "page" ? origin.requestId : null,
    digest,
    input.remark ?? null,
    recipient.external_id,
    recipient.username,
    now,
  );
  const entries =
    input.destination === "balance"
      ? [
          // 可用 must cover it (balance_entries_available_guard).
          env.DB.prepare(
            `INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,transfer_id,created_at)
            VALUES (?,?,'transfer_out',?,0,?,?)`,
          ).bind(crypto.randomUUID(), senderId, -input.amountMinor, id, now),
          env.DB.prepare(
            `INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,transfer_id,created_at)
            VALUES (?,?,'transfer_in',?,0,?,?)`,
          ).bind(crypto.randomUUID(), recipient.id, input.amountMinor, id, now),
        ]
      : [];
  const keyUse = key
    ? [
        env.DB.prepare(
          `UPDATE balance_api_keys SET last_transfer_at=?,last_transfer_ip=?,
            transfer_count=transfer_count+1,transfer_total_minor=transfer_total_minor+?
          WHERE id=?`,
        ).bind(
          now,
          origin.kind === "key" ? origin.ip : null,
          input.amountMinor,
          key.id,
        ),
      ]
    : [];
  try {
    await env.DB.batch([
      guard,
      ...around.head,
      insert,
      ...entries,
      ...around.tail,
      ...keyUse,
    ]);
  } catch (error) {
    // The same request, sent twice at once: the one that got in.
    const winner = await findPrevious(env, senderId, origin);
    if (winner) {
      if (winner.request_digest !== digest) reused(origin);
      return { row: winner, taskId: null };
    }
    if (String(error).includes("BALANCE_INSUFFICIENT"))
      balanceError(409, "BALANCE_INSUFFICIENT", "可用不足");
    // Something changed between the check and the write: say what.
    await checkTransfer(env, senderId, input, origin);
    throw error;
  }
  console.info(
    JSON.stringify({
      event: "balance_transfer_created",
      transferId: id,
      destination: input.destination,
      viaKey: key !== null,
    }),
  );
  const row = await env.DB.prepare("SELECT * FROM balance_transfers WHERE id=?")
    .bind(id)
    .first<TransferRow>();
  if (!row) throw new Error("Transfer missing after creation");
  return { row, taskId };
}

type PartyRow = {
  id: string;
  external_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

/** The people, keys and 转出 a page of 转账 names, read at once. */
async function relatedOf(env: ApiBindings, rows: TransferRow[]) {
  const userIds = [
    ...new Set(rows.flatMap((row) => [row.from_user_id, row.to_user_id])),
  ];
  const keyIds = [
    ...new Set(rows.flatMap((row) => (row.api_key_id ? [row.api_key_id] : []))),
  ];
  const withdrawalIds = rows.flatMap((row) =>
    row.withdrawal_id ? [row.withdrawal_id] : [],
  );
  const marks = (count: number) => Array(count).fill("?").join(",");
  const [users, keys, withdrawals] = await Promise.all([
    userIds.length
      ? env.DB.prepare(
          `SELECT id,external_id,username,display_name,avatar_url FROM users WHERE id IN (${marks(userIds.length)})`,
        )
          .bind(...userIds)
          .all<PartyRow>()
      : { results: [] as PartyRow[] },
    keyIds.length
      ? env.DB.prepare(
          `SELECT id,name FROM balance_api_keys WHERE id IN (${marks(keyIds.length)})`,
        )
          .bind(...keyIds)
          .all<{ id: string; name: string }>()
      : { results: [] as { id: string; name: string }[] },
    withdrawalIds.length
      ? env.DB.prepare(
          `SELECT * FROM balance_withdrawals WHERE id IN (${marks(withdrawalIds.length)})`,
        )
          .bind(...withdrawalIds)
          .all<WithdrawalRow>()
      : { results: [] as WithdrawalRow[] },
  ]);
  return {
    users: new Map(users.results.map((row) => [row.id, row])),
    keys: new Map(keys.results.map((row) => [row.id, row.name])),
    withdrawals: new Map(withdrawals.results.map((row) => [row.id, row])),
  };
}

type Related = Awaited<ReturnType<typeof relatedOf>>;

function statusOf(
  row: TransferRow,
  withdrawal: WithdrawalRow | undefined,
): TransferStatus {
  if (row.destination === "balance") return "sent";
  if (withdrawal?.status === "sent") return "sent";
  if (withdrawal?.status === "failed") return "not_sent";
  return "sending";
}

function partyOf(
  row: PartyRow | undefined,
  fallback: {
    external_id: string;
    username: string;
  },
): BalanceTransferParty {
  return {
    userId: row?.external_id ?? fallback.external_id,
    username: row?.username ?? fallback.username,
    displayName: row?.display_name ?? fallback.username,
    avatarUrl: row?.avatar_url ?? null,
  };
}

function pageView(
  row: TransferRow,
  viewerId: string,
  related: Related,
): BalanceTransfer {
  const out = row.from_user_id === viewerId;
  const withdrawal = row.withdrawal_id
    ? related.withdrawals.get(row.withdrawal_id)
    : undefined;
  const sender = related.users.get(row.from_user_id);
  return {
    id: row.id,
    direction: out ? "out" : "in",
    destination: row.destination,
    amountMinor: row.amount_minor,
    remark: row.remark,
    counterpart: out
      ? partyOf(related.users.get(row.to_user_id), {
          external_id: row.recipient_external_id,
          username: row.recipient_username,
        })
      : partyOf(sender, { external_id: "", username: "" }),
    apiKeyName:
      out && row.api_key_id ? (related.keys.get(row.api_key_id) ?? null) : null,
    outTransferNo: out ? row.out_transfer_no : null,
    status: statusOf(row, withdrawal),
    withdrawal: out && withdrawal ? withdrawalView(withdrawal) : null,
    createdAt: row.created_at,
  };
}

/** 转账 in 明细, as the viewer sees them (sender or recipient). */
export async function transferViews(
  env: ApiBindings,
  rows: TransferRow[],
  viewerId: string,
) {
  const related = await relatedOf(env, rows);
  return rows.map((row) => pageView(row, viewerId, related));
}

/** One 转账 its sender or recipient opens; anyone else finds nothing. */
export async function transferDetail(
  env: ApiBindings,
  viewerId: string,
  id: string,
) {
  const row = await env.DB.prepare(
    `SELECT * FROM balance_transfers WHERE id=?1
      AND (from_user_id=?2 OR (to_user_id=?2 AND destination='balance'))`,
  )
    .bind(id, viewerId)
    .first<TransferRow>();
  if (!row) balanceError(404, "TRANSFER_NOT_FOUND", "没有找到这笔转账");
  const [view] = await transferViews(env, [row], viewerId);
  if (!view) throw new Error("Transfer view missing");
  return view;
}

/** A 转账 as the open API answers it (docs/balance-design.md §16). */
export type OpenTransfer = {
  id: string | null;
  outTransferNo: string | null;
  direction: "out" | "in";
  from: { userId: string; username: string };
  to: { userId: string; username: string };
  destination: TransferDestination;
  amount: string;
  remark: string | null;
  status: TransferStatus;
  notSentReason: WithdrawalFailure | null;
  createdAt: string;
  dryRun?: true;
};

function openView(
  row: TransferRow,
  ownerId: string,
  related: Related,
  dryRun = false,
): OpenTransfer {
  const withdrawal = row.withdrawal_id
    ? related.withdrawals.get(row.withdrawal_id)
    : undefined;
  const sender = related.users.get(row.from_user_id);
  return {
    id: row.id || null,
    outTransferNo: row.out_transfer_no,
    direction: row.from_user_id === ownerId ? "out" : "in",
    from: {
      userId: sender?.external_id ?? "",
      username: sender?.username ?? "",
    },
    to: { userId: row.recipient_external_id, username: row.recipient_username },
    destination: row.destination,
    amount: formatAmount(row.amount_minor),
    remark: row.remark,
    status: dryRun
      ? row.destination === "balance"
        ? "sent"
        : "sending"
      : statusOf(row, withdrawal),
    notSentReason:
      withdrawal?.status === "failed" ? withdrawal.failure_reason : null,
    createdAt: new Date(row.created_at).toISOString(),
    ...(dryRun ? { dryRun: true as const } : {}),
  };
}

/** 转账 for the open API, with their people and 转出 read at once. */
export async function openTransferViews(
  env: ApiBindings,
  rows: { row: TransferRow; dryRun?: boolean }[],
  ownerId: string,
) {
  const related = await relatedOf(
    env,
    rows.map(({ row }) => row),
  );
  return rows.map(({ row, dryRun }) => openView(row, ownerId, related, dryRun));
}

/** 转账 as admins list them: both sides, the key's name, the status. */
export async function adminTransferViews(
  env: ApiBindings,
  rows: TransferRow[],
) {
  const related = await relatedOf(env, rows);
  return rows.map((row) => {
    const withdrawal = row.withdrawal_id
      ? related.withdrawals.get(row.withdrawal_id)
      : undefined;
    return {
      id: row.id,
      from: partyOf(related.users.get(row.from_user_id), {
        external_id: "",
        username: "",
      }),
      to: partyOf(related.users.get(row.to_user_id), {
        external_id: row.recipient_external_id,
        username: row.recipient_username,
      }),
      fromUserId: row.from_user_id,
      toUserId: row.to_user_id,
      destination: row.destination,
      amountMinor: row.amount_minor,
      remark: row.remark,
      apiKeyName: row.api_key_id
        ? (related.keys.get(row.api_key_id) ?? null)
        : null,
      outTransferNo: row.out_transfer_no,
      status: statusOf(row, withdrawal),
      withdrawalId: row.withdrawal_id,
      createdAt: row.created_at,
    };
  });
}
