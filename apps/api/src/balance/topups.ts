// 转入 (docs/balance-design.md §3): an order to the platform app at Credit,
// confirmed by the person at Credit's cashier. No callbacks and no timers:
// the order is checked when someone asks (the detail page, the 🐟额 page,
// 重新查询, an admin), and the 🐟 arrive the first time Credit says paid.
import {
  amountToMinor,
  BALANCE_LIMITS,
  type BalanceTopup,
  type CreateTopupInput,
  quoteTopup,
} from "@hb/contracts";
import type { ApiBindings } from "../env";
import { loadMerchantSecret } from "../payments/credentials";
import {
  queryTopupOrder,
  type RealProtocolOptions,
  submitTopupOrder,
  type TopupQueryResult,
  type TopupSubmitResult,
} from "../payments/real-protocol";
import { credentialVerificationView } from "../payments/verification";
import { reachesCredit } from "../runtime/controls";
import { sha256Hex } from "../security/crypto";
import { balanceError } from "./errors";
import { readPlatformAppRow } from "./platform-app";
import { readBalanceSettings, requireBalanceOpen } from "./settings";

/** Shown in Credit's records and at its cashier. */
export const TOPUP_ORDER_NAME = "站内🐟额转入 · hb.lafi.sh";
/** A constant, like a claim's 业务号: `hb.lafi.sh_in_<32 hex>`, 46 characters. */
const BUSINESS_PREFIX = "hb.lafi.sh_in_";
/** “去 Credit 确认” and the page's polling last this long from the first order. */
export const TOPUP_PAYABLE_MS = 10 * 60_000;
const CHECK_INTERVAL_MS = 3_000;
/** 重新查询 on a 未完成 one. */
const RECHECK_INTERVAL_MS = 30_000;
const OPEN_CHECK_WINDOW_MS = 24 * 60 * 60_000;
const OPEN_CHECK_LIMIT = 5;

export type TopupRow = {
  id: string;
  user_id: string;
  merchant_id: string;
  client_id: string;
  credential_version: number;
  business_no: string;
  debit_minor: number;
  fee_minor: number;
  credit_minor: number;
  fee_percent: number;
  settings_version: number;
  order_name: string;
  return_url: string;
  status: "pending" | "unpaid" | "credited";
  flag: "mismatch" | "reversed" | null;
  external_order_id: string | null;
  request_id: string;
  request_digest: string;
  created_at: number;
  submitted_at: number | null;
  credited_at: number | null;
  credited_by: "auto" | "admin" | null;
  credited_by_user_id: string | null;
  credit_reason: string | null;
  last_checked_at: number | null;
  last_check_result: string | null;
  check_claimed_at: number;
  updated_at: number;
};

function protocol(): RealProtocolOptions {
  return { fetch: (input, init) => fetch(input, init) };
}

export function payableUntil(row: TopupRow) {
  return (row.submitted_at ?? row.created_at) + TOPUP_PAYABLE_MS;
}

export function topupView(row: TopupRow): BalanceTopup {
  return {
    id: row.id,
    businessNo: row.business_no,
    externalOrderId: row.external_order_id,
    status: row.status,
    flag: row.flag,
    debitMinor: row.debit_minor,
    feeMinor: row.fee_minor,
    creditMinor: row.credit_minor,
    feePercent: row.fee_percent,
    createdAt: row.created_at,
    payableUntil: payableUntil(row),
    creditedAt: row.credited_at,
    creditedBy: row.credited_by,
    lastCheckedAt: row.last_checked_at,
  };
}

export function readTopup(env: ApiBindings, id: string) {
  return env.DB.prepare("SELECT * FROM balance_topups WHERE id=?")
    .bind(id)
    .first<TopupRow>();
}

export async function ownedTopup(env: ApiBindings, userId: string, id: string) {
  const row = await readTopup(env, id);
  if (!row || row.user_id !== userId)
    balanceError(404, "TOPUP_NOT_FOUND", "没有找到这笔转入");
  return row;
}

function unavailable(message: string): never {
  balanceError(503, "BALANCE_TOPUP_UNAVAILABLE", message);
}

/** Starts a 转入 and asks Credit for its cashier. */
export async function createTopup(
  env: ApiBindings,
  userId: string,
  input: CreateTopupInput,
  appOrigin: string,
): Promise<{ topup: BalanceTopup; cashierUrl: string | null }> {
  await requireBalanceOpen(env, userId);
  const digest = await sha256Hex(
    `balance-topup:${JSON.stringify({ settingsVersion: input.settingsVersion, by: input.by, amount: input.amount })}`,
  );
  const previous = await env.DB.prepare(
    "SELECT * FROM balance_topups WHERE user_id=? AND request_id=?",
  )
    .bind(userId, input.requestId)
    .first<TopupRow>();
  if (previous) {
    if (previous.request_digest !== digest)
      balanceError(
        409,
        "TOPUP_REQUEST_REUSED",
        "同一次转入不能换数量，请重新填写。",
      );
    return resubmit(env, previous);
  }
  const settings = await readBalanceSettings(env);
  if (!settings.topupEnabled)
    balanceError(409, "BALANCE_TOPUP_PAUSED", "转入暂停");
  if (settings.version !== input.settingsVersion)
    balanceError(
      409,
      "BALANCE_SETTINGS_CHANGED",
      "流转费率刚刚改了，请看一下新的数量再确认。",
    );
  if (!reachesCredit(env)) unavailable("这个环境不能转入。");
  const platform = await readPlatformAppRow(env);
  if (!platform) unavailable("转入还没准备好，请稍后再试。");
  if (
    (
      await credentialVerificationView(
        env,
        platform.id,
        platform.credential_version,
      )
    ).status !== "passed"
  )
    unavailable("平台应用的凭证还没检查通过，暂时不能转入。");
  if (platform.author_id === userId)
    balanceError(
      403,
      "BALANCE_SELF",
      "Credit 不能给自己的应用付款，站长的账号不能转入。",
    );

  const amountMinor = amountToMinor(input.amount);
  const quote = quoteTopup(
    settings.topupFeePercent,
    input.by === "debit"
      ? { debitMinor: amountMinor }
      : { creditMinor: amountMinor },
  );
  if (
    quote.debitMinor < BALANCE_LIMITS.topupMinMinor ||
    quote.debitMinor > BALANCE_LIMITS.topupMaxMinor
  )
    balanceError(
      400,
      "BALANCE_TOPUP_RANGE",
      "Credit 扣除要在 1.00 到 2000.00 LDC 之间。",
    );

  const id = crypto.randomUUID();
  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT INTO balance_topups (id,user_id,merchant_id,client_id,credential_version,business_no,
      debit_minor,fee_minor,credit_minor,fee_percent,settings_version,order_name,return_url,
      request_id,request_digest,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    WHERE (SELECT COUNT(*) FROM balance_topups WHERE user_id=? AND created_at>?) < ?`,
  )
    .bind(
      id,
      userId,
      platform.id,
      platform.client_id,
      platform.credential_version,
      `${BUSINESS_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`,
      quote.debitMinor,
      quote.feeMinor,
      quote.creditMinor,
      settings.topupFeePercent,
      settings.version,
      TOPUP_ORDER_NAME,
      `${appOrigin}/balance/${id}`,
      input.requestId,
      digest,
      now,
      now,
      userId,
      now - 60 * 60_000,
      BALANCE_LIMITS.topupsPerHour,
    )
    .run()
    .catch(async (error) => {
      // The same request, sent twice at once: the one that got in.
      const winner = await env.DB.prepare(
        "SELECT id FROM balance_topups WHERE user_id=? AND request_id=?",
      )
        .bind(userId, input.requestId)
        .first();
      if (winner) return null;
      throw error;
    });
  if (inserted && inserted.meta.changes === 0)
    balanceError(
      429,
      "BALANCE_TOPUP_TOO_FREQUENT",
      "转入太频繁了，请过一会儿再试。",
    );
  const row =
    (await readTopup(env, id)) ??
    (await env.DB.prepare(
      "SELECT * FROM balance_topups WHERE user_id=? AND request_id=?",
    )
      .bind(userId, input.requestId)
      .first<TopupRow>());
  if (!row) throw new Error("Topup missing after creation");
  return resubmit(env, row);
}

/** “去 Credit 确认” again: the same order, while it can still be paid. */
export async function payTopup(env: ApiBindings, userId: string, id: string) {
  const row = await ownedTopup(env, userId, id);
  if (row.status !== "pending" || Date.now() >= payableUntil(row))
    balanceError(409, "TOPUP_CLOSED", "这笔转入已经过了确认时间，请新建一笔。");
  return resubmit(env, row);
}

async function resubmit(
  env: ApiBindings,
  row: TopupRow,
): Promise<{ topup: BalanceTopup; cashierUrl: string | null }> {
  if (row.status !== "pending" || Date.now() >= payableUntil(row))
    return { topup: topupView(row), cashierUrl: null };
  if (!reachesCredit(env)) unavailable("这个环境不能转入。");
  const secret = await loadMerchantSecret(
    env,
    row.merchant_id,
    row.credential_version,
    row.client_id,
  );
  const result = await submitTopupOrder(
    {
      clientId: row.client_id,
      clientSecret: secret,
      businessNo: row.business_no,
      name: row.order_name,
      amountMinor: row.debit_minor,
      returnUrl: row.return_url,
    },
    protocol(),
  );
  return afterSubmit(env, row, result);
}

async function afterSubmit(
  env: ApiBindings,
  row: TopupRow,
  result: TopupSubmitResult,
): Promise<{ topup: BalanceTopup; cashierUrl: string | null }> {
  const now = Date.now();
  if (result.kind === "cashier") {
    await env.DB.prepare(
      "UPDATE balance_topups SET submitted_at=COALESCE(submitted_at,?),updated_at=? WHERE id=?",
    )
      .bind(now, now, row.id)
      .run();
    console.info(
      JSON.stringify({ event: "balance_topup_created", topupId: row.id }),
    );
    return {
      topup: topupView((await readTopup(env, row.id)) ?? row),
      cashierUrl: result.url,
    };
  }
  if (result.kind === "retry") {
    console.warn(
      JSON.stringify({
        event: "balance_topup_submit_retry",
        topupId: row.id,
        reason: result.reason,
        httpStatus: result.httpStatus ?? null,
      }),
    );
    return { topup: topupView(row), cashierUrl: null };
  }
  // Turned down: Credit may still hold a paid order under this 业务号, so
  // check it before calling it 未完成.
  console.warn(
    JSON.stringify({
      event: "balance_topup_submit_refused",
      topupId: row.id,
      reason: result.reason,
      httpStatus: result.httpStatus,
    }),
  );
  const checked = await checkTopup(env, row, "submit", { force: true });
  if (checked.status === "pending")
    await env.DB.prepare(
      `UPDATE balance_topups SET status='unpaid',
        flag=CASE WHEN ?='conflict' THEN 'mismatch' ELSE flag END,
        last_check_result=CASE WHEN ?='credentials' THEN 'credentials' ELSE last_check_result END,
        updated_at=? WHERE id=? AND status='pending'`,
    )
      .bind(result.reason, result.reason, now, row.id)
      .run();
  return {
    topup: topupView((await readTopup(env, row.id)) ?? checked),
    cashierUrl: null,
  };
}

function creditStatements(
  env: ApiBindings,
  row: TopupRow,
  by: { kind: "auto" } | { kind: "admin"; userId: string; reason: string },
  externalOrderId: string | null,
) {
  const now = Date.now();
  return [
    env.DB.prepare(
      `UPDATE balance_topups SET status='credited',credited_at=?,credited_by=?,credited_by_user_id=?,
        credit_reason=?,external_order_id=COALESCE(external_order_id,?),updated_at=?
      WHERE id=? AND status IN ('pending','unpaid')`,
    ).bind(
      now,
      by.kind,
      by.kind === "admin" ? by.userId : null,
      by.kind === "admin" ? by.reason : null,
      externalOrderId,
      now,
      row.id,
    ),
    // Once per 转入 (and the unique index says so too): the 🐟 arrive.
    env.DB.prepare(
      `INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,topup_id,created_at)
      SELECT ?,user_id,'topup',credit_minor,0,id,? FROM balance_topups
      WHERE id=? AND status='credited'
        AND NOT EXISTS(SELECT 1 FROM balance_entries WHERE topup_id=? AND kind='topup')`,
    ).bind(crypto.randomUUID(), now, row.id, row.id),
  ];
}

function matches(
  row: TopupRow,
  result: Extract<TopupQueryResult, { evidence: unknown }>,
) {
  const evidence = result.evidence;
  return (
    evidence.clientId === row.client_id &&
    evidence.businessNo === row.business_no &&
    evidence.amountMinor === row.debit_minor &&
    (row.external_order_id === null ||
      evidence.externalOrderId === row.external_order_id)
  );
}

type CheckTrigger = "user" | "page" | "admin" | "submit";

/**
 * One check of a 转入 at Credit, at most every 3 s for each (30 s when a
 * person asks again about a 未完成 one); otherwise what is known.
 */
export async function checkTopup(
  env: ApiBindings,
  row: TopupRow,
  trigger: CheckTrigger,
  options: { force?: boolean } = {},
): Promise<TopupRow> {
  if (!reachesCredit(env)) return row;
  const now = Date.now();
  const interval =
    trigger === "user" && row.status === "unpaid"
      ? RECHECK_INTERVAL_MS
      : CHECK_INTERVAL_MS;
  const claimed = await env.DB.prepare(
    `UPDATE balance_topups SET check_claimed_at=? WHERE id=? AND (?=1 OR check_claimed_at<=?) RETURNING *`,
  )
    .bind(now, row.id, options.force ? 1 : 0, now - interval)
    .first<TopupRow>();
  if (!claimed) return (await readTopup(env, row.id)) ?? row;

  let result: TopupQueryResult;
  try {
    const secret = await loadMerchantSecret(
      env,
      claimed.merchant_id,
      claimed.credential_version,
      claimed.client_id,
    );
    result = await queryTopupOrder(
      {
        clientId: claimed.client_id,
        clientSecret: secret,
        businessNo: claimed.business_no,
      },
      protocol(),
    );
  } catch {
    result = { kind: "unavailable", reason: "network" };
  }
  const kind =
    result.kind === "paid" || result.kind === "unpaid"
      ? matches(claimed, result)
        ? result.kind
        : "mismatch"
      : result.kind;
  const httpStatus =
    "httpStatus" in result ? (result.httpStatus ?? null) : null;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "INSERT INTO balance_topup_checks (id,topup_id,trigger,result,http_status,created_at) VALUES (?,?,?,?,?,?)",
    ).bind(crypto.randomUUID(), claimed.id, trigger, kind, httpStatus, now),
    env.DB.prepare(
      "UPDATE balance_topups SET last_checked_at=?,last_check_result=?,updated_at=? WHERE id=?",
    ).bind(now, kind, now, claimed.id),
  ];
  if (kind === "paid" && result.kind === "paid") {
    if (claimed.status === "credited")
      // Paid again after a dispute was withdrawn: nothing to look into.
      statements.push(
        env.DB.prepare(
          "UPDATE balance_topups SET flag=NULL WHERE id=? AND flag='reversed'",
        ).bind(claimed.id),
      );
    else
      statements.push(
        ...creditStatements(
          env,
          claimed,
          { kind: "auto" },
          result.evidence.externalOrderId,
        ),
      );
  } else if (kind === "mismatch") {
    statements.push(
      env.DB.prepare(
        "UPDATE balance_topups SET flag='mismatch' WHERE id=?",
      ).bind(claimed.id),
    );
  } else if (claimed.status === "credited") {
    // Paid before, not now: a dispute, a refused one, or a refund. Only a
    // flag for an admin to look at Credit; never 🐟 taken back for it.
    if (kind === "unpaid" || kind === "not_found")
      statements.push(
        env.DB.prepare(
          "UPDATE balance_topups SET flag='reversed' WHERE id=? AND flag IS NULL",
        ).bind(claimed.id),
      );
  } else if (claimed.status === "pending" && now >= payableUntil(claimed)) {
    statements.push(
      env.DB.prepare(
        "UPDATE balance_topups SET status='unpaid' WHERE id=? AND status='pending'",
      ).bind(claimed.id),
    );
  }
  await env.DB.batch(statements);
  const after = (await readTopup(env, claimed.id)) ?? claimed;
  if (after.status === "credited" && claimed.status !== "credited")
    console.info(
      JSON.stringify({
        event: "balance_topup_credited",
        topupId: claimed.id,
        by: "auto",
      }),
    );
  else if (kind !== "paid" && kind !== "unpaid" && kind !== "not_found")
    console.warn(
      JSON.stringify({
        event: "balance_topup_check_failed",
        topupId: claimed.id,
        result: kind,
        httpStatus,
      }),
    );
  return after;
}

/** The 🐟额 page, opened: the person's recent 转入 not yet arrived. */
export async function checkOpenTopups(env: ApiBindings, userId: string) {
  const rows = await env.DB.prepare(
    `SELECT * FROM balance_topups WHERE user_id=? AND status IN ('pending','unpaid') AND created_at>?
    ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(userId, Date.now() - OPEN_CHECK_WINDOW_MS, OPEN_CHECK_LIMIT)
    .all<TopupRow>();
  const checked = await Promise.all(
    rows.results.map((row) => checkTopup(env, row, "page")),
  );
  return checked.filter((row) => row.status === "credited").length;
}

/**
 * An admin's 确认到账, after looking at Credit: the same way in as Credit's
 * 1, so it never adds to an automatic one.
 */
export async function confirmTopup(
  env: ApiBindings,
  adminUserId: string,
  id: string,
  reason: string,
) {
  const row = await readTopup(env, id);
  if (!row) balanceError(404, "TOPUP_NOT_FOUND", "没有找到这笔转入");
  if (row.user_id === adminUserId)
    balanceError(403, "BALANCE_SELF_ADMIN", "管理员不能处理自己的单");
  if (row.status === "credited")
    balanceError(409, "TOPUP_ALREADY_CREDITED", "这笔转入已经到账了");
  await env.DB.batch(
    creditStatements(
      env,
      row,
      { kind: "admin", userId: adminUserId, reason },
      null,
    ),
  );
  const after = await readTopup(env, id);
  if (after?.status === "credited")
    console.info(
      JSON.stringify({
        event: "balance_topup_credited",
        topupId: id,
        by: "admin",
      }),
    );
  return after ?? row;
}
