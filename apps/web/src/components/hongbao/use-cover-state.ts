import {
  type AnimationPlaybackControls,
  animate,
  useIsPresent,
  useMotionValue,
} from "motion/react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

export type CoverState = "big" | "small";

/**
 * Content kept under the small cover: the page sits this far down whenever
 * the small cover shows, so it can always be scrolled back up to the big one.
 */
export const COVER_RESERVE = 32;

/**
 * The view's scroll container: the parent of the page's <article> (see
 * view-stage.tsx). Found from the cover's own element: on mount, layout
 * effects run before an ancestor's ref is attached.
 */
export const scrollerOf = (element: RefObject<HTMLElement | null>) =>
  element.current?.closest("article")?.parentElement ?? null;

/**
 * Which cover shows (docs/redesign/05 §12).
 *
 * - Not taken part: always the big cover, scrolling with the page.
 * - Taken part: the small cover, pinned under the bar, except at the very top
 *   of the page. Scrolling past COVER_RESERVE collapses it, back above 1px
 *   opens it again; the 31px between keeps trackpad jitter from flipping it.
 *   Nothing follows the scroll: each flip is one animation.
 * - Scroll-driven flips never write the scroll position (that would fight
 *   momentum).
 * - Entering the small cover by itself (the opening, switching to an account
 *   that took part) happens in two steps: pin the big cover and move the
 *   page to COVER_RESERVE behind a margin that holds the body still; then,
 *   in a later commit, flip. A flip never moves the page in the same commit,
 *   so the title's shared crossfade starts exactly where the title was.
 * - The claim on this page (the opening) first scrolls back to the top with
 *   the cover still unpinned, then collapses D + 0.26 s after the claim.
 */
export function useCoverState({
  opened,
  claimedAt,
  openDelay,
  reduced,
  anchorRef,
}: {
  opened: boolean;
  /** A claim made while this page is on screen: the opening plays. */
  claimedAt: number | null;
  openDelay: number;
  reduced: boolean;
  /** An element of the cover, to find the scroll container from. */
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState<CoverState>(opened ? "small" : "big");
  // Scrolling back to the top before the opening collapses the cover.
  const [gating, setGating] = useState(false);
  // A flip to the small cover waiting for the pin step (seconds to wait).
  const [pending, setPending] = useState<{
    after: number;
    opening: boolean;
  } | null>(null);
  // The current flip is the opening: slower, with its own easing.
  const [opening, setOpening] = useState(false);
  /** The margin under the frame that holds the body still while pinning. */
  const comp = useMotionValue(0);
  const present = useIsPresent();
  const stateRef = useRef(state);
  const gate = useRef<AnimationPlaybackControls | null>(null);
  const previous = useRef(opened);

  useLayoutEffect(() => {
    stateRef.current = state;
  });

  // Taking part (or a reset) changes which covers there are.
  useLayoutEffect(() => {
    if (previous.current === opened) return;
    previous.current = opened;
    gate.current?.stop();
    if (!opened) {
      setGating(false);
      setPending(null);
      setOpening(false);
      setState("big");
      return;
    }
    const scroller = scrollerOf(anchorRef);
    // Taken part elsewhere (say, switching accounts): just collapse.
    if (claimedAt === null) {
      setPending({ after: 0, opening: false });
      return;
    }
    if (reduced) {
      if (scroller) scroller.scrollTop = 0;
      setPending({ after: 0, opening: false });
      return;
    }
    // The fold starts D + 0.26s after the claim, however long the way up took.
    const enter = () => {
      setGating(false);
      setPending({
        after: Math.max(0, openDelay + 0.26 - (Date.now() - claimedAt) / 1000),
        opening: true,
      });
    };
    if (!scroller || scroller.scrollTop <= 0) {
      enter();
      return;
    }
    setGating(true);
    gate.current = animate(scroller.scrollTop, 0, {
      duration: 0.3,
      ease: [0.3, 0, 0.1, 1],
      onUpdate: (top) => {
        scroller.scrollTop = top;
      },
      onComplete: enter,
    });
  }, [opened, claimedAt, openDelay, reduced, anchorRef]);

  useEffect(() => () => gate.current?.stop(), []);

  // The pin step: the frame is sticky by now, so moving the page to
  // COVER_RESERVE only moves the body — which the margin holds still. Then
  // the flip, in its own commit.
  useLayoutEffect(() => {
    if (!pending) return;
    const scroller = scrollerOf(anchorRef);
    const top = scroller?.scrollTop ?? 0;
    if (scroller && top < COVER_RESERVE) {
      const offset = COVER_RESERVE - top;
      scroller.scrollTop = COVER_RESERVE;
      comp.jump(offset);
      if (anchorRef.current)
        anchorRef.current.style.marginBottom = `${offset}px`;
    }
    const flip = () => {
      const now = scrollerOf(anchorRef)?.scrollTop ?? COVER_RESERVE;
      setPending(null);
      // Scrolled back to the very top meanwhile: stay big, let go of the margin.
      if (now < 1 && stateRef.current === "big") {
        animate(comp, 0, { duration: reduced ? 0 : 0.2 });
        return;
      }
      setOpening(pending.opening && !reduced);
      setState("small");
    };
    if (pending.after > 0) {
      const timer = window.setTimeout(flip, pending.after * 1000);
      return () => window.clearTimeout(timer);
    }
    const frame = requestAnimationFrame(flip);
    return () => cancelAnimationFrame(frame);
  }, [pending, anchorRef, comp, reduced]);

  // Scroll position decides, once taken part. flushSync paints the flip in
  // the same frame as the scroll that caused it.
  useEffect(() => {
    const scroller = scrollerOf(anchorRef);
    if (!opened || gating || !present || !scroller) return;
    const onScroll = () => {
      const top = scroller.scrollTop;
      const next =
        stateRef.current === "big" && top > COVER_RESERVE
          ? "small"
          : stateRef.current === "small" && top < 1
            ? "big"
            : null;
      if (!next) return;
      flushSync(() => {
        setPending(null);
        setOpening(false);
        setState(next);
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [opened, gating, present, anchorRef]);

  /** The opening's flip has finished: later flips use the usual timing. */
  const settle = useCallback(() => setOpening(false), []);

  return {
    state,
    /** Pinned under the bar: taken part, and not on the way up. */
    pinned: opened && !gating,
    opening,
    comp,
    settle,
  };
}
