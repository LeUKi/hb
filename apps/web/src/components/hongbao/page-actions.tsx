import { useRouter } from "@tanstack/react-router";
import { Globe, Share2 } from "lucide-react";
import { openOverlay } from "../../lib/overlay";
import { useAttachedPageOpener } from "../shell/attached-page";
import { useWindowInfo } from "../shell/window-info";
import { Button } from "../ui/button";
import { Reveal } from "../ui/reveal";

/**
 * 页面操作: 分享 and, for a 红包 with one, 附带网页 under it, pinned under
 * the avatar while the page scrolls (a zero-height sticky row in the 内容区,
 * not the 顶栏). 分享 opens the 分享 panel (share-dialog.tsx, 05 §5), its
 * own history entry; 附带网页 opens and closes the page beside the 红包
 * window or pulls up its sheet (docs/attached-page-design.md §2.2), pressed
 * in while it is open. One above the other, never beside: beside it would
 * run into the author's name over the cover.
 */
export function PageActions() {
  const { compact } = useWindowInfo();
  const router = useRouter();
  const page = useAttachedPageOpener();
  return (
    <div
      className="pointer-events-none sticky top-[calc(var(--bar-h)+0.75rem)] z-20 h-0"
      data-hb-part="actions"
    >
      <div
        className="pointer-events-auto absolute top-0 right-3 flex flex-col items-end gap-2 @wide/window:right-5"
        data-morph="fade"
      >
        <Button
          id="share-button"
          variant="secondary"
          size={compact ? "icon-sm" : "sm"}
          aria-label={compact ? "分享" : undefined}
          aria-haspopup="dialog"
          onClick={() => openOverlay(router, { panel: "share" })}
        >
          <Share2 />
          {!compact && "分享"}
        </Button>
        <Reveal show={page.available}>
          <Button
            id="page-button"
            variant="secondary"
            size={compact ? "icon-sm" : "sm"}
            aria-label={compact ? "附带网页" : undefined}
            aria-pressed={page.isOpen}
            title={page.isOpen ? "收起附带网页" : "打开附带网页"}
            onClick={page.toggle}
          >
            <Globe />
            {!compact && "附带网页"}
          </Button>
        </Reveal>
      </div>
    </div>
  );
}
