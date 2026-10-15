import { squirclePath } from "./squircle-path";

// The forum image of a 红包 (内嵌图). It answers three things only: whose 红包
// and what it is called, whether it can still be taken, and — for a signed-in
// viewer who took part — what they got. Everything else is on the page.
// Flat, light and shadow, no 3D; self-contained: system fonts, no scripts,
// no external resources (so no avatars: there are only avatar URLs). No
// brand either: the bottom line is the 红包's own 14-emoji code.

export const IMAGE_WIDTH = 420;
export const IMAGE_HEIGHT = 560;

export type ImageTone = "success" | "warning" | "danger";

export type HongbaoImageInput = {
  sender: string;
  title: string;
  /** The 红包's emoji code (14 emoji), printed on the bottom line. */
  code: string;
  /** Over, or not won: desaturated cover, pewter seal. */
  muted: boolean;
  /**
   * The seal's words: 开 / 报 for a signed-in viewer, 查看 for a guest,
   * 已报名 / 开奖中, 完 / 未中 when muted. Null: the 红包 is opened.
   */
  seal: string | null;
  body:
    | { kind: "line"; text: string }
    | {
        kind: "opened";
        /** 你已领取 / 你中奖了 */
        label: string;
        amount: string;
        status: { text: string; tone: ImageTone };
        /** When the share was taken (a winner's: when the draw ran). */
        at: number;
        /** The seal that pops in the opening animation: 开 or 报. */
        opens: string;
      };
  /** Counts, waiting or a payment on its way: warn once it may be stale. */
  live: boolean;
  renderedAt: number;
  /** Seconds since rendering, to preview the stale notes. */
  age?: number;
};

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

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
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] ?? "";
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

const pad = (value: number) => String(value).padStart(2, "0");

function clock(at: number) {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function dateTime(at: number) {
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock(at)}`;
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

const toneColors: Record<ImageTone, { fill: string; text: string }> = {
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
function describe(input: HongbaoImageInput) {
  const as = `数据截至 ${clock(input.renderedAt)}`;
  if (input.body.kind === "opened")
    return `${input.body.label} ${input.body.amount} LDC，${input.body.status.text}；${as}`;
  return `${input.body.text}；${as}`;
}

/** The 内嵌图 as an SVG document string. */
export function renderHongbaoImage(input: HongbaoImageInput) {
  const opened = input.body.kind === "opened";
  const card = squirclePath(
    CARD.x,
    CARD.y,
    CARD.width,
    CARD.height,
    CARD.radius,
  );
  const edge = opened ? OPENED : SEALED;

  // On the red: the sender, a short gold rule, the title (one or two lines).
  const titleLines = wrap(input.title, 28, 340, 2);
  const lineGap = 38;
  const titleTop = 176 - ((titleLines.length - 1) * lineGap) / 2;
  const title = titleLines
    .map(
      (line, index) =>
        `<text x="210" y="${(titleTop + index * lineGap).toFixed(1)}" class="title">${escapeXml(line)}</text>`,
    )
    .join("");
  const sender = wrap(`${input.sender}的红包`, 15, 300, 1)[0] ?? "";

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
    const { label, amount, status, at } = input.body;
    const tone = toneColors[status.tone];
    const pillWidth = textWidth(status.text, 13) + 24;
    below = `<text x="210" y="318" class="label rise r1 motion">${escapeXml(label)}</text>
  <text x="210" y="380" class="amount rise r2 motion"><tspan>+${escapeXml(amount)}</tspan><tspan class="unit" dx="6">LDC</tspan></text>
  <g class="rise r3 motion">
    <path d="${squirclePath(210 - pillWidth / 2, 400, pillWidth, 26, 9)}" fill="${tone.fill}"/>
    <text x="210" y="417.5" class="pill" fill="${tone.text}">${escapeXml(status.text)}</text>
  </g>
  <text x="210" y="452" class="when rise r4 motion">领取于 ${escapeXml(dateTime(at))}</text>`;
    footY = 474;
  }
  // As production: "可能过期" after 10 s, "已过期" after 30 s (CSS only: an
  // image cannot run scripts). `age` previews the later notes.
  const age = input.age ?? 0;
  const foot = `<text x="210" y="${footY}" class="foot${opened ? " rise r4 motion" : ""}">数据截至 ${clock(input.renderedAt)}</text>${
    input.live
      ? `
  <text x="210" y="${footY + 22}" class="stale soft">数据可能过期，打开红包查看最新</text>
  <text x="210" y="${footY + 22}" class="stale hard">数据已过期，打开红包查看最新</text>`
      : ""
  }`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" viewBox="0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}" role="img" aria-labelledby="hb-title hb-desc">
  <title id="hb-title">${escapeXml(`${input.sender}的红包：${input.title}`)}</title>
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
    .pill { font-size: 13px; font-weight: 500; }
    .when, .foot { font-size: 12px; fill: #9a7f85; }
    .stale { font-size: 12px; opacity: 0; }
    .soft { fill: #9a5b00; animation: show .3s linear ${10 - age}s forwards, hide .3s linear ${30 - age}s forwards; }
    .hard { fill: #b3262c; animation: show .3s linear ${30 - age}s forwards; }
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
