import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { ease, useReducedMotionPref } from "../../lib/motion";
import {
  type ButtonSize,
  buttonHeight,
  buttonRadius,
  buttonVariants,
  useButtonShape,
} from "./button";
import { MorphLabel } from "./morph-label";
import { radius, Squircle, SquircleFill, SquirclePlate } from "./squircle";

export type SplitItem = { label: string; onSelect: () => void };

/**
 * A button with a menu beside its action (04 §4, 保存并开放 ▾): one face in
 * two halves, a thin line between them; the arrow opens a few more ways to
 * do it. The menu hangs in the window layer above the button (below when
 * there is no room), follows it, and goes with Esc (focus back on the
 * arrow), a press elsewhere or Tab.
 */
export function SplitButton({
  variant = "primary",
  size = "md",
  children,
  onClick,
  disabled = false,
  paused = false,
  menuLabel,
  items,
}: {
  variant?: "primary" | "secondary";
  size?: Exclude<ButtonSize, `icon${string}`>;
  /** The action's words (they may change in place). */
  children: ReactNode;
  onClick: () => void;
  /** Nothing to do now (greyed, still focusable). */
  disabled?: boolean;
  /** On its way (正在…): both halves wait, as they look. */
  paused?: boolean;
  /** The arrow's name for screen readers. */
  menuLabel: string;
  items: SplitItem[];
}) {
  const r = buttonRadius[size];
  const shape = useButtonShape(r, buttonHeight[size]);
  const [open, setOpen] = useState(false);
  const arrow = useRef<HTMLButtonElement>(null);
  const face = useRef<HTMLFieldSetElement>(null);
  const menuId = useId();
  const off = disabled || paused;
  return (
    <>
      <fieldset
        ref={face}
        className={cn(
          buttonVariants({ variant, size }),
          "split-button gap-0 px-0",
        )}
        style={shape}
        data-disabled={disabled || undefined}
      >
        <SquircleFill radius={r} />
        <button
          type="button"
          className="split-half h-full pr-3 pl-4.5"
          aria-disabled={off || undefined}
          onClick={() => {
            if (!off) onClick();
          }}
        >
          <MorphLabel>{children}</MorphLabel>
        </button>
        <span aria-hidden="true" className="split-line" />
        <button
          ref={arrow}
          type="button"
          className="split-half h-full w-10 justify-center"
          aria-label={menuLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-disabled={off || undefined}
          onClick={() => {
            if (!off) setOpen((value) => !value);
          }}
          onKeyDown={(event) => {
            if (off || (event.key !== "ArrowDown" && event.key !== "ArrowUp"))
              return;
            event.preventDefault();
            setOpen(true);
          }}
        >
          <ChevronDown aria-hidden="true" />
        </button>
      </fieldset>
      <SplitMenu
        id={menuId}
        open={open}
        anchor={face}
        arrow={arrow}
        items={items}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function SplitMenu({
  id,
  open,
  anchor,
  arrow,
  items,
  onClose,
}: {
  id: string;
  open: boolean;
  anchor: RefObject<HTMLFieldSetElement | null>;
  arrow: RefObject<HTMLButtonElement | null>;
  items: SplitItem[];
  onClose: () => void;
}) {
  const reduced = useReducedMotionPref();
  const menu = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [place, setPlace] = useState<{
    right: number;
    y: number;
    above: boolean;
  }>();

  // Its right edge on the button's, above it unless there is no room; it
  // follows the button while the page scrolls or the window changes (a
  // step's scroll may still be easing as it opens).
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const layer = document.querySelector<HTMLElement>("[data-window-layer]");
      const target = anchor.current;
      if (!layer || !target) return;
      setHost(layer);
      const box = layer.getBoundingClientRect();
      const at = target.getBoundingClientRect();
      const above = at.top - box.top > 160;
      setPlace({
        right: box.right - at.right,
        y: above ? at.top - box.top - 8 : at.bottom - box.top + 8,
        above,
      });
    };
    measure();
    document.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, anchor]);

  // The first item takes focus; arrows move between them.
  useEffect(() => {
    if (!open || !place) return;
    menu.current
      ?.querySelector<HTMLButtonElement>("[role=menuitem]")
      ?.focus({ preventScroll: true });
  }, [open, place]);

  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    if (!open) return;
    const close = (back: boolean) => {
      latestClose.current();
      if (back) arrow.current?.focus({ preventScroll: true });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (menu.current?.contains(target) || arrow.current?.contains(target))
      )
        return;
      close(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === "Tab") close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, arrow]);

  if (!host) return null;
  return createPortal(
    <AnimatePresence>
      {open && place && (
        <motion.div
          key="menu"
          ref={menu}
          className="absolute z-[60] w-max min-w-40"
          style={{
            right: place.right,
            top: place.y,
            translateY: place.above ? "-100%" : 0,
            transformOrigin: place.above ? "bottom right" : "top right",
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
          <SquirclePlate className="pop-plate" radius={radius.pop} />
          <Squircle radius={radius.pop}>
            <div
              id={id}
              role="menu"
              className="glass-pop relative grid p-1.5"
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                  return;
                event.preventDefault();
                const all = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "[role=menuitem]",
                  ),
                );
                const at = all.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  event.key === "ArrowDown"
                    ? (at + 1) % all.length
                    : (at - 1 + all.length) % all.length;
                all[next]?.focus();
              }}
            >
              {items.map((item) => (
                <Squircle key={item.label} radius={radius.row}>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex h-9 w-full items-center px-3 text-left text-sm text-ink transition-colors hover:bg-fill-2 focus-visible:bg-fill-2 focus-visible:outline-none"
                    onClick={() => {
                      latestClose.current();
                      arrow.current?.focus({ preventScroll: true });
                      item.onSelect();
                    }}
                  >
                    {item.label}
                  </button>
                </Squircle>
              ))}
            </div>
          </Squircle>
        </motion.div>
      )}
    </AnimatePresence>,
    host,
  );
}
