import {
  AnimatePresence,
  type AnimationPlaybackControls,
  animate,
  motion,
  PresenceContext,
  useIsPresent,
} from "motion/react";
import {
  type ReactNode,
  type Ref,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "../../lib/cn";
import { durations, ease, useReducedMotionPref } from "../../lib/motion";

// How things appear, leave and change in place, the same everywhere
// (02 §12): nothing pops in or out, and nothing jumps.
//
// - Reveal: something there or not (a filter row, a notice). Its height
//   opens and closes with a fade; the gap its parent puts beside it opens
//   and closes with it, so the content around it moves continuously. The
//   parent is a flex column: a grid keeps the gap until the content is
//   gone, and the content around it jumps by the gap at the end.
// - Swap: one thing replaced by another in the same place (a list by
//   another, a skeleton by its content). The new one fades in over the old
//   one fading out, and the place changes height smoothly between them.

/** The box that lays the element out (display: contents is skipped). */
function layoutParent(element: HTMLElement | null) {
  let parent = element?.parentElement ?? null;
  while (parent && getComputedStyle(parent).display === "contents")
    parent = parent.parentElement;
  return parent;
}

/** The gap the parent lays out beside its children. */
function parentGap(probe: HTMLElement | null) {
  const parent = layoutParent(probe);
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

/** While developing: says so when a stack keeps the gap (a grid, see above). */
function warnGrid(element: HTMLElement | null, what: string) {
  if (!import.meta.env.DEV) return;
  const parent = layoutParent(element);
  if (
    parent &&
    getComputedStyle(parent).display.endsWith("grid") &&
    parentGap(element) > 0
  )
    console.warn(
      `${what} is in a grid with a gap, which jumps away when it closes: make the parent a flex column.`,
      parent,
    );
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
 * content goes, as a child of the column that spaces it (flex flex-col
 * gap-*): the gap opens and closes with it.
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
  // leaves (the probe is from the last commit), and only then: the edge
  // only shapes opening and closing, and read on every render it laid the
  // page out on each frame of a window resize.
  const probe = useRef<HTMLSpanElement>(null);
  const read = useRef<{ show: boolean; gap: number; top: boolean } | null>(
    null,
  );
  if (read.current?.show !== show)
    read.current = {
      show,
      gap: probe.current ? parentGap(probe.current) : 0,
      top: probe.current ? followsSibling(probe.current) : true,
    };
  const edge: Edge = { gap: read.current.gap, top: read.current.top, reduced };
  useLayoutEffect(() => warnGrid(probe.current, "Reveal"), []);
  return (
    <>
      <span
        ref={probe}
        aria-hidden="true"
        data-reveal=""
        className="absolute size-0"
      />
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
  // As Reveal's: read only as it opens or closes.
  const read = useRef<{ show: boolean; gap: number; start: boolean } | null>(
    null,
  );
  if (read.current?.show !== show)
    read.current = {
      show,
      gap: probe.current ? parentColumnGap(probe.current) : 0,
      start: probe.current ? followsSibling(probe.current) : true,
    };
  const edge: InlineEdge = {
    gap: read.current.gap,
    start: read.current.start,
    reduced,
  };
  return (
    <>
      <span
        ref={probe}
        aria-hidden="true"
        data-reveal=""
        className="absolute size-0"
      />
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
    // The size the observer measured: reading it again could lay the page
    // out once more, after another observer has changed it.
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize?.[0];
      height.current = box ? box.blockSize : element.offsetHeight;
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

// popLayout pops the leaving layer out of the flow through this ref: without
// it, the leaving and arriving layers would stack one under the other.
function SwapLayer({
  ref,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      // Full width: popped out at its measured width, it keeps its lines.
      className="w-full"
      // A true cross-fade: the same time and curve both ways, starting
      // together, so the two always add up to one (no dimmer moment
      // between them).
      initial={{ opacity: 0 }}
      animate={{
        opacity: 1,
        transition: { duration: durations.crossFade, ease },
      }}
      exit={{
        opacity: 0,
        transition: { duration: durations.crossFade, ease },
      }}
      inert={!present || undefined}
      aria-hidden={!present || undefined}
    >
      {children}
    </motion.div>
  );
}

/** Which side of a row its list's gap is on, and how wide (none when alone). */
function rowEdge(row: HTMLElement) {
  const gap = parentGap(row);
  if (followsSibling(row)) return { side: "marginTop", gap } as const;
  if (row.nextElementSibling) return { side: "marginBottom", gap } as const;
  return null;
}

/**
 * A row of a list that changes while it is shown (a poll brings one, one is
 * deleted): it opens in place and closes in place, its gap with it (the
 * list is a flex column, as Reveal's). Rows already there when the list
 * appears do not move — put the rows in <AnimatePresence initial={false}>.
 */
export function ListItem({
  children,
  className,
  layout = false,
}: {
  children: ReactNode;
  className?: string;
  /** Its list is reordered too: it slides to its new place. */
  layout?: boolean;
}) {
  const reduced = useReducedMotionPref();
  const present = useIsPresent();
  // A row there from the start is shown as it is (initial={false}).
  const arriving = useContext(PresenceContext)?.initial !== false;
  const row = useRef<HTMLLIElement>(null);
  // Arriving, it starts without its gap: motion starts the opening after
  // layout effects, from this margin.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as it arrives
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    warnGrid(element, "ListItem");
    const edge = arriving && !reduced ? rowEdge(element) : null;
    if (edge) element.style[edge.side] = `${-edge.gap}px`;
  }, []);
  // Read as it starts to close, when the row is still in its list.
  const variants = {
    gone: () => {
      const edge = row.current ? rowEdge(row.current) : null;
      return {
        height: 0,
        opacity: 0,
        ...(edge && { [edge.side]: -edge.gap }),
        overflow: "hidden",
        transition: {
          duration: reduced ? 0 : durations.collapse,
          ease,
          opacity: { duration: durations.fadeOut, ease },
        },
      };
    },
  };
  return (
    <motion.li
      ref={row}
      className={className}
      layout={layout && !reduced ? "position" : undefined}
      variants={variants}
      initial={{ height: 0, opacity: 0, overflow: "hidden" }}
      animate={{
        height: "auto",
        opacity: 1,
        marginTop: 0,
        marginBottom: 0,
        transition: {
          duration: reduced ? 0 : durations.reveal,
          ease,
          opacity: {
            duration: durations.fadeIn,
            delay: reduced ? 0 : durations.fadeDelay,
            ease,
          },
        },
        transitionEnd: { overflow: "visible" },
      }}
      exit="gone"
      inert={!present || undefined}
    >
      {children}
    </motion.li>
  );
}
