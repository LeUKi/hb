import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { radius, Squircle } from "./squircle";

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

/**
 * A small status label: soft tone, optional dot. 24px (squircle 9) in
 * lists; 28px (squircle 10) where it stands on its own (我的结果).
 */
export function StatusChip({
  tone = "neutral",
  dot = false,
  size = "sm",
  children,
  className,
}: {
  tone?: ChipTone;
  dot?: boolean;
  size?: "sm" | "md";
  children: ReactNode;
  className?: string;
}) {
  return (
    <Squircle radius={size === "md" ? 10 : radius.tag}>
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 font-medium whitespace-nowrap",
          size === "md" ? "h-7 px-2.5 text-sm" : "h-6 px-2 text-xs",
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
