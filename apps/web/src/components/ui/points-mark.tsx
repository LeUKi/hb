import { createLucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * 三方积分's own mark (docs/third-party-points-design.md §9): a coin with a
 * four-pointed star, as points are drawn. On lucide's 24×24 grid with its
 * 2px stroke, so it sits with the rest (commands, buttons, the cover).
 */
export const PointsMark = createLucideIcon("points", [
  ["circle", { cx: "12", cy: "12", r: "9", key: "coin" }],
  [
    "path",
    {
      d: "M12 7.2l1.35 3.45 3.45 1.35-3.45 1.35L12 16.8l-1.35-3.45L7.2 12l3.45-1.35z",
      fill: "currentColor",
      strokeWidth: "1",
      key: "star",
    },
  ],
]);

/**
 * The capsule's two halves: the mark on a solid front half, the name on the
 * back half, meeting by colour alone (no rule between them). Read aloud as
 * 三方积分 and its name.
 */
export function PointsCapsuleParts({ name }: { name: string }) {
  return (
    <>
      <span className="hb-capsule-mark">
        <PointsMark aria-hidden="true" />
      </span>
      <span className="sr-only">三方积分</span>
      <span className="hb-capsule-name">{name}</span>
    </>
  );
}

/**
 * A 三方积分 named as a capsule. `cover` is drawn for the 红包's red (and
 * the black lacquer of 代码判定); `light` for the site's own light pages.
 */
export function PointsCapsule({
  name,
  tone = "light",
  small = false,
  className,
}: {
  name: string;
  tone?: "cover" | "light";
  small?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "hb-capsule",
        tone === "light" && "hb-capsule-light",
        small && "hb-capsule-sm",
        className,
      )}
    >
      <PointsCapsuleParts name={name} />
    </span>
  );
}
