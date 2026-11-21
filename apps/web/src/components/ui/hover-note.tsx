import { AnimatePresence, motion } from "motion/react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { radius, Squircle, SquirclePlate } from "./squircle";

/** The note's least gap to the window's edge. */
const EDGE = 8;

/**
 * A short note that hangs under something small (a status tag): shown on
 * hover and on keyboard focus, and on a tap where there is no hover. The
 * note also describes the trigger, so it is read out with it.
 */
export function HoverNote({
  note,
  children,
  align = "end",
  tagRadius = 9,
}: {
  note: ReactNode;
  children: ReactNode;
  /** Which edge of the trigger the note lines up with. */
  align?: "start" | "end";
  /** The trigger's squircle radius (a StatusChip's by default). */
  tagRadius?: number;
}) {
  const id = useId();
  const reduced = useReducedMotionPref();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hover || focus || pinned;
  const wrap = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  // Kept 8px inside the window, as TagHint's bubble is: on a phone the
  // edit page's tag wraps to the left of its row, and a note lined up with
  // its right edge reached far past the window's left edge, cut off there
  // (sweep 2026-11-21). Measured before paint, so it never shows out of
  // place; it stays in the page, so it scrolls with the tag. Its width is
  // capped in CSS (a phone's window is the screen), so what is measured
  // here is what shows.
  useLayoutEffect(() => {
    if (!open) return;
    const at = wrap.current?.getBoundingClientRect();
    // offsetWidth leaves out the entry's scale.
    const width = bubble.current?.offsetWidth;
    if (!at || width === undefined) return;
    const box = (
      wrap.current?.closest("[data-window-layer]") ?? document.documentElement
    ).getBoundingClientRect();
    const natural = align === "end" ? at.right - width : at.left;
    const left = Math.min(
      Math.max(natural, box.left + EDGE),
      box.right - EDGE - width,
    );
    setShift(left - natural);
  }, [open, align]);

  // A tap doesn't focus a button on iPhone Safari, so no blur unpins the
  // note: a tap anywhere else does (sweep 2026-11-21).
  useEffect(() => {
    if (!pinned) return;
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node && wrap.current?.contains(event.target))
      )
        setPinned(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [pinned]);

  return (
    <span
      ref={wrap}
      className="relative inline-flex"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHover(true);
      }}
      onPointerLeave={() => setHover(false)}
    >
      {/* The tag's own shape, so the focus ring follows it. */}
      <Squircle radius={tagRadius}>
        <button
          type="button"
          aria-describedby={id}
          className="inline-flex cursor-help"
          onFocus={(event) => setFocus(event.target.matches(":focus-visible"))}
          onBlur={() => {
            setFocus(false);
            setPinned(false);
          }}
          onClick={() => setPinned((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              setFocus(false);
              setPinned(false);
              setHover(false);
            }
          }}
        >
          {children}
        </button>
      </Squircle>
      {/* Always in the DOM: it is the trigger's description. */}
      <span id={id} className="sr-only">
        {note}
      </span>
      <AnimatePresence>
        {open && (
          <motion.span
            key="note"
            ref={bubble}
            aria-hidden="true"
            className={`pointer-events-none absolute top-full z-30 mt-2 w-max max-w-[min(16rem,calc(100vw-1rem))] ${
              align === "end"
                ? "right-0 origin-top-right"
                : "left-0 origin-top-left"
            }`}
            initial={{
              opacity: 0,
              scale: reduced ? 1 : 0.96,
              y: reduced ? 0 : -2,
            }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.1 } }}
            transition={{ duration: reduced ? 0 : 0.14, ease }}
            style={{ x: shift }}
          >
            <SquirclePlate className="pop-plate" radius={radius.row} />
            <Squircle radius={radius.row}>
              <span className="glass-pop relative block px-3 py-2 text-left text-sm text-ink-2">
                {note}
              </span>
            </Squircle>
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
