// What a 红包's 分享 menu hands out (docs/redesign/05-hongbao.md §5), and
// reading it back when someone pastes it whole into the omnibox (02 §6).
// Both live here so they cannot drift apart: every form below is read back
// in test/share-text.test.ts.
import { passwordSchema } from ".";
import { FORUM_POST_URL } from "./activity-image";
import { decodeActivityEmoji, encodeActivityEmoji } from "./ecoji-v2";
import { fromForumEmoji } from "./forum-emoji";

/** What the copy needs to know of a 红包. */
export type ShareActivity = {
  id: string;
  title: string;
  /** 限时开奖: one signs up (报名) rather than takes (领). */
  draw: boolean;
  /** 首页领取 off: the copy says so, and to paste it whole. */
  pageOnly: boolean;
};

const FENCE = "```";

/** A 红包's path as people paste it: /🧧/ and its 14 emoji. */
export function activityPath(activityId: string) {
  return `/🧧/${encodeActivityEmoji(activityId)}`;
}

// The templates' rules (05 §5): the title first (not on the plain link or
// the image); what to copy in a code block; one line on how to use it, the
// same everywhere; a special case adds a line of its own, “本红包…”.

/** The line under a code block: paste it into the site (its forum post). */
function howTo(result: string) {
  return `复制上面这段，粘贴到[红包站](${FORUM_POST_URL})的输入框即可${result}。`;
}

/** 领取 or, for a 限时开奖, 报名. */
const verbOf = (activity: Pick<ShareActivity, "draw">) =>
  activity.draw ? "报名" : "领取";

/**
 * 发到社区 · 链接: the path in a code block, which the forum gives a copy
 * button and leaves as it is (no emoji pictures, no link preview); the site
 * itself is only reached through its forum post.
 */
export function forumShareLink(activity: Pick<ShareActivity, "id" | "title">) {
  return [
    `【${activity.title}】`,
    FENCE,
    activityPath(activity.id),
    FENCE,
    howTo("打开红包"),
  ].join("\n");
}

/** 发到社区 · 链接与口令: the path and the 口令, copied together. */
export function forumShareWithPassword(
  activity: ShareActivity,
  password: string,
) {
  return [
    `【${activity.title}】`,
    FENCE,
    activityPath(activity.id),
    `口令：${password}`,
    FENCE,
    howTo(verbOf(activity)),
    ...(activity.pageOnly
      ? [`本红包已关闭首页领取，只输入口令无法${verbOf(activity)}。`]
      : []),
  ].join("\n");
}

/** 发到别处 · 链接与口令: plain lines, the link itself. */
export function plainShareWithPassword(
  activity: ShareActivity,
  url: string,
  password: string,
) {
  return [
    `【${activity.title}】`,
    url,
    `口令：${password}`,
    ...(activity.pageOnly
      ? ["本红包已关闭首页领取，请先打开上面的链接再输入口令。"]
      : []),
  ].join("\n");
}

/** What a pasted text points at: a 红包, a 口令, or both. */
export type SharedEntry = {
  activityId: string | null;
  password: string | null;
};

// 🧧 then its code, wherever it stands: a path, a link, the 内嵌代码's
// image address. The code ends where emoji do.
const address = /🧧\/?([^\s/`'"<>()[\]，。：:]+)/gu;
// A line of its own, “口令：…” (a title that says 口令 is not one), the
// code-span backticks of older copy dropped.
const passwordLine = /^[ \t]*口令[ \t]*[：:][ \t]*`?([^\s`]+)`?[ \t]*$/gmu;

/**
 * Reads a pasted share text back (any form the menu gives out, also as the
 * forum turns emoji into :name: when copied, or a link percent-encoded):
 * the first 红包 address in it, and its 口令 line. Null when it has
 * neither, so ordinary input stays as it is.
 */
export function readShareText(text: string): SharedEntry | null {
  let plain = fromForumEmoji(text);
  try {
    plain = decodeURIComponent(plain);
  } catch {
    // Not encoded (a lone % in it): read as it is.
  }
  let activityId: string | null = null;
  for (const match of plain.matchAll(address)) {
    activityId = decodeActivityEmoji(match[1] ?? "");
    if (activityId) break;
  }
  let password: string | null = null;
  for (const match of plain.matchAll(passwordLine)) {
    const checked = passwordSchema.safeParse(match[1] ?? "");
    if (checked.success) {
      password = checked.data;
      break;
    }
  }
  return activityId || password ? { activityId, password } : null;
}
