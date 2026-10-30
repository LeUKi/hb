import { AnimatePresence, motion, type Transition } from "motion/react";
import {
  type CSSProperties,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { haptic } from "../../lib/haptics";
import type { HongbaoActivity } from "../../lib/hongbao";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { isApple } from "../../lib/platform";
import {
  omniboxElements,
  useCooldownSeconds,
} from "../omnibox/use-omnibox-controller";
import { MORPH_MS } from "../shell/layout-morph";
import { useWindowInfo, type WindowInfo } from "../shell/window-info";
import { ShortcutKbd } from "../ui/kbd";
import { MorphLabel, RollingNumber, RollingText } from "../ui/morph-label";
import { Reveal } from "../ui/reveal";
import { CoverData } from "./cover-data";
import { CoverHead } from "./cover-head";
import { coverMotion } from "./cover-motion";
import { MyResult } from "./my-result";
import { Seal } from "./parts";
import { useCoverHeight } from "./use-cover-height";
import { COVER_RESERVE, scrollerOf, useCoverState } from "./use-cover-state";
import { countdown, type Hongbao, useNow } from "./use-hongbao";

const clamp = (min: number, value: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * The page's geometry in px, from the window (not the viewport), so the CSS
 * and the animations use the same numbers.
 */
/** “还有 02:13:05”, by the second, to a timed draft's opening. */
function OpensIn({ at }: { at: number }) {
  const now = useNow(1000);
  return (
    <p className="text-sm text-ink-2 tabular-nums">
      还有 {countdown(Math.max(1000, at - now))}
    </p>
  );
}

export function hongbaoSizes({ width, height, compact }: WindowInfo) {
  const seal = clamp(76, width * 0.2, 112);
  const curve = clamp(36, height * 0.06, 64);
  // A tall window gets a tall big cover; a phone a little less, or the head
  // floats in empty red. Content can make it taller, up to the window.
  const cover = clamp(432, height * (compact ? 0.6 : 0.68), 736);
  return { seal, curve, cover, reserve: COVER_RESERVE };
}

export type HongbaoSizes = ReturnType<typeof hongbaoSizes>;

export function sizeVars(sizes: HongbaoSizes) {
  return {
    "--hb-cover": `${sizes.cover}px`,
    "--hb-curve": `${sizes.curve}px`,
    "--seal": `${sizes.seal}px`,
    "--hb-reserve": `${sizes.reserve}px`,
  } as CSSProperties;
}

function CooldownText() {
  const seconds = useCooldownSeconds();
  return (
    <>
      还需等待 <RollingNumber value={seconds} /> 秒
    </>
  );
}

/** Under the closed 红包: what the seal will do, and any result message. */
function ActionHint({
  activity,
  hongbao,
  hintId,
}: {
  activity: HongbaoActivity;
  hongbao: Hongbao;
  hintId: string;
}) {
  const { compact } = useWindowInfo();
  const reduced = useReducedMotionPref();
  const { phase, message, standing } = hongbao;
  return (
    <div
      className="grid justify-items-center gap-1.5 px-6 text-center"
      style={{ paddingTop: "calc(var(--seal) / 2 + 0.875rem)" }}
      data-hb-part="hint"
    >
      <p id={hintId} className="text-lg text-ink">
        <MorphLabel fit={false}>
          {hongbao.cooldown && phase === "closed" ? (
            <CooldownText />
          ) : (
            hongbao.hint
          )}
        </MorphLabel>
      </p>
      {/* 代码判定, protocol 5 (docs/multi-prize-design.md §4.1): what only
          they see, and their 待结算 until it is settled. */}
      <Reveal show={Boolean(standing && !standing.settled)}>
        {standing && (
          <div
            className="grid justify-items-center gap-1"
            data-hb-part="standing"
          >
            <Reveal show={Boolean(standing.view?.summary)}>
              <p className="text-base break-words text-ink">
                {standing.view?.summary}
              </p>
            </Reveal>
            {/* Its figure rolls as each judgment moves it. */}
            <p className="text-sm text-ink-2">
              <RollingText text={`待结算 ${standing.pending} LDC`} /> ·
              判定器结算或红包结束时发
            </p>
          </div>
        )}
      </Reveal>
      {/* 定时开放 (scheduled-opening §6): how long until it opens. */}
      {hongbao.draft &&
        !hongbao.author &&
        activity.scheduledOpenAt !== undefined && (
          <OpensIn at={activity.scheduledOpenAt} />
        )}
      {/* Said by the command box's own announcer (one for every result). */}
      {message && phase === "closed" && (
        <p
          className={
            message.tone === "danger"
              ? "text-sm text-danger"
              : "text-sm text-ink-2"
          }
        >
          {message.text}
        </p>
      )}
      {/* Only beside a keyboard's room: the window turning narrow or wide
          folds it away or opens it (布局补间), the page below following. */}
      <AnimatePresence initial={false}>
        {!compact &&
          phase === "closed" &&
          activity.participation !== "direct" &&
          hongbao.sealState === "idle" &&
          !hongbao.gate &&
          !hongbao.author &&
          !hongbao.draft && (
            <motion.p
              key="shortcut"
              className="flex items-center gap-1.5 overflow-hidden text-sm text-ink-3"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: reduced ? 0 : MORPH_MS / 1000, ease }}
            >
              或按 <ShortcutKbd />
            </motion.p>
          )}
      </AnimatePresence>
    </div>
  );
}

/**
 * 红包皮 with its head, 说明 and 公开数据, then the hint (closed) or 我的结果
 * (taken part). Two covers (docs/redesign/05 §大小红包皮):
 *
 * - big: the whole cover, with the seal on its curved edge while it can
 *   still be opened;
 * - small: once taken part, pinned under the bar whenever the page is not
 *   at the very top; smaller type, one line of data, the 说明 folded.
 *
 * Three layers: the frame (sticky; holds the seal so it is not clipped), the
 * red face (its height animated in px, clipping the content), the content
 * (natural height, laid out on its own so the animation never moves it).
 * Flat only: on opening the seal pops away, a light crosses the cover, and
 * it collapses into the small cover while the result fades in below.
 */
export function HongbaoHero({
  activity,
  hongbao,
  arriveFrom = null,
  fromRed = false,
}: {
  activity: HongbaoActivity;
  hongbao: Hongbao;
  /** The skeleton's cover height, when the page arrived after one. */
  arriveFrom?: number | null;
  /** That skeleton was red: a 代码判定红包's lacquer fades in from it. */
  fromRed?: boolean;
}) {
  const { phase, mine, fresh, reveal, openDelay: delay, reduced } = hongbao;
  const opened = phase === "open";
  const play = opened && fresh && !reduced;
  const resultRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const faceRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  // Red for a frame, then the registered cover colours fade to lacquer.
  const [red, setRed] = useState(fromRed && activity.mode === "code");
  useEffect(() => {
    if (!red) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setRed(false));
    });
    return () => cancelAnimationFrame(frame);
  }, [red]);

  // 震动反馈: success as the cover starts to open on a claim or sign-up
  // just made (once; StrictMode's second run must not drop it).
  const felt = useRef<number | null>(null);
  const claimedAt = opened && fresh && mine ? mine.at : null;
  useEffect(() => {
    if (claimedAt === null || felt.current === claimedAt) return;
    const timer = window.setTimeout(
      () => {
        felt.current = claimedAt;
        haptic("success");
      },
      reduced ? 0 : delay * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [claimedAt, delay, reduced]);

  const cover = useCoverState({
    opened,
    claimedAt: opened && fresh && mine ? mine.at : null,
    openDelay: delay,
    reduced,
    anchorRef: frameRef,
  });
  const { state, pinned, opening, comp } = cover;
  const transition: Transition = reduced
    ? { duration: 0 }
    : opening
      ? { duration: 0.62, ease: [0.6, 0, 0.2, 1] }
      : { duration: 0.42, ease: [0.3, 0, 0.1, 1] };
  const motions = coverMotion(state, transition, opening, reduced);
  const { height, smallHeight } = useCoverHeight({
    state,
    comp,
    innerRef,
    faceRef,
    frameRef,
    transition,
    onSettled: cover.settle,
    from: arriveFrom,
  });

  // Focus and find-in-page stop below the pinned cover, not under it.
  useLayoutEffect(() => {
    const scroller = scrollerOf(frameRef);
    if (!pinned || !scroller) return;
    const before = scroller.style.scrollPaddingTop;
    scroller.style.scrollPaddingTop = `${(smallHeight.current || 240) + 8}px`;
    return () => {
      scroller.style.scrollPaddingTop = before;
    };
  }, [pinned, smallHeight]);

  /** 展开 on the small cover: back to the top, where the big one is. */
  const expand = () => scrollerOf(frameRef)?.scrollTo({ top: 0 });

  return (
    <>
      <motion.div
        ref={frameRef}
        layout
        layoutRoot
        layoutDependency={state}
        className={cn(
          "hb-cover-frame z-10",
          pinned ? "sticky top-0" : "relative",
          phase === "ended" && !hongbao.drawing && "hb-ended",
          // 代码判定红包: 黑漆描金 (05 §14).
          activity.mode === "code" && "hb-code",
          red && "hb-from-red",
        )}
        style={{ marginBottom: comp }}
        data-cover={state}
        data-hb-part="hero"
      >
        <motion.div
          ref={faceRef}
          className="hb-cover relative"
          style={{ height }}
          data-hb-part="cover"
        >
          <div
            ref={innerRef}
            className={cn(
              "relative flex flex-col items-center",
              state === "big"
                ? "max-h-[max(100cqh,var(--hb-cover-least,0px))] min-h-(--hb-cover) gap-6 pt-[calc(var(--bar-h)+1rem)] pb-[calc(var(--seal)/2+1rem)]"
                : "gap-3 pt-[calc(var(--bar-h)+0.875rem)] pb-[calc(var(--hb-curve)*0.55+0.75rem)]",
            )}
          >
            <CoverHead
              activity={activity}
              ended={phase === "ended" && !hongbao.drawing}
              drawing={hongbao.drawing}
              motions={motions}
              onExpand={expand}
              onOpenNote={hongbao.openNote}
            />
            <CoverData
              activity={activity}
              view={hongbao.view}
              roster={hongbao.roster}
              onOpenRoster={hongbao.openRoster}
              motions={motions}
            />
          </div>
          <span
            aria-hidden="true"
            className="hb-cover-sweep"
            data-play={play || undefined}
            style={{ "--sweep-delay": `${delay + 0.18}s` } as CSSProperties}
          />
        </motion.div>

        {play && (
          <motion.span
            aria-hidden="true"
            className="hb-ring-flash pointer-events-none absolute top-full left-1/2 size-(--seal) -translate-x-1/2 -translate-y-1/2"
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: [0.9, 2.4], opacity: [0.8, 0] }}
            transition={{ duration: 0.46, delay: delay + 0.14 }}
          />
        )}

        <AnimatePresence
          onExitComplete={() => {
            // Focus is wherever the claim left it: <body> (the seal went),
            // the bar (the box closed) or the view (arrived from the start
            // page). Unless the viewer moved on, hand it to the result.
            const active = document.activeElement;
            if (
              active === document.body ||
              active === omniboxElements.address ||
              active?.id === "view"
            )
              resultRef.current?.focus({ preventScroll: true });
          }}
        >
          {!opened && (
            <motion.div
              key="seal"
              className="absolute top-full left-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
              exit={{
                scale: [1, 1.12, 0.5],
                opacity: [1, 1, 0],
                transition: {
                  duration: reduced ? 0 : 0.36,
                  delay: reduced ? 0 : delay,
                  times: [0, 0.4, 1],
                },
              }}
              data-hb-part="seal"
            >
              <Seal
                glyph={hongbao.glyph}
                label={hongbao.sealLabel}
                state={hongbao.sealState}
                onPress={hongbao.press}
                describedBy={hintId}
                shortcut={
                  activity.participation !== "direct" &&
                  hongbao.sealState === "idle" &&
                  !hongbao.gate
                    ? isApple
                      ? "Meta+K"
                      : "Control+K"
                    : undefined
                }
              />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <AnimatePresence initial={false} mode="popLayout">
        {opened && mine ? (
          <motion.div
            key="result"
            // Clears the content kept under the small cover.
            className="pt-[calc(var(--hb-reserve)-0.5rem)]"
            transition={{ duration: 0.36, delay: play ? delay + 0.62 : 0 }}
            initial={play ? { opacity: 0, y: 12 } : false}
            animate={{ opacity: 1, y: 0 }}
          >
            <MyResult
              ref={resultRef}
              activity={activity}
              mine={mine}
              play={play || reveal}
              delay={play ? delay + 0.7 : 0.2}
              deadlineAt={hongbao.view.deadlineAt}
              drawNote={hongbao.drawStep?.note}
            />
          </motion.div>
        ) : (
          <motion.div
            key="hint"
            exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.15 } }}
          >
            <ActionHint activity={activity} hongbao={hongbao} hintId={hintId} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
