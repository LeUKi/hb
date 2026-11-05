import type {
  ActivityParticipationResponse,
  PublicActivity,
  PublicRecipientList,
  PublicRegistrationList,
} from "./index";

// 社区小程序 (docs/mini-app-design.md §7): LINUX DO's mini app for a 红包,
// opened from a forum link that names it, to claim it inside the forum.

/** The forum app's id, as its app page gave it (public: it is in its address). */
export const FORUM_MINI_APP_ID = "01a19ba5-b9d2-766f-9fb9-b7eddc10e0c7";
/** The forum, which signs the mini app's requests. */
export const FORUM_ORIGIN = "https://linux.do";
/** The launch parameter that names the 红包. */
export const MINI_APP_HONGBAO_PARAM = "hb";
/** The launch parameter that names a 打赏卡 (docs/tip-design.md §7). */
export const MINI_APP_TIP_PARAM = "tip";

/** What decides how tall a 红包 is in a post. */
export type MiniEmbedShape = {
  participation: "password" | "direct" | "code";
  humanCheck: boolean;
  /** A 领取范围: a first-timer may be asked to sign in on 红包站 first. */
  scoped: boolean;
  title: string;
  beforeInfo: string;
  /** The cover's tags (coverTags), which wrap on a phone. */
  tags: string[];
};

/** Width in em at the cover's type: a wide character 1, a narrow one ½. */
const ems = (text: string) => {
  let width = 0;
  for (const character of text)
    width += (character.codePointAt(0) ?? 0) < 0x2e80 ? 0.5 : 1;
  return width;
};

/**
 * Rows of tags (13px chips, 11px padding each side, 8px apart) across 277px,
 * the cover's room in a 360px phone's post.
 */
function tagRows(tags: string[]) {
  let rows = 1;
  let used = 0;
  for (const tag of tags) {
    const width = ems(tag) * 13 + 22;
    if (used > 0 && used + 8 + width > 277) {
      rows += 1;
      used = width;
    } else used += (used > 0 ? 8 : 0) + width;
  }
  return rows;
}

/**
 * A 红包's height in a post, as its embed code gives it: the 社区's bar and
 * its page at its tallest (at
 * a desktop post's width, where it is tallest), from measured parts (0.1.1,
 * docs/mini-app-design.md §4): the page with no 说明 and a one-line title;
 * the 说明's lines (29 wide characters a line, two and 展开全文 at most); a
 * title of 16 or more wraps; a 口令's field and a wrong 口令's line; the
 * card that sends 代码判定 or a human check to 红包站; the card that asks a
 * first-timer in a 领取范围 to sign in there; on a phone, each further row of
 * tags (there the page is otherwise lower). Never lower than its page once
 * claimed.
 */
export function miniAppEmbedHeight(shape: MiniEmbedShape) {
  const lines = shape.beforeInfo
    .split("\n")
    .filter((line) => line.trim())
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(ems(line) / 29)), 0);
  const elsewhere = shape.participation === "code" || shape.humanCheck;
  const page =
    490 +
    (lines > 2 ? 100 : lines === 2 ? 72 : lines === 1 ? 48 : 0) +
    (ems(shape.title) >= 16 ? 34 : 0) +
    (tagRows(shape.tags) - 1) * 34 +
    (elsewhere
      ? 106
      : shape.participation === "password"
        ? shape.scoped
          ? 116
          : 86
        : shape.scoped
          ? 58
          : 0);
  // Once claimed here: the small cover and 我的结果, a 附言 at its three
  // lines and 展开全文 (616–620, phone or desktop). 代码判定 and a human
  // check are not claimed here.
  const claimed = elsewhere ? 0 : 620;
  // The 社区's bar above, and a little room for what is not measured.
  return Math.ceil((Math.max(page, claimed) + 68 + 12) / 10) * 10;
}

const attribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * 社区小程序嵌入代码: the iframe the 社区 gives its apps to embed in a post
 * (as its own 分享 writes it, embed_mode), on this 红包, so it opens right
 * in the post.
 */
export function forumMiniAppEmbed(
  activityId: string,
  title: string,
  height: number,
) {
  const src = `${FORUM_ORIGIN}/apps/${FORUM_MINI_APP_ID}?embed_mode=true&${MINI_APP_HONGBAO_PARAM}=${encodeURIComponent(activityId)}`;
  return `<iframe src="${src}" title="${attribute(title)}" width="100%" height="${height}" frameborder="0" loading="lazy" referrerpolicy="no-referrer" allow="fullscreen; clipboard-write" allowfullscreen style="display:block;width:100%;border:0;"></iframe>`;
}

/**
 * A person's picture in what 红包站 answers the mini app: the 社区's own,
 * by their LINUX DO id (the 社区's user id), for the app to ask the 社区
 * for (sdk.user.getById); its frame loads no pictures from elsewhere.
 */
export const FORUM_AVATAR_PREFIX = "forum-user:";
export const forumAvatar = (forumUserId: string) =>
  `${FORUM_AVATAR_PREFIX}${forumUserId}`;
/** The 社区 user id a picture names, or null for any other. */
export function forumUserIdOf(src: string): number | null {
  if (!src.startsWith(FORUM_AVATAR_PREFIX)) return null;
  const id = Number(src.slice(FORUM_AVATAR_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * GET /api/mini/hongbao?id=: the 红包, without what the mini app never
 * shows (its code, its page, its proof), and the viewer's own part.
 */
export type MiniHongbaoResponse = {
  activity: PublicActivity;
  participation: Pick<ActivityParticipationResponse, "claim" | "registration">;
  /**
   * They have an account here (signed in once, or made from the forum by an
   * earlier claim). Without one the first claim makes it.
   */
  known: boolean;
  /** They sent it: their first share is asked about first (自领). */
  author: boolean;
  /**
   * A sandbox build on the production site (its author or the 社区's
   * reviewers checking it): it shows the 红包, nobody can claim.
   */
  lookOnly: boolean;
};

/**
 * GET /api/mini/roster?id=&kind=claims|registrations&cursor=: the 名单 as
 * 红包站 shows everyone, 20 at a time (the sender's own view, with 口令 and
 * payments, stays on 红包站).
 */
export type MiniRosterKind = "claims" | "registrations";
export type MiniRosterPage = PublicRecipientList | PublicRegistrationList;

/**
 * POST /api/mini/claim?id=: a claim, or a timed draw's sign-up. `forumUser`
 * is what the forum told the app (sdk.user.getCurrent()): it names an
 * account made for a first-timer; who they are is the token's id.
 */
export type MiniClaimInput = {
  submissionId: string;
  password?: string;
  forumUser?: { username: string; name: string };
};

/**
 * What a 红包's live channel sends a mini app's socket, each under
 * MINI_LIVE_LIMIT bytes: its public read without the parts that do not
 * move while it runs, its sender and 领取范围 (the app keeps the read's),
 * or `changed` when even that is too long (read it again); how many
 * people watch, and that their own part moved.
 */
export type MiniLiveActivity = Omit<
  PublicActivity,
  | "beforeInfo"
  | "afterEndInfo"
  | "rosterPreview"
  | "judge"
  | "page"
  | "drawProof"
  | "author"
  | "scope"
>;
export type MiniLiveMessage =
  | { type: "activity"; activity: MiniLiveActivity; seq: number }
  | { type: "changed"; seq: number }
  | { type: "viewers"; count: number; seq: number }
  | { type: "mine" };

/** The forum's limit on one WebSocket message. */
export const MINI_LIVE_LIMIT = 4096;
