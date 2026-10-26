import { atom, useSetAtom } from "jotai";
import { useEffect } from "react";

/**
 * How much of the window's bottom the on-screen keyboard covers, in px,
 * measured with visualViewport (iOS Safari and Android Chrome do not shrink
 * the layout viewport for it). Lists that open under the 指令框 stop above it.
 */
export const keyboardInsetAtom = atom(0);

const TEXT_FIELD = "input, textarea, [contenteditable='true']";
/** How long after a change the keyboard, Safari's pan and the 指令框 move. */
const SETTLE_MS = 1000;

/**
 * The real keyboard, and the focused field kept in sight.
 *
 * iOS Safari, raising its keyboard, pans the page so the field just focused
 * is not under it. Here the whole site is one fixed window, so it pans the
 * window itself, and a field near the top (the 指令框, which rises there as
 * it opens) goes out of sight above. While the field fits above the
 * keyboard with the window at rest, the pan is undone: scrolled back, and
 * where Safari keeps its view panned anyway (visualViewport.offsetTop stays,
 * as on an iPhone 13 mini), the desktop moves down by as much. A field
 * lower down keeps Safari's pan.
 */
function useKeyboard(setInset: (inset: number) => void) {
  useEffect(() => {
    const viewport = window.visualViewport;
    // Only where a finger types on the screen: with a mouse there is no
    // keyboard to follow, and each round reads the layout every frame for
    // a second after any focus or resize (opening the page window, dragging
    // the line between the windows).
    if (!viewport || !matchMedia("(any-pointer: coarse)").matches) return;
    let follow = false;
    let shift = 0;
    let frame = 0;
    let until = 0;
    const update = () => {
      const layer = document.querySelector("[data-window-layer]");
      const desktop = document.querySelector<HTMLElement>("[data-desktop]");
      if (!layer || !desktop) return;
      const field = document.activeElement;
      if (
        field instanceof HTMLElement &&
        field.matches(TEXT_FIELD) &&
        layer.contains(field)
      ) {
        // Where the field ends below the window's top: panned, moved or
        // not, the two move together.
        const below =
          field.getBoundingClientRect().bottom -
          layer.getBoundingClientRect().top;
        follow =
          below <= viewport.height && Math.abs(viewport.scale - 1) < 0.01;
      } else if (viewport.offsetTop === 0) {
        // Left for a button, the keyboard goes down and the pan with it:
        // followed until it is undone.
        follow = false;
      }
      if (follow && window.scrollY !== 0) window.scrollTo(0, 0);
      const next = follow ? Math.round(viewport.offsetTop) : 0;
      if (next !== shift) {
        shift = next;
        desktop.style.translate = shift ? `0 ${shift}px` : "";
      }
      const bottom = layer.getBoundingClientRect().bottom;
      setInset(
        Math.max(
          0,
          Math.round(bottom - (viewport.offsetTop + viewport.height)),
        ),
      );
    };
    // Each change is followed frame by frame for a while: the keyboard and
    // Safari's pan animate, and the 指令框 rises after its focus.
    const tick = () => {
      update();
      frame = performance.now() < until ? requestAnimationFrame(tick) : 0;
    };
    const settle = () => {
      until = performance.now() + SETTLE_MS;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    update();
    viewport.addEventListener("resize", settle);
    viewport.addEventListener("scroll", settle);
    window.addEventListener("scroll", settle);
    document.addEventListener("focusin", settle);
    document.addEventListener("focusout", settle);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", settle);
      viewport.removeEventListener("scroll", settle);
      window.removeEventListener("scroll", settle);
      document.removeEventListener("focusin", settle);
      document.removeEventListener("focusout", settle);
      document
        .querySelector<HTMLElement>("[data-desktop]")
        ?.style.removeProperty("translate");
    };
  }, [setInset]);
}

/** Keeps keyboardInsetAtom current, and the focused field in sight. */
export function KeyboardLayer() {
  useKeyboard(useSetAtom(keyboardInsetAtom));
  return null;
}
