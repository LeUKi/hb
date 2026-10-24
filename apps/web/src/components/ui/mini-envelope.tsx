import { cn } from "../../lib/cn";
import { Squircle } from "./squircle";

/**
 * A small 红包 for lists: red with the gold dot; dusty once it is over. A
 * 代码判定红包 is black lacquer, cool grey once over (05 §14).
 */
export function MiniEnvelope({
  ended = false,
  draft = false,
  code = false,
  size = "md",
}: {
  ended?: boolean;
  /** Not opened yet: outlined, no seal. */
  draft?: boolean;
  code?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <Squircle radius={size === "sm" ? 7 : 9}>
      <span
        aria-hidden="true"
        data-ended={(code && ended) || undefined}
        className={cn(
          "relative shrink-0 overflow-hidden",
          code && "mini-lacquer",
          size === "sm" ? "h-10 w-8" : "h-14 w-11",
          draft
            ? "bg-white/70 squircle-ring [--sq-ring-w:1.5px] [--sq-ring:color-mix(in_srgb,var(--color-envelope)_45%,transparent)]"
            : ended
              ? "bg-envelope-ended"
              : "bg-envelope",
        )}
      >
        <span
          className={cn(
            "absolute inset-x-0 top-0 h-[58%] rounded-b-[50%]",
            draft
              ? "shadow-[inset_0_-1.5px_0_color-mix(in_srgb,var(--color-envelope)_45%,transparent)]"
              : ended
                ? "bg-envelope-ended-flap"
                : "bg-envelope-flap",
          )}
        />
        {!draft && (
          <span
            className={cn(
              "absolute top-[46%] left-1/2 -translate-x-1/2 rounded-full bg-envelope-gold",
              size === "sm" ? "size-2.5" : "size-3.5",
            )}
          />
        )}
      </span>
    </Squircle>
  );
}
