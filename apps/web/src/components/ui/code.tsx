import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { radius, Squircle } from "./squircle";

/**
 * Literal text among words (a 口令 in the 分享 menu): monospace on a light
 * fill, so it reads as what to type rather than as one more hint.
 */
export function Code({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Squircle radius={radius.kbd}>
      <code
        className={cn(
          "inline-block max-w-full truncate bg-fill-2 px-1.5 align-bottom font-mono text-ink-2",
          className,
        )}
      >
        {children}
      </code>
    </Squircle>
  );
}
