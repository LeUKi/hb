import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

/**
 * Focus for the window's panels (用户卡片, 名单弹窗, 说明弹窗): into the panel when it
 * opens; once its exit animation has finished, back to the control that
 * opened it — or to the new page if the panel closed by navigating away —
 * unless the viewer has already moved focus somewhere else.
 */
export function useOverlayFocus(open: boolean, triggerId: string) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const openedOn = useRef("");
  useEffect(() => {
    if (!open) return;
    openedOn.current = router.state.location.pathname;
    panelRef.current?.focus({ preventScroll: true });
  }, [open, router]);
  const onExitComplete = useCallback(() => {
    const active = document.activeElement;
    const lost =
      !active ||
      active === document.body ||
      !active.isConnected ||
      Boolean(panelRef.current?.contains(active));
    if (!lost) return;
    const target =
      openedOn.current === router.state.location.pathname
        ? document.getElementById(triggerId)
        : document.getElementById("view");
    target?.focus({ preventScroll: true });
  }, [router, triggerId]);
  return { panelRef, onExitComplete };
}
