import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Squircle } from "./squircle";

export type ChipTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "gold"
  | "accent";

const tones: Record<ChipTone, string> = {
  neutral: "bg-fill-2 text-ink-2",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  gold: "bg-gold-soft text-gold-ink",
  accent: "bg-accent-soft text-accent-ink",
};

/** A small status label: soft tone, squircle 9, optional dot. */
export function StatusChip({
  tone = "neutral",
  dot = false,
  children,
  className,
}: {
  tone?: ChipTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Squircle radius={9}>
      <span
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1.5 px-2 text-xs font-medium whitespace-nowrap",
          tones[tone],
          className,
        )}
      >
        {dot && (
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-current"
          />
        )}
        {children}
      </span>
    </Squircle>
  );
}
