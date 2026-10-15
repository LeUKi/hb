import {
  animate,
  type MotionValue,
  type Transition,
  useMotionValue,
} from "motion/react";
import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * A surface's height, always in px (as the 红包 cover's, use-cover-height):
 * when `phase` changes it animates from what is on screen to the content's
 * new height; at rest it follows the content. The DOM is written directly
 * as well, so the first paint already has the height.
 */
export function useMorphHeight({
  phase,
  innerRef,
  surfaceRef,
  transition,
  enterFrom,
}: {
  phase: unknown;
  innerRef: RefObject<HTMLElement | null>;
  surfaceRef: RefObject<HTMLElement | null>;
  transition: Transition;
  /** A surface that appears grows from this height. */
  enterFrom?: number;
}): MotionValue<number> {
  const height = useMotionValue(0);
  const previous = useRef<{ phase: unknown } | null>(null);
  const latest = useRef(transition);
  latest.current = transition;

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const set = (value: number) => {
      height.jump(value);
      if (surfaceRef.current) surfaceRef.current.style.height = `${value}px`;
    };
    const to = inner.offsetHeight;
    const before = previous.current;
    previous.current = { phase };
    if (before && before.phase === phase) return;
    const from = before ? height.get() : (enterFrom ?? to);
    if (!before) set(from);
    if (from === to || latest.current.duration === 0) {
      set(to);
      return;
    }
    // Not stopped on cleanup: StrictMode runs this twice, and a new phase
    // starts its own animation on the value, which stops this one.
    animate(height, to, {
      ...latest.current,
      onComplete: () => set(inner.offsetHeight),
    });
  }, [phase, height, innerRef, surfaceRef, enterFrom]);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const observer = new ResizeObserver(() => {
      if (height.isAnimating()) return;
      height.jump(inner.offsetHeight);
      if (surfaceRef.current)
        surfaceRef.current.style.height = `${inner.offsetHeight}px`;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [height, innerRef, surfaceRef]);

  return height;
}
