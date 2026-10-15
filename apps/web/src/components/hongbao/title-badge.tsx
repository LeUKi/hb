import type { RosterTitle } from "../../lib/titles";
import { Squircle } from "../ui/squircle";

const labels: Record<RosterTitle, string> = {
  highest: "手气王",
  lowest: "手气亡",
  fastest: "手速王",
  flash: "我焯有桂！",
};

/**
 * One title, in one shape everywhere (roster rows and the claimer's result):
 * a text-only squircle tag; the colour says which title it is.
 */
export function TitleBadge({
  title,
  size = "sm",
}: {
  title: RosterTitle;
  size?: "sm" | "md";
}) {
  return (
    <Squircle radius={size === "md" ? 9 : 7}>
      <span className="title-badge" data-title={title} data-size={size}>
        {labels[title]}
      </span>
    </Squircle>
  );
}

export function TitleBadges({
  titles,
  size,
  className = "flex-wrap",
}: {
  titles: readonly RosterTitle[];
  size?: "sm" | "md";
  className?: string;
}) {
  if (titles.length === 0) return null;
  return (
    <span className={`flex items-center gap-1.5 ${className}`}>
      {titles.map((title) => (
        <TitleBadge key={title} title={title} size={size} />
      ))}
    </span>
  );
}
