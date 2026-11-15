// How a 私信通知 reads (docs/notification-design.md §5): the 社区 shows the
// subject in its lists and the plain text in a code block, which never
// wraps and whose links cannot be tapped. So lines are broken here, at most
// 20 汉字 wide, and a link stands on its own line.

/** Columns a line may take: a 汉字 is two, ASCII one (20 汉字). */
export const LINE_COLUMNS = 40;
/** A 红包's or 判定器's name in a subject, at most this many characters. */
const NAME_IN_SUBJECT = 12;
const SUBJECT_PREFIX = "红包站：";

const CLOSING = new Set([..."，。、：；！？）」』”’》〉…·"]);

function columnsOf(text: string) {
  let columns = 0;
  for (const character of text)
    columns += /[\x20-\x7e]/.test(character) ? 1 : 2;
  return columns;
}

/** Words, numbers and links stay whole; every other character stands alone. */
function tokens(text: string) {
  return text.match(/https?:\/\/\S+|[\x21-\x7e]+| +|[^\x20-\x7e]/gu) ?? [];
}

/** One paragraph broken into lines of at most `columns`. */
export function wrapParagraph(text: string, columns = LINE_COLUMNS) {
  const lines: string[] = [];
  let line = "";
  for (const token of tokens(text)) {
    if (token.startsWith(" ")) {
      if (line) line += token;
      continue;
    }
    const fits = columnsOf(line.trimEnd() + token) <= columns;
    // A closing mark never starts a line: it hangs past the edge.
    if (!line || fits || CLOSING.has(token)) {
      line = (fits || CLOSING.has(token) ? line : line.trimEnd()) + token;
      continue;
    }
    lines.push(line.trimEnd());
    line = token;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

/** 《周五摸鱼》, cut to 12 characters. */
export function nameOf(name: string, open = "《", close = "》") {
  const characters = [...name.replace(/\s+/g, " ").trim()];
  const shown =
    characters.length > NAME_IN_SUBJECT
      ? `${characters.slice(0, NAME_IN_SUBJECT).join("")}…`
      : characters.join("");
  return `${open}${shown || "未命名"}${close}`;
}

export function subjectOf(sentence: string) {
  return `${SUBJECT_PREFIX}${sentence}`;
}

export type NoticeLink = { label: string; url: string };

/**
 * The body: what happened, a link to it, and where this kind is turned
 * off (none for a notice without a switch).
 */
export function bodyOf(
  paragraphs: string[],
  link: NoticeLink,
  off: string | null,
) {
  const blocks = paragraphs
    .filter((paragraph) => paragraph.trim())
    .map((paragraph) => wrapParagraph(paragraph).join("\n"));
  blocks.push(`${link.label}：\n${link.url}`);
  if (off) blocks.push(`不想收这类通知，在这里关：\n${off}`);
  return `${blocks.join("\n\n")}\n`;
}

/** "11月16日 20:00", Beijing time. */
export function timeOf(at: number) {
  const shanghai = new Date(at + 8 * 3_600_000);
  const hours = String(shanghai.getUTCHours()).padStart(2, "0");
  const minutes = String(shanghai.getUTCMinutes()).padStart(2, "0");
  return `${shanghai.getUTCMonth() + 1}月${shanghai.getUTCDate()}日 ${hours}:${minutes}`;
}
