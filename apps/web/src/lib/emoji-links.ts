/// <reference types="vite/client" />
import {
  decodeActivityEmoji,
  encodeActivityEmoji,
  normalizeActivityUuid,
} from "./ecoji-v2";

export { decodeActivityEmoji, encodeActivityEmoji } from "./ecoji-v2";

function siteOrigin(origin: string): string {
  const url = new URL(origin);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new TypeError("Invalid site origin");
  }
  return url.origin;
}

/** Resolve an encoded pathname, decoding the emoji segment exactly once. */
export function resolveEmojiPath(pathname: string): string | null {
  const match = /^\/e\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeActivityEmoji(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

/** Accept an ID, an emoji code, or a complete activity URL from this origin. */
export function parseActivityLink(
  input: string,
  origin: string,
): string | null {
  const value = input.trim();
  const uuid = normalizeActivityUuid(value);
  if (uuid) return uuid;
  const emojiUuid = decodeActivityEmoji(value);
  if (emojiUuid) return emojiUuid;

  // URL() normalizes backslashes, dot segments, and embedded ASCII line breaks.
  // Match the original pathname so those spellings cannot become accepted links.
  if (
    value.includes("\\") ||
    value.includes("\t") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return null;
  }
  const match = /^https?:\/\/([^/?#]+)(\/[^?#]*)/i.exec(value);
  const authority = match?.[1];
  const pathname = match?.[2];
  if (!authority || !pathname || authority.includes("@")) return null;
  try {
    const url = new URL(value);
    if (url.origin !== siteOrigin(origin) || url.username || url.password) {
      return null;
    }
    const legacy = /^\/activities\/([^/]+)\/?$/.exec(pathname);
    if (legacy?.[1]) return normalizeActivityUuid(legacy[1]);
    return resolveEmojiPath(pathname);
  } catch {
    return null;
  }
}

/** Keep emoji visible in copied links; recovery builds generate legacy links. */
export function activityShareUrl(id: string, origin: string): string {
  const uuid = normalizeActivityUuid(id);
  if (!uuid) throw new TypeError("Invalid activity UUID");
  const base = siteOrigin(origin);
  return import.meta.env.VITE_EMOJI_LINKS_RECOVERY === "1"
    ? `${base}/activities/${uuid}`
    : `${base}/e/${encodeActivityEmoji(uuid)}`;
}
