// 附带网页 (docs/attached-page-design.md): on a 红包 page, the page its
// sender gave it, in a second window. On a wide screen the 红包 window
// narrows to the left — its layout follows the window, so it turns to the
// narrow one by itself — and the page opens on the right, in a window of
// the same make; it narrows, widens or hides (and stays loaded). On a
// narrow one it is a sheet pulled up from the bottom. The layout changes
// behind a passing blur, the windows' widths moving. Full screen, the
// page's window covers the whole page, the 红包 window still under it.
import { useLocation, useRouter } from "@tanstack/react-router";
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import {
  ArrowUpRight,
  ChevronUp,
  Globe,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
  X,
} from "lucide-react";
import {
  AnimatePresence,
  animate,
  motion,
  useDragControls,
  useMotionValue,
} from "motion/react";
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
import { useCachedQueryData } from "../../lib/cached-query";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { closeOverlay } from "../../lib/overlay";
import { askPageRisk, siteAccepted } from "../../lib/page-risk";
import { useIdentity } from "../../lib/session";
import { windowDialogsAtom } from "../../lib/store";
import { useOmniboxMode } from "../omnibox/state";
import { Button } from "../ui/button";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";
import { usePageBridge } from "./page-bridge";

/**
 * The page held: the 红包 it is for and its address (null: none), open
 * beside the 红包 (or pulled up), loaded once first opened, and the split. Off its
 * 红包's page (its 📝 page, the start page) it stays, hidden; another
 * 红包's page lets it go.
 */
type Held = {
  forId: string | null;
  url: string | null;
  /** The 红包 author's LINUX DO username: whose page this is. */
  author: string | null;
  open: boolean;
  loaded: boolean;
  mainWidth: number;
};
const heldAtom = atom<Held>({
  forId: null,
  url: null,
  author: null,
  open: false,
  loaded: false,
  mainWidth: 460,
});
/** Bumped to reload the page (刷新). */
const reloadAtom = atom(0);
/**
 * Asked from the 红包 page (附带网页 under 分享, the cover's tag, a note's
 * button): `n` moves on with each ask, `open` says which way.
 */
const requestAtom = atom({ n: 0, open: true });
/**
 * The page's window covers the whole page (wide screens, open beside the
 * 红包 window only): nothing of the 背景 shows.
 */
export const pageFullAtom = atom(false);

/** Wide enough for the page beside the 红包 window. */
const WIDE = "(min-width: 900px) and (min-height: 560px)";

/**
 * The page of the 红包 page shown, when it has one: open beside it on a
 * wide screen, or its sheet pulled up on a narrow one.
 */
export function useAttachedPageOpener() {
  const activityId = useCurrentActivityId();
  const held = useAtomValue(heldAtom);
  const stop = useAtomValue(sheetStopAtom);
  const wide = useMedia(WIDE);
  const request = useSetAtom(requestAtom);
  const available =
    held.url !== null && activityId !== null && held.forId === activityId;
  const isOpen = available && (wide ? held.open : stop === "full");
  const ask = (open: boolean) =>
    request((current) => ({ n: current.n + 1, open }));
  return {
    available,
    isOpen,
    open: () => ask(true),
    toggle: () => ask(!isOpen),
  };
}

/**
 * The 红包 whose page this browser left open beside it, newest last (the
 * page opens there again on the next visit, docs/attached-page-design.md
 * §2.2). Only this browser's: nothing is sent anywhere.
 */
const REMEMBERED = "hb.attached-page";
const REMEMBERED_MAX = 50;

const rememberedOpen = () => rememberedIds(REMEMBERED);

/**
 * The 红包 whose page the viewer closed (beside it, the sheet pulled back,
 * or 取消 at 打开附带网页？): one that opens by itself does not again
 * (§2.7) until opened by hand.
 */
const CLOSED = "hb.attached-page-closed";

function rememberedIds(key: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

const rememberedClosed = () => rememberedIds(CLOSED);

function rememberOpen(activityId: string, open: boolean) {
  try {
    const keep = (key: string, on: boolean) => {
      const rest = rememberedIds(key).filter((id) => id !== activityId);
      localStorage.setItem(
        key,
        JSON.stringify(
          on ? [...rest, activityId].slice(-REMEMBERED_MAX) : rest,
        ),
      );
    };
    keep(REMEMBERED, open);
    keep(CLOSED, !open);
  } catch {
    // Not kept (a private window): next time it starts hidden.
  }
}

/** Both windows with the line between them: wider than one, not endless. */
const SPLIT_MAX = 1680;
const MAIN_MIN = 380;
const SIDE_MIN = 360;
const GAP = 16;
/** The 红包 window's width when the page beside it is wide. */
const MAIN_BESIDE = 460;
/** Dragged this far past its end, the line closes the page on letting go. */
const PULL_CLOSE = 96;
/** How much of a pull past the end the windows give (rubber). */
const pullGive = (pull: number) => Math.min(pull, 240) * 0.35;
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

/**
 * The 红包 page's 附带网页 and its author's username, from what that page
 * has read (no read of its own).
 */
function useCurrentPage(activityId: string | null) {
  const userId = useIdentity().user?.id ?? null;
  // Not as one of its readers: their options become the query's.
  const activity = useCachedQueryData<PublicActivityDetail>(
    activityId ? activityKeys.public(activityId, userId) : null,
  )?.activity;
  return activity?.page
    ? {
        url: activity.page.url,
        author: activity.author.username,
        autoOpen: activity.page.autoOpen === true,
      }
    : null;
}

/** Opens by itself as its 红包 page is entered (§2.7), unless closed before. */
const opensByItself = (activityId: string, autoOpen: boolean) =>
  autoOpen && !rememberedClosed().includes(activityId);

/** Whose page this is, said wherever it is named. */
const fromLine = (author: string | null) =>
  author ? `来自 @${author} 的红包` : "红包作者附带的网页";

/** The page's mark wherever it is named: a globe on the 红包's red. */
function PageMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-white shadow-sm"
    >
      <Globe className="size-4" />
    </span>
  );
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
  /** Under the page's window gone full screen: where it was, out of reach. */
  covered: boolean;
};
const FrameContext = createContext<Frame>({
  width: null,
  height: null,
  tick: 0,
  moving: false,
  lifting: false,
  holding: false,
  covered: false,
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
 * veil is only there while it blurs. A change of layout that comes as a
 * hold is let go (the line dragged past its end and released, closing the
 * page) carries the held blur on: it stays until the windows are in place,
 * never clearing and blurring again on the way.
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
  const [pulse, setPulse] = useState({ n: 0, carried: false });
  const [releasing, setReleasing] = useState(false);
  // From tick 0: mounted after a change (the page window coming with the
  // layout), it still passes.
  const [seen, setSeen] = useState({ tick: 0, hold });
  if (seen.tick !== tick || seen.hold !== hold) {
    setSeen({ tick, hold });
    if (tick !== seen.tick && tick > 0 && !hold) {
      setPulse({ n: tick, carried: seen.hold || releasing });
      setReleasing(false);
    } else if (seen.hold && !hold) setReleasing(true);
  }
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
  if (pulse.n === 0) return null;
  const from = pulse.carried ? "blur(10px)" : "blur(0px)";
  return (
    <motion.div
      key={`pulse-${pulse.n}`}
      {...veil}
      initial={{ backdropFilter: from }}
      animate={{
        backdropFilter: [from, "blur(12px)", "blur(12px)", "blur(0px)"],
      }}
      transition={{
        duration: 0.68,
        times: [0, 0.22, 0.7, 1],
        ease: "easeInOut",
      }}
      onAnimationComplete={() => setPulse({ n: 0, carried: false })}
    />
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

/**
 * The page itself: its own origin, never this site's; only what the SDK
 * asks is heard from it (page-bridge.ts). It loads the first time it is
 * opened (beside the 红包, or the sheet pulled up), not before: only then
 * does its site learn of the visit (the title bar says so), and then it
 * stays.
 */
function Page({ url, active }: { url: string; active: boolean }) {
  const reload = useAtomValue(reloadAtom);
  const [{ loaded, author }, setHeld] = useAtom(heldAtom);
  const store = useStore();
  const request = useSetAtom(requestAtom);
  useEffect(() => {
    if (!active || loaded) return;
    const site = hostOf(url);
    if (siteAccepted(site)) {
      setHeld((current) => ({ ...current, loaded: true }));
      return;
    }
    // 打开附带网页？ (§2.5) over the 红包 window — on a phone the sheet
    // steps aside for it — answered whenever it comes, while this page is
    // still the one held; then back where it was asked: open, or not.
    void askPageRisk(store, { site, author }).then((open) => {
      const now = store.get(heldAtom);
      if (now.url !== url) return;
      if (open) setHeld((current) => ({ ...current, loaded: true }));
      // 取消 is the viewer closing it (§2.7).
      else if (now.forId !== null) rememberOpen(now.forId, false);
      request((current) => ({ n: current.n + 1, open }));
    });
  }, [active, loaded, url, author, setHeld, store, request]);
  if (!loaded) return null;
  return <PageFrame key={`${url}-${reload}`} url={url} />;
}

/** The frame, clear until its page has loaded (a spinner under it). */
function PageFrame({ url }: { url: string }) {
  const [ready, setReady] = useState(false);
  const host = hostOf(url);
  const frame = useRef<HTMLIFrameElement>(null);
  usePageBridge(frame, url, useAtomValue(heldAtom).forId);
  return (
    <>
      {!ready && (
        <div className="absolute inset-0 grid place-items-center text-ink-3">
          <LoaderCircle
            className="size-5 motion-safe:animate-spin"
            aria-label="正在加载"
          />
        </div>
      )}
      <iframe
        ref={frame}
        title={`${host} 的网页`}
        className={`absolute inset-0 size-full border-0 ${ready ? "bg-white" : ""}`}
        src={url}
        onLoad={() => setReady(true)}
        referrerPolicy="no-referrer-when-downgrade"
        allow={PAGE_FEATURES}
        sandbox={PAGE_SANDBOX}
      />
    </>
  );
}

/** The title bar's buttons: as large as the 顶栏's beside the 红包 window. */
const BarSize = createContext<"icon-xs" | "icon-sm">("icon-xs");

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
      size={useContext(BarSize)}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/**
 * Beside the 红包 window, its title bar: whose 红包 the page comes from and
 * its address, as tall as the 红包 window's 顶栏, its tops in line. The
 * notice under it says the rest.
 */
function TitleBar({
  host,
  author,
  children,
}: {
  host: string;
  author: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex h-16 shrink-0 items-center gap-3 border-line border-b pr-3 pl-5">
      <PageMark />
      <span className="grid min-w-0 flex-1 gap-0.5 leading-tight">
        <span className="truncate text-sm font-semibold text-ink">
          {fromLine(author)}
        </span>
        <span className="truncate font-mono text-xs text-ink-3">{host}</span>
      </span>
      <BarSize.Provider value="icon-sm">
        {/* Each button 12px after the last (Fold), the first after the text. */}
        <span className="-ml-3 flex shrink-0 items-center">{children}</span>
      </BarSize.Provider>
    </div>
  );
}

/**
 * One of the title bar's buttons (36 wide, 12 after the last): one that
 * goes, going full screen, folds away, the rest closing up, not popping
 * out; coming back, it opens again.
 */
function Fold({
  shown = true,
  children,
}: {
  shown?: boolean;
  children: ReactNode;
}) {
  const reduced = useReducedMotionPref();
  return (
    <AnimatePresence initial={false}>
      {shown && (
        <motion.span
          className="flex shrink-0 justify-end overflow-hidden"
          initial={{ width: 0, marginLeft: 0, opacity: 0 }}
          animate={{ width: 36, marginLeft: 12, opacity: 1 }}
          exit={{ width: 0, marginLeft: 0, opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.26, ease }}
        >
          {children}
        </motion.span>
      )}
    </AnimatePresence>
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
  author,
  width,
  height,
  cornerRadius,
  open,
  frame,
  sideIsNarrow,
  closing,
  full,
  veilTick,
  onToggleWidth,
  onToggleFull,
  onHide,
}: {
  url: string;
  author: string | null;
  width: number;
  height: number;
  cornerRadius: number;
  open: boolean;
  frame: Frame;
  sideIsNarrow: boolean;
  /** The line is dragged past its end: let go and the page closes. */
  closing: boolean;
  /** Over the whole page, the 红包 window still where it was under it. */
  full: boolean;
  /** Its own passing blur: each change of layout, and full screen. */
  veilTick: number;
  onToggleWidth: () => void;
  onToggleFull: () => void;
  onHide: () => void;
}) {
  const reduced = useReducedMotionPref();
  const { loaded } = useAtomValue(heldAtom);
  // Full screen, the window reaches from its place in the row (kept, so
  // nothing beside it moves) to the page's edges: where that place is,
  // read as it goes (its first frame already starts from there) and again
  // as the browser window changes.
  const place = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x: 0, y: 0 });
  const readPlace = () => {
    const box = place.current?.getBoundingClientRect();
    if (box)
      setAt((current) =>
        current.x === box.left && current.y === box.top
          ? current
          : { x: box.left, y: box.top },
      );
  };
  // Each render while full screen (the layout renders it again as the
  // browser window is resized), before it is painted.
  useLayoutEffect(() => {
    if (full) readPlace();
  });
  // Its corners square off as it reaches the edges, and round again.
  const corner = useMotionValue(cornerRadius);
  const moving = frame.moving;
  useEffect(() => {
    const to = full ? 0 : cornerRadius;
    if (reduced || !moving) {
      corner.set(to);
      return;
    }
    const controls = animate(corner, to, {
      duration: MOVE_MS / 1000,
      ease: [0.2, 0, 0, 1],
    });
    return () => controls.stop();
  }, [full, cornerRadius, reduced, moving, corner]);
  return (
    // Over all of the 红包 window's parts (they stack with the desktop's:
    // the 指令框, its dialogs, its passing blur at 100), which only meet it
    // full screen.
    <div
      ref={place}
      className="relative z-[120] shrink-0"
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
      <div
        className="absolute"
        style={{
          ...(full
            ? { left: -at.x, top: -at.y, width: "100vw", height: "100dvh" }
            : { left: 0, top: 0, width: "100%", height: "100%" }),
          transition: moving
            ? `left ${MOVE}, top ${MOVE}, width ${MOVE}, height ${MOVE}`
            : undefined,
        }}
      >
        <SquirclePlate className="window-plate" radius={corner} />
        <Squircle radius={corner}>
          <div className="window-glass absolute inset-0 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 flex w-full flex-col"
              style={{ minWidth: SIDE_MIN }}
            >
              <TitleBar host={hostOf(url)} author={author}>
                <Fold shown={loaded}>
                  <Reload />
                </Fold>
                {/* Full screen, only what is for the page itself stays. */}
                <Fold shown={!full}>
                  <OpenElsewhere url={url} />
                </Fold>
                <Fold shown={!full}>
                  <BarButton
                    label={sideIsNarrow ? "放宽" : "收窄"}
                    onClick={onToggleWidth}
                  >
                    {sideIsNarrow ? <PanelRightOpen /> : <PanelRightClose />}
                  </BarButton>
                </Fold>
                <Fold>
                  <BarButton
                    label={full ? "退出全屏" : "全屏"}
                    onClick={() => {
                      if (!full) readPlace();
                      onToggleFull();
                    }}
                  >
                    <motion.span
                      key={full ? "leave" : "enter"}
                      className="grid"
                      initial={{ opacity: 0, scale: reduced ? 1 : 0.6 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: reduced ? 0 : 0.2, ease }}
                    >
                      {full ? <Minimize2 /> : <Maximize2 />}
                    </motion.span>
                  </BarButton>
                </Fold>
                <Fold shown={!full}>
                  <BarButton label="隐藏（不会卸载）" onClick={onHide}>
                    <X />
                  </BarButton>
                </Fold>
              </TitleBar>
              {/* While the line is dragged the page takes no pointer: over
                its frame the moves would go to it, not to the line. */}
              <div
                className={`relative min-h-0 flex-1 bg-white/60 ${
                  frame.holding ? "pointer-events-none" : ""
                }`}
              >
                <Page url={url} active={open} />
              </div>
            </div>
            <MorphVeil tick={veilTick} hold={frame.holding} />
            {/* Dragged past its end: the whole window under a red blur. */}
            <AnimatePresence>
              {closing && (
                <motion.div
                  key="closing"
                  role="status"
                  className="absolute inset-0 z-[110] grid place-items-center bg-[rgb(176_18_40/0.45)] text-white backdrop-blur-md backdrop-saturate-150"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduced ? 0 : 0.16, ease }}
                >
                  <span className="grid justify-items-center gap-3 px-6 text-center">
                    <motion.span
                      className="grid size-14 place-items-center rounded-full bg-white/20 ring-1 ring-white/50"
                      initial={{ scale: reduced ? 1 : 0.6 }}
                      animate={{ scale: 1 }}
                      transition={
                        reduced
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 520, damping: 22 }
                      }
                    >
                      <X className="size-7" aria-hidden="true" />
                    </motion.span>
                    <span className="text-base font-semibold">
                      松手关闭网页
                    </span>
                    <span className="text-xs text-white/80">
                      往回拖可以取消
                    </span>
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </Squircle>
      </div>
    </div>
  );
}

/** Between the two windows: drag (or arrow keys) to move the line. */
function Divider({
  value,
  min,
  max,
  armed,
  onChange,
  onDragging,
}: {
  value: number;
  min: number;
  max: number;
  /** Dragged past its end: the page closes on letting go. */
  armed: boolean;
  /** The width asked for, not held to min and max. */
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
      aria-valuenow={Math.round(Math.min(value, max))}
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
      <span
        className={`h-12 w-1 rounded-full shadow-sm transition-[background-color,height] group-hover:h-16 group-focus-visible:h-16 ${armed ? "h-16 bg-danger" : "bg-white/45 group-hover:bg-white group-focus-visible:bg-white"}`}
      />
    </div>
  );
}

const SHEET_PEEK = 68;
type Stop = "peek" | "full";
const sheetStopAtom = atom<Stop>("peek");
/**
 * The sheet has stepped aside for the 红包 window's dialog: it is below the
 * screen, and the window reaches the screen's bottom until it is back.
 */
const sheetAwayAtom = atom(false);

/**
 * The sheet's head, the same down and up (2026-10-26, the user: the icon
 * shrank, the address jumped, the buttons popped in and the colours
 * snapped): the mark and the address stay where they are; only the line
 * above the address changes, sliding (上拉查看附带网页 ↔ whose 红包 it comes
 * from); the arrow turns over; 刷新 and 在新标签页打开 open beside it; the
 * line under the head fades in. Down, all of it pulls the sheet up; up, it
 * lets it down.
 */
function SheetHeader({
  url,
  host,
  author,
  up,
  onToggle,
  onPointerDown,
}: {
  url: string;
  host: string;
  author: string | null;
  up: boolean;
  onToggle: () => void;
  onPointerDown: (event: ReactPointerEvent) => void;
}) {
  const reduced = useReducedMotionPref();
  const shift = reduced ? 0 : 10;
  const turn = { duration: reduced ? 0 : 0.26, ease };
  // A button up only: it opens from nothing beside the arrow.
  const grow = {
    className: "flex shrink-0 justify-center overflow-hidden",
    initial: { width: 0, opacity: 0 },
    animate: { width: 32, opacity: 1 },
    exit: { width: 0, opacity: 0 },
    transition: turn,
  };
  return (
    <div
      className={`flex h-12 shrink-0 touch-none items-center gap-1 pr-2 pl-4 transition-[box-shadow] duration-200 ${
        up
          ? "shadow-[inset_0_-1px_0_var(--color-line)]"
          : "shadow-[inset_0_-1px_0_transparent]"
      }`}
      onPointerDown={onPointerDown}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={up}
        aria-label={up ? "收起" : `上拉查看附带网页：${host}`}
        className="flex min-w-0 flex-1 items-center gap-3 self-stretch text-left"
      >
        <PageMark />
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="relative grid h-5 overflow-hidden">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={up ? "from" : "pull"}
                className="truncate text-sm font-semibold text-ink"
                initial={{ opacity: 0, y: up ? shift : -shift }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: up ? -shift : shift }}
                transition={turn}
              >
                {up ? fromLine(author) : "上拉查看附带网页"}
              </motion.span>
            </AnimatePresence>
          </span>
          <span className="truncate font-mono text-xs text-ink-3">{host}</span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {up && (
          <motion.span key="reload" {...grow}>
            <Reload />
          </motion.span>
        )}
        {up && (
          <motion.span key="open" {...grow}>
            <OpenElsewhere url={url} />
          </motion.span>
        )}
      </AnimatePresence>
      {/* The same toggle, for a thumb at the edge; the head says it. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onToggle}
        className="grid size-8 shrink-0 place-items-center text-accent"
      >
        {/* Down, it nods up: a CSS animation, on the compositor (driven
            from script it ran a frame of work for as long as it showed). */}
        <span className={`grid ${up ? "" : "hb-nudge-up"}`}>
          <motion.span
            className="grid"
            animate={{ rotate: up ? 180 : 0 }}
            transition={turn}
          >
            <ChevronUp className="size-5" />
          </motion.span>
        </span>
      </button>
    </div>
  );
}

/**
 * Something of the 红包 window's dims the whole screen: one of its dialogs
 * (名单弹窗, 用户卡片, a confirmation) or its expanded 指令框.
 */
function useWindowCovered() {
  const panel = useLocation({
    select: (location) => Boolean(location.state.panel),
  });
  const dialogs = useAtomValue(windowDialogsAtom) > 0;
  const omnibox = useOmniboxMode() === "expanded";
  return panel || dialogs || omnibox;
}

/**
 * Phones: the page in a sheet pulled up from the bottom. It comes up from
 * below with a bounce and, once, nods up as if pulled, until touched. Off
 * a 红包 page it goes below the screen, still loaded. While the 红包
 * window's dialog is open it steps aside, below the screen, and the window
 * reaches the bottom: the dialog's 压暗层 alone covers the screen, one blur
 * (a 压暗层 of the sheet's own blurred only the sheet, a block of its own).
 * The window grows and shrinks under the sheet, out of sight.
 */
function Sheet({
  url,
  author,
  shown,
  inset,
}: {
  url: string;
  author: string | null;
  shown: boolean;
  inset: number;
}) {
  const [, height] = useViewport();
  const reduced = useReducedMotionPref();
  const drag = useDragControls();
  const host = hostOf(url);
  const full = Math.round(height * 0.92);
  const [stop, go] = useAtom(sheetStopAtom);
  const forId = useAtomValue(heldAtom).forId;
  // The viewer's own moves: pulled back is closed, for a 红包 that opens
  // by itself (§2.7); pulled up, open again.
  const settle = (next: Stop) => {
    if (forId !== null && next !== stop) rememberOpen(forId, next === "full");
    go(next);
  };
  const covered = useWindowCovered() && shown;
  const setAway = useSetAtom(sheetAwayAtom);
  // Until it is touched (or a dialog has come over it), it nods up once
  // after coming in.
  const [touched, setTouched] = useState(false);
  // Before the frame is painted: the window reaches down while the sheet
  // still covers the bottom.
  useLayoutEffect(() => {
    if (!covered) return;
    go("peek");
    setAway(true);
    setTouched(true);
  }, [covered, go, setAway]);
  const hidden = !shown || covered;
  const offsetOf = (at: Stop) =>
    hidden ? full + 24 : at === "full" ? 0 : full - SHEET_PEEK;
  const up = !hidden && stop !== "peek";
  const target = offsetOf(stop);
  // Only coming onto the 红包 page bounces: back from a dialog, pulled or
  // let go, a bounce would show the screen's edge under the sheet.
  const [lastShown, setLastShown] = useState(shown);
  const [rising, setRising] = useState(shown);
  if (lastShown !== shown) {
    setLastShown(shown);
    setRising(shown);
  }
  // A drag ends in a click too: that click is not a tap.
  const dragged = useRef(false);
  const nod = !hidden && stop === "peek" && !touched && !reduced;
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
            onClick={() => settle("peek")}
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
        initial={{ y: full + 24 }}
        animate={{ y: target }}
        transition={
          reduced
            ? { duration: 0 }
            : rising
              ? { type: "spring", damping: 14, stiffness: 260 }
              : { type: "spring", damping: 34, stiffness: 340 }
        }
        onAnimationComplete={() => {
          setRising(false);
          // Back in place: the window ends above it again, under it.
          if (!covered) setAway(false);
        }}
        aria-hidden={hidden}
        inert={hidden}
        drag="y"
        dragListener={false}
        dragControls={drag}
        dragConstraints={{ top: 0, bottom: full - SHEET_PEEK }}
        dragElastic={0.08}
        dragMomentum={false}
        onDragStart={() => {
          dragged.current = true;
          setTouched(true);
          setRising(false);
        }}
        onDragEnd={(_, info) => {
          // Past halfway, or flicked, it goes the rest of the way.
          const at = offsetOf(stop) + info.offset.y;
          let next: Stop = at < (full - SHEET_PEEK) / 2 ? "full" : "peek";
          if (info.velocity.y > 500) next = "peek";
          if (info.velocity.y < -500) next = "full";
          settle(next);
        }}
      >
        <motion.div
          className="absolute inset-0"
          animate={nod ? { y: [0, -18, 0, -8, 0] } : { y: 0 }}
          transition={
            nod
              ? {
                  duration: 1.2,
                  delay: 1.1,
                  times: [0, 0.3, 0.55, 0.75, 1],
                  ease: "easeInOut",
                }
              : { duration: 0.2 }
          }
        >
          <SquirclePlate className="window-plate" radius={radius.window} />
          <Squircle radius={radius.window}>
            <div className="window-glass absolute inset-0 overflow-hidden select-none">
              {/* Over the glass's light, not under it. */}
              <div className="absolute inset-0 flex flex-col">
                <div
                  aria-hidden="true"
                  className="grid h-4 shrink-0 cursor-grab touch-none place-items-center"
                  onPointerDown={(event) => drag.start(event)}
                >
                  <span className="h-1 w-10 rounded-full bg-ink-3/40" />
                </div>
                <SheetHeader
                  url={url}
                  host={host}
                  author={author}
                  up={up}
                  onPointerDown={(event) => {
                    dragged.current = false;
                    drag.start(event);
                  }}
                  onToggle={() => {
                    setTouched(true);
                    if (!dragged.current) settle(up ? "peek" : "full");
                  }}
                />
                <div className="relative min-h-0 flex-1 bg-white/60 select-text">
                  <Page url={url} active={up} />
                </div>
                {/* Below the screen's edge (its lower corners): nothing. */}
                <div className="shrink-0" style={{ height: radius.window }} />
              </div>
            </div>
          </Squircle>
        </motion.div>
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
  const wide = useMedia(WIDE);
  const mid = useMedia("(min-width: 640px) and (min-height: 560px)");
  const roomy = useMedia("(min-width: 1024px) and (min-height: 560px)");
  const [vw, vh] = useViewport();
  // A 红包's page takes its own (or none); other pages keep what is held.
  // On a wide screen it opens again where this browser left it open.
  const pageUrl = page?.url ?? null;
  const pageAuthor = page?.author ?? null;
  const pageAuto = page?.autoOpen === true;
  const store = useStore();
  const pullSheet = useSetAtom(sheetStopAtom);
  useLayoutEffect(() => {
    if (activityId === null) return;
    const current = store.get(heldAtom);
    if (current.forId === activityId && current.url === pageUrl) return;
    // 打开红包页时自动打开 (§2.7): beside it, or the sheet pulled up.
    const byItself = pageUrl !== null && opensByItself(activityId, pageAuto);
    setHeld({
      forId: activityId,
      url: pageUrl,
      author: pageAuthor,
      open:
        pageUrl !== null &&
        wide &&
        (rememberedOpen().includes(activityId) || byItself),
      loaded: false,
      mainWidth: current.mainWidth,
    });
    if (byItself && !wide) pullSheet("full");
  }, [
    activityId,
    pageUrl,
    pageAuthor,
    pageAuto,
    wide,
    setHeld,
    store,
    pullSheet,
  ]);
  const url = held.url;
  const onPage =
    url !== null && activityId !== null && held.forId === activityId;
  const split = onPage && wide && held.open;
  // Opened or closed beside the 红包 window (not the phone's sheet): kept
  // for the next visit.
  const forId = held.forId;
  useEffect(() => {
    if (onPage && wide && forId !== null) rememberOpen(forId, held.open);
  }, [onPage, wide, forId, held.open]);
  // The same sizes as app-window-frame; beside the page, the two windows
  // take the desktop's width, up to SPLIT_MAX.
  const frameHeight = roomy ? Math.min(940, vh - 64) : vh - 32;
  const cornerRadius = roomy ? radius.window : radius.windowMid;
  const both = Math.min(SPLIT_MAX, vw - (roomy ? 64 : 32));
  const maxMain = both - GAP - SIDE_MIN;
  // Dragged past the end, the line gives a little and, far enough, closes
  // the page on letting go (dragged back, it does not).
  const [pull, setPull] = useState(0);
  const dragFrom = useRef(MAIN_BESIDE);
  const armed = pull >= PULL_CLOSE;
  const mainWidth =
    Math.max(MAIN_MIN, Math.min(held.mainWidth, maxMain)) + pullGive(pull);
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
  // Stepped aside for a dialog: the window reaches the bottom at once (the
  // sheet still covers it), not moving.
  const away = useAtomValue(sheetAwayAtom);
  const above = sheetBelow && !away;
  // Full screen, beside the 红包 window only: closed (leaving the 红包
  // page, the browser window narrowed to the sheet), it is over.
  const [fullAsked, setFullAsked] = useState(false);
  // A dialog of the 红包 window's comes over it (the SDK's 让这个网页替你提交,
  // a human check, the login card): out of full screen until it closes.
  const windowCovered = useWindowCovered();
  const full = split && fullAsked && !windowCovered;
  const [fullTick, setFullTick] = useState(0);
  const setPageFull = useSetAtom(pageFullAtom);
  useEffect(() => setPageFull(full), [full, setPageFull]);
  const [last, setLast] = useState({ split, sheetBelow, full });
  if (
    last.split !== split ||
    last.sheetBelow !== sheetBelow ||
    last.full !== full
  ) {
    setLast({ split, sheetBelow, full });
    if (!split && fullAsked) setFullAsked(false);
    if (!reduced) {
      if (last.split !== split) {
        setTick((count) => count + 1);
        setMoving(true);
      } else if (last.full !== full) {
        setFullTick((count) => count + 1);
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
  // Going full screen or back, only the page's window moves, under its
  // own blur; the 红包 window stays as it is.
  useEffect(() => {
    if (!full) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setFullAsked(false);
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [full]);
  // Asked from the 红包 page (附带网页 under 分享, the cover's tag, a
  // note's button).
  const request = useAtomValue(requestAtom);
  const answered = useRef(request.n);
  const setSheetStop = useSetAtom(sheetStopAtom);
  const router = useRouter();
  useEffect(() => {
    if (answered.current === request.n) return;
    answered.current = request.n;
    if (!onPage) return;
    if (!wide) {
      if (!request.open) setSheetStop("peek");
      else {
        // Asked from a dialog (the 说明弹窗): over it the sheet could not
        // come up, so the dialog closes first.
        closeOverlay(router);
        setSheetStop("full");
      }
    } else if (held.open !== request.open) {
      if (!reduced) {
        setTick((count) => count + 1);
        setMoving(true);
      }
      setHeld((current) => ({ ...current, open: request.open }));
    }
  }, [
    request,
    onPage,
    wide,
    held.open,
    reduced,
    router,
    setHeld,
    setSheetStop,
  ]);

  const frame: Frame = {
    width: split ? mainWidth : null,
    height: !above
      ? null
      : mid
        ? `calc(100dvh - ${16 + SHEET_PEEK + 8}px)`
        : `calc(100dvh - ${SHEET_PEEK - 20}px)`,
    tick,
    moving: moving && !dragging,
    lifting,
    holding: dragging,
    covered: full,
  };
  return (
    <FrameContext.Provider value={frame}>
      <div
        className={`relative flex items-center justify-center ${above ? (mid ? "mt-4 self-start" : "self-start") : ""}`}
      >
        {children}
        {wide && url !== null && (
          <SideWindow
            url={url}
            author={held.author}
            width={sideWidth}
            height={frameHeight}
            cornerRadius={cornerRadius}
            open={split}
            frame={frame}
            sideIsNarrow={sideIsNarrow}
            closing={armed}
            full={full}
            veilTick={tick + fullTick}
            onToggleFull={() => setFullAsked(!full)}
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
            its middle, and goes first (full screen too); it follows the
            line when 收窄 or 放宽 moves it. */}
        <AnimatePresence>
          {split && !full && (
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
                  armed={armed}
                  onChange={(width) => {
                    if (dragging) setPull(Math.max(0, width - maxMain));
                    setHeld((current) => ({
                      ...current,
                      mainWidth: Math.max(MAIN_MIN, Math.min(width, maxMain)),
                    }));
                  }}
                  onDragging={(on) => {
                    setDragging(on);
                    if (on) {
                      dragFrom.current = Math.min(held.mainWidth, maxMain);
                      return;
                    }
                    setPull(0);
                    // Let go past the end: the page closes, and opens
                    // again at the width it had before the drag.
                    if (armed)
                      change(() =>
                        setHeld((current) => ({
                          ...current,
                          open: false,
                          mainWidth: dragFrom.current,
                        })),
                      );
                  }}
                />
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
      {!wide && url !== null && (
        <Sheet
          url={url}
          author={held.author}
          shown={onPage}
          inset={mid ? 16 : 0}
        />
      )}
    </FrameContext.Provider>
  );
}
