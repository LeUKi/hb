import {
  animate,
  type MotionValue,
  type Transition,
  useMotionValue,
} from "motion/react";
import { type RefObject, useLayoutEffect, useRef } from "react";
import { ease } from "../../lib/motion";
import { crossedJustNow, MORPH_MS } from "../shell/layout-morph";
import { COVER_RESERVE, type CoverState, scrollerOf } from "./use-cover-state";

/**
 * The red face's height, always in px: a flip animates it from what is on
 * screen to the new content's height (never `auto`, or the old and new
 * heights would read the same). Content changes at rest just follow.
 *
 * The margin that held the body still while the cover was pinned
 * (use-cover-state.ts) is animated away together with the height.
 */
export function useCoverHeight({
  state,
  comp,
  innerRef,
  faceRef,
  frameRef,
  transition,
  onSettled,
  from = null,
}: {
  state: CoverState;
  comp: MotionValue<number>;
  innerRef: RefObject<HTMLDivElement | null>;
  faceRef: RefObject<HTMLDivElement | null>;
  frameRef: RefObject<HTMLDivElement | null>;
  transition: Transition;
  onSettled: () => void;
  /** The skeleton's height, when the page arrived after one. */
  from?: number | null;
}) {
  const height = useMotionValue(0);
  const arrival = useRef(from);
  const previous = useRef<CoverState | null>(null);
  /** The small cover's height, for the scroller's scroll-padding. */
  const smallHeight = useRef(0);
  const latest = useRef({ transition, onSettled });
  useLayoutEffect(() => {
    latest.current = { transition, onSettled };
  });

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const before = previous.current;
    previous.current = state;
    const to = inner.offsetHeight;
    if (state === "small") smallHeight.current = to;
    if (before === null) {
      // After the skeleton the red goes on from its height to this one.
      const start =
        arrival.current && Math.abs(arrival.current - to) > 1
          ? arrival.current
          : to;
      // First paint: set the DOM too, motion values only reach it next frame.
      height.jump(start);
      if (faceRef.current) faceRef.current.style.height = `${start}px`;
      // Coming back to a 红包 taken part in: small, the page at the reserve.
      const scroller = scrollerOf(frameRef);
      if (state === "small" && scroller) scroller.scrollTop = COVER_RESERVE;
      if (start !== to)
        animate(height, to, {
          ...latest.current.transition,
          onComplete: () => height.jump(inner.offsetHeight),
        });
      return;
    }
    if (before === state) return;
    const { transition, onSettled } = latest.current;
    if (comp.get() > 0) animate(comp, 0, transition);
    animate(height, to, {
      ...transition,
      onComplete: () => {
        // Content may have changed on the way (a countdown, a new claim).
        height.jump(inner.offsetHeight);
        onSettled();
      },
    });
  }, [state, height, comp, innerRef, faceRef, frameRef]);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const observer = new ResizeObserver(() => {
      if (height.isAnimating()) return;
      // The window crossing a layout line (布局补间) changes the cover's
      // size: it grows or shrinks there, as the parts in it move.
      if (crossedJustNow()) {
        animate(height, inner.offsetHeight, {
          duration: MORPH_MS / 1000,
          ease,
          onComplete: () => height.jump(inner.offsetHeight),
        });
        return;
      }
      height.jump(inner.offsetHeight);
      if (previous.current === "small")
        smallHeight.current = inner.offsetHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [height, innerRef]);

  return { height, smallHeight };
}
