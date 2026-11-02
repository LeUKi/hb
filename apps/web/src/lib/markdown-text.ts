/**
 * The note as one line of plain text (the small cover's summary): links
 * keep their words, marks and images drop away.
 */
export function markdownText(source: string) {
  return source
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gmu, "")
    .replace(/[*_~`]+/gu, "")
    .replace(/\|/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
