import { Eye, EyeOff } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { MorphLabel } from "../ui/morph-label";

const filler = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/**
 * A stable 12-character stand-in for a 口令 that is not shown: never its
 * length or characters, and seeded by something else (the 红包, the row),
 * so a screenshot of it says nothing about the 口令.
 */
export function standIn(seed: string, index = 0) {
  let value = 0;
  for (const character of seed)
    value = (value * 31 + character.charCodeAt(0)) % 9973;
  return Array.from(
    { length: 12 },
    (_, position) =>
      filler[(value + (index + 1) * 17 + position * 13) % filler.length],
  ).join("");
}

/**
 * A 口令 as it shows: the text, or a blurred stand-in that screen readers
 * hear as “已隐藏” (the 口令 itself is not on the page then). The two
 * cross-fade; `fit` lets the width follow (a chip), `wrap` breaks a long
 * one onto more lines, else it truncates.
 */
export function PasswordText({
  text,
  shown,
  seed,
  index,
  fit = false,
  wrap = false,
  className,
}: {
  text: string;
  shown: boolean;
  /** What the stand-in is made from: never the 口令. */
  seed: string;
  index?: number;
  fit?: boolean;
  /** The whole 口令, on as many lines as it takes (up to 32 characters). */
  wrap?: boolean;
  className?: string;
}) {
  const line = wrap
    ? "block [overflow-wrap:anywhere]"
    : fit
      ? ""
      : "block truncate";
  return (
    <MorphLabel fit={fit && !wrap} align="start" className={className}>
      {shown ? (
        <span className={cn(line, "font-mono")}>{text}</span>
      ) : (
        <span className={cn(line, "font-mono")}>
          <span
            aria-hidden="true"
            className="text-ink-3 blur-[2.5px] select-none"
          >
            {standIn(seed, index)}
          </span>
          <span className="sr-only">已隐藏</span>
        </span>
      )}
    </MorphLabel>
  );
}

/**
 * The eye after a hidden 口令. Only while the 红包 runs: a screenshot of it
 * then must not give the 口令 away, so they start hidden; once it has
 * ended they are public and plain, with no eye.
 */
export function RevealToggle({
  shown,
  onToggle,
  what = "口令",
  size = "icon-xs",
  className,
}: {
  shown: boolean;
  onToggle: () => void;
  /** Named as “显示…” (pressed while shown): “口令”, “全部口令”, “口令 2”. */
  what?: string;
  size?: "icon-xs" | "icon-sm";
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size={size}
      aria-label={`显示${what}`}
      aria-pressed={shown}
      title={`${shown ? "隐藏" : "显示"}${what}`}
      className={cn("text-ink-3", className)}
      onClick={onToggle}
    >
      {shown ? <EyeOff /> : <Eye />}
    </Button>
  );
}
