import { brand, documentTitle } from "./brand";

// What a page says of itself to link previews (docs/link-preview-design.md):
// the web Worker writes it into index.html's head for every page, and the
// build writes the site's own. Pure data, read by both.

export type PageMeta = {
  /** og:title: the preview card's bold line. */
  title: string;
  description: string;
  /**
   * The tab's title, as the page itself sets it (documentTitle), so it does
   * not change once the page runs. null: the site's.
   */
  tab: string | null;
  /** Someone's own page: kept out of search engines. */
  private?: boolean;
};

/** What a preview looks up (GET /api/site/preview/<kind>/<key>). */
export type PreviewKind = "activity" | "draw" | "tip" | "judge" | "points";

/** The one picture, the site's mark (public/og.png, §3). */
export const previewImage = {
  path: "/og.png",
  width: 512,
  height: 512,
  alt: "红色方块中间一个金点：红包站的图标",
} as const;

export const siteMeta: PageMeta = {
  title: brand.name || brand.description,
  description:
    "用 LINUX DO 账号登录，输入口令或打开红包链接领红包，也可以自己发红包。",
  tab: null,
};

const help = (title: string, description: string): PageMeta => ({
  title: `${title} · 帮助中心`,
  description,
  tab: title,
});

/** Pages with words of their own, as their headers say them. */
const pages: Record<string, PageMeta> = {
  "/": siteMeta,
  "/help": {
    title: "帮助中心",
    description:
      "领红包、发红包、收打赏、🐟额，还有做玩法和发行三方积分：按要做的事找答案。",
    tab: "帮助",
  },
  "/help/claim": help("领红包", "口令、领不到、什么时候到账。"),
  "/help/send": help("发红包", "商户、玩法、设置、发放暂停。"),
  "/help/tips": help("收打赏", "打赏卡、嵌进帖子、到账。"),
  "/help/fish": help("🐟额和 PLUS", "转出、受邀开通。"),
  "/help/start": help(
    "做一个玩法",
    "红包的玩法可以写成判定器，可以配一个网页，也可以接自己的服务。先按需求选一种做法，再看对应的说明。",
  ),
  "/help/code": {
    title: "代码判定红包 · 开发文档",
    description:
      "写一段代码，决定谁领多少。登录就能发；代码在本站的沙箱里跑，开放时公布指纹，结束后公开代码。",
    tab: "代码判定红包",
  },
  "/help/page": {
    title: "附带网页 · 接入说明",
    description:
      "发红包时可以附带一个自己的网页，显示在红包页旁边（手机上在底部抽屉里）。",
    tab: "附带网页",
  },
  "/help/points": {
    title: "三方积分 · 接入说明",
    description:
      "让大家用你网站的积分发红包：做好三个接口，通过接口测试，站长审核通过后，大家发红包时就能选它。",
    tab: "三方积分",
  },
  "/help/api": help("🐟额开放接口", "开放接口的认证、请求和返回。"),
  "/help/token": help(
    "个人令牌",
    "给你自己的脚本或客户端用的令牌：能做什么、怎么认证。",
  ),
  "/rank": {
    title: "排行榜",
    description:
      "发红包和领红包的排行：按金额和人数一起算，分数 = √(金额 × 人数)。",
    tab: "排行榜",
  },
  "/square": {
    title: "红包广场",
    description:
      "发红包时选了“加入红包广场”的红包，按开放时间排列；结束 72 小时后不再列出。",
    tab: "红包广场",
  },
  "/judges": {
    title: "判定器广场",
    description: "挑一个判定器，填几项参数就能发红包。",
    tab: "判定器广场",
  },
  "/roadmap": {
    title: "施工中",
    description:
      "站长正在做的、做完了的，还有大家想要的。想要哪个，就给它点个赞。",
    tab: "施工中",
  },
};

/** Anyone's page, with nothing to say of its own: the site's words. */
const publicPage = { ...siteMeta };
/** Someone's own page, or one that is no use to a stranger. */
const privatePage: PageMeta = { ...siteMeta, private: true };

export type PageLookup = {
  kind: PreviewKind;
  key: string;
  /** Said when the lookup finds nothing, or does not answer in time. */
  fallback: PageMeta;
};

/**
 * What a path says: its words, or what to look up for them. The path is as
 * a request carries it (percent-encoded).
 */
export function pageOf(pathname: string): PageMeta | PageLookup {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return privatePage;
  }
  if (path.length > 1) path = path.replace(/\/+$/, "");
  const known = pages[path];
  if (known) return known;
  const parts = path.split("/").slice(1);
  const [first, key, rest, ...more] = parts;
  if (!key || more.length > 0) return privatePage;
  // A 红包 and its 🎲; its sender's 📝📊🧾 are theirs.
  if (first === "🧧")
    return rest === undefined
      ? { kind: "activity", key, fallback: publicPage }
      : rest === "🎲"
        ? { kind: "draw", key, fallback: publicPage }
        : privatePage;
  if (rest !== undefined) return privatePage;
  if (first === "☕") return { kind: "tip", key, fallback: publicPage };
  if (first === "judges" && key !== "new")
    return { kind: "judge", key, fallback: publicPage };
  if (first === "points" && key !== "new")
    return { kind: "points", key, fallback: publicPage };
  // A 🐟额 PLUS invitation, without whose.
  if (first === "invite")
    return {
      title: "🐟额 PLUS 邀请",
      description: "有人邀请你开通🐟额 PLUS，打开链接登录后接受。",
      tab: "邀请",
      private: true,
    };
  return privatePage;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The head's lines for a page. Without `at` (the build, which knows no
 * host), no address or picture: the Worker writes every page's anyway.
 */
export function pageMetaHtml(
  meta: PageMeta,
  at?: { origin: string; pathname: string },
) {
  const tag = (attribute: "name" | "property", key: string, value: string) =>
    `<meta ${attribute}="${key}" content="${escapeHtml(value)}" />`;
  return [
    `<title>${escapeHtml(documentTitle(meta.tab))}</title>`,
    tag("name", "description", meta.description),
    tag("property", "og:type", "website"),
    tag("property", "og:site_name", siteMeta.title),
    tag("property", "og:locale", "zh_CN"),
    tag("property", "og:title", meta.title),
    tag("property", "og:description", meta.description),
    ...(at
      ? [
          tag("property", "og:url", `${at.origin}${at.pathname}`),
          tag("property", "og:image", `${at.origin}${previewImage.path}`),
          tag("property", "og:image:width", String(previewImage.width)),
          tag("property", "og:image:height", String(previewImage.height)),
          tag("property", "og:image:alt", previewImage.alt),
        ]
      : []),
    tag("name", "twitter:card", "summary"),
    ...(meta.private ? [tag("name", "robots", "noindex")] : []),
  ].join("\n    ");
}

const START = "<!--page-meta-->";
const END = "<!--/page-meta-->";

/** index.html's placeholder, filled: kept between its marks for the Worker. */
export function pageMetaBlock(lines: string) {
  return `${START}\n    ${lines}\n    ${END}`;
}

/** index.html with this page's lines in place of the site's. */
export function withPageMeta(html: string, lines: string) {
  const start = html.indexOf(START);
  const end = html.indexOf(END, start);
  if (start < 0 || end < 0) return html;
  return `${html.slice(0, start)}${pageMetaBlock(lines)}${html.slice(end + END.length)}`;
}
