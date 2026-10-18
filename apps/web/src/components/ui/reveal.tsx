import {
  AnimatePresence,
  type AnimationPlaybackControls,
  animate,
  motion,
  useIsPresent,
} from "motion/react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { durations, ease, useReducedMotionPref } from "../../lib/motion";

// How things appear, leave and change in place, the same everywhere
// (02 §12): nothing pops in or out, and nothing jumps.
//
// - Reveal: something there or not (a filter row, a notice). Its height
//   opens and closes with a fade; the gap its parent puts beside it opens
//   and closes with it, so the content around it moves continuously.
// - Swap: one thing replaced by another in the same place (a list by
//   another, a skeleton by its content). The new one fades in over the old
//   one fading out, and the place changes height smoothly between them.

/** The gap the parent lays out beside its children (display: contents is skipped). */
function parentGap(probe: HTMLElement | null) {
  let parent = probe?.parentElement ?? null;
  while (parent && getComputedStyle(parent).display === "contents")
    parent = parent.parentElement;
  if (!parent) return 0;
  const gap = Number.parseFloat(getComputedStyle(parent).rowGap);
  return Number.isFinite(gap) ? gap : 0;
}

/** Whether something in the flow comes before the probe (else the gap is after). */
function followsSibling(probe: HTMLElement | null) {
  let sibling = probe?.previousElementSibling ?? null;
  while (sibling) {
    const style = getComputedStyle(sibling);
    if (
      style.display !== "none" &&
      style.position !== "absolute" &&
      style.position !== "fixed"
    )
      return true;
    sibling = sibling.previousElementSibling;
  }
  return false;
}

type Edge = { gap: number; top: boolean; reduced: boolean };

const revealVariants = {
  hidden: ({ gap, top }: Edge) => ({
    height: 0,
    opacity: 0,
    ...(top ? { marginTop: -gap } : { marginBottom: -gap }),
    overflow: "hidden",
  }),
  shown: ({ reduced }: Edge) => ({
    height: "auto",
    opacity: 1,
    marginTop: 0,
    marginBottom: 0,
    transition: {
      height: { duration: reduced ? 0 : durations.reveal, ease },
      marginTop: { duration: reduced ? 0 : durations.reveal, ease },
      marginBottom: { duration: reduced ? 0 : durations.reveal, ease },
      opacity: {
        duration: durations.fadeIn,
        delay: reduced ? 0 : durations.fadeDelay,
        ease,
      },
    },
    // Open, it no longer clips: shadows and focus rings show again.
    transitionEnd: { overflow: "visible" },
  }),
};

/**
 * Something shown or not, opening and closing in place. Put it where the
 * content goes, as a child of the stack that spaces it (a grid or a column
 * with a gap): the gap opens and closes with it.
 */
export function Reveal({
  show,
  children,
  className,
}: {
  show: boolean;
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotionPref();
  // Out of the flow, so it takes no gap; it finds the parent's gap and
  // which side of the content it is on. Read as the content arrives or
  // leaves (the probe is from the last commit).
  const probe = useRef<HTMLSpanElement>(null);
  const edge: Edge = {
    gap: probe.current ? parentGap(probe.current) : 0,
    top: probe.current ? followsSibling(probe.current) : true,
    reduced,
  };
  return (
    <>
      <span ref={probe} aria-hidden="true" className="absolute size-0" />
      <AnimatePresence initial={false} custom={edge}>
        {show && (
          <RevealBody key="reveal" edge={edge} className={className}>
            {children}
          </RevealBody>
        )}
      </AnimatePresence>
    </>
  );
}

function RevealBody({
  edge,
  className,
  children,
}: {
  edge: Edge;
  className?: string;
  children: ReactNode;
}) {
  const present = useIsPresent();
  return (
    <motion.div
      custom={edge}
      variants={revealVariants}
      initial="hidden"
      animate="shown"
      exit="hidden"
      transition={{
        duration: edge.reduced ? 0 : durations.collapse,
        ease,
        opacity: { duration: durations.fadeOut, ease },
      }}
      // Leaving: out of reach and unread while it closes.
      inert={!present || undefined}
      aria-hidden={!present || undefined}
      className={className}
    >
      {children}
    </motion.div>
  );
}

type InlineEdge = { gap: number; start: boolean; reduced: boolean };

const inlineVariants = {
  hidden: ({ gap, start }: InlineEdge) => ({
    width: 0,
    opacity: 0,
    ...(start ? { marginInlineStart: -gap } : { marginInlineEnd: -gap }),
    overflow: "hidden",
  }),
  shown: ({ reduced }: InlineEdge) => ({
    width: "auto",
    opacity: 1,
    marginInlineStart: 0,
    marginInlineEnd: 0,
    transition: {
      width: { duration: reduced ? 0 : durations.slide, ease },
      marginInlineStart: { duration: reduced ? 0 : durations.slide, ease },
      marginInlineEnd: { duration: reduced ? 0 : durations.slide, ease },
      opacity: {
        duration: durations.fadeIn,
        delay: reduced ? 0 : durations.fadeDelay,
        ease,
      },
    },
    transitionEnd: { overflow: "visible" },
  }),
};

/** The gap the parent puts between items on a line. */
function parentColumnGap(probe: HTMLElement | null) {
  let parent = probe?.parentElement ?? null;
  while (parent && getComputedStyle(parent).display === "contents")
    parent = parent.parentElement;
  if (!parent) return 0;
  const gap = Number.parseFloat(getComputedStyle(parent).columnGap);
  return Number.isFinite(gap) ? gap : 0;
}

/**
 * Reveal for something on a line (a button beside a field): it grows from
 * nothing to its width and shrinks back, taking its gap with it, so what
 * follows slides instead of jumping.
 */
export function RevealInline({
  show,
  children,
  className,
}: {
  show: boolean;
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotionPref();
  const probe = useRef<HTMLSpanElement>(null);
  const edge: InlineEdge = {
    gap: probe.current ? parentColumnGap(probe.current) : 0,
    start: probe.current ? followsSibling(probe.current) : true,
    reduced,
  };
  return (
    <>
      <span ref={probe} aria-hidden="true" className="absolute size-0" />
      <AnimatePresence initial={false} custom={edge}>
        {show && (
          <InlineBody key="reveal" edge={edge} className={className}>
            {children}
          </InlineBody>
        )}
      </AnimatePresence>
    </>
  );
}

function InlineBody({
  edge,
  className,
  children,
}: {
  edge: InlineEdge;
  className?: string;
  children: ReactNode;
}) {
  const present = useIsPresent();
  return (
    <motion.span
      custom={edge}
      variants={inlineVariants}
      initial="hidden"
      animate="shown"
      exit="hidden"
      transition={{
        duration: edge.reduced ? 0 : durations.collapse,
        ease,
        opacity: { duration: durations.fadeOut, ease },
      }}
      inert={!present || undefined}
      aria-hidden={!present || undefined}
      className={cn("inline-flex shrink-0", className)}
    >
      {children}
    </motion.span>
  );
}

/**
 * One thing in place of another (`id` says which): the new one fades in
 * over the old one, and the place eases to the new one's height. Content
 * that changes under the same `id` (more rows loaded) just grows.
 */
export function Swap({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotionPref();
  const surface = useRef<HTMLDivElement>(null);
  // The height on screen, kept by an observer: what a change starts from
  // (layout effects run before the observer sees the new content).
  const height = useRef<number | null>(null);
  const shownId = useRef(id);
  const running = useRef<AnimationPlaybackControls | null>(null);

  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    height.current = element.offsetHeight;
    const observer = new ResizeObserver(() => {
      height.current = element.offsetHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = surface.current;
    if (!element || shownId.current === id) return;
    shownId.current = id;
    const from = height.current ?? element.offsetHeight;
    running.current?.stop();
    element.style.height = "";
    // The leaving content is out of the flow by now (popLayout).
    const to = element.offsetHeight;
    if (reduced || Math.abs(from - to) < 1) {
      element.style.overflow = "";
      return;
    }
    element.style.height = `${from}px`;
    element.style.overflow = "clip";
    running.current = animate(
      element,
      { height: [`${from}px`, `${to}px`] },
      {
        duration: durations.reveal,
        ease,
        onComplete: () => {
          element.style.height = "";
          element.style.overflow = "";
        },
      },
    );
  }, [id, reduced]);

  return (
    <div ref={surface} className={cn("relative", className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <SwapLayer key={id}>{children}</SwapLayer>
      </AnimatePresence>
    </div>
  );
}

function SwapLayer({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      // Full width: popped out at its measured width, it keeps its lines.
      className="w-full"
      initial={{ opacity: 0 }}
      animate={{
        opacity: 1,
        transition: {
          duration: durations.fadeIn,
          delay: durations.fadeDelay,
          ease,
        },
      }}
      exit={{
        opacity: 0,
        transition: { duration: durations.fadeOut, ease },
      }}
      inert={!present || undefined}
      aria-hidden={!present || undefined}
    >
      {children}
    </motion.div>
  );
}
