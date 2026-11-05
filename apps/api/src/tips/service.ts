// 打赏 (docs/tip-design.md §5, §7): a tip through a card. Credit 站: an
// order on the owner's 商户 that this site makes and checks (guests only
// this way, after a Cap check). 🐟额: a 转账 to the owner's 🐟额, written
// together with the tip (🐟额 PLUS, 免密打赏). 我的商户 is not built yet.
import {
  amountToMinor,
  type CreateTipInput,
  TIP_LIMITS,
  type Tip,
  type TipList,
  type TipMethod,
  type TipRange,
  type TipReceipt,
  type TipResult,
  type TipViewer,
} from "@hb/contracts";
import { capEndpoint } from "../activities/human-check";
import { checkoutMerchant } from "../balance/checkouts";
import { readAccount } from "../balance/ledger";
import { readBalanceSettings } from "../balance/settings";
import { makeTransfer, transferAccess } from "../balance/transfers";
import type { ApiBindings } from "../env";
import { loadMerchantSecret } from "../payments/credentials";
import {
  queryTopupOrder,
  type RealProtocolOptions,
  submitTopupOrder,
  type TopupQueryResult,
} from "../payments/real-protocol";
import { reachesCredit } from "../runtime/controls";
import { sha256Hex } from "../security/crypto";
import { amountsOf, type CardWithOwner, tipError } from "./cards";

/** `hb.lafi.sh_tp_<32 hex>`, 46 characters, like a 转入's. */
const BUSINESS_PREFIX = "hb.lafi.sh_tp_";
/** Credit 站 takes an order name of up to 64 characters, a return URL of 100. */
const ORDER_NAME_MAX = 64;
const RETURN_URL_MAX = 100;
const HOUR_MS = 3_600_000;
/** 我的商户 is not built yet (docs/tip-design.md §5): never offered. */
const MERCHANT_TIPS = false;

export type TipRow = {
  id: string;
  card_id: string;
  card_version: number;
  owner_id: string;
  tipper_id: string | null;
  amount_minor: number;
  method: TipMethod;
  message: string | null;
  message_hidden: number;
  status: Tip["status"];
  not_sent_reason: string | null;
  via: Tip["via"];
  request_id: string;
  request_digest: string;
  merchant_id: string | null;
  client_id: string | null;
  credential_version: number | null;
  business_no: string | null;
  order_name: string | null;
  return_url: string | null;
  external_order_id: string | null;
  flag: "mismatch" | "reversed" | null;
  submitted_at: number | null;
  last_checked_at: number | null;
  last_check_result: string | null;
  check_claimed_at: number;
  transfer_id: string | null;
  payment_task_id: string | null;
  created_at: number;
  done_at: number | null;
  updated_at: number;
};

type TipWithPeople = TipRow & {
  card_code: string;
  card_name: string;
  card_palette: TipReceipt["card"]["palette"];
  owner_username: string;
  owner_display_name: string;
  owner_avatar_url: string | null;
  tipper_username: string | null;
  tipper_display_name: string | null;
  tipper_avatar_url: string | null;
};

const WITH_PEOPLE = `SELECT t.*,c.code AS card_code,c.name AS card_name,c.palette AS card_palette,
    o.username AS owner_username,o.display_name AS owner_display_name,o.avatar_url AS owner_avatar_url,
    p.username AS tipper_username,p.display_name AS tipper_display_name,p.avatar_url AS tipper_avatar_url
  FROM tips t JOIN tip_cards c ON c.id=t.card_id JOIN users o ON o.id=t.owner_id
  LEFT JOIN users p ON p.id=t.tipper_id`;

export type Tipper = { id: string; username: string } | null;

function protocol(): RealProtocolOptions {
  return { fetch: (input, init) => fetch(input, init) };
}

/** “打赏 · @看客 · hb.lafi.sh” (a guest's has no name), cut to Credit 站's 64. */
function orderName(tipperUsername: string | null) {
  if (!tipperUsername) return "打赏 · hb.lafi.sh";
  const room = ORDER_NAME_MAX - Array.from("打赏 · @ · hb.lafi.sh").length;
  return `打赏 · @${Array.from(tipperUsername).slice(0, room).join("")} · hb.lafi.sh`;
}

/** Where Credit 站 sends the payer back: the tip's own page. */
export function receiptUrl(appOrigin: string, code: string, tipId: string) {
  return `${appOrigin}/${encodeURIComponent("☕")}/${code}/${encodeURIComponent("🧾")}/${tipId}`;
}

/** What may be paid with on this card, by this viewer. */
export async function viewerOf(
  env: ApiBindings,
  card: CardWithOwner,
  viewer: Tipper,
): Promise<TipViewer> {
  const settings = await readBalanceSettings(env);
  const own = viewer?.id === card.owner_id;
  const checkout = await receivingOf(env, card.owner_id);
  const passwordFree = settings.tipPasswordFreeEnabled;
  let balance: TipViewer["methods"]["balance"] = null;
  if (
    viewer &&
    !own &&
    passwordFree &&
    settings.transferEnabled &&
    (await transferAccess(env, viewer.id)).allowed
  ) {
    const account = await readAccount(env, viewer.id);
    if (account.availableMinor > 0)
      balance = { availableMinor: account.availableMinor };
  }
  let merchant: TipViewer["methods"]["merchant"] = null;
  if (MERCHANT_TIPS && viewer && !own && passwordFree) {
    const mine = await checkoutMerchant(env, viewer.id);
    if (mine.merchant)
      merchant = {
        name:
          (
            await env.DB.prepare("SELECT label FROM merchants WHERE id=?")
              .bind(mine.merchant.id)
              .first<{ label: string }>()
          )?.label ?? "我的商户",
      };
  }
  return {
    signedIn: viewer !== null,
    own,
    methods: { checkout, merchant, balance },
    passwordFree,
    paused: !settings.tipEnabled,
    capEndpoint: viewer ? null : capEndpoint(env, `tip:${card.code}`),
  };
}

function tipView(row: TipWithPeople, viewerId: string | null): Tip {
  const out = viewerId !== null && row.tipper_id === viewerId;
  const counterpart = out
    ? {
        username: row.owner_username,
        displayName: row.owner_display_name,
        avatarUrl: row.owner_avatar_url,
      }
    : row.tipper_username
      ? {
          username: row.tipper_username,
          displayName: row.tipper_display_name ?? row.tipper_username,
          avatarUrl: row.tipper_avatar_url,
        }
      : null;
  return {
    id: row.id,
    // The card's name is its owner's.
    card: { code: row.card_code, name: out ? null : row.card_name },
    direction: out ? "out" : "in",
    counterpart,
    amountMinor: row.amount_minor,
    method: row.method,
    message: row.message,
    messageHidden: row.message_hidden === 1,
    status: row.status,
    notSentReason: row.not_sent_reason,
    via: row.via,
    createdAt: row.created_at,
    doneAt: row.done_at,
  };
}

async function readTip(env: ApiBindings, id: string) {
  return env.DB.prepare(`${WITH_PEOPLE} WHERE t.id=?`)
    .bind(id)
    .first<TipWithPeople>();
}

async function previousTip(
  env: ApiBindings,
  tipper: Tipper,
  requestId: string,
) {
  return tipper
    ? env.DB.prepare("SELECT * FROM tips WHERE tipper_id=? AND request_id=?")
        .bind(tipper.id, requestId)
        .first<TipRow>()
    : env.DB.prepare(
        "SELECT * FROM tips WHERE tipper_id IS NULL AND request_id=?",
      )
        .bind(requestId)
        .first<TipRow>();
}

async function resultOf(
  env: ApiBindings,
  id: string,
  viewerId: string | null,
  payUrl: string | null,
): Promise<TipResult> {
  const row = await readTip(env, id);
  if (!row) throw new Error("Tip missing");
  return { tip: tipView(row, viewerId), payUrl };
}

/**
 * Makes a tip on this card. The same request again gives back the same tip
 * (and, while its Credit 站 order waits, the cashier again); different
 * content under the same request is refused. A guest's Cap check is the
 * route's, before this.
 */
export async function createTip(
  env: ApiBindings,
  card: CardWithOwner,
  tipper: Tipper,
  input: CreateTipInput,
  via: Tip["via"],
  appOrigin: string,
): Promise<TipResult> {
  const amountMinor = amountToMinor(input.amount);
  const message = input.message ?? null;
  const digest = await sha256Hex(
    `tip:${JSON.stringify({ card: card.id, amountMinor, method: input.method, message })}`,
  );
  const previous = await previousTip(env, tipper, input.requestId);
  if (previous) {
    if (previous.request_digest !== digest)
      tipError(409, "TIP_REQUEST_REUSED", "同一笔打赏不能换内容，请重新选。");
    return previous.method === "checkout" && previous.status === "pending"
      ? submitCheckout(env, previous, tipper?.id ?? null)
      : resultOf(env, previous.id, tipper?.id ?? null, null);
  }
  const settings = await readBalanceSettings(env);
  if (!settings.tipEnabled) tipError(403, "TIP_DISABLED", "打赏暂时关闭");
  if (card.stopped_at !== null)
    tipError(409, "TIP_CARD_STOPPED", "这张打赏卡已停用");
  if (input.cardVersion !== card.version)
    tipError(409, "TIP_CARD_CHANGED", "打赏卡刚改过，请重新选。");
  if (tipper?.id === card.owner_id)
    tipError(400, "TIP_SELF", "不能打赏自己的卡");
  const listed = amountsOf(card).some(
    (item) => item.amountMinor === amountMinor,
  );
  const other =
    card.allow_other === 1 &&
    amountMinor >= TIP_LIMITS.amountMinMinor &&
    amountMinor <= TIP_LIMITS.amountMaxMinor;
  if (!listed && !other)
    tipError(400, "TIP_AMOUNT_INVALID", "这张卡上没有这个数额，请重新选。");
  const base = { card, tipper, input, via, amountMinor, message, digest };
  if (input.method === "checkout")
    return createCheckoutTip(env, base, appOrigin);
  if (input.method === "balance") return createBalanceTip(env, base, settings);
  tipError(
    503,
    "TIP_METHOD_UNAVAILABLE",
    "暂时不能从自己的商户打赏，请用 Credit 站付。",
  );
}

type TipBase = {
  card: CardWithOwner;
  tipper: Tipper;
  input: CreateTipInput;
  via: Tip["via"];
  amountMinor: number;
  message: string | null;
  digest: string;
};

async function createCheckoutTip(
  env: ApiBindings,
  base: TipBase,
  appOrigin: string,
) {
  const { card, tipper, input } = base;
  if (!reachesCredit(env)) tipError(503, "TIP_OFFLINE", "这个环境不能付款。");
  const { block, merchant } = await checkoutMerchant(env, card.owner_id);
  if (block !== null)
    tipError(
      409,
      "TIP_NO_MERCHANT",
      block === "no_merchant"
        ? "作者还没开 LDC 商户，不能用 Credit 站付。"
        : "作者的商户凭证没通过，暂时不能用 Credit 站付。",
    );
  const id = crypto.randomUUID();
  const now = Date.now();
  const returnUrl = receiptUrl(appOrigin, card.code, id);
  if (returnUrl.length > RETURN_URL_MAX)
    throw new Error("Tip return URL too long");
  const inserted = await env.DB.prepare(
    `INSERT INTO tips (id,card_id,card_version,owner_id,tipper_id,amount_minor,method,message,status,via,
      request_id,request_digest,merchant_id,client_id,credential_version,business_no,order_name,return_url,
      created_at,updated_at)
    SELECT ?1,?2,?3,?4,?5,?6,'checkout',?7,'pending',?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17
    WHERE ?5 IS NULL OR (SELECT COUNT(*) FROM tips WHERE tipper_id=?5 AND created_at>?18) < ?19`,
  )
    .bind(
      id,
      card.id,
      card.version,
      card.owner_id,
      tipper?.id ?? null,
      base.amountMinor,
      base.message,
      base.via,
      input.requestId,
      base.digest,
      merchant.id,
      merchant.client_id,
      merchant.credential_version,
      `${BUSINESS_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`,
      orderName(tipper?.username ?? null),
      returnUrl,
      now,
      now - HOUR_MS,
      TIP_LIMITS.linksPerHour,
    )
    .run()
    .catch(async (error) => {
      // The same request, sent twice at once: the one that got in.
      if (await previousTip(env, tipper, input.requestId)) return null;
      throw error;
    });
  if (inserted && inserted.meta.changes === 0)
    tipError(429, "TIP_TOO_FREQUENT", "生成得太频繁了，过一会儿再试。");
  const row = await previousTip(env, tipper, input.requestId);
  if (!row) throw new Error("Tip missing after creation");
  return submitCheckout(env, row, tipper?.id ?? null);
}

/** Asks Credit 站 for the order's cashier: the same order while it waits. */
async function submitCheckout(
  env: ApiBindings,
  row: TipRow,
  viewerId: string | null,
): Promise<TipResult> {
  if (
    row.status !== "pending" ||
    !reachesCredit(env) ||
    !row.merchant_id ||
    !row.client_id ||
    !row.business_no
  )
    return resultOf(env, row.id, viewerId, null);
  const secret = await loadMerchantSecret(
    env,
    row.merchant_id,
    row.credential_version ?? 0,
    row.client_id,
  );
  const result = await submitTopupOrder(
    {
      clientId: row.client_id,
      clientSecret: secret,
      businessNo: row.business_no,
      name: row.order_name ?? orderName(null),
      amountMinor: row.amount_minor,
      returnUrl: row.return_url ?? "",
    },
    protocol(),
  );
  const now = Date.now();
  if (result.kind === "cashier") {
    await env.DB.prepare(
      "UPDATE tips SET submitted_at=COALESCE(submitted_at,?),updated_at=? WHERE id=?",
    )
      .bind(now, now, row.id)
      .run();
    return resultOf(env, row.id, viewerId, result.url);
  }
  if (result.kind === "retry") {
    console.warn(
      JSON.stringify({
        event: "tip_submit_retry",
        tipId: row.id,
        reason: result.reason,
      }),
    );
    return resultOf(env, row.id, viewerId, null);
  }
  // Turned down (expired, closed): Credit 站 may still hold a paid order
  // under this 业务号, so check before calling it 没付.
  console.warn(
    JSON.stringify({
      event: "tip_submit_refused",
      tipId: row.id,
      reason: result.reason,
    }),
  );
  const checked = await checkTip(env, row, { force: true });
  if (checked.status === "pending")
    await env.DB.prepare(
      "UPDATE tips SET status='unpaid',updated_at=? WHERE id=? AND status='pending'",
    )
      .bind(now, row.id)
      .run();
  return resultOf(env, row.id, viewerId, null);
}

async function createBalanceTip(
  env: ApiBindings,
  base: TipBase,
  settings: Awaited<ReturnType<typeof readBalanceSettings>>,
): Promise<TipResult> {
  const { card, tipper, input } = base;
  if (!tipper) tipError(403, "TIP_SIGN_IN", "登录以后才能用🐟额打赏。");
  if (!settings.tipPasswordFreeEnabled)
    tipError(
      403,
      "TIP_PASSWORD_FREE_OFF",
      "免密打赏暂时关闭，请用 Credit 站付。",
    );
  if (!settings.transferEnabled)
    tipError(403, "TIP_BALANCE_OFF", "🐟额打赏暂时关闭，请用 Credit 站付。");
  if (!(await transferAccess(env, tipper.id)).allowed)
    tipError(403, "TIP_BALANCE_NOT_ALLOWED", "开通🐟额 PLUS 才能用🐟额打赏。");
  const id = crypto.randomUUID();
  // A 转账 to the owner's 🐟额 (balance-design §16), written with the tip.
  await makeTransfer(
    env,
    tipper.id,
    {
      toUserId: card.owner_external_id,
      toUsername: card.owner_username.toLowerCase(),
      destination: "balance",
      amountMinor: base.amountMinor,
      remark: "打赏",
    },
    { kind: "page", requestId: input.requestId },
    (transferId, now) => [
      env.DB.prepare(
        `INSERT INTO tips (id,card_id,card_version,owner_id,tipper_id,amount_minor,method,message,status,via,
          request_id,request_digest,transfer_id,created_at,done_at,updated_at)
        VALUES (?,?,?,?,?,?,'balance',?,'done',?,?,?,?,?,?,?)`,
      ).bind(
        id,
        card.id,
        card.version,
        card.owner_id,
        tipper.id,
        base.amountMinor,
        base.message,
        base.via,
        input.requestId,
        base.digest,
        transferId,
        now,
        now,
        now,
      ),
    ],
  );
  const row = await previousTip(env, tipper, input.requestId);
  if (!row) throw new Error("Tip missing after transfer");
  return resultOf(env, row.id, tipper.id, null);
}

function matches(
  row: TipRow,
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

/**
 * One check at Credit 站, at most every 5 s for each tip, whoever asks (the
 * card, “查一下”, the receipt page, the 兜底检查); otherwise what is known.
 * Past 15 minutes unpaid, it is 没付 (a later payment still counts).
 */
export async function checkTip(
  env: ApiBindings,
  row: TipRow,
  options: { force?: boolean } = {},
): Promise<TipRow> {
  if (row.method !== "checkout" || row.status === "done" || !reachesCredit(env))
    return row;
  if (!row.merchant_id || !row.client_id || !row.business_no) return row;
  const now = Date.now();
  const claimed = await env.DB.prepare(
    "UPDATE tips SET check_claimed_at=? WHERE id=? AND (?=1 OR check_claimed_at<=?) RETURNING *",
  )
    .bind(now, row.id, options.force ? 1 : 0, now - TIP_LIMITS.checkEveryMs)
    .first<TipRow>();
  if (!claimed)
    return (
      (await env.DB.prepare("SELECT * FROM tips WHERE id=?")
        .bind(row.id)
        .first<TipRow>()) ?? row
    );
  let result: TopupQueryResult;
  try {
    const secret = await loadMerchantSecret(
      env,
      claimed.merchant_id ?? "",
      claimed.credential_version ?? 0,
      claimed.client_id ?? "",
    );
    result = await queryTopupOrder(
      {
        clientId: claimed.client_id ?? "",
        clientSecret: secret,
        businessNo: claimed.business_no ?? "",
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
      "UPDATE tips SET last_checked_at=?,last_check_result=?,updated_at=? WHERE id=?",
    ).bind(now, kind, now, claimed.id),
  ];
  if (kind === "paid" && result.kind === "paid")
    statements.push(
      env.DB.prepare(
        `UPDATE tips SET status='done',done_at=?,external_order_id=COALESCE(external_order_id,?)
        WHERE id=? AND status IN ('pending','unpaid')`,
      ).bind(now, result.evidence.externalOrderId, claimed.id),
    );
  else if (kind === "mismatch")
    statements.push(
      env.DB.prepare("UPDATE tips SET flag='mismatch' WHERE id=?").bind(
        claimed.id,
      ),
    );
  else if (
    (kind === "unpaid" || kind === "not_found") &&
    claimed.status === "pending" &&
    now - claimed.created_at >= TIP_LIMITS.sweepAfterMs
  )
    statements.push(
      env.DB.prepare(
        "UPDATE tips SET status='unpaid' WHERE id=? AND status='pending'",
      ).bind(claimed.id),
    );
  await env.DB.batch(statements);
  const after =
    (await env.DB.prepare("SELECT * FROM tips WHERE id=?")
      .bind(claimed.id)
      .first<TipRow>()) ?? claimed;
  if (after.status === "done" && claimed.status !== "done")
    console.info(JSON.stringify({ event: "tip_paid", tipId: claimed.id }));
  else if (kind !== "paid" && kind !== "unpaid" && kind !== "not_found")
    console.warn(
      JSON.stringify({
        event: "tip_check_failed",
        tipId: claimed.id,
        result: kind,
      }),
    );
  return after;
}

/** A tip on this card, checked if it still waits; what anyone with its id sees. */
export async function checkTipOnCard(
  env: ApiBindings,
  cardId: string,
  tipId: string,
  viewerId: string | null,
): Promise<TipResult> {
  const row = await env.DB.prepare(
    "SELECT * FROM tips WHERE id=? AND card_id=?",
  )
    .bind(tipId, cardId)
    .first<TipRow>();
  if (!row) tipError(404, "TIP_NOT_FOUND", "没有找到这笔打赏");
  await checkTip(env, row);
  return resultOf(env, row.id, viewerId, null);
}

/**
 * 兜底检查 (§5), with the 5-minute cron: links still waiting after 15
 * minutes are asked about once more, oldest first, 50 a round.
 */
export async function sweepTips(env: ApiBindings) {
  if (!reachesCredit(env)) return { checked: 0 };
  const { results } = await env.DB.prepare(
    `SELECT * FROM tips WHERE status='pending' AND method='checkout' AND created_at<=?
    ORDER BY created_at LIMIT ?`,
  )
    .bind(Date.now() - TIP_LIMITS.sweepAfterMs, TIP_LIMITS.sweepBatch)
    .all<TipRow>();
  for (const row of results) await checkTip(env, row, { force: true });
  return { checked: results.length };
}

export async function receiptOf(
  env: ApiBindings,
  code: string,
  tipId: string,
): Promise<TipReceipt> {
  const row = await readTip(env, tipId);
  if (!row || row.card_code !== code)
    tipError(404, "TIP_NOT_FOUND", "没有找到这笔打赏");
  return {
    id: row.id,
    card: {
      code: row.card_code,
      owner: {
        username: row.owner_username,
        displayName: row.owner_display_name,
        avatarUrl: row.owner_avatar_url,
      },
      palette: row.card_palette,
    },
    amountMinor: row.amount_minor,
    method: row.method,
    status: row.status,
    createdAt: row.created_at,
    doneAt: row.done_at,
  };
}

const DAY_MS = 86_400_000;

function sinceOf(range: TipRange) {
  if (range === "all") return 0;
  if (range === "week") return Date.now() - 7 * DAY_MS;
  // Today in Beijing time.
  const offset = 8 * 3_600_000;
  return Math.floor((Date.now() + offset) / DAY_MS) * DAY_MS - offset;
}

export function encodeTipCursor(row: { created_at: number; id: string }) {
  return btoa(JSON.stringify([row.created_at, row.id]));
}

function decodeTipCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const [at, id] = JSON.parse(atob(value)) as [unknown, unknown];
    return typeof at === "number" && typeof id === "string" ? { at, id } : null;
  } catch {
    return null;
  }
}

const PAGE = 20;

/**
 * 我的打赏's table. 收到的: tips that went through, and signed-in tippers'
 * links still waiting (a guest's unpaid ones never show); 我打赏的: all
 * of one's own.
 */
export async function listTips(
  env: ApiBindings,
  userId: string,
  side: "in" | "out",
  filter: { card?: string; method?: TipMethod; range: TipRange },
  cursorText: string | undefined,
): Promise<TipList> {
  const cursor = decodeTipCursor(cursorText);
  const since = sinceOf(filter.range);
  const where =
    side === "in"
      ? `t.owner_id=?1 AND (t.status='done' OR (t.tipper_id IS NOT NULL AND t.status IN ('pending','sending')))`
      : "t.tipper_id=?1";
  const filters = `AND (?2 IS NULL OR c.code=?2) AND (?3 IS NULL OR t.method=?3) AND t.created_at>=?4`;
  const { results } = await env.DB.prepare(
    `${WITH_PEOPLE} WHERE ${where} ${filters}
      AND (?5 IS NULL OR t.created_at<?5 OR (t.created_at=?5 AND t.id<?6))
    ORDER BY t.created_at DESC,t.id DESC LIMIT ?7`,
  )
    .bind(
      userId,
      filter.card ?? null,
      filter.method ?? null,
      since,
      cursor?.at ?? null,
      cursor?.id ?? null,
      PAGE + 1,
    )
    .all<TipWithPeople>();
  const page = results.slice(0, PAGE);
  const last = page.at(-1);
  let stats: TipList["stats"] = null;
  if (side === "in" && !cursor) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count,COUNT(DISTINCT t.tipper_id) AS people,COALESCE(SUM(t.amount_minor),0) AS amount
      FROM tips t JOIN tip_cards c ON c.id=t.card_id
      WHERE t.owner_id=?1 AND t.status='done' AND t.flag IS NULL ${filters}`,
    )
      .bind(userId, filter.card ?? null, filter.method ?? null, since)
      .first<{ count: number; people: number; amount: number }>();
    stats = {
      count: row?.count ?? 0,
      people: row?.people ?? 0,
      amountMinor: row?.amount ?? 0,
    };
  }
  return {
    tips: page.map((row) => tipView(row, userId)),
    stats,
    cursor: results.length > PAGE && last ? encodeTipCursor(last) : null,
  };
}

/**
 * Whether a card's owner can take tips at Credit 站 (their own LDC 商户,
 * its key checked), and why not: what the card shows tippers, and what
 * 我的打赏 and the card form warn its owner of.
 */
export async function receivingOf(
  env: ApiBindings,
  ownerId: string,
): Promise<TipViewer["methods"]["checkout"]> {
  if (!reachesCredit(env)) return { available: false, reason: "offline" };
  const { block } = await checkoutMerchant(env, ownerId);
  return block === null
    ? { available: true, reason: null }
    : { available: false, reason: block };
}

/** How many of a card's last tips the mini app's card page shows. */
export const CARD_RECENT_TIPS = 5;

/**
 * The mini app's home (docs/tip-design.md §7): each of one's cards with its
 * last tips (done), by its own index, all in one round trip.
 */
export async function recentTipsByCard(
  env: ApiBindings,
  ownerId: string,
  codes: string[],
): Promise<Record<string, Tip[]>> {
  if (!codes.length) return {};
  const results = await env.DB.batch(
    codes.map((code) =>
      env.DB.prepare(
        `${WITH_PEOPLE} WHERE c.code=?1 AND t.owner_id=?2 AND t.status='done'
        ORDER BY t.done_at DESC,t.id DESC LIMIT ?3`,
      ).bind(code, ownerId, CARD_RECENT_TIPS),
    ),
  );
  return Object.fromEntries(
    codes.map((code, index) => [
      code,
      ((results[index]?.results ?? []) as TipWithPeople[]).map((row) =>
        tipView(row, ownerId),
      ),
    ]),
  );
}

/** The owner hides a 留言 on their card (the amount still counts), or shows it again. */
export async function setMessageHidden(
  env: ApiBindings,
  ownerId: string,
  tipId: string,
  hidden: boolean,
) {
  const updated = await env.DB.prepare(
    "UPDATE tips SET message_hidden=?,updated_at=? WHERE id=? AND owner_id=? AND message IS NOT NULL",
  )
    .bind(hidden ? 1 : 0, Date.now(), tipId, ownerId)
    .run();
  if (updated.meta.changes === 0)
    tipError(404, "TIP_NOT_FOUND", "没有找到这条留言");
  const row = await readTip(env, tipId);
  if (!row) throw new Error("Tip missing");
  return tipView(row, ownerId);
}
