import { fromForumEmoji } from "@hb/contracts";
import { decodeActivityEmoji, normalizeActivityUuid } from "@/lib/ecoji-v2";
import { parseActivityLink } from "@/lib/emoji-links";
import { classifyHomeEntry } from "@/lib/home-entry";
import { parseRedPacketAddress } from "./activity-route";
import { commandQuery } from "./commands";
import { inspectPassword, type PasswordInspection } from "./password-rules";

/** The "protocol" the omnibox recognises from what was typed. */
export type SchemeKind =
  | "password"
  | "uuid"
  | "emoji"
  | "link"
  | "topic"
  | "command";

export type EntryScheme =
  | { kind: "empty" }
  | ({ kind: "password" } & PasswordInspection)
  | { kind: "uuid" | "emoji" | "link"; activityId: string }
  | { kind: "topic"; topicId: string; postNumber: number; topicUrl: string }
  | { kind: "command"; query: string };

export const schemeLabels: Record<SchemeKind, string> = {
  password: "口令",
  uuid: "红包 ID",
  emoji: "表情码",
  link: "红包链接",
  topic: "帖子",
  command: "命令",
};

/**
 * Order matters: activity addresses beat commands (so "/🧧/…" jumps), then
 * "/" commands, then the production classifier (UUID, emoji code, full links
 * including the retired /e/ and /activities/ formats, topic links), and
 * finally a 口令 — which can never start with "/".
 */
export function detectScheme(raw: string, origin: string): EntryScheme {
  if (raw.length === 0) return { kind: "empty" };
  // Copied from a forum post, a link's emoji are :name: (fromForumEmoji):
  // a 红包 read with its emoji put back.
  const forum = fromForumEmoji(raw);
  if (forum !== raw) {
    const scheme = detectScheme(forum, origin);
    if ("activityId" in scheme) return scheme;
  }
  const packet = parseRedPacketAddress(raw, origin);
  if (packet) return { kind: "link", activityId: packet };
  const trimmed = raw.trim();
  if (trimmed.startsWith("/")) {
    const legacy = parseActivityLink(origin + trimmed, origin);
    if (legacy) return { kind: "link", activityId: legacy };
  }
  const query = commandQuery(raw);
  if (query !== null) return { kind: "command", query };
  const entry = classifyHomeEntry(raw, origin);
  if (entry.kind === "activity") {
    const kind = normalizeActivityUuid(trimmed)
      ? "uuid"
      : decodeActivityEmoji(trimmed)
        ? "emoji"
        : "link";
    return { kind, activityId: entry.id };
  }
  if (entry.kind === "topic") return entry;
  return { kind: "password", ...inspectPassword(raw) };
}

/**
 * A link this site does not recognise (another domain, a typo'd path). It
 * still falls through to "口令", but must not be treated as one: no rules
 * line about invalid characters, no "optimise" that strips it to letters.
 */
export function looksLikeAddress(raw: string) {
  const text = raw.trim();
  return (
    /^[a-z][a-z\d+.-]*:\/\//i.test(text) ||
    /^www\./i.test(text) ||
    /^[\w-]+(\.[\w-]+)+\/\S*$/u.test(text)
  );
}

export function isJumpScheme(
  scheme: EntryScheme,
): scheme is Extract<EntryScheme, { activityId: string }> {
  return (
    scheme.kind === "uuid" || scheme.kind === "emoji" || scheme.kind === "link"
  );
}
