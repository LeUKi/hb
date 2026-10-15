import type { useRouter } from "@tanstack/react-router";

type Router = ReturnType<typeof useRouter>;

declare module "@tanstack/history" {
  interface HistoryState {
    /** The omnibox is expanded into the command box over the current view. */
    omnibox?: "expanded";
    /** A panel is open over the window: 用户卡片, 名单弹窗, 说明弹窗 or 更多设置. */
    panel?: Panel;
    /** History index of the entry the overlay was opened from. */
    overlayBase?: number;
  }
}

export type Panel = "account" | "roster" | "note" | "settings";

type Overlay = { omnibox?: "expanded"; panel?: Panel };

/** Push an overlay as its own history entry so system back closes it. */
export function openOverlay(router: Router, overlay: Overlay) {
  const { href, state } = router.history.location;
  const { __TSR_index, __TSR_key, key, omnibox, panel, overlayBase, ...rest } =
    state;
  router.history.push(href, {
    ...rest,
    ...overlay,
    overlayBase: __TSR_index,
  });
}

/**
 * Close by going back when the overlay entry sits right after the entry it
 * was opened from; otherwise (e.g. after a reload) drop the state in place so
 * closing never leaves the site.
 */
export function closeOverlay(router: Router) {
  const { href, state } = router.history.location;
  const { __TSR_index, __TSR_key, key, omnibox, panel, overlayBase, ...rest } =
    state;
  if (!omnibox && !panel) return;
  if (overlayBase !== undefined && __TSR_index === overlayBase + 1) {
    router.history.back();
  } else {
    router.history.replace(href, rest);
  }
}

/** Replace the open overlay with another one, keeping its base entry. */
export function switchOverlay(router: Router, overlay: Overlay) {
  const { href, state } = router.history.location;
  const { __TSR_index, __TSR_key, key, omnibox, panel, overlayBase, ...rest } =
    state;
  if (!omnibox && !panel) {
    openOverlay(router, overlay);
    return;
  }
  router.history.replace(href, { ...rest, ...overlay, overlayBase });
}
