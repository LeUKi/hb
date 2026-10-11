import { normalizeTopicLink } from "@hb/contracts";

export function normalizeDisplayTopicLink(value: string): {
  topicId: string;
  postNumber: number;
  topicUrl: string;
} | null {
  const normalized = normalizeTopicLink(value);
  if (!normalized) return null;
  return {
    ...normalized,
    topicUrl: displayTopicUrl(normalized.topicId, normalized.postNumber),
  };
}

export function displayTopicUrl(topicId: string, postNumber: number) {
  return `https://linux.do/t/topic/${topicId}/${postNumber}`;
}
