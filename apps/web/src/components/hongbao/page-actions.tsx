import { useRouter } from "@tanstack/react-router";
import { Share2 } from "lucide-react";
import { openOverlay } from "../../lib/overlay";
import { useWindowInfo } from "../shell/window-info";
import { Button } from "../ui/button";

/**
 * 页面操作: 分享, pinned under the avatar while the page scrolls (a
 * zero-height sticky row in the 内容区, not the 顶栏). It opens the 分享
 * panel (share-dialog.tsx, 05 §5), its own history entry.
 */
export function PageActions() {
  const { compact } = useWindowInfo();
  const router = useRouter();
  return (
    <div
      className="pointer-events-none sticky top-[calc(var(--bar-h)+0.75rem)] z-20 h-0"
      data-hb-part="actions"
    >
      <div className="pointer-events-auto absolute top-0 right-3 @wide/window:right-5">
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
      </div>
    </div>
  );
}
