import { ChevronRight } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { cn } from "../../lib/cn";
import {
  type ButtonSize,
  buttonHeight,
  buttonRadius,
  buttonVariants,
  useButtonShape,
} from "./button";
import { SquircleFill } from "./squircle";

/**
 * A link that looks like a button. A real link, so modified clicks open a
 * new tab; a plain click goes through `onGo` (the app's own navigation).
 * Without `onGo` it leaves the site, in a new tab.
 */
export function ButtonLink({
  href,
  onGo,
  variant = "quiet",
  size = "sm",
  className,
  children,
  stopPropagation = false,
  ...aria
}: {
  href: string;
  onGo?: () => void;
  variant?: "primary" | "secondary" | "quiet" | "ghost";
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
  /** Inside a clickable row: the row must not take the click too. */
  stopPropagation?: boolean;
  "aria-label"?: string;
  title?: string;
}) {
  const shape = useButtonShape(buttonRadius[size], buttonHeight[size]);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (stopPropagation) event.stopPropagation();
    if (
      !onGo ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    onGo();
  };
  return (
    <a
      {...aria}
      href={href}
      target={onGo ? undefined : "_blank"}
      rel={onGo ? undefined : "noopener noreferrer"}
      onClick={onClick}
      className={cn(buttonVariants({ variant, size }), className)}
      style={shape}
    >
      <SquircleFill radius={buttonRadius[size]} />
      {children}
    </a>
  );
}

/** "红包记录 ›": a quiet link to another page, drawn the same everywhere. */
export function MoreLink({
  href,
  onGo,
  children,
  className,
}: {
  href: string;
  onGo: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ButtonLink
      href={href}
      onGo={onGo}
      variant="ghost"
      size="xs"
      className={cn("shrink-0 gap-0.5 pr-1.5", className)}
    >
      {children}
      <ChevronRight aria-hidden="true" />
    </ButtonLink>
  );
}
