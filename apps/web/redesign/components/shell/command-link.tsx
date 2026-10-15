import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode, Ref } from "react";
import type { Command } from "../../lib/commands";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";

/**
 * A real link to a command's page, so modified clicks still open a new tab.
 * Plain clicks run the command (account gating, overlay-aware navigation).
 * Style, ref and data-* pass through so <Squircle> can wrap it.
 */
export function CommandLink({
  command,
  children,
  ref,
  ...props
}: {
  command: Command;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
  "aria-label"?: string;
  "aria-current"?: "page";
  ref?: Ref<HTMLAnchorElement & HTMLButtonElement>;
}) {
  const { runCommand } = useOmniboxController();
  if (!command.path)
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        onClick={() => void runCommand(command)}
      >
        {children}
      </button>
    );
  return (
    <Link
      {...props}
      ref={ref}
      to={command.path}
      onClick={(event) => {
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        void runCommand(command);
      }}
    >
      {children}
    </Link>
  );
}
