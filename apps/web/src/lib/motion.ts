import { useReducedMotion } from "motion/react";

/** Shared timing so every surface moves on the same rhythm. */
export const ease = [0.2, 0, 0, 1] as const;
export const durations = {
  /** Omnibox travelling between start, dock and command positions. */
  travel: 0.34,
  /** A page entering after the omnibox has started moving. */
  enter: 0.26,
  /** A page leaving. */
  exit: 0.14,
  /** A switcher's highlight sliding, a label's width (as 按钮换字). */
  slide: 0.24,
  /** Something opening in place (Reveal), or a surface changing height. */
  reveal: 0.26,
  /** Something closing in place. */
  collapse: 0.22,
  /** What arrives in place, after a beat (fadeDelay). */
  fadeIn: 0.2,
  fadeDelay: 0.04,
  /** What leaves in place. */
  fadeOut: 0.12,
} as const;

/** The system's reduced-motion setting. */
export function useReducedMotionPref() {
  return Boolean(useReducedMotion());
}

/**
 * Outside React (a scroll started from a plain function): whether motion is
 * reduced (the shell marks the page with data-motion).
 */
export function scrollBehavior(): ScrollBehavior {
  const reduced =
    document.querySelector("[data-motion=reduce]") !== null ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduced ? "auto" : "smooth";
}
