import type { ViewerStats } from "@hb/contracts";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Eye } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { liveViewersAtom } from "../../lib/live-state";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { clockLabel } from "../../lib/roster-time";
import { readViewers, viewersKey } from "../../lib/viewers";
import { buttonHeight, buttonRadius, useButtonShape } from "../ui/button";
import { MorphLabel, RollingNumber } from "../ui/morph-label";
import { radius, Squircle, SquircleFill, SquirclePlate } from "../ui/squircle";
import { ViewerCurve } from "./viewer-curve";

const CARD_WIDTH = 320;
/** The chip: a small two-line card, not 分享's pill (user 2026-11-19). */
const CHIP_RADIUS = 12;
const CHIP_HEIGHT = 46;

/**
 * 「N 人在看」, pinned top left as 分享 is top right, while the 红包 runs:
 * how many people have its page open right now, each once however many
 * tabs (api: activities/live.ts). Only signed-in viewers are on the live
 * channel, so only they are counted, and only they see it. It goes while
 * the line is down, and comes back with the next count. Once it is over,
 * everyone sees how many looked and the most at once in its place
 * (docs/viewer-stats-design.md). Either is a small two-line card that opens
 * a bigger one with the numbers and the curve.
 */
export function LiveViewers({
  activityId,
  running,
  over,
  openedAt,
  plain = false,
}: {
  activityId: string;
  running: boolean;
  /** 在看人数 once it is over, from the public read. */
  over?: ViewerStats;
  openedAt?: number;
  /**
   * 社区小程序: the one-line count, nothing to open and nothing once it is
   * over (user 2026-11-19: not in the mini app for now).
   */
  plain?: boolean;
}) {
  const viewers = useAtomValue(liveViewersAtom);
  const reduced = useReducedMotionPref();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const cardId = useId();
  const live = running && viewers?.id === activityId ? viewers : null;
  const ended = !plain && !running && over ? over : null;
  const shown = live !== null || ended !== null;
  // Gone (the line dropped, it ended before anyone was counted): so is the card.
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  return (
    <div
      className="pointer-events-none sticky top-[calc(var(--bar-h)+0.75rem)] z-20 h-0"
      data-hb-part="viewers"
    >
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div
            key="viewers"
            className="pointer-events-auto absolute top-0 left-3 @wide/window:left-5"
            data-morph="move"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.2, ease }}
          >
            {plain && live ? (
              <PlainCount count={live.count} />
            ) : (
              <ViewersChip
                ref={trigger}
                live={live}
                ended={ended}
                open={open}
                controls={open ? cardId : undefined}
                onToggle={() => setOpen((value) => !value)}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {!plain && (
        <ViewersCard
          id={cardId}
          open={open && shown}
          anchor={trigger}
          activityId={activityId}
          live={live}
          ended={ended}
          openedAt={openedAt}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** The 社区小程序's: 分享's glass, but not a button (nothing to press). */
function PlainCount({ count }: { count: number }) {
  const shape = useButtonShape(buttonRadius.sm, buttonHeight.sm);
  return (
    <span className="btn btn-secondary h-9 px-3.5 text-sm" style={shape}>
      <SquircleFill radius={buttonRadius.sm} />
      <span className="hb-live-dot" aria-hidden="true" />
      <MorphLabel>
        <span>
          <RollingNumber value={count} /> 人在看
        </span>
      </MorphLabel>
    </span>
  );
}

/**
 * A small card of two short lines on 分享's glass, squarer than its pill:
 * the number by itself, and under it the live dot and 在看 (an eye and 看过
 * once over), as a live count is marked (user 2026-11-20). It stays in the
 * column the cover keeps free at its sides for 分享 (56px on a phone: the
 * small cover's padding, the big cover's name line clearance), so it never
 * runs over the author's name or the title (user 2026-11-19): the mark sits
 * by the short word, not the number, so four digits still fit. A wide
 * window's column (112px) takes it a size up. The most at once is in the
 * card it opens.
 */
function ViewersChip({
  ref,
  live,
  ended,
  open,
  controls,
  onToggle,
}: {
  ref: RefObject<HTMLButtonElement | null>;
  live: { count: number } | null;
  ended: ViewerStats | null;
  open: boolean;
  controls?: string;
  onToggle: () => void;
}) {
  const shape = useButtonShape(CHIP_RADIUS, CHIP_HEIGHT);
  const count = live ? live.count : (ended?.total ?? 0);
  const label = live ? "人在看" : "人看过";
  return (
    <button
      ref={ref}
      type="button"
      className="btn btn-secondary min-h-[2.875rem] min-w-10 flex-col gap-0 px-1 py-1.5 @wide/window:min-w-14 @wide/window:px-2.5 @wide/window:py-2"
      style={shape}
      aria-label={`${count} ${label}`}
      aria-expanded={open}
      aria-controls={controls}
      aria-haspopup="dialog"
      onClick={onToggle}
    >
      <SquircleFill radius={CHIP_RADIUS} />
      <span className="text-sm leading-5 font-semibold tracking-[-0.02em] text-ink tabular-nums @wide/window:text-lg @wide/window:leading-6">
        <RollingNumber value={count} />
      </span>
      <span
        className="flex items-center gap-0.5 text-[0.6875rem] leading-[0.875rem] font-normal text-ink-2 @wide/window:gap-1 @wide/window:text-xs @wide/window:leading-4"
        aria-hidden="true"
      >
        {live ? (
          <span className="hb-live-dot size-1.5 @wide/window:size-2" />
        ) : (
          <Eye
            className="size-[0.6875rem] @wide/window:size-3"
            strokeWidth={2.25}
          />
        )}
        {live ? "在看" : "看过"}
      </span>
    </button>
  );
}

function Figure({
  value,
  label,
  dot,
  at,
}: {
  value: number;
  label: string;
  dot?: boolean;
  /** When it was (the most at once): small, after the number. */
  at?: string;
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <p className="flex items-baseline gap-1.5 text-lg leading-6 font-semibold text-ink tabular-nums">
        {dot && <span className="hb-live-dot self-center" aria-hidden="true" />}
        <RollingNumber value={value} />
        {at && (
          <span className="truncate text-xs font-normal text-ink-3">{at}</span>
        )}
      </p>
      <p className="truncate text-xs text-ink-3">{label}</p>
    </div>
  );
}

function ViewersCard({
  id,
  open,
  anchor,
  activityId,
  live,
  ended,
  openedAt,
  onClose,
}: {
  id: string;
  open: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  activityId: string;
  live: {
    count: number;
    peak?: number;
    peakAt?: string;
    total?: number;
  } | null;
  ended: ViewerStats | null;
  openedAt?: number;
  onClose: () => void;
}) {
  const reduced = useReducedMotionPref();
  const card = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [place, setPlace] = useState<{ x: number; y: number; width: number }>();

  // Under the chip, its left edges lined up, inside the window.
  useLayoutEffect(() => {
    if (!open) return;
    const layer = document.querySelector<HTMLElement>("[data-window-layer]");
    const target = anchor.current;
    if (!layer || !target) return;
    setHost(layer);
    const box = layer.getBoundingClientRect();
    const at = target.getBoundingClientRect();
    const width = Math.min(CARD_WIDTH, box.width - 16);
    const x = Math.min(Math.max(8, at.left - box.left), box.width - width - 8);
    setPlace({ x, y: at.bottom - box.top + 8, width });
  }, [open, anchor]);

  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    if (!open) return;
    const close = () => latestClose.current();
    const inside = (node: EventTarget | null) =>
      node instanceof Node &&
      Boolean(card.current?.contains(node) || anchor.current?.contains(node));
    const outside = (event: PointerEvent) => {
      if (!inside(event.target)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      const hadFocus = inside(document.activeElement);
      close();
      if (hadFocus) anchor.current?.focus({ preventScroll: true });
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
          key="card"
          ref={card}
          id={id}
          role="dialog"
          aria-label="在看人数"
          className="absolute z-[60]"
          style={{
            left: place.x,
            top: place.y,
            width: place.width,
            transformOrigin: "top left",
          }}
          initial={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{
            opacity: 0,
            scale: reduced ? 1 : 0.97,
            transition: { duration: reduced ? 0 : 0.1 },
          }}
          transition={{ duration: reduced ? 0 : 0.16, ease }}
        >
          <SquirclePlate className="pop-plate" radius={radius.pop} />
          <Squircle radius={radius.pop}>
            <div className="glass-pop relative">
              <CardBody
                activityId={activityId}
                live={live}
                ended={ended}
                openedAt={openedAt}
              />
            </div>
          </Squircle>
        </motion.div>
      )}
    </AnimatePresence>,
    host,
  );
}

/** Read each time it opens: the numbers at once, the curve when it comes. */
function CardBody({
  activityId,
  live,
  ended,
  openedAt,
}: {
  activityId: string;
  live: {
    count: number;
    peak?: number;
    peakAt?: string;
    total?: number;
  } | null;
  ended: ViewerStats | null;
  openedAt?: number;
}) {
  const { data, isError } = useQuery({
    queryKey: viewersKey(activityId),
    queryFn: ({ signal }) => readViewers(activityId, signal),
    refetchOnMount: "always",
    staleTime: 0,
  });
  const read = data?.viewers ?? null;
  // Live numbers move with the channel; the read fills what it has not said.
  const peak = Math.max(
    live?.count ?? 0,
    live?.peak ?? 0,
    ended?.peak ?? read?.peak ?? 0,
  );
  const peakAt = live?.peakAt ?? ended?.peakAt ?? read?.peakAt;
  const total = Math.max(live?.total ?? 0, ended?.total ?? read?.total ?? 0);
  const curve = data?.curve ?? null;
  // Over with nobody watching at the end (no `end`): up to its last stretch,
  // not on to today.
  const endAt = live
    ? Date.now()
    : curve?.end
      ? Date.parse(curve.end)
      : curve
        ? Date.parse(curve.start) +
          curve.values.length * curve.stepSeconds * 1000
        : Date.now();
  return (
    <div className="grid gap-3 p-4">
      <div className={cn("grid gap-3", live ? "grid-cols-3" : "grid-cols-2")}>
        {live && <Figure value={live.count} label="此刻在看" dot />}
        <Figure
          value={peak}
          label="同时最多"
          at={peakAt ? clockLabel(Date.parse(peakAt)) : undefined}
        />
        <Figure value={total} label="来看过" />
      </div>
      {curve ? (
        <ViewerCurve
          curve={curve}
          endAt={endAt}
          live={live ? live.count : null}
          openedAt={openedAt}
        />
      ) : data ? (
        <p className="text-xs text-ink-3">还没有曲线。</p>
      ) : isError ? (
        <p className="text-xs text-ink-3">曲线没读到，稍后再打开看看。</p>
      ) : (
        // Its frame while the curve comes: the sheen, never a blank.
        <div
          aria-hidden="true"
          className="loading-sheen h-[7.75rem] overflow-hidden rounded-[10px] bg-fill"
        />
      )}
      <p className="text-xs text-ink-3">
        只数登录后开着这一页的人，同一人开几个标签页也只算一个。
      </p>
    </div>
  );
}
