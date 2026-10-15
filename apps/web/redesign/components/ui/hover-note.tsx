import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useId, useState } from "react";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { radius, Squircle, SquirclePlate } from "./squircle";

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
  return (
    <span
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
            aria-hidden="true"
            className={`pointer-events-none absolute top-full z-30 mt-2 w-max max-w-64 ${
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
