import { useLocation } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useSyncExternalStore } from "react";
import { useBootDone } from "../../lib/boot";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { windowDialogsAtom } from "../../lib/store";
import { Omnibox } from "../omnibox/omnibox";
import {
  editLinesAtom,
  omniboxMetrics,
  useOmniboxMode,
} from "../omnibox/state";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";
import { AccountCard, AuthErrorWatcher } from "./account-card";
import { KeyboardLayer } from "./keyboard";
import { useSlot, useSlotStage } from "./slots";
import { ViewStage } from "./view-stage";
import { WindowBar } from "./window-bar";
import { WindowClip } from "./window-clip";
import { useMeasuredWindow, WindowInfoProvider } from "./window-info";

// Breakpoints of the app-window-frame utility (and the boot frame).
const wideFrame = "(min-width: 1024px) and (min-height: 560px)";
const midFrame = "(min-width: 640px) and (min-height: 560px)";

function useMedia(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
  );
}

/** Corner radius for the current frame; a full-screen phone frame has none. */
function useFrameRadius() {
  const wide = useMedia(wideFrame);
  const mid = useMedia(midFrame);
  return wide ? radius.window : mid ? radius.windowMid : 0;
}

/** Where the expanded command box sits over the current view. */
function CommandSlot({ compact }: { compact: boolean }) {
  const slot = useSlot("command");
  const lines = useAtomValue(editLinesAtom);
  const metrics = omniboxMetrics(compact);
  return (
    <div
      ref={slot}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-x-0 mx-auto ${
        compact ? "w-[calc(100%-1rem)]" : "w-[min(40rem,calc(100%-3rem))]"
      }`}
      style={{
        top: compact
          ? "calc(0.5rem + var(--safe-top))"
          : "calc(clamp(4.5rem, 15cqh, 9rem) + var(--safe-top))",
        height: metrics.base + (lines - 1) * metrics.line,
      }}
    />
  );
}

/**
 * 跳到主要内容: the first stop for Tab, off the window until focused, then
 * over the 顶栏's corner. Enter puts focus on the page itself.
 */
function SkipLink() {
  return (
    <Squircle radius={radius.chip}>
      <button
        type="button"
        onClick={() => document.getElementById("view")?.focus()}
        className="glass-pop absolute top-3 left-3 z-50 flex h-10 items-center px-4 text-sm font-medium text-ink -translate-y-16 opacity-0 transition-[translate,opacity] duration-150 focus:translate-y-0 focus:opacity-100 reduce-motion:transition-none"
      >
        跳到主要内容
      </button>
    </Squircle>
  );
}

function Scrim() {
  const mode = useOmniboxMode();
  const reduced = useReducedMotionPref();
  const { collapse } = useOmniboxController();
  return (
    <AnimatePresence>
      {mode === "expanded" && (
        <WindowClip key="scrim">
          <motion.div
            aria-hidden="true"
            className="scrim absolute inset-0 z-20"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.24, ease }}
            onClick={collapse}
          />
        </WindowClip>
      )}
    </AnimatePresence>
  );
}

/** The app window: a fixed-size frame; everything scrolls inside it. */
export function AppWindow() {
  const windowRef = useRef<HTMLDivElement>(null);
  const frameRadius = useFrameRadius();
  const info = useMeasuredWindow(windowRef, frameRadius);
  const bootDone = useBootDone();
  const reduced = useReducedMotionPref();
  const stageRef = useSlotStage();
  const panelOpen = useLocation({
    select: (location) => Boolean(location.state.panel),
  });
  const dialogsOpen = useAtomValue(windowDialogsAtom) > 0;

  return (
    <WindowInfoProvider value={info}>
      {/* 窗口: the plate carries the long shadow the squircle clip would cut;
          the 玻璃层 and the 内容区 are two layers of exactly the same size.
          The 内容区 itself is not clipped: its full-window layers each clip
          themselves (WindowClip), so the 顶栏's blur can see the page. */}
      <div className="app-window-frame relative">
        <SquirclePlate className="window-plate" radius={frameRadius} />
        <WindowClip ring>
          <div aria-hidden="true" className="window-glass absolute inset-0" />
        </WindowClip>
        <div
          ref={windowRef}
          data-window-layer
          className="absolute inset-0 overflow-hidden [container:window/size]"
        >
          <motion.div
            ref={stageRef}
            data-window-stage
            className="absolute inset-0"
            initial={false}
            animate={
              bootDone
                ? { opacity: 1, y: 0 }
                : { opacity: 0, y: reduced ? 0 : 10 }
            }
            transition={{ duration: reduced ? 0 : 0.36, ease }}
            inert={panelOpen || dialogsOpen}
          >
            {/* The 顶栏 and the 指令框 come first, as they are seen and
                reached with Tab; the 内容区 still lies beneath them (they
                are stacked by z-index), so pages scroll under the bar. */}
            <SkipLink />
            <WindowBar />
            <CommandSlot compact={info.compact} />
            <Scrim />
            <Omnibox />
            <ViewStage />
          </motion.div>
          <AccountCard />
          <AuthErrorWatcher />
          <KeyboardLayer />
        </div>
      </div>
    </WindowInfoProvider>
  );
}
