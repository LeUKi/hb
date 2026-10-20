import type { PaymentState, PublicActivity } from ".";
import { encodeActivityEmoji } from "./ecoji-v2";
import { squirclePath } from "./squircle-path";

// The forum image of a 红包 (内嵌图, docs/redesign/05 §6), served at
// /🧧/<code>/🖼️.svg. It answers three things only: whose 红包 and what it is
// called, whether it can still be taken, and — for a signed-in viewer who
// took part — what they got. Everything else is on the page. Flat, light
// and shadow; self-contained: system fonts, no scripts, no external
// resources (so no avatars: there are only avatar URLs). No brand either:
// the bottom line is the 红包's own 14-emoji code.

export const ACTIVITY_IMAGE_WIDTH = 420;
export const ACTIVITY_IMAGE_HEIGHT = 560;
export const DEFAULT_ACTIVITY_IMAGE_TIME_ZONE = "Asia/Shanghai";

export type ActivityImagePaymentStatus = Extract<
  PaymentState,
  "pending" | "sending" | "reconciling" | "waiting" | "confirmed" | "attention"
> | null;

/**
 * Who is looking, by the image cookie. No cookie (or a third-party cookie
 * the browser blocked), and the sender themself, see the public image.
 */
export type ActivityImageViewerState =
  | { kind: "public" }
  | { kind: "eligible"; action: "claim" | "register" }
  | { kind: "registered" }
  | { kind: "drawing" }
  | {
      kind: "claimed";
      amount: string;
      claimedAt: string | Date;
      paymentStatus?: ActivityImagePaymentStatus;
      /** A 🐟额红包's: in the viewer's 🐟额 already, no payment. */
      fish?: true;
    }
  /** A claim whose amount is not settled yet. */
  | { kind: "pending" }
  | { kind: "ended" }
  | { kind: "not_won" };

export type ActivityImagePreferences = {
  timeZone: string;
  recentRequest: null | {
    activityId: string;
    requestedAt: string;
    available: boolean;
  };
};

export type ActivityImageTone = "success" | "warning" | "danger";

/** What the image draws; `activityImageInput` picks it for a viewer. */
export type ActivityImageInput = {
  sender: string;
  title: string;
  /** The 红包's emoji code (14 emoji), printed on the bottom line. */
  code: string;
  /** Over, or not won: desaturated cover, pewter seal. */
  muted: boolean;
  /**
   * The seal's words: 开 / 报 for a signed-in viewer, 查看 for a guest,
   * 已报名 / 开奖中, 完 / 未中 when muted. Null: no seal (opened).
   */
  seal: string | null;
  body:
    | { kind: "line"; text: string }
    | {
        kind: "opened";
        /** 你已领取 / 你中奖了 */
        label: string;
        amount: string;
        /** The small 🐟 after LDC: it is in 🐟额 (balance-design §14). */
        fish?: true;
        status: { text: string; tone: ActivityImageTone };
        /** When the share was taken (a winner's: when the draw ran). */
        at: Date;
        /** The seal that pops in the opening animation: 开 or 报. */
        opens: string;
      };
  /** Counts, waiting or a payment on its way: warn once it may be stale. */
  live: boolean;
  renderedAt: Date;
  /** Times are written in this zone (the viewer's preference, or Beijing). */
  timeZone: string;
};

const VALID_TIME_ZONE_CACHE = new Map<string, boolean>();
const IMAGE_TIME_ZONE_IDENTIFIER_RE =
  /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

export function isImageTimeZone(
  value: string | null | undefined,
): value is string {
  if (!value || value.length > 80) return false;
  if (!IMAGE_TIME_ZONE_IDENTIFIER_RE.test(value)) return false;
  if (value === "Asia/Shanghai" || value === "UTC") return true;
  const cached = VALID_TIME_ZONE_CACHE.get(value);
  if (cached !== undefined) return cached;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    if (VALID_TIME_ZONE_CACHE.size > 128) {
      const oldest = VALID_TIME_ZONE_CACHE.keys().next().value;
      if (oldest !== undefined) VALID_TIME_ZONE_CACHE.delete(oldest);
    }
    VALID_TIME_ZONE_CACHE.set(value, true);
    return true;
  } catch {
    if (VALID_TIME_ZONE_CACHE.size > 128) {
      const oldest = VALID_TIME_ZONE_CACHE.keys().next().value;
      if (oldest !== undefined) VALID_TIME_ZONE_CACHE.delete(oldest);
    }
    VALID_TIME_ZONE_CACHE.set(value, false);
    return false;
  }
}

function siteOrigin(origin: string) {
  const url = new URL(origin);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  )
    throw new TypeError("Invalid site origin");
  return url.origin;
}

/**
 * The image's address to copy: /🧧/<code>/🖼️.svg with the emoji kept
 * visible, like every link the site hands out. `/🧧/<code>/🖼️` works too,
 * with or without U+FE0F (chat apps and forums often drop it).
 */
export function activityImageUrl(
  activityId: string,
  origin: string,
  options: { timeZone?: string } = {},
) {
  const path = `/🧧/${encodeActivityEmoji(activityId)}/🖼️.svg`;
  const zone =
    options.timeZone && isImageTimeZone(options.timeZone)
      ? `?tz=${encodeURIComponent(options.timeZone)}`
      : "";
  return `${siteOrigin(origin)}${path}${zone}`;
}

/**
 * The site's own post on the forum: where what it hands the forum (the
 * 社区链接, the 内嵌代码's image) leads, the same for every 红包 (user's
 * choice).
 */
export const FORUM_POST_URL = "https://linux.do/t/3033290";

/**
 * The 社区链接 (05 §5): the 红包's path as code, which the forum leaves as
 * it is (no emoji pictures, no link preview), linking to the site's post.
 */
export function createActivityForumLink(activityId: string) {
  return `[\`/🧧/${encodeActivityEmoji(activityId)}\`](${FORUM_POST_URL})`;
}

/**
 * The forum code (05 §5), as the user wrote it: the image at its own size,
 * linking to the site's post, named by the 红包's emoji code (not its title).
 */
export function createActivityImageEmbed(input: {
  activityId: string;
  origin: string;
  sender: string;
}) {
  const href = activityImageUrl(input.activityId, input.origin);
  const alt = `${normalizeText(input.sender, "发红包的人")}的红包：${encodeActivityEmoji(input.activityId)}`;
  return [
    `<a href="${FORUM_POST_URL}">`,
    `<picture><source type="image/svg+xml" srcset="${escapeXml(href)} 1x"><img width="${ACTIVITY_IMAGE_WIDTH}" height="${ACTIVITY_IMAGE_HEIGHT}" `,
    `alt="${escapeXml(alt)}"></picture>`,
    "</a>",
  ].join("\n");
}

/** Nothing left to take, by whatever the quantity setting shows. */
function soldOut(activity: PublicActivity) {
  const { quantity } = activity;
  if (quantity.mode === "exact") return quantity.remaining <= 0;
  if (quantity.mode === "fuzzy") return quantity.level === "empty";
  if (quantity.mode === "availability") return !quantity.available;
  return false;
}

const fuzzyWords = { plenty: "充足", limited: "有限", low: "少量" } as const;

/** The one public line: what is left, as the quantity setting allows. */
function remainingLine(activity: PublicActivity) {
  const { draw, quantity } = activity;
  if (draw)
    return typeof draw.registeredCount === "number"
      ? `已报名 ${draw.registeredCount} 人`
      : "限时开奖";
  if (quantity.mode === "exact") return `剩余 ${quantity.remaining} 份`;
  if (quantity.mode === "fuzzy")
    return quantity.level === "empty"
      ? "已领完"
      : `余量${fuzzyWords[quantity.level]}`;
  return soldOut(activity) ? "已领完" : "进行中";
}

/** Why it is over, as under the page's seal. */
function endLine(activity: PublicActivity, now: Date) {
  if (activity.draw)
    return activity.draw.state === "empty" ? "无人报名" : "已开奖";
  if (soldOut(activity)) return "红包已领完";
  if (activity.deadlineAt && Date.parse(activity.deadlineAt) <= now.getTime())
    return "红包已过期";
  return "红包已提前结束";
}

/** Production's four payment words. */
function paymentWords(status: ActivityImagePaymentStatus): {
  text: string;
  tone: ActivityImageTone;
} {
  if (status === "confirmed") return { text: "已发放", tone: "success" };
  if (status === "attention") return { text: "需要关注", tone: "danger" };
  if (status === "reconciling")
    return { text: "正在核对原订单", tone: "warning" };
  return { text: "付款处理中", tone: "warning" };
}

/** What a viewer sees, by the same tiers as the page (05 §6). */
export function activityImageInput(input: {
  activity: PublicActivity;
  viewer: ActivityImageViewerState;
  renderedAt: Date;
  timeZone?: string | null;
}): ActivityImageInput {
  const { activity, viewer, renderedAt } = input;
  const isDraw = Boolean(activity.draw);
  const base = {
    sender:
      activity.author.displayName || activity.author.username || "发红包的人",
    title: activity.title || "红包",
    code: encodeActivityEmoji(activity.id),
    renderedAt,
    timeZone: isImageTimeZone(input.timeZone)
      ? input.timeZone
      : DEFAULT_ACTIVITY_IMAGE_TIME_ZONE,
  };
  const line = (text: string) => ({ kind: "line" as const, text });
  const open = { ...base, muted: false };
  const over = { ...base, muted: true, live: false };
  switch (viewer.kind) {
    case "claimed": {
      const status = viewer.paymentStatus ?? null;
      return {
        ...open,
        seal: null,
        body: {
          kind: "opened",
          label: isDraw ? "你中奖了" : "你已领取",
          amount: viewer.amount,
          ...(viewer.fish ? { fish: true as const } : {}),
          status: viewer.fish
            ? { text: "已存入🐟额", tone: "success" }
            : paymentWords(status),
          at: new Date(viewer.claimedAt),
          opens: isDraw ? "报" : "开",
        },
        // The payment may still move on; once sent (or in 🐟额), nothing
        // will change.
        live: !viewer.fish && status !== "confirmed",
      };
    }
    case "pending":
      return {
        ...open,
        seal: null,
        body: line("你已领取，金额确认中"),
        live: true,
      };
    case "registered":
      return {
        ...open,
        seal: "已报名",
        body: line("已报名，等待开奖"),
        live: true,
      };
    case "drawing":
      return { ...open, seal: "开奖中", body: line("正在开奖"), live: true };
    case "not_won":
      return { ...over, seal: "未中", body: line("本次未中奖") };
    case "ended":
      return { ...over, seal: "完", body: line(endLine(activity, renderedAt)) };
    case "eligible":
      return {
        ...open,
        seal: viewer.action === "register" ? "报" : "开",
        body: line(remainingLine(activity)),
        live: true,
      };
    default:
      if (activity.draw?.state === "settling")
        return { ...open, seal: "开奖中", body: line("正在开奖"), live: true };
      if (activity.status !== "active")
        return {
          ...over,
          seal: "完",
          body: line(endLine(activity, renderedAt)),
        };
      // A guest may have taken part already: the seal only offers a look.
      return {
        ...open,
        seal: "查看",
        body: line(remainingLine(activity)),
        live: true,
      };
  }
}

/** Rough advance widths for the system fonts the viewer will have. */
function textWidth(text: string, size: number) {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x2e80) width += size;
    else if (character === " ") width += size * 0.3;
    else if ("·/:.,".includes(character)) width += size * 0.42;
    else if (/[A-Z0-9]/.test(character)) width += size * 0.62;
    else width += size * 0.54;
  }
  return width;
}

/** Up to `lines` lines within `max` px, the last one cut with "…". */
function wrap(text: string, size: number, max: number, lines: number) {
  const result: string[] = [];
  let line = "";
  const characters = Array.from(text.replace(/\s+/gu, " ").trim());
  for (const character of characters) {
    if (textWidth(line + character, size) <= max) {
      line += character;
      continue;
    }
    if (result.length === lines - 1) {
      while (line && textWidth(`${line}…`, size) > max)
        line = Array.from(line).slice(0, -1).join("");
      result.push(`${line}…`);
      return result;
    }
    result.push(line);
    line = character;
  }
  if (line) result.push(line);
  return result;
}

function timeParts(at: Date, timeZone: string) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map(({ type, value }) => [type, value]),
  ) as Record<string, string>;
}

function clock(at: Date, timeZone: string) {
  const parts = timeParts(at, timeZone);
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function dateTime(at: Date, timeZone: string) {
  const parts = timeParts(at, timeZone);
  return `${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}:${parts.second}`;
}

const SANS =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';
const EMOJI =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';

// Geometry: the card leaves 10px for its shadow. Sealed, the cover's curved
// edge runs from y 318 at the sides to 360 in the middle, where the seal
// sits; opened, the edge has risen to 236–272 and the result takes the
// paper. The sender and title keep their places, so opening only moves the
// edge.
const CARD = { x: 10, y: 10, width: 400, height: 540, radius: 34 };
const SEALED = { side: 318, depth: 42 };
const OPENED = { side: 236, depth: 36 };
const SEAL = { cx: 210, cy: SEALED.side + SEALED.depth, r: 44 };
/** The opened edge over the sealed one, measured from the card's top. */
const RISE =
  (OPENED.side + OPENED.depth - CARD.y) / (SEALED.side + SEALED.depth - CARD.y);

const coverPath = (edge: { side: number; depth: number }) =>
  `M${CARD.x} ${CARD.y}H${CARD.x + CARD.width}V${edge.side}A${CARD.width / 2} ${edge.depth} 0 0 1 ${CARD.x} ${edge.side}Z`;
const rimPath = (edge: { side: number; depth: number }) =>
  `M${CARD.x + CARD.width} ${edge.side}A${CARD.width / 2} ${edge.depth} 0 0 1 ${CARD.x} ${edge.side}`;

const toneColors: Record<ActivityImageTone, { fill: string; text: string }> = {
  success: { fill: "rgb(30 138 87 / .12)", text: "#1e8a57" },
  warning: { fill: "rgb(196 122 18 / .14)", text: "#9a5b00" },
  danger: { fill: "rgb(200 42 48 / .12)", text: "#b3262c" },
};

/** The seal's words get smaller as there are more of them. */
const sealSize = (words: string) =>
  ({ 1: 40, 2: 24 })[Array.from(words).length] ?? 19;

/** The gold (or pewter) coin on the curved edge, with its words. */
function sealMarkup(words: string, muted: boolean, className = "") {
  return `<g class="${className}">
    <g filter="url(#seal-shadow)"><circle cx="${SEAL.cx}" cy="${SEAL.cy}" r="${SEAL.r}" fill="url(#${muted ? "pewter" : "gold"})"/></g>
    <circle cx="${SEAL.cx}" cy="${SEAL.cy}" r="${SEAL.r - 1}" fill="none" stroke="#fff" stroke-opacity=".55"/>
    <circle cx="${SEAL.cx}" cy="${SEAL.cy}" r="${SEAL.r - 7}" fill="none" stroke="${muted ? "#7a6f6c" : "#9b1c23"}" stroke-opacity=".16"/>${
      muted || className
        ? ""
        : `<g clip-path="url(#seal-clip)"><rect class="sheen" x="${SEAL.cx - 22}" y="${SEAL.cy - 60}" width="44" height="120" fill="url(#sheen)" transform="rotate(20 ${SEAL.cx} ${SEAL.cy})"/></g>`
    }
    <text x="${SEAL.cx}" y="${SEAL.cy + 1}" class="glyph${muted ? " muted" : ""}" style="font-size:${sealSize(words)}px">${escapeXml(words)}</text>
  </g>`;
}

/** What a screen reader hears, and what a forum shows if SVG is blocked. */
function describe(input: ActivityImageInput) {
  const as = `数据截至 ${clock(input.renderedAt, input.timeZone)}`;
  if (input.body.kind === "opened")
    return `${input.body.label} ${input.body.amount} LDC${input.body.fish ? "（在🐟额）" : ""}，${input.body.status.text}；${as}`;
  return `${input.body.text}；${as}`;
}

/** The 内嵌图 as an SVG document string. */
export function renderActivityImage(input: ActivityImageInput) {
  const opened = input.body.kind === "opened";
  const card = squirclePath(
    CARD.x,
    CARD.y,
    CARD.width,
    CARD.height,
    CARD.radius,
  );
  const edge = opened ? OPENED : SEALED;
  const senderName = normalizeText(input.sender, "发红包的人");
  const titleText = normalizeText(input.title, "红包");

  // On the red: the sender, a short gold rule, the title (one or two lines).
  const titleLines = wrap(titleText, 28, 340, 2);
  const lineGap = 38;
  const titleTop = 176 - ((titleLines.length - 1) * lineGap) / 2;
  const title = titleLines
    .map(
      (line, index) =>
        `<text x="210" y="${(titleTop + index * lineGap).toFixed(1)}" class="title">${escapeXml(line)}</text>`,
    )
    .join("");
  const sender = wrap(`${senderName}的红包`, 15, 300, 1)[0] ?? "";

  // Opened: the sealed cover lies over the opened one and folds up into it
  // while its seal pops, as on the page; then the result rises in. The
  // resting style is the end state, so reduced motion simply shows it.
  const flap = opened
    ? `<g class="flap motion">
      <path d="${coverPath(SEALED)}" fill="url(#red)"/>
      <path d="${coverPath(SEALED)}" fill="url(#warm)"/>
      <path d="${rimPath(SEALED)}" fill="none" stroke="#e8c079" stroke-width="3"/>
    </g>`
    : "";
  const lightSweep = opened
    ? `<g clip-path="url(#cover-clip)"><rect class="sweep motion" x="-150" y="0" width="150" height="380" fill="url(#sweep)"/></g>`
    : "";
  const seal =
    input.seal !== null
      ? sealMarkup(input.seal, input.muted)
      : input.body.kind === "opened"
        ? `${sealMarkup(input.body.opens, false, "pop motion")}
  <circle class="ring motion" cx="${SEAL.cx}" cy="${SEAL.cy}" r="${SEAL.r}" fill="none" stroke="#e8c079" stroke-width="3"/>`
        : "";

  // Below the edge: one line, or the viewer's own result. Then, always, the
  // time the data is from; under it a warning once it may be stale.
  let below = "";
  let footY = 476;
  if (input.body.kind === "line") {
    below = `<text x="210" y="448" class="line">${escapeXml(input.body.text)}</text>`;
  } else {
    const { label, amount, status, at, fish } = input.body;
    const tone = toneColors[status.tone];
    const pillWidth = textWidth(status.text, 13) + 24;
    below = `<text x="210" y="318" class="label rise r1 motion">${escapeXml(label)}</text>
  <text x="210" y="380" class="amount rise r2 motion"><tspan>+${escapeXml(amount)}</tspan><tspan class="unit" dx="6">LDC</tspan>${fish ? `<tspan class="fish" dx="3">🐟</tspan>` : ""}</text>
  <g class="rise r3 motion">
    <path d="${squirclePath(210 - pillWidth / 2, 400, pillWidth, 26, 9)}" fill="${tone.fill}"/>
    <text x="210" y="417.5" class="pill" fill="${tone.text}">${escapeXml(status.text)}</text>
  </g>
  <text x="210" y="452" class="when rise r4 motion">${label === "你中奖了" ? "开奖于" : "领取于"} ${escapeXml(dateTime(at, input.timeZone))}</text>`;
    footY = 474;
  }
  // "可能过期" after 10 s, "已过期" after 30 s: CSS delays only, as an image
  // cannot run scripts.
  const foot = `<text x="210" y="${footY}" class="foot${opened ? " rise r4 motion" : ""}">数据截至 ${clock(input.renderedAt, input.timeZone)}</text>${
    input.live
      ? `
  <text x="210" y="${footY + 22}" class="stale soft">数据可能过期，打开红包查看最新</text>
  <text x="210" y="${footY + 22}" class="stale hard">数据已过期，打开红包查看最新</text>`
      : ""
  }`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ACTIVITY_IMAGE_WIDTH}" height="${ACTIVITY_IMAGE_HEIGHT}" viewBox="0 0 ${ACTIVITY_IMAGE_WIDTH} ${ACTIVITY_IMAGE_HEIGHT}" role="img" aria-labelledby="hb-title hb-desc">
  <title id="hb-title">${escapeXml(`${senderName}的红包：${titleText}`)}</title>
  <desc id="hb-desc">${escapeXml(describe(input))}</desc>
  <defs>
    <clipPath id="card"><path d="${card}"/></clipPath>
    <clipPath id="cover-clip"><path d="${coverPath(OPENED)}"/></clipPath>
    <clipPath id="seal-clip"><circle cx="${SEAL.cx}" cy="${SEAL.cy}" r="${SEAL.r}"/></clipPath>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fdf6f3"/><stop offset="1" stop-color="#f6e8e4"/>
    </linearGradient>
    <linearGradient id="red" gradientUnits="userSpaceOnUse" x1="0" y1="${CARD.y}" x2="0" y2="${SEAL.cy}">
      <stop offset="0" stop-color="#d93c33"/><stop offset=".62" stop-color="#c82a30"/><stop offset="1" stop-color="#b9212c"/>
    </linearGradient>
    <radialGradient id="warm" gradientUnits="userSpaceOnUse" cx="74" cy="${CARD.y}" r="300">
      <stop offset="0" stop-color="#ffa878" stop-opacity=".26"/><stop offset="1" stop-color="#ffa878" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="gold" cx="35%" cy="30%" r="75%">
      <stop offset="0" stop-color="#fff7df"/><stop offset=".36" stop-color="#f7dc9a"/><stop offset=".7" stop-color="#e7b862"/><stop offset="1" stop-color="#cf9746"/>
    </radialGradient>
    <radialGradient id="pewter" cx="35%" cy="30%" r="75%">
      <stop offset="0" stop-color="#f7f4f2"/><stop offset=".55" stop-color="#ddd6d2"/><stop offset="1" stop-color="#b9b0ab"/>
    </radialGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffecc8" stop-opacity="0"/><stop offset=".5" stop-color="#ffecc8" stop-opacity=".32"/><stop offset="1" stop-color="#ffecc8" stop-opacity="0"/>
    </linearGradient>
    <filter id="lift" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#5a0a14" flood-opacity=".18"/>
    </filter>
    <filter id="seal-shadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#5a0a14" flood-opacity=".32"/>
    </filter>
    <filter id="muted"><feColorMatrix type="saturate" values=".18"/><feComponentTransfer><feFuncR type="linear" slope=".92"/><feFuncG type="linear" slope=".92"/><feFuncB type="linear" slope=".92"/></feComponentTransfer></filter>
  </defs>
  <style>
    text { font-family: ${SANS}; text-anchor: middle; }
    .sender { font-size: 15px; fill: rgb(255 236 214 / .8); }
    .title { font-size: 28px; font-weight: 700; fill: #fff3e2; letter-spacing: .01em; }
    .glyph { font-weight: 700; fill: #9b1c23; dominant-baseline: central; }
    .glyph.muted { fill: #7a6f6c; }
    .line { font-size: 18px; fill: #2a1519; }
    .label { font-size: 15px; fill: #745c61; }
    .amount { font-size: 56px; font-weight: 700; fill: #1e8a57; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
    .unit { font-size: 20px; font-weight: 600; }
    .fish { font-family: ${EMOJI}; font-size: 15px; }
    .pill { font-size: 13px; font-weight: 500; }
    .when, .foot { font-size: 12px; fill: #9a7f85; }
    .stale { font-size: 12px; opacity: 0; }
    .soft { fill: #9a5b00; animation: show .3s linear 10s forwards, hide .3s linear 30s forwards; }
    .hard { fill: #b3262c; animation: show .3s linear 30s forwards; }
    .code { font-family: ${EMOJI}; font-size: 14px; letter-spacing: 1px; }
    .sheen { animation: sheen 6.4s ease-in-out 1.2s infinite; transform: translateX(-130px); }
    /* The opening: resting styles are the end state. */
    .flap { opacity: 0; transform-origin: 210px ${CARD.y}px; transform: scaleY(${RISE.toFixed(4)}); animation: flap .7s cubic-bezier(.6, 0, .2, 1) .42s both; }
    .pop { opacity: 0; transform-origin: ${SEAL.cx}px ${SEAL.cy}px; animation: pop .36s linear .16s both; }
    .ring { opacity: 0; transform-origin: ${SEAL.cx}px ${SEAL.cy}px; animation: ring .46s ease-out .3s both; }
    .sweep { opacity: 0; animation: sweep .6s cubic-bezier(.2, 0, 0, 1) .34s both; }
    .rise { animation: rise .36s cubic-bezier(.2, 0, 0, 1) both; }
    .r1 { animation-delay: .78s; } .r2 { animation-delay: .86s; } .r3 { animation-delay: 1.02s; } .r4 { animation-delay: 1.12s; }
    @keyframes sheen { 0%, 72% { transform: translateX(-130px); } 92%, 100% { transform: translateX(130px); } }
    @keyframes flap { 0% { opacity: 1; transform: scaleY(1); } 88% { opacity: 1; transform: scaleY(${RISE.toFixed(4)}); } 100% { opacity: 0; transform: scaleY(${RISE.toFixed(4)}); } }
    @keyframes pop { 0% { opacity: 1; transform: scale(1); } 40% { opacity: 1; transform: scale(1.12); } 100% { opacity: 0; transform: scale(.5); } }
    @keyframes ring { from { opacity: .8; transform: scale(.9); } to { opacity: 0; transform: scale(2.4); } }
    @keyframes sweep { from { opacity: 1; transform: translateX(0); } to { opacity: 1; transform: translateX(570px); } }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    @keyframes hide { to { opacity: 0; } }
    @keyframes show { to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .sheen, .motion { animation: none; } .sheen { opacity: 0; } }
  </style>
  <g filter="url(#lift)">
    <path d="${card}" fill="url(#paper)"/>
  </g>
  <g clip-path="url(#card)">
    <g${input.muted ? ' filter="url(#muted)"' : ""}>
      <path d="${coverPath(edge)}" fill="url(#red)"/>
      <path d="${coverPath(edge)}" fill="url(#warm)"/>
      <path d="${rimPath(edge)}" fill="none" stroke="#e8c079" stroke-width="3"/>
      ${flap}
      ${lightSweep}
      <text x="210" y="92" class="sender">${escapeXml(sender)}</text>
      <path d="M198 110H222" stroke="#e8c079" stroke-opacity=".7" stroke-width="2" stroke-linecap="round"/>
      ${title}
    </g>
  </g>
  ${seal}
  ${below}
  ${foot}
  <text x="210" y="534" class="code">${escapeXml(input.code)}</text>
</svg>`;
}

/** No such 红包 (or not open yet), or a read that failed. */
export function renderUnavailableActivityImage(kind: "missing" | "error") {
  const card = squirclePath(
    CARD.x,
    CARD.y,
    CARD.width,
    CARD.height,
    CARD.radius,
  );
  const text =
    kind === "missing"
      ? "红包不存在，或链接已经失效"
      : "图片读取失败，请稍后刷新";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ACTIVITY_IMAGE_WIDTH}" height="${ACTIVITY_IMAGE_HEIGHT}" viewBox="0 0 ${ACTIVITY_IMAGE_WIDTH} ${ACTIVITY_IMAGE_HEIGHT}" role="img" aria-label="${text}">
  <style>text { font-family: ${SANS}; text-anchor: middle; font-size: 16px; fill: #745c61; }</style>
  <path d="${card}" fill="#f6e8e4"/>
  <text x="210" y="280">${text}</text>
</svg>`;
}

function normalizeText(value: unknown, fallback: string) {
  const text = stripInvalidXmlChars(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function escapeXml(value: unknown) {
  return stripInvalidXmlChars(String(value))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stripInvalidXmlChars(value: string) {
  let output = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff)
    ) {
      output += char;
    }
  }
  return output;
}
