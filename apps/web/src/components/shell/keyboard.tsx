import { atom, useSetAtom } from "jotai";
import { useEffect, useState } from "react";

/**
 * How much of the window's bottom the on-screen keyboard covers, in px,
 * measured with visualViewport (iOS Safari and Android Chrome do not shrink
 * the layout viewport for it). Lists that open under the 指令框 stop above it.
 */
export const keyboardInsetAtom = atom(0);

/** The real keyboard: what the visual viewport leaves of the window's bottom. */
function useViewportInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const layer = document.querySelector("[data-window-layer]");
      if (!layer) return;
      const bottom = layer.getBoundingClientRect().bottom;
      setInset(
        Math.max(
          0,
          Math.round(bottom - (viewport.offsetTop + viewport.height)),
        ),
      );
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

/** Keeps keyboardInsetAtom current. */
export function KeyboardLayer() {
  const inset = useViewportInset();
  const setInset = useSetAtom(keyboardInsetAtom);
  useEffect(() => setInset(inset), [inset, setInset]);
  return null;
}
