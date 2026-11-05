// 打赏 (docs/tip-design.md): a 打赏卡 that others tip its owner through, in
// the 社区 (mini app), on its ☕ page, or embedded outside the 社区. Amounts
// are whole cents (minor units), as in balance.ts.
import { z } from "zod";
import { moneySchema } from "./payments";

export const TIP_LIMITS = {
  /** Cards one may keep switched on: everyone's, and 🐟额 PLUS's (§2). */
  cardsMax: 3,
  cardsMaxPlus: 30,
  nameMax: 20,
  promptMax: 30,
  /** A card's amounts and the 说明 on each. */
  amountsMax: 4,
  labelMax: 4,
  /** One tip, and each of a card's amounts: 1.00–2000.00 LDC. */
  amountMinMinor: 100,
  amountMaxMinor: 200_000,
  /** A 目标: up to 100,000 LDC. */
  goalMaxMinor: 10_000_000,
  messageMax: 50,
  /** Payment links a signed-in person may make in an hour (§7). */
  linksPerHour: 90,
  /** One tip is asked about at Credit 站 at most this often (§5). */
  checkEveryMs: 5_000,
  /** The card asks by itself every 10 s, for at most 15 minutes. */
  pollEveryMs: 10_000,
  pollForMs: 15 * 60_000,
  /** 兜底检查: a link still waiting this long is asked about once more. */
  sweepAfterMs: 15 * 60_000,
  sweepBatch: 50,
  /** 最近 shows this many at a time; 总榜 the first 50. */
  recentPage: 20,
  topMax: 50,
  /** A card's own rows on the card itself. */
  cardListRows: 4,
} as const;

/** 简洁 (one row) and 标准 (amounts laid out, with switches). */
export const tipStyleSchema = z.enum(["simple", "standard"]);
export type TipStyle = z.infer<typeof tipStyleSchema>;

/**
 * A palette's id, kept on a card. 红包站 holds the palettes and serves each
 * card's colours with it (docs/tip-design.md §12), so a new one needs no
 * new web or mini app build; it checks the id against them.
 */
export const tipPaletteSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,23}$/, "配色不对");
export type TipPalette = z.infer<typeof tipPaletteSchema>;

/**
 * One mode's colours, each #rrggbb: the card's tint (its soft fills, lines
 * and bars come from it), its words in colour, and its buttons, whose words
 * are white. Never 红包's red and gold.
 */
export type TipColors = { accent: string; ink: string; button: string };
export type TipPaletteColors = { light: TipColors; dark: TipColors };
/** A palette to choose, as the card form lists them. */
export type TipPaletteOption = {
  id: TipPalette;
  name: string;
  colors: TipPaletteColors;
};

/** Credit 站 (the owner's 商户), 我的商户 (the tipper's), 🐟额. */
export const tipMethodSchema = z.enum(["checkout", "merchant", "balance"]);
export type TipMethod = z.infer<typeof tipMethodSchema>;

const characters = (value: string) => Array.from(value).length;
const noControls = (value: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refused on purpose.
  !/[\u0000-\u001f\u007f]/.test(value);

const shortText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .refine((value) => characters(value) <= max, `${what}最多 ${max} 个字`)
    .refine(noControls, `${what}不能有换行或控制字符`);

/** Where a card is used, only for its owner to see where tips come from. */
export const tipLinkSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("profile") }),
  z.strictObject({ kind: z.literal("topic"), topicUrl: z.string().trim() }),
]);
export type TipLinkInput = z.infer<typeof tipLinkSchema>;

export const tipCardInputSchema = z.strictObject({
  name: shortText(TIP_LIMITS.nameMax, "名称").refine(
    (value) => value.length > 0,
    "起个名称，只有你看得到",
  ),
  style: tipStyleSchema,
  palette: tipPaletteSchema,
  /** Empty: the card reads “打赏 <昵称>”. */
  prompt: shortText(TIP_LIMITS.promptMax, "一句话"),
  amounts: z
    .array(
      z.strictObject({
        amount: moneySchema,
        label: shortText(TIP_LIMITS.labelMax, "说明"),
      }),
    )
    .min(1, "至少要有一个数额")
    .max(TIP_LIMITS.amountsMax, `最多 ${TIP_LIMITS.amountsMax} 个数额`),
  defaultIndex: z
    .number()
    .int()
    .min(0)
    .max(TIP_LIMITS.amountsMax - 1),
  allowOther: z.boolean(),
  /** 标准 only; null is off. */
  goal: moneySchema.nullable(),
  showRecent: z.boolean(),
  showTop: z.boolean(),
  link: tipLinkSchema,
});
export type TipCardInput = z.infer<typeof tipCardInputSchema>;

export const updateTipCardSchema = tipCardInputSchema.extend({
  expectedVersion: z.number().int().positive(),
});
export type UpdateTipCardInput = z.infer<typeof updateTipCardSchema>;

/** A tip's 留言: everyone sees it when the card shows 最近, else its owner. */
export const tipMessageSchema = shortText(TIP_LIMITS.messageMax, "留言")
  .transform((value) => (value === "" ? undefined : value))
  .optional();

export const createTipSchema = z.strictObject({
  /** Made by the page, one per tip: a repeat gives back the same tip. */
  requestId: z.uuid(),
  /** The card as the tipper saw it: changed since, and the tip is refused. */
  cardVersion: z.number().int().positive(),
  amount: moneySchema,
  method: tipMethodSchema,
  message: tipMessageSchema,
  /** A guest's Cap token, scoped to this card (§7). */
  capToken: z.string().min(1).max(512).optional(),
});
export type CreateTipInput = z.infer<typeof createTipSchema>;

export type TipAmount = { amountMinor: number; label: string };

export type TipLink =
  | { kind: "none" }
  | { kind: "profile" }
  | { kind: "topic"; topicId: string; title: string | null; url: string };

/** Someone on a card's lists, or a tip's other side. */
export type TipPerson = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

/** One row of 最近: a guest (paid from outside) has no person. */
export type TipRecentRow = {
  id: string;
  person: TipPerson | null;
  amountMinor: number;
  /** In 🐟 when paid from 🐟额. */
  method: TipMethod;
  /** Hidden by the owner: null, and hidden says so. */
  message: string | null;
  messageHidden: boolean;
  at: number;
};

export type TipTopRow = {
  rank: number;
  person: TipPerson;
  amountMinor: number;
};

/** What a viewer may pay with on this card, read with it. */
export type TipMethods = {
  /** The owner's 商户: usable, or why not (offline: this site cannot pay here). */
  checkout: {
    available: boolean;
    reason: "no_merchant" | "unverified" | "offline" | null;
  };
  /** The viewer's own 商户: null when they have none (not shown). */
  merchant: { name: string } | null;
  /** The viewer's 🐟额: null unless 🐟额 PLUS and some available. */
  balance: { availableMinor: number } | null;
};

/** A card as anyone sees it (its ☕ page, the mini app, an embed). */
export type PublicTipCard = {
  code: string;
  version: number;
  active: boolean;
  owner: TipPerson;
  style: TipStyle;
  palette: TipPalette;
  /** Its palette's colours (the default's, should it be gone). */
  colors: TipPaletteColors;
  prompt: string;
  amounts: TipAmount[];
  defaultIndex: number;
  allowOther: boolean;
  goal: { amountMinor: number; reachedMinor: number } | null;
  /** People who tipped on this card (guests not counted). */
  tipperCount: number;
  /** This card's lists, when it shows them. */
  recent: TipRecentRow[] | null;
  top: TipTopRow[] | null;
};

/** The viewer: signed in or a guest, and whether it is their own card. */
export type TipViewer = {
  signedIn: boolean;
  own: boolean;
  methods: TipMethods;
  /** Password-free tips are off site-wide (the 站长's switch). */
  passwordFree: boolean;
  /** 打赏 is off site-wide: the card says so and takes nothing. */
  paused: boolean;
  /** A guest's Cap challenge for this card (null when signed in or no Cap). */
  capEndpoint: string | null;
};

export type TipCardView = { card: PublicTipCard; viewer: TipViewer };

/** A card in 我的打赏, as its owner sees it. */
export type TipCard = Omit<PublicTipCard, "owner" | "recent" | "top"> & {
  name: string;
  /** 标准's lists, switched on or not. */
  showRecent: boolean;
  showTop: boolean;
  link: TipLink;
  createdAt: number;
  updatedAt: number;
  stoppedAt: number | null;
  /** Stopped by the 站长, who said why; its owner cannot start it again. */
  stoppedByAdmin: boolean;
  stopReason: string | null;
  /** Tips on it in the last 7 days: how many and how much. */
  week: { count: number; amountMinor: number };
};

/**
 * 等付款 / 已打赏 / 没付 (Credit 站), 发放中 / 已打赏 / 没发出 (我的商户),
 * 已打赏 (🐟额).
 */
export type TipStatus = "pending" | "done" | "unpaid" | "sending" | "not_sent";

/** One tip, as its tipper or its card's owner sees it. */
export type Tip = {
  id: string;
  card: { code: string; name: string | null };
  direction: "in" | "out";
  /** The other side; null for a guest. */
  counterpart: TipPerson | null;
  amountMinor: number;
  method: TipMethod;
  message: string | null;
  messageHidden: boolean;
  status: TipStatus;
  /** 没发出: why (Credit 站's refusal, in its words). */
  notSentReason: string | null;
  via: "web" | "mini" | "embed";
  createdAt: number;
  doneAt: number | null;
};

/** After a tip is made or checked: Credit 站's cashier while it waits. */
export type TipResult = { tip: Tip; payUrl: string | null };

/** A tip's own page (/☕/<code>/🧾/<id>), where Credit 站 sends its payer back. */
export type TipReceipt = {
  id: string;
  card: { code: string; owner: TipPerson; palette: TipPalette };
  amountMinor: number;
  method: TipMethod;
  status: TipStatus;
  createdAt: number;
  doneAt: number | null;
};

/** 我的打赏's table: one page, and the numbers for the filter. */
export type TipList = {
  tips: Tip[];
  stats: { count: number; people: number; amountMinor: number } | null;
  cursor: string | null;
};

export const tipRangeSchema = z.enum(["today", "week", "all"]);
export type TipRange = z.infer<typeof tipRangeSchema>;

/** The 社区's own bar above a mini app embedded in a post: 69px (2026-11-05). */
export const FORUM_EMBED_BAR = 69;
/**
 * The least the 社区 makes a mini app's frame, however short its page: it
 * sets max(240, min(1600, height)) (seen in its code, 2026-11-05).
 */
export const FORUM_FRAME_MIN = 240;
