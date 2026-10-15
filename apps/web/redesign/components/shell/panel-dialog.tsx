import { useLocation, useRouter } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { type FixtureActivity, findActivity } from "../../fixtures/activities";
import { useCurrentActivityId } from "../../lib/activity-route";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { closeOverlay, type Panel } from "../../lib/overlay";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";
import { useOverlayFocus } from "./use-overlay-focus";
import { WindowClip } from "./window-clip";
import { useWindowInfo } from "./window-info";

/**
 * The frame of a 红包's panels (名单弹窗, 说明弹窗): its own history entry,
 * like the 用户卡片 — back, Esc or the 压暗层 close it, and focus returns to
 * the control that opened it. Centred on a wide window; on a phone a sheet
 * floating 8px above the bottom. Keeps the last 红包 while animating out.
 */
export function PanelDialog({
  panel,
  triggerId,
  labelledBy,
  width = "30rem",
  children,
}: {
  panel: Exclude<Panel, "account">;
  triggerId: string;
  labelledBy: string;
  width?: string;
  children: (activity: FixtureActivity, close: () => void) => ReactNode;
}) {
  const open = useLocation({
    select: (location) => location.state.panel === panel,
  });
  const currentId = useCurrentActivityId();
  const router = useRouter();
  const { compact } = useWindowInfo();
  const reduced = useReducedMotionPref();
  const { panelRef, onExitComplete } = useOverlayFocus(open, triggerId);
  // Keep showing the last 红包 while the dialog animates out.
  const lastId = useRef<string | null>(null);
  const current = currentId ? findActivity(currentId) : null;
  if (open && current) lastId.current = current.id;
  const activity = lastId.current ? findActivity(lastId.current) : null;
  // An entry with nothing to show (say, restored on another page) would
  // leave the window inert behind an invisible dialog: drop it.
  const orphan = open && !current;
  useEffect(() => {
    if (orphan) closeOverlay(router);
  }, [orphan, router]);
  const close = () => closeOverlay(router);
  const fade = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, transition: { duration: reduced ? 0 : 0.12 } },
    transition: { duration: reduced ? 0 : 0.18, ease },
  };

  return (
    <AnimatePresence onExitComplete={onExitComplete}>
      {open && !orphan && activity && (
        <>
          <WindowClip key="scrim">
            <motion.div
              aria-hidden="true"
              className="scrim absolute inset-0 z-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.22, ease }}
              onClick={close}
            />
          </WindowClip>
          <div
            key="frame"
            className={`pointer-events-none absolute inset-0 z-50 flex ${
              compact ? "items-end p-2" : "items-center justify-center p-6"
            }`}
          >
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={labelledBy}
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
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
                  className="glass-pop relative flex min-h-0 flex-1 flex-col"
                  {...fade}
                >
                  {children(activity, close)}
                </motion.div>
              </Squircle>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
