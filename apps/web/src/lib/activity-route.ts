import { fromForumEmoji } from "@hb/contracts";
import { useMatches } from "@tanstack/react-router";
import { decodeActivityEmoji, encodeActivityEmoji } from "@/lib/ecoji-v2";

// Activities live at /🧧/<emoji code>. The old /activities/<uuid> and /e/<code>
// addresses are retired and fall through to "not found".

export const RED_PACKET = "🧧";

export function activityCode(id: string) {
  return encodeActivityEmoji(id);
}

export function activityPath(id: string) {
  return `/${RED_PACKET}/${encodeActivityEmoji(id)}`;
}

/**
 * The sender's own pages under a 红包, all emoji (03 §7): 📝 编辑,
 * 📊 尝试统计, 🧾 付款. 🖼️ (the forum image) is served by the API.
 */
export const senderPages = {
  edit: { emoji: "📝", title: "编辑红包" },
  stats: { emoji: "📊", title: "尝试统计" },
  payments: { emoji: "🧾", title: "付款记录" },
} as const;

export type SenderPage = keyof typeof senderPages;

/**
 * A sender page's name for this 红包: a 代码判定红包's 尝试统计 is its
 * 判定记录 (docs/judge-records-design.md §2).
 */
export function senderPageTitle(page: SenderPage, code: boolean) {
  return page === "stats" && code ? "判定记录" : senderPages[page].title;
}

export function senderPagePath(id: string, page: SenderPage) {
  return `${activityPath(id)}/${senderPages[page].emoji}`;
}

/** The last codes read: the page's own is read again on every render. */
const decoded = new Map<string, string | null>();

/** Decode a route param (already percent-decoded by the router, usually). */
export function activityIdFromCode(code: string): string | null {
  const known = decoded.get(code);
  if (known !== undefined) return known;
  let id = decodeActivityEmoji(code);
  if (!id)
    try {
      id = decodeActivityEmoji(decodeURIComponent(code));
    } catch {
      id = null;
    }
  if (decoded.size >= 32) decoded.clear();
  decoded.set(code, id ?? null);
  return id ?? null;
}

/**
 * The address as copied from a forum post, each emoji a :name:
 * (fromForumEmoji), put back to its emoji in place: the same page, the
 * address the site gives.
 */
export function restoreForumEmojiAddress() {
  const { pathname, search, hash } = window.location;
  const restored = pathname
    .split("/")
    .map((segment) => {
      let text: string;
      try {
        text = decodeURIComponent(segment);
      } catch {
        return segment;
      }
      const emoji = fromForumEmoji(text);
      return emoji === text ? segment : encodeURIComponent(emoji);
    })
    .join("/");
  if (restored !== pathname)
    window.history.replaceState(
      window.history.state,
      "",
      `${restored}${search}${hash}`,
    );
}

const packetPath = new RegExp(`^/?${RED_PACKET}/?([^/]+)/?$`, "u");

/**
 * Activity addresses typed into the omnibox: `/🧧/<code>`, `🧧/<code>`,
 * `🧧<code>`, or a full link on this origin.
 */
export function parseRedPacketAddress(
  input: string,
  origin: string,
): string | null {
  let value = input.trim();
  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      if (url.origin !== origin || url.username || url.password) return null;
      value = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  const code = packetPath.exec(value)?.[1];
  return code ? activityIdFromCode(code) : null;
}

export function useCurrentActivityId(): string | null {
  return useMatches({
    select: (matches) => {
      const leaf = matches[matches.length - 1];
      if (leaf?.routeId !== "/🧧/$code") return null;
      return activityIdFromCode((leaf.params as { code?: string }).code ?? "");
    },
  });
}
