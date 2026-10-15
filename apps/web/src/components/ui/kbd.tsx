import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { shortcutLabel } from "../../lib/platform";
import { radius, Squircle } from "./squircle";

export function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Squircle radius={radius.kbd}>
      <kbd className={cn("kbd", className)}>{children}</kbd>
    </Squircle>
  );
}

/** The open-box shortcut for this platform: ⌘K or Ctrl K. */
export function ShortcutKbd({ className }: { className?: string }) {
  return <Kbd className={className}>{shortcutLabel()}</Kbd>;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent reduce-motion:animate-none",
        className,
      )}
    />
  );
}
