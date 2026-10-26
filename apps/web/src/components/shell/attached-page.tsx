// 附带网页 (docs/attached-page-design.md): on a 红包 page, the page its
// sender gave it, in a second window. On a wide screen the 红包 window
// narrows to the left — its layout follows the window, so it turns to the
// narrow one by itself — and the page opens on the right, in a window of
// the same make; it narrows, widens or hides (and stays loaded). On a
// narrow one it is a sheet pulled up from the bottom. The layout changes
// behind a passing blur, the windows' widths moving.
import { skipToken, useQuery } from "@tanstack/react-query";
import { atom, useAtom, useAtomValue } from "jotai";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Globe,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import {
  type CSSProperties,
  createContext,
  type HTMLAttributes,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { activityKeys, type PublicActivityDetail } from "../../lib/activities";
import { useCurrentActivityId } from "../../lib/activity-route";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { useIdentity } from "../../lib/session";
import { Button } from "../ui/button";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";

/**
 * The page held: the 红包 it is for and its address (null: none), open
 * beside the 红包 (or pulled up), loaded once asked, and the split. Off its
 * 红包's page (its 📝 page, the start page) it stays, hidden; another
 * 红包's page lets it go.
 */
type Held = {
  forId: string | null;
  url: string | null;
  open: boolean;
  loaded: boolean;
  mainWidth: number;
};
const heldAtom = atom<Held>({
  forId: null,
  url: null,
  open: false,
  loaded: false,
  mainWidth: 460,
});
/** Bumped to reload the page (刷新). */
const reloadAtom = atom(0);

/** Both windows with the line between them: wider than one, not endless. */
const SPLIT_MAX = 1680;
const MAIN_MIN = 380;
const SIDE_MIN = 360;
const GAP = 16;
/** The 红包 window's width when the page beside it is wide. */
const MAIN_BESIDE = 460;
const MOVE_MS = 520;
const MOVE = `${MOVE_MS}ms cubic-bezier(0.2, 0, 0, 1)`;

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

function useViewport() {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("resize", onChange);
      return () => window.removeEventListener("resize", onChange);
    },
    () => `${window.innerWidth}x${window.innerHeight}`,
  )
    .split("x")
    .map(Number) as [number, number];
}

const hostOf = (url: string) => new URL(url).hostname;

/** The 红包 page's 附带网页, from what that page has read (no read of its own). */
function useCurrentPage(activityId: string | null) {
  const userId = useIdentity().user?.id ?? null;
  const { data } = useQuery({
    queryKey: activityKeys.public(activityId ?? "", userId),
    queryFn: skipToken,
    select: (detail: PublicActivityDetail) => detail.activity.page ?? null,
  });
  return activityId ? (data ?? null) : null;
}

/** The 红包 window's frame as the layout sets it (AppWindow reads it). */
type Frame = {
  /** Its width beside the page; null: the frame's own (app-window-frame). */
  width: number | null;
  /** Its height above the sheet (narrow screens); null: the frame's own. */
  height: string | null;
  /** Moves on at each change of layout: the passing blur. */
  tick: number;
  /** While the widths move (not while dragged). */
  moving: boolean;
  /** While the 红包 window's height moves (the sheet came or went). */
  lifting: boolean;
  /** While the line between the windows is dragged: both stay blurred. */
  holding: boolean;
};
const FrameContext = createContext<Frame>({
  width: null,
  height: null,
  tick: 0,
  moving: false,
  lifting: false,
  holding: false,
});
export const useAttachedFrame = () => useContext(FrameContext);

/** The 红包 window frame's inline style. */
export function attachedFrameStyle(frame: Frame): CSSProperties {
  return {
    width: frame.width ?? undefined,
    height: frame.height ?? undefined,
    // Only what this change moves: a browser window dragged past 900 must
    // not leave the window's width trailing behind.
    transition:
      [frame.moving && `width ${MOVE}`, frame.lifting && `height ${MOVE}`]
        .filter(Boolean)
        .join(", ") || undefined,
  };
}

/**
 * A passing blur each time `tick` moves on (the layout changed), and one
 * held while `hold` (the line between the windows dragged), let go slowly:
 * a veil over the window whose backdrop-filter blurs what lies under it. A
 * filter on the window itself would fade its edges into the transparent
 * beyond them, a pale ring; a backdrop blur mirrors its edges instead. The
 * veil is only there while it blurs.
 */
export function MorphVeil({
  tick,
  hold = false,
  style,
  ...rest
}: { tick: number; hold?: boolean } & Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
>) {
  const reduced = useReducedMotionPref();
  const [pulse, setPulse] = useState(0);
  const [releasing, setReleasing] = useState(false);
  const [wasHeld, setWasHeld] = useState(hold);
  if (wasHeld !== hold) {
    setWasHeld(hold);
    if (!hold) setReleasing(true);
  }
  useEffect(() => {
    if (tick > 0 && !reduced) setPulse(tick);
  }, [tick, reduced]);
  if (reduced) return null;
  const veil = {
    "aria-hidden": true,
    "data-morph-veil": "",
    ...(rest as object),
    className: "pointer-events-none absolute inset-0 z-[100]",
    style,
  };
  if (hold || releasing)
    return (
      <motion.div
        key="held"
        {...veil}
        initial={{ backdropFilter: "blur(0px)" }}
        animate={{ backdropFilter: hold ? "blur(10px)" : "blur(0px)" }}
        transition={{ duration: hold ? 0.22 : 0.45, ease }}
        onAnimationComplete={() => {
          if (!hold) setReleasing(false);
        }}
      />
    );
  if (pulse === 0) return null;
  return (
    <motion.div
      key={`pulse-${pulse}`}
      {...veil}
      initial={{ backdropFilter: "blur(0px)" }}
      animate={{
        backdropFilter: ["blur(0px)", "blur(12px)", "blur(12px)", "blur(0px)"],
      }}
      transition={{
        duration: 0.68,
        times: [0, 0.22, 0.7, 1],
        ease: "easeInOut",
      }}
      onAnimationComplete={() => setPulse(0)}
    />
  );
}

/** Before it loads: whose page, and what loading it tells them. */
function NotLoaded({ host }: { host: string }) {
  const [, setHeld] = useAtom(heldAtom);
  return (
    <div className="grid h-full place-items-center overflow-y-auto p-6">
      <div className="grid max-w-72 justify-items-center gap-3 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-fill-2 text-ink-2">
          <Globe className="size-6" aria-hidden="true" />
        </span>
        <p className="text-base font-semibold text-ink">发红包的人的网页</p>
        <p className="font-mono text-sm break-all text-ink-2">{host}</p>
        <p className="text-xs text-ink-3">
          这是发红包的人提供的网页，不是本站的。加载以后，对方能看到你的 IP
          地址和浏览器信息。
        </p>
        <Button
          variant="primary"
          size="sm"
          className="mt-1"
          onClick={() => setHeld((current) => ({ ...current, loaded: true }))}
        >
          加载网页
        </Button>
      </div>
    </div>
  );
}

/**
 * What the page may do (§3, as freely as is safe, for those who build
 * on it): run, send forms, open windows (to log in), show its own
 * dialogs, download, lock the pointer and the screen's turn, go full
 * screen, write the clipboard, play sound and video, and ask (on a click)
 * for its own cookies (the Storage Access API). Never move this page away,
 * nor use the camera, the microphone, the place or payments (their prompts
 * would bear this site's name). It is told which 红包 page it is on.
 */
const PAGE_SANDBOX = [
  "allow-scripts",
  "allow-forms",
  "allow-same-origin",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-modals",
  "allow-downloads",
  "allow-pointer-lock",
  "allow-orientation-lock",
  "allow-presentation",
  "allow-storage-access-by-user-activation",
].join(" ");
const PAGE_FEATURES = [
  "fullscreen",
  "clipboard-write",
  "autoplay",
  "encrypted-media",
  "picture-in-picture",
  "web-share",
  "screen-wake-lock",
  "gamepad",
  "storage-access",
].join("; ");

/** The page itself: its own origin, never this site's; nothing here listens to it. */
function Page({ url }: { url: string }) {
  const reload = useAtomValue(reloadAtom);
  const { loaded } = useAtomValue(heldAtom);
  const host = hostOf(url);
  if (!loaded) return <NotLoaded host={host} />;
  return (
    <iframe
      key={`${url}-${reload}`}
      title={`${host} 的网页`}
      className="absolute inset-0 size-full border-0 bg-white"
      src={url}
      referrerPolicy="no-referrer-when-downgrade"
      allow={PAGE_FEATURES}
      sandbox={PAGE_SANDBOX}
    />
  );
}

function BarButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** Its title bar: always says whose page this is, and that it isn't ours. */
function TitleBar({
  host,
  children,
  onPointerDown,
}: {
  host: string;
  children: ReactNode;
  onPointerDown?: (event: ReactPointerEvent) => void;
}) {
  return (
    <div
      className="flex h-12 shrink-0 touch-none items-center gap-1 border-line border-b pr-2 pl-4"
      onPointerDown={onPointerDown}
    >
      <Globe className="mr-1 size-4 shrink-0 text-ink-3" aria-hidden="true" />
      <span className="grid min-w-0 flex-1 leading-tight">
        <span className="truncate font-mono text-sm font-medium text-ink">
          {host}
        </span>
        <span className="truncate text-[11px] text-ink-3">
          发红包的人提供的网页 · 不是本站
        </span>
      </span>
      {children}
    </div>
  );
}

/** Many sites refuse to be shown in another's page: there it opens whole. */
function OpenElsewhere({ url }: { url: string }) {
  return (
    <BarButton
      label="在新标签页打开"
      onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
    >
      <ArrowUpRight />
    </BarButton>
  );
}

function Reload() {
  const { loaded } = useAtomValue(heldAtom);
  const [, setReload] = useAtom(reloadAtom);
  if (!loaded) return null;
  return (
    <BarButton label="刷新" onClick={() => setReload((count) => count + 1)}>
      <RotateCw />
    </BarButton>
  );
}

/** Wide screens: the window beside the 红包's. */
function SideWindow({
  url,
  width,
  height,
  cornerRadius,
  open,
  frame,
  sideIsNarrow,
  onToggleWidth,
  onHide,
}: {
  url: string;
  width: number;
  height: number;
  cornerRadius: number;
  open: boolean;
  frame: Frame;
  sideIsNarrow: boolean;
  onToggleWidth: () => void;
  onHide: () => void;
}) {
  return (
    <div
      className="relative shrink-0"
      style={{
        height,
        width: open ? width : 0,
        marginLeft: open ? GAP : 0,
        opacity: open ? 1 : 0,
        transition: frame.moving
          ? `width ${MOVE}, margin-left ${MOVE}, opacity ${MOVE}`
          : undefined,
      }}
      aria-hidden={!open}
      inert={!open}
    >
      <SquirclePlate className="window-plate" radius={cornerRadius} />
      <Squircle radius={cornerRadius}>
        <div className="window-glass absolute inset-0 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 flex w-full flex-col"
            style={{ minWidth: SIDE_MIN }}
          >
            <TitleBar host={hostOf(url)}>
              <Reload />
              <OpenElsewhere url={url} />
              <BarButton
                label={sideIsNarrow ? "放宽" : "收窄"}
                onClick={onToggleWidth}
              >
                {sideIsNarrow ? <PanelRightOpen /> : <PanelRightClose />}
              </BarButton>
              <BarButton label="隐藏（不会卸载）" onClick={onHide}>
                <X />
              </BarButton>
            </TitleBar>
            <div className="relative min-h-0 flex-1 bg-white/60">
              <Page url={url} />
            </div>
          </div>
          <MorphVeil tick={frame.tick} hold={frame.holding} />
        </div>
      </Squircle>
    </div>
  );
}

/** Between the two windows: drag (or arrow keys) to move the line. */
function Divider({
  value,
  min,
  max,
  onChange,
  onDragging,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onDragging: (dragging: boolean) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const end = () => {
    start.current = null;
    onDragging(false);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a window splitter (WAI-ARIA) is a focusable separator; <hr> can't be one
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="拖动调整两个窗口的宽度"
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      className="group absolute top-1/2 z-10 grid h-28 w-4 -translate-x-1/2 -translate-y-1/2 cursor-col-resize touch-none place-items-center outline-none"
      onPointerDown={(event) => {
        start.current = { x: event.clientX, width: value };
        event.currentTarget.setPointerCapture(event.pointerId);
        onDragging(true);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        onChange(start.current.width + event.clientX - start.current.x);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 80 : 24;
        if (event.key === "ArrowLeft") onChange(value - step);
        else if (event.key === "ArrowRight") onChange(value + step);
        else return;
        event.preventDefault();
      }}
    >
      <span className="h-12 w-1 rounded-full bg-white/45 shadow-sm transition-[background-color,height] group-hover:h-16 group-hover:bg-white group-focus-visible:h-16 group-focus-visible:bg-white" />
    </div>
  );
}

/** How far the tab goes in under the 红包 window when it hides. */
const TAB_IN = -32;

/**
 * Hidden on a wide screen: a tab behind the 红包 window's edge brings the
 * page back. It slides out from under the edge once the layout has settled
 * (never over a blurred window), with a small bounce to be noticed; it
 * leans out under the pointer, gives under a press, and slides back in as
 * the windows part. Behind the window, the window's own dialogs and their
 * dimming never reach it.
 */
function EdgeTab({
  host,
  delay,
  onOpen,
}: {
  host: string;
  delay: number;
  onOpen: () => void;
}) {
  const reduced = useReducedMotionPref();
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      aria-label={`打开 ${host} 的网页`}
      title={`打开 ${host} 的网页`}
      initial={{ x: TAB_IN, opacity: 0 }}
      animate={{
        x: 0,
        opacity: 1,
        transition: reduced
          ? { duration: 0 }
          : {
              x: { type: "spring", stiffness: 420, damping: 15, delay },
              opacity: { duration: 0.12, delay },
            },
      }}
      whileHover={reduced ? undefined : { x: 5 }}
      whileTap={reduced ? undefined : { scale: 0.92, x: 2 }}
      exit={{
        x: TAB_IN,
        opacity: 0,
        transition: { duration: reduced ? 0 : 0.16, ease },
      }}
      className="glass-pop absolute top-1/2 left-0 flex -translate-y-1/2 flex-col items-center gap-2 rounded-2xl py-3 pr-2 pl-4 text-ink-2 hover:text-ink"
    >
      <Globe className="size-4" aria-hidden="true" />
      <span className="text-xs whitespace-nowrap [writing-mode:vertical-rl]">
        发红包的人的网页
      </span>
    </motion.button>
  );
}

const SHEET_PEEK = 68;
/** The sheet's handle and title bar. */
const SHEET_HEAD = 64;
type Stop = "peek" | "full";
const sheetStopAtom = atom<Stop>("peek");

/**
 * Phones: the page in a sheet pulled up from the bottom. Off a 红包 page
 * it goes below the screen, still loaded.
 */
function Sheet({
  url,
  shown,
  inset,
}: {
  url: string;
  shown: boolean;
  inset: number;
}) {
  const [, height] = useViewport();
  const reduced = useReducedMotionPref();
  const drag = useDragControls();
  const host = hostOf(url);
  const full = Math.round(height * 0.92);
  const [stop, go] = useAtom(sheetStopAtom);
  const offsetOf = (at: Stop) =>
    !shown ? full + 24 : at === "full" ? 0 : full - SHEET_PEEK;
  const up = shown && stop !== "peek";
  return (
    <>
      <AnimatePresence>
        {up && (
          <motion.div
            key="sheet-scrim"
            aria-hidden="true"
            className="fixed inset-0 z-30 bg-[rgb(30_0_6/0.28)] backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.28, ease }}
            onClick={() => go("peek")}
          />
        )}
      </AnimatePresence>
      <motion.div
        // A sheet sits on the screen's bottom edge: its lower corners
        // reach past it, out of sight, so only the top ones round.
        className="fixed z-40"
        style={{
          height: full + radius.window,
          bottom: -radius.window,
          left: inset,
          right: inset,
        }}
        initial={false}
        animate={{ y: offsetOf(stop) }}
        transition={
          reduced
            ? { duration: 0 }
            : { type: "spring", damping: 34, stiffness: 340 }
        }
        aria-hidden={!shown}
        inert={!shown}
        drag="y"
        dragListener={false}
        dragControls={drag}
        dragConstraints={{ top: 0, bottom: full - SHEET_PEEK }}
        dragElastic={0.08}
        dragMomentum={false}
        onDragEnd={(_, info) => {
          // Past halfway, or flicked, it goes the rest of the way.
          const at = offsetOf(stop) + info.offset.y;
          let next: Stop = at < (full - SHEET_PEEK) / 2 ? "full" : "peek";
          if (info.velocity.y > 500) next = "peek";
          if (info.velocity.y < -500) next = "full";
          go(next);
        }}
      >
        <SquirclePlate className="window-plate" radius={radius.window} />
        <Squircle radius={radius.window}>
          <div className="window-glass absolute inset-0 flex flex-col overflow-hidden select-none">
            <div
              aria-hidden="true"
              className="grid h-4 shrink-0 cursor-grab touch-none place-items-center"
              onPointerDown={(event) => drag.start(event)}
            >
              <span className="h-1 w-10 rounded-full bg-ink-3/40" />
            </div>
            <TitleBar host={host} onPointerDown={(event) => drag.start(event)}>
              <Reload />
              <BarButton
                label={up ? "收起" : "拉起"}
                onClick={() => go(up ? "peek" : "full")}
              >
                {up ? <ChevronDown /> : <ChevronUp />}
              </BarButton>
            </TitleBar>
            <div
              className="relative shrink-0 bg-white/60 select-text"
              style={{ height: full - SHEET_HEAD }}
            >
              <Page url={url} />
            </div>
          </div>
        </Squircle>
      </motion.div>
    </>
  );
}

/**
 * The 红包 window and, on a 红包 page with a 附带网页, the page beside it
 * (wide screens) or under it (narrow ones). Elsewhere the 红包 window is
 * as always; the page, once loaded, stays loaded, hidden, until another
 * 红包's page.
 */
export function AttachedPageLayout({ children }: { children: ReactNode }) {
  const activityId = useCurrentActivityId();
  const page = useCurrentPage(activityId);
  const [held, setHeld] = useAtom(heldAtom);
  const reduced = useReducedMotionPref();
  const wide = useMedia("(min-width: 900px) and (min-height: 560px)");
  const mid = useMedia("(min-width: 640px) and (min-height: 560px)");
  const roomy = useMedia("(min-width: 1024px) and (min-height: 560px)");
  const [vw, vh] = useViewport();
  // A 红包's page takes its own (or none); other pages keep what is held.
  const pageUrl = page?.url ?? null;
  useLayoutEffect(() => {
    if (activityId === null) return;
    setHeld((current) =>
      current.forId === activityId && current.url === pageUrl
        ? current
        : {
            forId: activityId,
            url: pageUrl,
            open: false,
            loaded: false,
            mainWidth: current.mainWidth,
          },
    );
  }, [activityId, pageUrl, setHeld]);
  const url = held.url;
  const onPage =
    url !== null && activityId !== null && held.forId === activityId;
  const split = onPage && wide && held.open;
  // The same sizes as app-window-frame; beside the page, the two windows
  // take the desktop's width, up to SPLIT_MAX.
  const alone = roomy ? Math.min(1200, vw - 64) : vw - 32;
  const frameHeight = roomy ? Math.min(940, vh - 64) : vh - 32;
  const cornerRadius = roomy ? radius.window : radius.windowMid;
  const both = Math.min(SPLIT_MAX, vw - (roomy ? 64 : 32));
  const maxMain = both - GAP - SIDE_MIN;
  const mainWidth = Math.max(MAIN_MIN, Math.min(held.mainWidth, maxMain));
  const sideWidth = both - GAP - mainWidth;
  const sideIsNarrow = sideWidth < SIDE_MIN + 40;

  // Each change of layout moves the widths behind a blur.
  const [tick, setTick] = useState(0);
  const [moving, setMoving] = useState(false);
  const [lifting, setLifting] = useState(false);
  const [dragging, setDragging] = useState(false);
  // On a narrow screen the 红包 window ends where the sheet begins; it
  // grows back, not jumps, when the sheet goes (leaving the 红包 page).
  const sheetBelow = onPage && !wide;
  const [last, setLast] = useState({ split, sheetBelow });
  if (last.split !== split || last.sheetBelow !== sheetBelow) {
    setLast({ split, sheetBelow });
    if (!reduced) {
      if (last.split !== split) {
        setTick((count) => count + 1);
        setMoving(true);
      }
      if (last.sheetBelow !== sheetBelow) setLifting(true);
    }
  }
  useEffect(() => {
    if (!moving && !lifting) return;
    const timer = window.setTimeout(() => {
      setMoving(false);
      setLifting(false);
    }, MOVE_MS + 80);
    return () => window.clearTimeout(timer);
  }, [moving, lifting]);
  const change = (update: () => void) => {
    if (!reduced) {
      setTick((count) => count + 1);
      setMoving(true);
    }
    update();
  };
  const setOpen = (open: boolean) =>
    change(() => setHeld((current) => ({ ...current, open })));

  const frame: Frame = {
    width: split ? mainWidth : null,
    height: !sheetBelow
      ? null
      : mid
        ? `calc(100dvh - ${16 + SHEET_PEEK + 8}px)`
        : `calc(100dvh - ${SHEET_PEEK - 20}px)`,
    tick,
    moving: moving && !dragging,
    lifting,
    holding: dragging,
  };
  return (
    <FrameContext.Provider value={frame}>
      <div
        className={`relative flex items-center justify-center ${sheetBelow ? (mid ? "mt-4 self-start" : "self-start") : ""}`}
      >
        {/* Before the windows: it lies under the 红包 window's edge. Back
            from beside the page, it waits until the layout has settled. */}
        <AnimatePresence>
          {onPage && wide && !held.open && (
            <div
              key="edge"
              className="absolute inset-y-0"
              style={{ left: alone - 12 }}
            >
              <EdgeTab
                host={hostOf(url)}
                delay={reduced ? 0 : moving ? (MOVE_MS + 260) / 1000 : 0.45}
                onOpen={() => setOpen(true)}
              />
            </div>
          )}
        </AnimatePresence>
        {children}
        {wide && url !== null && (
          <SideWindow
            url={url}
            width={sideWidth}
            height={frameHeight}
            cornerRadius={cornerRadius}
            open={split}
            frame={frame}
            sideIsNarrow={sideIsNarrow}
            onToggleWidth={() =>
              change(() =>
                setHeld((current) => ({
                  ...current,
                  mainWidth: sideIsNarrow ? MAIN_BESIDE : maxMain,
                })),
              )
            }
            onHide={() => setOpen(false)}
          />
        )}
        {/* The handle comes once both windows are in place, growing from
            its middle, and goes first; it follows the line when 收窄 or
            放宽 moves it. */}
        <AnimatePresence>
          {split && (
            <div
              key="divider"
              className="absolute inset-y-0"
              style={{
                left: mainWidth + GAP / 2,
                transition: frame.moving ? `left ${MOVE}` : undefined,
              }}
            >
              <motion.div
                className="absolute inset-y-0 left-0"
                initial={{ opacity: 0, scaleY: 0.3 }}
                animate={{
                  opacity: 1,
                  scaleY: 1,
                  transition: {
                    delay: reduced ? 0 : (MOVE_MS - 80) / 1000,
                    duration: reduced ? 0 : 0.28,
                    ease,
                  },
                }}
                exit={{
                  opacity: 0,
                  scaleY: 0.3,
                  transition: { duration: reduced ? 0 : 0.12 },
                }}
              >
                <Divider
                  value={mainWidth}
                  min={MAIN_MIN}
                  max={maxMain}
                  onChange={(width) =>
                    setHeld((current) => ({
                      ...current,
                      mainWidth: Math.max(MAIN_MIN, Math.min(width, maxMain)),
                    }))
                  }
                  onDragging={setDragging}
                />
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
      {!wide && url !== null && (
        <Sheet url={url} shown={onPage} inset={mid ? 16 : 0} />
      )}
    </FrameContext.Provider>
  );
}
