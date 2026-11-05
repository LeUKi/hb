// 打赏卡 (docs/tip-design.md §2): made, changed and stopped by their owner,
// read by anyone through their code (☕ page, mini app, embeds).
import {
  amountToMinor,
  normalizeTopicLink,
  type PublicTipCard,
  TIP_LIMITS,
  type TipAmount,
  type TipCard,
  type TipCardInput,
  type TipLink,
  type TipPerson,
  type TipRecentRow,
  type TipTopRow,
  type UpdateTipCardInput,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import { readBalanceSettings } from "../balance/settings";
import { transferAccess } from "../balance/transfers";
import type { ApiBindings } from "../env";
import { knownPalette, paletteColors } from "./palettes";

export type CardRow = {
  id: string;
  code: string;
  owner_id: string;
  name: string;
  style: "simple" | "standard";
  palette: string;
  prompt: string;
  amounts: string;
  default_index: number;
  allow_other: number;
  goal_minor: number | null;
  goal_since: number | null;
  show_recent: number;
  show_top: number;
  link_kind: "none" | "profile" | "topic";
  link_topic_id: string | null;
  link_title: string | null;
  link_url: string | null;
  version: number;
  stopped_at: number | null;
  stopped_by_admin_id: string | null;
  stop_reason: string | null;
  created_at: number;
  updated_at: number;
};

/** A card with its owner as they are now. */
export type CardWithOwner = CardRow & {
  owner_username: string;
  owner_display_name: string;
  owner_avatar_url: string | null;
  owner_external_id: string;
  owner_active: number;
};

const WITH_OWNER = `SELECT c.*,u.username AS owner_username,u.display_name AS owner_display_name,
    u.avatar_url AS owner_avatar_url,u.external_id AS owner_external_id,u.active AS owner_active
  FROM tip_cards c JOIN users u ON u.id=c.owner_id`;

export function tipError(
  status: 400 | 403 | 404 | 409 | 429 | 503,
  code: string,
  message: string,
): never {
  throw new ActivityError(status, code, message);
}

/** Letters and digits that cannot be mistaken for each other. */
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(
    bytes,
    (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length],
  ).join("");
}

export function amountsOf(row: Pick<CardRow, "amounts">): TipAmount[] {
  return JSON.parse(row.amounts) as TipAmount[];
}

/** How many cards someone may keep switched on: 3, or 30 with 🐟额 PLUS. */
export async function cardLimitFor(env: ApiBindings, userId: string) {
  const { allowed } = await transferAccess(env, userId);
  return {
    plus: allowed,
    limit: allowed ? TIP_LIMITS.cardsMaxPlus : TIP_LIMITS.cardsMax,
  };
}

/** What a card's form says, checked and turned into its columns. */
function columnsOf(input: TipCardInput) {
  if (!knownPalette(input.palette))
    tipError(400, "TIP_PALETTE_INVALID", "没有这个配色，请换一个。");
  const amounts = input.amounts.map((item) => {
    const amountMinor = amountToMinor(item.amount);
    if (
      amountMinor < TIP_LIMITS.amountMinMinor ||
      amountMinor > TIP_LIMITS.amountMaxMinor
    )
      tipError(
        400,
        "TIP_AMOUNT_OUT_OF_RANGE",
        "每个数额要在 1.00 到 2000.00 LDC 之间。",
      );
    return { amountMinor, label: item.label };
  });
  if (new Set(amounts.map((item) => item.amountMinor)).size !== amounts.length)
    tipError(400, "TIP_AMOUNTS_REPEATED", "数额不能重复。");
  if (input.defaultIndex >= amounts.length)
    tipError(400, "TIP_DEFAULT_INVALID", "默认选中的数额不在里面。");
  let goalMinor: number | null = null;
  if (input.goal !== null) {
    if (input.style !== "standard")
      tipError(400, "TIP_GOAL_STANDARD_ONLY", "简洁样式没有目标。");
    goalMinor = amountToMinor(input.goal);
    if (
      goalMinor < TIP_LIMITS.amountMinMinor ||
      goalMinor > TIP_LIMITS.goalMaxMinor
    )
      tipError(
        400,
        "TIP_GOAL_OUT_OF_RANGE",
        "目标要在 1.00 到 100000.00 LDC 之间。",
      );
  }
  let link: {
    kind: TipLink["kind"];
    topicId: string | null;
    url: string | null;
  } = {
    kind: input.link.kind,
    topicId: null,
    url: null,
  };
  if (input.link.kind === "topic") {
    const topic = normalizeTopicLink(input.link.topicUrl);
    if (!topic)
      tipError(
        400,
        "TIP_TOPIC_INVALID",
        "请贴社区帖子的链接，比如 https://linux.do/t/123456。",
      );
    link = {
      kind: "topic",
      topicId: topic.topicId,
      url: `https://linux.do/t/${topic.topicId}`,
    };
  }
  const standard = input.style === "standard";
  return {
    name: input.name,
    style: input.style,
    palette: input.palette,
    prompt: input.prompt,
    amounts: JSON.stringify(amounts),
    defaultIndex: input.defaultIndex,
    allowOther: input.allowOther ? 1 : 0,
    goalMinor,
    // 最近 and 总榜 show on 标准 only.
    showRecent: standard && input.showRecent ? 1 : 0,
    showTop: standard && input.showTop ? 1 : 0,
    link,
  };
}

function requireTipsOn(enabled: boolean) {
  if (!enabled) tipError(403, "TIP_DISABLED", "打赏暂时关闭");
}

export async function readCard(env: ApiBindings, code: string) {
  return env.DB.prepare(`${WITH_OWNER} WHERE c.code=?`)
    .bind(code)
    .first<CardWithOwner>();
}

export async function requireCard(env: ApiBindings, code: string) {
  const card = await readCard(env, code);
  if (card?.owner_active !== 1)
    tipError(404, "TIP_CARD_NOT_FOUND", "没有找到这张打赏卡");
  return card;
}

async function ownedCard(env: ApiBindings, ownerId: string, code: string) {
  const card = await readCard(env, code);
  if (!card || card.owner_id !== ownerId)
    tipError(404, "TIP_CARD_NOT_FOUND", "没有找到这张打赏卡");
  return card;
}

export async function createCard(
  env: ApiBindings,
  ownerId: string,
  input: TipCardInput,
) {
  requireTipsOn((await readBalanceSettings(env)).tipEnabled);
  const columns = columnsOf(input);
  const { limit } = await cardLimitFor(env, ownerId);
  const now = Date.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = crypto.randomUUID();
    const code = newCode();
    try {
      const inserted = await env.DB.prepare(
        `INSERT INTO tip_cards (id,code,owner_id,name,style,palette,prompt,amounts,default_index,allow_other,
          goal_minor,goal_since,show_recent,show_top,link_kind,link_topic_id,link_title,link_url,version,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,1,?,?
        WHERE (SELECT COUNT(*) FROM tip_cards WHERE owner_id=? AND stopped_at IS NULL) < ?`,
      )
        .bind(
          id,
          code,
          ownerId,
          columns.name,
          columns.style,
          columns.palette,
          columns.prompt,
          columns.amounts,
          columns.defaultIndex,
          columns.allowOther,
          columns.goalMinor,
          columns.goalMinor === null ? null : now,
          columns.showRecent,
          columns.showTop,
          columns.link.kind,
          columns.link.topicId,
          columns.link.url,
          now,
          now,
          ownerId,
          limit,
        )
        .run();
      if (inserted.meta.changes === 0)
        tipError(
          409,
          "TIP_CARDS_FULL",
          `最多 ${limit} 张打赏卡，先停用一张再建。`,
        );
      return ownerCardView(env, await ownedCard(env, ownerId, code));
    } catch (error) {
      // The rare clash of two codes: try another.
      if (
        String(error).includes("tip_cards_code_unique") ||
        String(error).includes("UNIQUE constraint failed: tip_cards.code")
      )
        continue;
      throw error;
    }
  }
  throw new Error("No free card code");
}

export async function updateCard(
  env: ApiBindings,
  ownerId: string,
  code: string,
  input: UpdateTipCardInput,
) {
  const card = await ownedCard(env, ownerId, code);
  const columns = columnsOf(input);
  const now = Date.now();
  // A 目标 counts from when it was set: the same one keeps its start.
  const goalSince =
    columns.goalMinor === null
      ? null
      : columns.goalMinor === card.goal_minor
        ? card.goal_since
        : now;
  const updated = await env.DB.prepare(
    `UPDATE tip_cards SET name=?,style=?,palette=?,prompt=?,amounts=?,default_index=?,allow_other=?,
      goal_minor=?,goal_since=?,show_recent=?,show_top=?,link_kind=?,link_topic_id=?,link_url=?,
      version=version+1,updated_at=?
    WHERE id=? AND version=?`,
  )
    .bind(
      columns.name,
      columns.style,
      columns.palette,
      columns.prompt,
      columns.amounts,
      columns.defaultIndex,
      columns.allowOther,
      columns.goalMinor,
      goalSince,
      columns.showRecent,
      columns.showTop,
      columns.link.kind,
      columns.link.topicId,
      columns.link.url,
      now,
      card.id,
      input.expectedVersion,
    )
    .run();
  if (updated.meta.changes === 0)
    tipError(
      409,
      "TIP_CARD_CONFLICT",
      "这张打赏卡刚被改过，请刷新后再改。你的输入还在。",
    );
  return ownerCardView(env, await ownedCard(env, ownerId, code));
}

export async function stopCard(
  env: ApiBindings,
  ownerId: string,
  code: string,
) {
  const card = await ownedCard(env, ownerId, code);
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE tip_cards SET stopped_at=?,version=version+1,updated_at=? WHERE id=? AND stopped_at IS NULL",
  )
    .bind(now, now, card.id)
    .run();
  return ownerCardView(env, await ownedCard(env, ownerId, code));
}

export async function startCard(
  env: ApiBindings,
  ownerId: string,
  code: string,
) {
  const card = await ownedCard(env, ownerId, code);
  if (card.stopped_by_admin_id)
    tipError(
      403,
      "TIP_CARD_STOPPED_BY_ADMIN",
      "这张打赏卡被站长停用了，不能再启用。",
    );
  const { limit } = await cardLimitFor(env, ownerId);
  const now = Date.now();
  const started = await env.DB.prepare(
    `UPDATE tip_cards SET stopped_at=NULL,version=version+1,updated_at=?
    WHERE id=? AND stopped_at IS NOT NULL
      AND (SELECT COUNT(*) FROM tip_cards WHERE owner_id=? AND stopped_at IS NULL) < ?`,
  )
    .bind(now, card.id, ownerId, limit)
    .run();
  if (started.meta.changes === 0 && card.stopped_at !== null)
    tipError(
      409,
      "TIP_CARDS_FULL",
      `最多 ${limit} 张打赏卡，先停用一张再启用。`,
    );
  return ownerCardView(env, await ownedCard(env, ownerId, code));
}

/** The 站长 stops someone's card (abuse); its owner sees why and cannot start it. */
export async function adminStopCard(
  env: ApiBindings,
  adminId: string,
  code: string,
  reason: string,
) {
  const card = await readCard(env, code);
  if (!card) tipError(404, "TIP_CARD_NOT_FOUND", "没有找到这张打赏卡");
  const now = Date.now();
  // Its own time even when its owner had stopped it: the 管理记录 says when.
  await env.DB.prepare(
    `UPDATE tip_cards SET stopped_at=?,stopped_by_admin_id=?,stop_reason=?,
      version=version+1,updated_at=? WHERE id=?`,
  )
    .bind(now, adminId, reason, now, card.id)
    .run();
}

/** 网站管理 · 用户: a person's 打赏卡 and their tips, given and received. */
export async function adminTipsOf(env: ApiBindings, userId: string) {
  const [cards, totals] = await env.DB.batch([
    env.DB.prepare(
      `SELECT code,name,style,stopped_at,stopped_by_admin_id,stop_reason,created_at,
        (SELECT COUNT(*) FROM tips t WHERE t.card_id=c.id AND t.status='done') AS tips
      FROM tip_cards c WHERE owner_id=? ORDER BY created_at,id`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM tips WHERE owner_id=?1 AND status='done') AS received,
        (SELECT COALESCE(SUM(amount_minor),0) FROM tips WHERE owner_id=?1 AND status='done') AS receivedMinor,
        (SELECT COUNT(*) FROM tips WHERE tipper_id=?1 AND status='done') AS given`,
    ).bind(userId),
  ]);
  const total = (totals?.results[0] ?? {}) as {
    received?: number;
    receivedMinor?: number;
    given?: number;
  };
  return {
    cards: (
      (cards?.results ?? []) as {
        code: string;
        name: string;
        style: "simple" | "standard";
        stopped_at: number | null;
        stopped_by_admin_id: string | null;
        stop_reason: string | null;
        created_at: number;
        tips: number;
      }[]
    ).map((row) => ({
      code: row.code,
      name: row.name,
      style: row.style,
      active: row.stopped_at === null,
      stoppedByAdmin: row.stopped_by_admin_id !== null,
      stopReason: row.stop_reason,
      createdAt: row.created_at,
      tips: row.tips,
    })),
    received: {
      count: total.received ?? 0,
      amountMinor: total.receivedMinor ?? 0,
    },
    given: total.given ?? 0,
  };
}

function linkOf(row: CardRow): TipLink {
  if (row.link_kind === "topic" && row.link_topic_id)
    return {
      kind: "topic",
      topicId: row.link_topic_id,
      title: row.link_title,
      url: row.link_url ?? `https://linux.do/t/${row.link_topic_id}`,
    };
  return row.link_kind === "profile" ? { kind: "profile" } : { kind: "none" };
}

function personOf(row: {
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
}): TipPerson | null {
  if (!row.username) return null;
  return {
    username: row.username,
    displayName: row.display_name ?? row.username,
    avatarUrl: row.avatar_url,
  };
}

/** What the card counts, all from its tips that went through (not reversed). */
async function cardNumbers(env: ApiBindings, row: CardRow) {
  return env.DB.prepare(
    `SELECT COUNT(DISTINCT tipper_id) AS tippers,
      COALESCE(SUM(CASE WHEN ?1 IS NOT NULL AND done_at>=?1 THEN amount_minor END),0) AS reached
    FROM tips WHERE card_id=?2 AND status='done' AND flag IS NULL`,
  )
    .bind(row.goal_since, row.id)
    .first<{ tippers: number; reached: number }>();
}

export async function recentOf(
  env: ApiBindings,
  cardId: string,
  limit: number,
  before?: { at: number; id: string },
) {
  const { results } = await env.DB.prepare(
    `SELECT t.id,t.amount_minor,t.method,t.message,t.message_hidden,t.done_at,
      u.username,u.display_name,u.avatar_url
    FROM tips t LEFT JOIN users u ON u.id=t.tipper_id
    WHERE t.card_id=? AND t.status='done' AND t.flag IS NULL
      AND (? IS NULL OR t.done_at<? OR (t.done_at=? AND t.id<?))
    ORDER BY t.done_at DESC,t.id DESC LIMIT ?`,
  )
    .bind(
      cardId,
      before?.at ?? null,
      before?.at ?? null,
      before?.at ?? null,
      before?.id ?? null,
      limit,
    )
    .all<{
      id: string;
      amount_minor: number;
      method: TipRecentRow["method"];
      message: string | null;
      message_hidden: number;
      done_at: number;
      username: string | null;
      display_name: string | null;
      avatar_url: string | null;
    }>();
  return results.map(
    (row): TipRecentRow => ({
      id: row.id,
      person: personOf(row),
      amountMinor: row.amount_minor,
      method: row.method,
      message: row.message_hidden === 1 ? null : row.message,
      messageHidden: row.message_hidden === 1 && row.message !== null,
      at: row.done_at,
    }),
  );
}

async function topOf(env: ApiBindings, cardId: string) {
  const { results } = await env.DB.prepare(
    `SELECT u.username,u.display_name,u.avatar_url,SUM(t.amount_minor) AS total
    FROM tips t JOIN users u ON u.id=t.tipper_id
    WHERE t.card_id=? AND t.status='done' AND t.flag IS NULL AND t.tipper_id IS NOT NULL
    GROUP BY t.tipper_id ORDER BY total DESC,MIN(t.done_at) ASC LIMIT ?`,
  )
    .bind(cardId, TIP_LIMITS.topMax)
    .all<{
      username: string;
      display_name: string;
      avatar_url: string | null;
      total: number;
    }>();
  return results.map(
    (row, index): TipTopRow => ({
      rank: index + 1,
      person: personOf(row) as TipPerson,
      amountMinor: row.total,
    }),
  );
}

/** A card as anyone sees it: its own numbers and the lists it shows. */
export async function publicCard(
  env: ApiBindings,
  row: CardWithOwner,
  rows = TIP_LIMITS.cardListRows,
): Promise<PublicTipCard> {
  const [numbers, recent, top] = await Promise.all([
    cardNumbers(env, row),
    row.show_recent === 1 ? recentOf(env, row.id, rows) : Promise.resolve(null),
    row.show_top === 1 ? topOf(env, row.id) : Promise.resolve(null),
  ]);
  return {
    code: row.code,
    version: row.version,
    active: row.stopped_at === null,
    owner: {
      username: row.owner_username,
      displayName: row.owner_display_name,
      avatarUrl: row.owner_avatar_url,
    },
    style: row.style,
    palette: row.palette,
    colors: paletteColors(row.palette),
    prompt: row.prompt,
    amounts: amountsOf(row),
    defaultIndex: row.default_index,
    allowOther: row.allow_other === 1,
    goal:
      row.goal_minor === null
        ? null
        : { amountMinor: row.goal_minor, reachedMinor: numbers?.reached ?? 0 },
    tipperCount: numbers?.tippers ?? 0,
    recent,
    top: top ? top.slice(0, rows) : null,
  };
}

async function weekOf(env: ApiBindings, cardId: string) {
  return (
    (await env.DB.prepare(
      `SELECT COUNT(*) AS count,COALESCE(SUM(amount_minor),0) AS amount FROM tips
      WHERE card_id=? AND status='done' AND flag IS NULL AND done_at>=?`,
    )
      .bind(cardId, Date.now() - 7 * 86_400_000)
      .first<{ count: number; amount: number }>()) ?? { count: 0, amount: 0 }
  );
}

export async function ownerCardView(
  env: ApiBindings,
  row: CardWithOwner,
): Promise<TipCard> {
  const [card, week] = await Promise.all([
    publicCard(env, row),
    weekOf(env, row.id),
  ]);
  const { owner: _owner, recent: _recent, top: _top, ...rest } = card;
  return {
    ...rest,
    name: row.name,
    showRecent: row.show_recent === 1,
    showTop: row.show_top === 1,
    link: linkOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stoppedAt: row.stopped_at,
    stoppedByAdmin: row.stopped_by_admin_id !== null,
    stopReason: row.stop_reason,
    week: { count: week.count, amountMinor: week.amount },
  };
}

export async function listOwnCards(env: ApiBindings, ownerId: string) {
  const { results } = await env.DB.prepare(
    `${WITH_OWNER} WHERE c.owner_id=? ORDER BY c.stopped_at IS NOT NULL,c.created_at,c.id`,
  )
    .bind(ownerId)
    .all<CardWithOwner>();
  const [cards, limits, settings] = await Promise.all([
    Promise.all(results.map((row) => ownerCardView(env, row))),
    cardLimitFor(env, ownerId),
    readBalanceSettings(env),
  ]);
  return {
    cards,
    used: results.filter((row) => row.stopped_at === null).length,
    limit: limits.limit,
    enabled: settings.tipEnabled,
  };
}
