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

/**
 * iOS Safari, raising its keyboard, pans the page so the field just focused
 * is not under it. Here the whole site is one fixed window, so it pans the
 * window itself, and a field near the top (the 指令框) goes out of sight
 * above. While the field fits above the keyboard with the window at rest,
 * pan back; a field lower down keeps Safari's pan.
 */
function useKeepFieldInSight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (window.scrollY === 0 && viewport.offsetTop === 0) return;
        const field = document.activeElement;
        const layer = document.querySelector("[data-window-layer]");
        if (
          !(field instanceof HTMLElement) ||
          !field.matches("input, textarea, [contenteditable='true']") ||
          !layer?.contains(field)
        )
          return;
        // Where the field ends below the window's top: panned or not, the
        // two move together.
        const below =
          field.getBoundingClientRect().bottom -
          layer.getBoundingClientRect().top;
        if (below <= viewport.height) window.scrollTo(0, 0);
      });
    };
    viewport.addEventListener("resize", settle);
    viewport.addEventListener("scroll", settle);
    window.addEventListener("scroll", settle);
    document.addEventListener("focusin", settle);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", settle);
      viewport.removeEventListener("scroll", settle);
      window.removeEventListener("scroll", settle);
      document.removeEventListener("focusin", settle);
    };
  }, []);
}

/** Keeps keyboardInsetAtom current, and the focused field in sight. */
export function KeyboardLayer() {
  const inset = useViewportInset();
  const setInset = useSetAtom(keyboardInsetAtom);
  useEffect(() => setInset(inset), [inset, setInset]);
  useKeepFieldInSight();
  return null;
}
