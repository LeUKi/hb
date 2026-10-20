import { normalizeTopicLink } from "@hb/contracts";
import { parseActivityLink } from "./emoji-links";

export type HomeEntry =
  | { kind: "password" }
  | { kind: "activity"; id: string }
  | { kind: "topic"; topicId: string; postNumber: number; topicUrl: string };

const strictLinuxDoTopicUrl =
  /^https:\/\/linux\.do\/t\/topic\/[0-9]+(?:\/[0-9]+)?\/?(?:[?#].*)?$/u;
const controlCharacter = /\p{Cc}/u;

export function parseStrictHomeTopicLink(
  value: string,
): Extract<HomeEntry, { kind: "topic" }> | null {
  const input = value.trim();
  if (!input || controlCharacter.test(input) || input.includes("\\")) {
    return null;
  }
  if (!strictLinuxDoTopicUrl.test(input)) return null;
  const normalized = normalizeTopicLink(input);
  if (!normalized) return null;
  return {
    kind: "topic",
    topicId: normalized.topicId,
    postNumber: normalized.postNumber,
    topicUrl: `https://linux.do/t/topic/${normalized.topicId}/${normalized.postNumber}`,
  };
}

export function classifyHomeEntry(value: string, origin: string): HomeEntry {
  const input = value.trim();
  const activityId = parseActivityLink(input, origin);
  if (activityId) return { kind: "activity", id: activityId };
  const topic = parseStrictHomeTopicLink(input);
  if (topic) return topic;
  return { kind: "password" };
}
