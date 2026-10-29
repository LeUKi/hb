import { AnimatePresence, motion } from "motion/react";
import {
  type ComponentPropsWithRef,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { radius, Squircle, SquirclePlate } from "./squircle";

const MAX_WIDTH = 240;
const HOVER_DELAY = 150;

/**
 * A tag that explains itself (the rule for contextual hints: they hang on
 * the tag). The hint shows while a mouse rests on it or keyboard focus is on
 * it; a tap toggles it. It lives in the window layer, above the tag (below
 * when there is no room), and goes with Esc, a tap elsewhere or a scroll.
 * Screen readers hear it as the tag's description, so the bubble itself is
 * hidden from them.
 */
export function TagHint({
  hint,
  children,
  width = MAX_WIDTH,
  ref,
  ...rest
}: {
  hint: string;
  children: ReactNode;
  /** How wide the bubble may grow (a longer explanation takes more). */
  width?: number;
} & Omit<ComponentPropsWithRef<"button">, "children" | "type">) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // A Squircle around the tag hands its shape (style) and its measuring ref
  // to this button, the element it wraps: both have to reach it.
  const setTrigger = useCallback(
    (node: HTMLButtonElement | null) => {
      trigger.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const descriptionId = useId();
  const pointer = useRef<string>("");
  const timer = useRef<number | undefined>(undefined);
  const clearTimer = () => window.clearTimeout(timer.current);
  // A hover that is still waiting must not open a bubble after unmount.
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <>
      <button
        {...rest}
        ref={setTrigger}
        type="button"
        aria-describedby={descriptionId}
        onPointerDown={(event) => {
          pointer.current = event.pointerType;
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          clearTimer();
          timer.current = window.setTimeout(() => setOpen(true), HOVER_DELAY);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "mouse") return;
          clearTimer();
          setOpen(false);
        }}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onClick={() => {
          // A mouse already has it on hover; a tap or a key toggles it.
          if (pointer.current === "mouse") return;
          setOpen((value) => !value);
        }}
      >
        {children}
      </button>
      {/* Beside the button, not in it: the tag's name stays its own words. */}
      <span id={descriptionId} className="sr-only">
        {hint}
      </span>
      <HintBubble
        open={open}
        anchor={trigger}
        hint={hint}
        width={width}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function HintBubble({
  open,
  anchor,
  hint,
  width,
  onClose,
}: {
  open: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  hint: string;
  width: number;
  onClose: () => void;
}) {
  const reduced = useReducedMotionPref();
  const bubble = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [place, setPlace] = useState<{
    x: number;
    y: number;
    above: boolean;
    room: number;
  }>();
  const [left, setLeft] = useState<number>();

  // Centred over the tag, inside the window; under it when there is no room.
  useLayoutEffect(() => {
    if (!open) return;
    const layer = document.querySelector<HTMLElement>("[data-window-layer]");
    const target = anchor.current;
    if (!layer || !target) return;
    setHost(layer);
    const box = layer.getBoundingClientRect();
    const at = target.getBoundingClientRect();
    const above = at.top - box.top > 96;
    setLeft(undefined);
    setPlace({
      x: at.left - box.left + at.width / 2,
      y: above ? at.top - box.top - 8 : at.bottom - box.top + 8,
      above,
      room: box.width,
    });
  }, [open, anchor]);

  // Once its size is known: under the tag when it does not fit above (a
  // long explanation), and 8px inside the window either way.
  useLayoutEffect(() => {
    if (!place || !bubble.current) return;
    const { offsetWidth: width, offsetHeight: height } = bubble.current;
    const target = anchor.current;
    if (place.above && place.y - height < 8 && host && target) {
      const box = host.getBoundingClientRect();
      setPlace({
        ...place,
        above: false,
        y: target.getBoundingClientRect().bottom - box.top + 8,
      });
      return;
    }
    setLeft(Math.min(Math.max(8, place.x - width / 2), place.room - width - 8));
  }, [place, host, anchor]);

  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    if (!open) return;
    const close = () => latestClose.current();
    const outside = (event: PointerEvent) => {
      if (
        !(
          event.target instanceof Node && anchor.current?.contains(event.target)
        )
      )
        close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, anchor]);

  if (!host) return null;
  return createPortal(
    <AnimatePresence>
      {open && place && (
        <motion.div
          key="hint"
          ref={bubble}
          aria-hidden="true"
          className="pointer-events-none absolute z-[60] w-max"
          style={{
            left: left ?? place.x,
            top: place.y,
            maxWidth: Math.min(width, place.room - 16),
            translateY: place.above ? "-100%" : 0,
            visibility: left === undefined ? "hidden" : "visible",
            transformOrigin: place.above ? "bottom center" : "top center",
          }}
          initial={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{
            opacity: 0,
            scale: reduced ? 1 : 0.97,
            transition: { duration: reduced ? 0 : 0.1 },
          }}
          transition={{ duration: reduced ? 0 : 0.14, ease }}
        >
          <SquirclePlate className="pop-plate" radius={radius.row} />
          <Squircle radius={radius.row}>
            <p className="glass-pop relative px-3 py-2 text-[13px] leading-5 text-pretty whitespace-pre-line text-ink-2">
              {hint}
            </p>
          </Squircle>
        </motion.div>
      )}
    </AnimatePresence>,
    host,
  );
}
