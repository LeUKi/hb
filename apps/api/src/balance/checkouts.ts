// 转账 through 对方的收银台 (docs/balance-design.md §16): an order made with
// the recipient's LDC 商户 and paid at Credit 站 from the payer's own Credit
// account, the way a 转入 is made with the platform app (topups.ts). Nothing
// passes 🐟额 or this site: it keeps how the order stands, checked only when
// someone asks (its page, the payer's 🐟额 page, the recipient's 商户 page).
import {
  amountToMinor,
  BALANCE_LIMITS,
  type BalanceCheckout,
  type BalanceTransferParty,
  type CheckoutBlock,
  type CreateCheckoutInput,
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
import { readBalanceSettings } from "./settings";
import { findRecipient, transferAccess } from "./transfers";

/** A constant, like a 转入's: `hb.lafi.sh_tr_<32 hex>`, 46 characters. */
const BUSINESS_PREFIX = "hb.lafi.sh_tr_";
/** “去 Credit 站确认” and the page's polling last this long from the first order. */
export const CHECKOUT_PAYABLE_MS = 10 * 60_000;
const CHECK_INTERVAL_MS = 3_000;
/** 重新查询 on a 未完成 one. */
const RECHECK_INTERVAL_MS = 30_000;
const OPEN_CHECK_WINDOW_MS = 24 * 60 * 60_000;
const OPEN_CHECK_LIMIT = 5;
/** Credit 站 takes an order name of up to 64 characters. */
const ORDER_NAME_MAX = 64;

export type CheckoutRow = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  to_username: string;
  to_linux_do_id: string;
  merchant_id: string;
  client_id: string;
  credential_version: number;
  business_no: string;
  amount_minor: number;
  remark: string | null;
  order_name: string;
  return_url: string;
  status: "pending" | "unpaid" | "paid";
  flag: "mismatch" | "reversed" | null;
  external_order_id: string | null;
  request_id: string;
  request_digest: string;
  created_at: number;
  submitted_at: number | null;
  paid_at: number | null;
  last_checked_at: number | null;
  last_check_result: string | null;
  check_claimed_at: number;
  updated_at: number;
};

/** A row with both people as they are now. */
type CheckoutWithUsers = CheckoutRow & {
  payer_external_id: string | null;
  payer_username: string | null;
  payer_display_name: string | null;
  payer_avatar_url: string | null;
  recipient_external_id: string | null;
  recipient_username: string | null;
  recipient_display_name: string | null;
  recipient_avatar_url: string | null;
};

const WITH_USERS = `SELECT c.*,
    p.external_id AS payer_external_id,p.username AS payer_username,
    p.display_name AS payer_display_name,p.avatar_url AS payer_avatar_url,
    r.external_id AS recipient_external_id,r.username AS recipient_username,
    r.display_name AS recipient_display_name,r.avatar_url AS recipient_avatar_url
  FROM balance_checkouts c
  LEFT JOIN users p ON p.id=c.from_user_id
  LEFT JOIN users r ON r.id=c.to_user_id`;

function protocol(): RealProtocolOptions {
  return { fetch: (input, init) => fetch(input, init) };
}

export function payableUntil(row: CheckoutRow) {
  return (row.submitted_at ?? row.created_at) + CHECKOUT_PAYABLE_MS;
}

function party(
  row: CheckoutWithUsers,
  side: "payer" | "recipient",
): BalanceTransferParty {
  const fallback =
    side === "recipient"
      ? { userId: row.to_linux_do_id, username: row.to_username }
      : { userId: "", username: "" };
  const username = row[`${side}_username`] ?? fallback.username;
  return {
    userId: row[`${side}_external_id`] ?? fallback.userId,
    username,
    displayName: row[`${side}_display_name`] ?? username,
    avatarUrl: row[`${side}_avatar_url`],
  };
}

export function checkoutView(
  row: CheckoutWithUsers,
  viewerId: string,
): BalanceCheckout {
  const out = row.from_user_id === viewerId;
  return {
    id: row.id,
    direction: out ? "out" : "in",
    counterpart: party(row, out ? "recipient" : "payer"),
    amountMinor: row.amount_minor,
    remark: row.remark,
    status: row.status,
    mismatch: row.flag === "mismatch",
    businessNo: row.business_no,
    externalOrderId: row.external_order_id,
    createdAt: row.created_at,
    payableUntil: payableUntil(row),
    paidAt: row.paid_at,
    lastCheckedAt: row.last_checked_at,
  };
}

function readCheckout(env: ApiBindings, id: string) {
  return env.DB.prepare(`${WITH_USERS} WHERE c.id=?`)
    .bind(id)
    .first<CheckoutWithUsers>();
}

/** One its payer opens; the recipient sees theirs on the 商户 page. */
export async function ownedCheckout(
  env: ApiBindings,
  userId: string,
  id: string,
) {
  const row = await readCheckout(env, id);
  if (!row || row.from_user_id !== userId)
    balanceError(404, "CHECKOUT_NOT_FOUND", "没有找到这笔付款");
  return row;
}

/**
 * The recipient's LDC 商户, when it can take a payment now: their current
 * one, paying for real, its 凭证 checked and passed.
 */
export async function checkoutMerchant(
  env: ApiBindings,
  userId: string,
): Promise<
  | {
      block: null;
      merchant: { id: string; client_id: string; credential_version: number };
    }
  | { block: CheckoutBlock; merchant: null }
> {
  const merchant = await env.DB.prepare(
    `SELECT id,client_id,credential_version,mode FROM merchants
    WHERE author_id=? AND kind='author' AND usage_status='current'`,
  )
    .bind(userId)
    .first<{
      id: string;
      client_id: string;
      credential_version: number;
      mode: string;
    }>();
  if (merchant?.mode !== "real")
    return { block: "no_merchant", merchant: null };
  const verification = await credentialVerificationView(
    env,
    merchant.id,
    merchant.credential_version,
  );
  if (verification.status !== "passed")
    return { block: "unverified", merchant: null };
  return { block: null, merchant };
}

const blockText: Record<CheckoutBlock, string> = {
  no_merchant: "对方还没有配置 LDC 商户",
  unverified: "对方的商户凭证未通过",
};

function unavailable(message: string): never {
  balanceError(503, "CHECKOUT_UNAVAILABLE", message);
}

/** “转账 · @付款人 · hb.lafi.sh”, the name cut to fit Credit 站's 64. */
function orderName(payerUsername: string) {
  const room = ORDER_NAME_MAX - Array.from("转账 · @ · hb.lafi.sh").length;
  const name = Array.from(payerUsername).slice(0, room).join("");
  return `转账 · @${name} · hb.lafi.sh`;
}

/** Makes one and asks Credit 站 for its cashier, with the recipient's 商户. */
export async function createCheckout(
  env: ApiBindings,
  payer: { id: string; username: string },
  input: CreateCheckoutInput,
  appOrigin: string,
): Promise<{ checkout: BalanceCheckout; cashierUrl: string | null }> {
  if (!(await transferAccess(env, payer.id)).allowed)
    balanceError(403, "TRANSFER_NOT_ALLOWED", "开通🐟额 PLUS 才能转账。");
  const remark = input.remark || null;
  const digest = await sha256Hex(
    `balance-checkout:${JSON.stringify({
      toUserId: input.toUserId,
      toUsername: input.toUsername.toLowerCase(),
      amount: amountToMinor(input.amount),
      remark,
    })}`,
  );
  const previous = await env.DB.prepare(
    "SELECT * FROM balance_checkouts WHERE from_user_id=? AND request_id=?",
  )
    .bind(payer.id, input.requestId)
    .first<CheckoutRow>();
  if (previous) {
    if (previous.request_digest !== digest)
      balanceError(
        409,
        "CHECKOUT_REQUEST_REUSED",
        "同一笔付款不能换内容，请重新填写。",
      );
    return resubmit(env, previous, payer.id);
  }
  if (!(await readBalanceSettings(env)).transferEnabled)
    balanceError(403, "TRANSFER_DISABLED", "转账暂时关闭");
  if (!reachesCredit(env)) unavailable("这个环境不能付款。");
  const recipient = await findRecipient(env, input.toUserId, input.toUsername);
  if (!recipient) balanceError(404, "RECIPIENT_NOT_FOUND", "收款人不存在");
  if (recipient.id === payer.id)
    balanceError(400, "SELF_TRANSFER", "不能转给自己");
  const amountMinor = amountToMinor(input.amount);
  if (
    amountMinor < BALANCE_LIMITS.topupMinMinor ||
    amountMinor > BALANCE_LIMITS.topupMaxMinor
  )
    balanceError(
      400,
      "AMOUNT_OUT_OF_RANGE",
      "付多少要在 1.00 到 2000.00 LDC 之间。",
    );
  const { block, merchant } = await checkoutMerchant(env, recipient.id);
  if (block !== null) balanceError(409, "CHECKOUT_BLOCKED", blockText[block]);

  const id = crypto.randomUUID();
  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT INTO balance_checkouts (id,from_user_id,to_user_id,to_username,to_linux_do_id,merchant_id,
      client_id,credential_version,business_no,amount_minor,remark,order_name,return_url,
      request_id,request_digest,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    WHERE (SELECT COUNT(*) FROM balance_checkouts WHERE from_user_id=? AND created_at>?) < ?`,
  )
    .bind(
      id,
      payer.id,
      recipient.id,
      recipient.username,
      recipient.external_id,
      merchant.id,
      merchant.client_id,
      merchant.credential_version,
      `${BUSINESS_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`,
      amountMinor,
      remark,
      orderName(payer.username),
      `${appOrigin}/balance/pay/${id}`,
      input.requestId,
      digest,
      now,
      now,
      payer.id,
      now - 60 * 60_000,
      BALANCE_LIMITS.topupsPerHour,
    )
    .run()
    .catch(async (error) => {
      // The same request, sent twice at once: the one that got in.
      const winner = await env.DB.prepare(
        "SELECT id FROM balance_checkouts WHERE from_user_id=? AND request_id=?",
      )
        .bind(payer.id, input.requestId)
        .first();
      if (winner) return null;
      throw error;
    });
  if (inserted && inserted.meta.changes === 0)
    balanceError(
      429,
      "CHECKOUT_TOO_FREQUENT",
      "付款太频繁了，请过一会儿再试。",
    );
  const row = await env.DB.prepare(
    "SELECT * FROM balance_checkouts WHERE from_user_id=? AND request_id=?",
  )
    .bind(payer.id, input.requestId)
    .first<CheckoutRow>();
  if (!row) throw new Error("Checkout missing after creation");
  return resubmit(env, row, payer.id);
}

/** “去 Credit 站确认” again: the same order, while it can still be paid. */
export async function payCheckout(
  env: ApiBindings,
  userId: string,
  id: string,
) {
  const row = await ownedCheckout(env, userId, id);
  if (row.status !== "pending" || Date.now() >= payableUntil(row))
    balanceError(
      409,
      "CHECKOUT_CLOSED",
      "这笔付款已经过了确认时间，请重新转账。",
    );
  return resubmit(env, row, userId);
}

async function viewOf(env: ApiBindings, id: string, viewerId: string) {
  const row = await readCheckout(env, id);
  if (!row) throw new Error("Checkout missing");
  return checkoutView(row, viewerId);
}

async function resubmit(
  env: ApiBindings,
  row: CheckoutRow,
  viewerId: string,
): Promise<{ checkout: BalanceCheckout; cashierUrl: string | null }> {
  if (row.status !== "pending" || Date.now() >= payableUntil(row))
    return { checkout: await viewOf(env, row.id, viewerId), cashierUrl: null };
  if (!reachesCredit(env)) unavailable("这个环境不能付款。");
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
      amountMinor: row.amount_minor,
      returnUrl: row.return_url,
    },
    protocol(),
  );
  return afterSubmit(env, row, result, viewerId);
}

async function afterSubmit(
  env: ApiBindings,
  row: CheckoutRow,
  result: TopupSubmitResult,
  viewerId: string,
): Promise<{ checkout: BalanceCheckout; cashierUrl: string | null }> {
  const now = Date.now();
  if (result.kind === "cashier") {
    await env.DB.prepare(
      "UPDATE balance_checkouts SET submitted_at=COALESCE(submitted_at,?),updated_at=? WHERE id=?",
    )
      .bind(now, now, row.id)
      .run();
    console.info(
      JSON.stringify({ event: "balance_checkout_created", checkoutId: row.id }),
    );
    return {
      checkout: await viewOf(env, row.id, viewerId),
      cashierUrl: result.url,
    };
  }
  if (result.kind === "retry") {
    console.warn(
      JSON.stringify({
        event: "balance_checkout_submit_retry",
        checkoutId: row.id,
        reason: result.reason,
        httpStatus: result.httpStatus ?? null,
      }),
    );
    return { checkout: await viewOf(env, row.id, viewerId), cashierUrl: null };
  }
  // Turned down: Credit 站 may still hold a paid order under this 业务号, so
  // check it before calling it 未完成.
  console.warn(
    JSON.stringify({
      event: "balance_checkout_submit_refused",
      checkoutId: row.id,
      reason: result.reason,
      httpStatus: result.httpStatus,
    }),
  );
  const checked = await checkCheckout(env, row, "submit", { force: true });
  if (checked.status === "pending")
    await env.DB.prepare(
      `UPDATE balance_checkouts SET status='unpaid',
        flag=CASE WHEN ?='conflict' THEN 'mismatch' ELSE flag END,
        last_check_result=CASE WHEN ?='credentials' THEN 'credentials' ELSE last_check_result END,
        updated_at=? WHERE id=? AND status='pending'`,
    )
      .bind(result.reason, result.reason, now, row.id)
      .run();
  return { checkout: await viewOf(env, row.id, viewerId), cashierUrl: null };
}

function matches(
  row: CheckoutRow,
  result: Extract<TopupQueryResult, { evidence: unknown }>,
) {
  const evidence = result.evidence;
  return (
    evidence.clientId === row.client_id &&
    evidence.businessNo === row.business_no &&
    evidence.amountMinor === row.amount_minor &&
    (row.external_order_id === null ||
      evidence.externalOrderId === row.external_order_id)
  );
}

type CheckTrigger = "user" | "page" | "submit";

/**
 * One check at Credit 站, at most every 3 s for each (30 s when a person
 * asks again about a 未完成 one); otherwise what is known. The 商户 credential
 * is the version it was made with, so a later change does not stop it.
 */
export async function checkCheckout(
  env: ApiBindings,
  row: CheckoutRow,
  trigger: CheckTrigger,
  options: { force?: boolean } = {},
): Promise<CheckoutRow> {
  if (!reachesCredit(env)) return row;
  const now = Date.now();
  const interval =
    trigger === "user" && row.status === "unpaid"
      ? RECHECK_INTERVAL_MS
      : CHECK_INTERVAL_MS;
  const claimed = await env.DB.prepare(
    `UPDATE balance_checkouts SET check_claimed_at=? WHERE id=? AND (?=1 OR check_claimed_at<=?) RETURNING *`,
  )
    .bind(now, row.id, options.force ? 1 : 0, now - interval)
    .first<CheckoutRow>();
  if (!claimed) return (await readCheckout(env, row.id)) ?? row;

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
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "UPDATE balance_checkouts SET last_checked_at=?,last_check_result=?,updated_at=? WHERE id=?",
    ).bind(now, kind, now, claimed.id),
  ];
  if (kind === "paid" && result.kind === "paid") {
    statements.push(
      claimed.status === "paid"
        ? // Paid again after a dispute was withdrawn.
          env.DB.prepare(
            "UPDATE balance_checkouts SET flag=NULL WHERE id=? AND flag='reversed'",
          ).bind(claimed.id)
        : env.DB.prepare(
            `UPDATE balance_checkouts SET status='paid',paid_at=?,
              external_order_id=COALESCE(external_order_id,?)
            WHERE id=? AND status IN ('pending','unpaid')`,
          ).bind(now, result.evidence.externalOrderId, claimed.id),
    );
  } else if (kind === "mismatch") {
    statements.push(
      env.DB.prepare(
        "UPDATE balance_checkouts SET flag='mismatch' WHERE id=?",
      ).bind(claimed.id),
    );
  } else if (claimed.status === "paid") {
    // Paid before, not now: a dispute or a refund at Credit 站. A mark only.
    if (kind === "unpaid" || kind === "not_found")
      statements.push(
        env.DB.prepare(
          "UPDATE balance_checkouts SET flag='reversed' WHERE id=? AND flag IS NULL",
        ).bind(claimed.id),
      );
  } else if (claimed.status === "pending" && now >= payableUntil(claimed)) {
    statements.push(
      env.DB.prepare(
        "UPDATE balance_checkouts SET status='unpaid' WHERE id=? AND status='pending'",
      ).bind(claimed.id),
    );
  }
  await env.DB.batch(statements);
  const after =
    (await env.DB.prepare("SELECT * FROM balance_checkouts WHERE id=?")
      .bind(claimed.id)
      .first<CheckoutRow>()) ?? claimed;
  if (after.status === "paid" && claimed.status !== "paid")
    console.info(
      JSON.stringify({
        event: "balance_checkout_paid",
        checkoutId: claimed.id,
      }),
    );
  else if (kind !== "paid" && kind !== "unpaid" && kind !== "not_found")
    console.warn(
      JSON.stringify({
        event: "balance_checkout_check_failed",
        checkoutId: claimed.id,
        result: kind,
      }),
    );
  return after;
}

/**
 * A page opened: the payer's (🐟额) or the recipient's (LDC 商户) recent
 * ones not yet paid, checked. How many turned out paid.
 */
export async function checkOpenCheckouts(
  env: ApiBindings,
  userId: string,
  side: "payer" | "recipient",
) {
  const rows = await env.DB.prepare(
    `SELECT * FROM balance_checkouts WHERE ${side === "payer" ? "from_user_id" : "to_user_id"}=?
      AND status IN ('pending','unpaid') AND created_at>?
    ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(userId, Date.now() - OPEN_CHECK_WINDOW_MS, OPEN_CHECK_LIMIT)
    .all<CheckoutRow>();
  const checked = await Promise.all(
    rows.results.map((row) => checkCheckout(env, row, "page")),
  );
  return checked.filter((row) => row.status === "paid").length;
}

/** The payer's, for 明细: a page of them before a cursor. */
export async function checkoutPage(
  env: ApiBindings,
  userId: string,
  before: { time: number; id: string } | null,
  limit: number,
) {
  const rows = await env.DB.prepare(
    `${WITH_USERS} WHERE c.from_user_id=? AND (?=0 OR c.created_at<? OR (c.created_at=? AND c.id<?))
    ORDER BY c.created_at DESC,c.id DESC LIMIT ?`,
  )
    .bind(
      userId,
      before ? 1 : 0,
      before?.time ?? 0,
      before?.time ?? 0,
      before?.id ?? "",
      limit,
    )
    .all<CheckoutWithUsers>();
  return rows.results.map((row) => checkoutView(row, userId));
}

/** 收到的付款 on the recipient's 商户 page: paid ones, newest first, 20 at a time. */
export async function listReceivedCheckouts(
  env: ApiBindings,
  userId: string,
  before: { time: number; id: string } | null,
) {
  const rows = await env.DB.prepare(
    `${WITH_USERS} WHERE c.to_user_id=? AND c.status='paid'
      AND (?=0 OR c.created_at<? OR (c.created_at=? AND c.id<?))
    ORDER BY c.created_at DESC,c.id DESC LIMIT 21`,
  )
    .bind(
      userId,
      before ? 1 : 0,
      before?.time ?? 0,
      before?.time ?? 0,
      before?.id ?? "",
    )
    .all<CheckoutWithUsers>();
  const items = rows.results.slice(0, 20);
  const last = items.at(-1);
  return {
    items: items.map((row) => checkoutView(row, userId)),
    nextCursor:
      rows.results.length > 20 && last
        ? btoa(JSON.stringify({ time: last.created_at, id: last.id }))
        : null,
  };
}
