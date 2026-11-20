import type { ComponentType } from "react";
import { cn } from "../../lib/cn";
import { Squircle } from "./squircle";

/**
 * An icon on its tile, the start page's 常用命令 and the 帮助 front page's
 * cards alike: faint gold, the deep gold of the 红包's rim for the mark, in
 * light and dark. One colour per command read as a scatter and sank or
 * glared in 深色 (user 2026-11-20 chose this from four;
 * docs/help-center-design.md §6).
 */
export function IconTile({
  icon: Icon,
  large = false,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** 40px with a 20px mark, for a card with a second line of words. */
  large?: boolean;
}) {
  return (
    <Squircle radius={10}>
      <span
        className={cn(
          "grid shrink-0 place-items-center bg-gold-soft text-gold-ink",
          large ? "size-10" : "size-9",
        )}
      >
        <Icon className={large ? "size-5" : "size-[18px]"} aria-hidden={true} />
      </span>
    </Squircle>
  );
}
