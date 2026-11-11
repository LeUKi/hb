import { createLucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * 三方积分's own mark (docs/third-party-points-design.md §9; the user chose
 * it, 2026-11-11): a four-pointed sparkle, as points are drawn. On lucide's
 * 24×24 grid with its 2px stroke, so it sits with the rest (commands,
 * buttons, the cover's capsule).
 */
export const PointsMark = createLucideIcon("points", [
  [
    "path",
    {
      d: "M12 3c.7 4.6 3.4 7.3 8.5 9-5.1 1.7-7.8 4.4-8.5 9-.7-4.6-3.4-7.3-8.5-9 5.1-1.7 7.8-4.4 8.5-9z",
      key: "sparkle",
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
