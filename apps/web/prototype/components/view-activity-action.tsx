import type { AnchorHTMLAttributes } from "react";
import { prepareActivityWindowLink } from "../activity-window";
import "./row-actions.css";

/** The stable local detail route used by list actions and external previews. */
export function activityHref(activityId: string): string {
  return `#activity?sample=${encodeURIComponent(activityId)}`;
}

function hasPreparedWindowToken(anchor: HTMLAnchorElement) {
  const [, query = ""] = anchor.hash.slice(1).split("?");
  return new URLSearchParams(query).has("view");
}

function prepareIfNeeded(anchor: HTMLAnchorElement, activityId: string) {
  if (!hasPreparedWindowToken(anchor))
    prepareActivityWindowLink(anchor, activityId);
}

export function ViewActivityAction({
  activityId,
  className = "",
  onClick,
  onAuxClick,
  onPointerDown,
  onKeyDown,
  ...props
}: {
  activityId: string;
  className?: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">) {
  return (
    <a
      {...props}
      className={`row-action view-activity-action ${className}`.trim()}
      href={activityHref(activityId)}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (!event.defaultPrevented && event.button <= 1)
          prepareIfNeeded(event.currentTarget, activityId);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          (event.key === "Enter" || event.key === " ")
        )
          prepareIfNeeded(event.currentTarget, activityId);
      }}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented)
          prepareIfNeeded(event.currentTarget, activityId);
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event);
        if (event.button === 1 && !event.defaultPrevented)
          prepareIfNeeded(event.currentTarget, activityId);
      }}
      target="_blank"
      rel="noopener noreferrer"
    >
      查看活动
    </a>
  );
}
