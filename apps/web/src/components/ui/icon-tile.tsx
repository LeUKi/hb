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
  solid = false,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** 40px with a 20px mark, for a card with a second line of words. */
  large?: boolean;
  /** The one to look at first (帮助中心 on the start page): solid gold. */
  solid?: boolean;
}) {
  return (
    <Squircle radius={10}>
      <span
        className={cn(
          "grid shrink-0 place-items-center",
          // Words on gold keep the dark gold ink in 深色 too (styles.css).
          solid
            ? "bg-linear-to-b from-gold-top to-gold-bottom text-[#6a4510] shadow-[inset_0_1px_0_rgb(255_255_255/0.7)]"
            : "bg-gold-soft text-gold-ink",
          large ? "size-10" : "size-9",
        )}
      >
        <Icon className={large ? "size-5" : "size-[18px]"} aria-hidden={true} />
      </span>
    </Squircle>
  );
}
