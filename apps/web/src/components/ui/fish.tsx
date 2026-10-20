import { formatSignedAmount } from "@hb/contracts";
import { cn } from "../../lib/cn";
import { RollingText } from "./morph-label";
import { TagHint } from "./tag-hint";

/** Signed cents as the page writes them: a true minus, a plus when asked. */
export function fishText(minor: number, signed = false) {
  const text = formatSignedAmount(minor).replace("-", "−");
  return signed && minor > 0 ? `+${text}` : text;
}

/**
 * A number of 🐟, 🐟额's unit (docs/balance-design.md §0): the figure
 * rolls as it changes, then 🐟; a screen reader hears “鱼”.
 */
export function Fish({
  minor,
  signed = false,
  className,
}: {
  minor: number;
  /** "+" before what comes in. */
  signed?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("whitespace-nowrap tabular-nums", className)}>
      <RollingText text={fishText(minor, signed)} />
      <span aria-hidden="true" className="ms-1 font-emoji">
        🐟
      </span>
      <span className="sr-only">鱼</span>
    </span>
  );
}

const FISH_HINT = "这笔 LDC 在你的🐟额里，转出后到 Credit 账户。";

/**
 * The small 🐟 after “LDC” on a 🐟额红包's amount (docs/balance-design.md
 * §14): “在🐟额”, where it is, not a unit. Where it stands alone (my result)
 * a tap or hover explains it; inside a row that is itself a link, it only
 * has the explanation as its title.
 */
export function FishMark({
  explained = false,
  className,
}: {
  explained?: boolean;
  className?: string;
}) {
  const mark = cn(
    "ms-0.5 inline-block align-baseline font-emoji text-[0.75em] leading-none",
    className,
  );
  if (explained)
    return (
      <TagHint hint={FISH_HINT} aria-label="在🐟额" className={mark}>
        <span aria-hidden="true">🐟</span>
      </TagHint>
    );
  return (
    <span className={mark} title={FISH_HINT}>
      <span aria-hidden="true">🐟</span>
      <span className="sr-only">在🐟额</span>
    </span>
  );
}
