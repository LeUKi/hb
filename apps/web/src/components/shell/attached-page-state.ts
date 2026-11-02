import { atom, useAtomValue, useSetAtom } from "jotai";
import { useSyncExternalStore } from "react";
import { useCurrentActivityId } from "../../lib/activity-route";

// The 附带网页's state that the 红包 page reads, on its own: the 红包 page's
// cover and 说明 ask for the page through it, and the forum's mini app
// draws them without the page itself (docs/mini-app-design.md §7).

/**
 * The page held: the 红包 it is for and its address (null: none), open
 * beside the 红包 (or pulled up), loaded once first opened, and the split. Off its
 * 红包's page (its 📝 page, the start page) it stays, hidden; another
 * 红包's page lets it go.
 */
export type Held = {
  forId: string | null;
  url: string | null;
  /** The 红包 author's LINUX DO username: whose page this is. */
  author: string | null;
  open: boolean;
  loaded: boolean;
  mainWidth: number;
};
export const heldAtom = atom<Held>({
  forId: null,
  url: null,
  author: null,
  open: false,
  loaded: false,
  mainWidth: 460,
});

/**
 * Asked from the 红包 page (附带网页 under 分享, the cover's tag, a note's
 * button): `n` moves on with each ask, `open` says which way.
 */
export const requestAtom = atom({ n: 0, open: true });

/** Wide enough for the page beside the 红包 window. */
export const WIDE = "(min-width: 900px) and (min-height: 560px)";

export function useMedia(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
  );
}

export type Stop = "peek" | "full";
export const sheetStopAtom = atom<Stop>("peek");

/**
 * The page of the 红包 page shown, when it has one: open beside it on a
 * wide screen, or its sheet pulled up on a narrow one.
 */
export function useAttachedPageOpener() {
  const activityId = useCurrentActivityId();
  const held = useAtomValue(heldAtom);
  const stop = useAtomValue(sheetStopAtom);
  const wide = useMedia(WIDE);
  const request = useSetAtom(requestAtom);
  const available =
    held.url !== null && activityId !== null && held.forId === activityId;
  const isOpen = available && (wide ? held.open : stop === "full");
  const ask = (open: boolean) =>
    request((current) => ({ n: current.n + 1, open }));
  return {
    available,
    isOpen,
    open: () => ask(true),
    toggle: () => ask(!isOpen),
  };
}
