import { useAtomValue } from "jotai";
import { useReducedMotion } from "motion/react";
import { motionPrefAtom } from "./store";

/** Shared timing so every surface moves on the same rhythm. */
export const ease = [0.2, 0, 0, 1] as const;
export const durations = {
  /** Omnibox travelling between start, dock and command positions. */
  travel: 0.34,
  /** Content entering after the omnibox has started moving. */
  enter: 0.26,
  exit: 0.14,
} as const;

/** System setting or the dev toolbar's forced reduced motion. */
export function useReducedMotionPref() {
  const system = useReducedMotion();
  const pref = useAtomValue(motionPrefAtom);
  return pref === "reduce" || Boolean(system);
}

/**
 * Outside React (a scroll started from a plain function): whether motion is
 * reduced, by the system or the dev toolbar (the shell marks the page).
 */
export function scrollBehavior(): ScrollBehavior {
  const reduced =
    document.querySelector("[data-motion=reduce]") !== null ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduced ? "auto" : "smooth";
}
