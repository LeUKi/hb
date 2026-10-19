import { formatSignedAmount } from "@hb/contracts";
import { cn } from "../../lib/cn";
import { RollingText } from "./morph-label";

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
