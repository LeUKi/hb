import { useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { windowDialogsAtom } from "../../lib/store";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";
import { WindowClip } from "./window-clip";
import { useWindowInfo } from "./window-info";

/** Inside a dialog's content: a dialog opened here stacks over it. */
const InsideDialog = createContext(false);

/**
 * A page's own dialog (a confirmation, a short form): the same frame as the
 * 红包's panels, laid over the whole window, but without a history entry —
 * it belongs to what the page is doing, so back still leaves the page.
 * Esc or the 压暗层 cancel (unless busy); the rest of the window is inert
 * meanwhile, and focus returns to where it was.
 */
export function WindowDialog({
  open,
  onClose,
  onClosed,
  labelledBy,
  busy = false,
  width = "28rem",
  initialFocus,
  nested = false,
  inert = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * After the exit animation, once focus is back. For a dialog whose
   * opener went away meanwhile (say 提前结束): put focus somewhere useful.
   */
  onClosed?: () => void;
  labelledBy: string;
  busy?: boolean;
  width?: string;
  /**
   * Where focus goes on opening, instead of the dialog itself (this runs
   * after the children's own effects, so they cannot set it themselves).
   */
  initialFocus?: () => HTMLElement | null | undefined;
  /** Opened from another dialog: drawn over it, its own 压暗层 covering it. */
  nested?: boolean;
  /** Another dialog is open over this one: this one waits. */
  inert?: boolean;
  children: ReactNode;
}) {
  // Opened from inside another dialog (a detail pane shown as one): drawn
  // over it, never beside it at the same level.
  const inside = useContext(InsideDialog);
  const stacked = nested || inside;
  const latestClosed = useRef(onClosed);
  latestClosed.current = onClosed;
  const latestFocus = useRef(initialFocus);
  latestFocus.current = initialFocus;
  const [host, setHost] = useState<HTMLElement | null>(null);
  const { compact } = useWindowInfo();
  const reduced = useReducedMotionPref();
  const panelRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setHost(document.querySelector<HTMLElement>("[data-window-layer]"));
  }, []);

  const setOpenCount = useSetAtom(windowDialogsAtom);
  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    // AppWindow makes the stage inert while any page dialog is open.
    setOpenCount((count) => count + 1);
    (latestFocus.current?.() ?? panelRef.current)?.focus({
      preventScroll: true,
    });
    return () => setOpenCount((count) => count - 1);
  }, [open, setOpenCount]);

  const cancel = () => {
    if (!busy) onClose();
  };
  const fade = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, transition: { duration: reduced ? 0 : 0.12 } },
    transition: { duration: reduced ? 0 : 0.18, ease },
  };

  if (!host) return null;
  return createPortal(
    <AnimatePresence
      onExitComplete={() => {
        const target = returnTo.current;
        if (target?.isConnected) target.focus({ preventScroll: true });
        latestClosed.current?.();
      }}
    >
      {open && (
        <>
          <WindowClip key="scrim">
            <motion.div
              aria-hidden="true"
              className={`scrim absolute inset-0 ${stacked ? "z-[60]" : "z-40"}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.22, ease }}
              onClick={cancel}
            />
          </WindowClip>
          <div
            key="frame"
            className={`pointer-events-none absolute inset-0 flex ${
              stacked ? "z-[70]" : "z-50"
            } ${
              compact
                ? "items-end p-2 pr-[max(0.5rem,var(--safe-right))] pb-[max(0.5rem,var(--safe-bottom))] pl-[max(0.5rem,var(--safe-left))]"
                : "items-center justify-center p-6 pr-[max(1.5rem,var(--safe-right))] pl-[max(1.5rem,var(--safe-left))]"
            }`}
          >
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={labelledBy}
              tabIndex={-1}
              inert={inert}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  // This dialog only, not one it was opened from.
                  event.preventDefault();
                  event.stopPropagation();
                  cancel();
                }
              }}
              className={`pointer-events-auto relative flex w-full flex-col outline-none ${
                compact ? "max-h-[85%]" : "max-h-[min(42rem,100%)]"
              }`}
              style={compact ? undefined : { maxWidth: width }}
              initial={
                compact
                  ? { y: reduced ? 0 : 24 }
                  : { scale: reduced ? 1 : 0.96 }
              }
              animate={compact ? { y: 0 } : { scale: 1 }}
              exit={{
                ...(compact
                  ? { y: reduced ? 0 : 16 }
                  : { scale: reduced ? 1 : 0.97 }),
                transition: { duration: reduced ? 0 : 0.12 },
              }}
              transition={{ duration: reduced ? 0 : 0.2, ease }}
            >
              <SquirclePlate
                className="pop-plate"
                radius={radius.pop}
                {...fade}
              />
              <Squircle radius={radius.pop}>
                <motion.div
                  className="glass-pop relative flex min-h-0 flex-1 flex-col overflow-y-auto"
                  {...fade}
                >
                  <InsideDialog.Provider value={true}>
                    {children}
                  </InsideDialog.Provider>
                </motion.div>
              </Squircle>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    host,
  );
}
