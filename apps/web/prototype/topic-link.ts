import { normalizeTopicLink } from "@hb/contracts";

export function normalizePrototypeTopicLink(value: string): {
  topicId: string;
  postNumber: number;
  topicUrl: string;
} | null {
  const normalized = normalizeTopicLink(value);
  if (!normalized) return null;
  return {
    ...normalized,
    topicUrl: prototypeTopicUrl(normalized.topicId, normalized.postNumber),
  };
}

export function prototypeTopicUrl(topicId: string, postNumber: number) {
  return `https://linux.do/t/topic/${topicId}/${postNumber}`;
}
