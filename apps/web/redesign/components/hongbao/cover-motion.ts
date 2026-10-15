import type { Transition } from "motion/react";
import type { CoverState } from "./use-cover-state";

/**
 * How the cover's parts move when it flips between big and small. Nothing
 * jumps and nothing blinks:
 *
 * - `leaf`: parts in both covers (sender, title, each label and value, the
 *   roster entry) move and scale. Only leaves get `layout`, keyed to the
 *   state, so a ticking countdown never starts a layout animation. The
 *   title breaks its lines in the same places on both covers, so it scales
 *   evenly too.
 * - `fade`: parts of only one cover. The leaving ones glide with their row
 *   (instead of jumping when the row moves) and fade; the arriving ones fade
 *   in before the old ones are gone, so there is no empty moment.
 * - `shrink`: the bars, steps and notes under the data shrink as they go.
 */
export function coverMotion(
  state: CoverState,
  transition: Transition,
  opening: boolean,
  reduced: boolean,
) {
  const leave = reduced ? { duration: 0 } : { duration: opening ? 0.4 : 0.32 };
  const arrive = reduced
    ? { duration: 0 }
    : { duration: opening ? 0.34 : 0.28, delay: opening ? 0.08 : 0.02 };
  const glide = {
    layout: "position",
    layoutDependency: state,
    transition: { layout: transition },
  } as const;
  return {
    state,
    leaf: {
      layout: true,
      layoutDependency: state,
      transition: { layout: transition },
    },
    fade: {
      ...glide,
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: arrive },
      exit: { opacity: 0, transition: leave },
    },
    shrink: {
      ...glide,
      initial: { opacity: 0, scale: 0.6 },
      animate: { opacity: 1, scale: 1, transition: arrive },
      exit: {
        opacity: 0,
        scale: 0.6,
        transition: reduced ? { duration: 0 } : { duration: 0.22 },
      },
    },
  } as const;
}

export type CoverMotion = ReturnType<typeof coverMotion>;
