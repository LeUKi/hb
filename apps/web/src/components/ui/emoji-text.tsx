/**
 * An emoji (with its modifiers and joins), or a flag's two letters: kept
 * whole so it still draws as one.
 */
const EMOJI =
  /((?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:\p{Emoji_Modifier}|\u{FE0F}|\u{20E3}|\u{200D}\p{Extended_Pictographic})*)/u;

/**
 * Text whose emoji are each in a span of class `hb-emoji`, so a gradient
 * title (05 §14) can leave them their own colours.
 */
export function EmojiText({ text }: { text: string }) {
  const parts = text.split(EMOJI);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string.
      <span key={index} className="hb-emoji">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
