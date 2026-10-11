import { Gift, Hourglass } from "lucide-react";
import {
  animate as animateValue,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const TEXT_REWARD_LABEL = "文本 / CDK";

import type { PaymentState, PublicUserProfile } from "@hb/contracts";
import { afterNavigationLayout } from "../../lib/navigation-state";
import { UserAvatar, UserIdentity } from "../user-identity";
import { PaymentConfirmation } from "./payment-confirmation";
import {
  SharedEnvelope,
  useEnvelopeSnapshot,
  useRedemptionTransition,
} from "./redemption-transition";

export type EnvelopeReward =
  | { kind: "ldc"; amount: string }
  | { kind: "text" }
  | { kind: "missed" | "not-won" | "ended" };
export type EnvelopePhase = "closed" | "opening" | "open" | "closing";

export interface EnvelopeProps {
  open: boolean;
  waiting?: boolean;
  reward?: EnvelopeReward;
  size?: "small" | "detail";
  /** Reserve the eventual paper layout while an instant redemption is pending. */
  reserveResultSpace?: boolean;
  /** A confirmed result event. Re-rendering with the same token never replays it. */
  animationToken?: string | number | null;
  /** A page visit. Once its factual paper arrives, show one full reveal. */
  entryToken?: string | number | null;
  shared?: boolean;
  author?: PublicUserProfile;
  payment?: {
    status: PaymentState | null | undefined;
    confirmedAt?: string | null;
  };
  onOpenRoster?: () => void;
  rosterLabel?: string;
}

const openingDuration = 0.8;
const closingDuration = 0.3;
const openingEase = [0.22, 1, 0.36, 1] as const;
const openedPaperOffset = -70;
const closedPaperOffset = 112;
const openedEnvelopeOffset = 50;

/** Presentation only: it never reads activities or dispatches reward operations. */
export function Envelope({
  open,
  waiting = false,
  reward,
  size = "detail",
  reserveResultSpace = false,
  animationToken = null,
  entryToken = null,
  shared = true,
  author,
  payment,
  onOpenRoster,
  rosterLabel = "领取名单",
}: EnvelopeProps) {
  useEnvelopeSnapshot(size === "detail" && open ? reward : undefined);
  const reduced = useReducedMotion();
  const {
    transition,
    shared: sharedNavigation,
    isPresent,
    moveDuration,
    beginMovement,
  } = useRedemptionTransition();
  const transitionId = transition?.id;
  const navigationIntent =
    reward &&
    shared &&
    transition?.shared !== false &&
    transition?.from === "home" &&
    transition.to === "activity"
      ? `navigation:${transition.id}`
      : null;
  const resultIntent =
    reward && animationToken !== null ? `result:${animationToken}` : null;
  const entryIntent =
    reward && entryToken !== null ? `entry:${entryToken}` : null;
  const navigatedOpen = navigationIntent !== null && sharedNavigation;
  // A visit and the result that arrives during it share a single display event.
  // Query updates can change the factual paper without restarting that event.
  const openingIntent =
    entryIntent ?? (navigatedOpen ? navigationIntent : resultIntent);
  const closingReward =
    shared &&
    sharedNavigation &&
    transition?.from === "activity" &&
    transition.to === "home"
      ? transition.closingReward
      : undefined;
  const returningHome = size === "small" && Boolean(closingReward);
  const initialPhase: EnvelopePhase =
    reduced || !open
      ? returningHome && !reduced
        ? "open"
        : open
          ? "open"
          : "closed"
      : openingIntent !== null
        ? "closed"
        : "open";
  const [phase, setPhase] = useState<EnvelopePhase>(initialPhase);
  const [shownReward, setShownReward] = useState(reward ?? closingReward);
  const [animated, setAnimated] = useState(false);
  const [openingCount, setOpeningCount] = useState(0);
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  const currentPhase = useRef(phase);
  const consumedIntent = useRef<{
    key: string;
    startAt: number;
    started: boolean;
    completed: boolean;
  } | null>(null);
  const generation = useRef(0);
  const rewardRef = useRef(reward);
  rewardRef.current = reward;
  const initialVisualOpen = useRef(initialPhase === "open");
  const visualOpen = phase === "open" || phase === "opening";
  const closing = phase === "closing";
  const duration = reduced
    ? 0
    : phase === "opening"
      ? openingDuration
      : closing
        ? closingDuration
        : 0;
  const ratio = size === "small" ? 104 / 210 : 1;
  const paperY = useMotionValue(
    (initialVisualOpen.current ? openedPaperOffset : closedPaperOffset) * ratio,
  );
  const paperOpacity = useMotionValue(initialVisualOpen.current ? 1 : 0);

  useEffect(() => {
    const viewport = window.matchMedia("(max-width: 760px)");
    const update = () => setCompact(viewport.matches);
    viewport.addEventListener("change", update);
    return () => viewport.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    // New paper inside AnimatePresence(initial=false) still needs its own
    // timeline; explicit values avoid inherited mount-animation suppression.
    const reveal = phase === "open" || phase === "opening";
    const opening = phase === "opening";
    const paperMoving = !reduced && (opening || phase === "closing");
    const position = animateValue(
      paperY,
      (reveal ? openedPaperOffset : closedPaperOffset) * ratio,
      {
        duration: paperMoving ? (opening ? 0.6 : 0.22) : 0,
        delay: paperMoving && opening ? 0.2 : 0,
        ease: openingEase,
      },
    );
    const opacity = animateValue(paperOpacity, reveal ? 1 : 0, {
      duration: paperMoving ? (opening ? 0.18 : 0.2) : 0,
      delay: paperMoving && opening ? 0.2 : 0,
    });
    return () => {
      position.stop();
      opacity.stop();
    };
  }, [paperOpacity, paperY, phase, ratio, reduced]);

  useEffect(() => {
    if (reward) setShownReward(reward);
  }, [reward]);

  useLayoutEffect(() => {
    const attempt = ++generation.current;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let cancelLayoutWait: (() => void) | undefined;
    const update = (next: EnvelopePhase) => {
      if (generation.current !== attempt) return;
      currentPhase.current = next;
      setPhase(next);
    };
    const later = (callback: () => void, milliseconds: number) => {
      timers.push(
        setTimeout(() => {
          if (generation.current === attempt) callback();
        }, milliseconds),
      );
    };
    const close = () => {
      update("closing");
      later(() => {
        update("closed");
        setShownReward(undefined);
      }, closingDuration * 1_000);
    };

    if (reduced) {
      update(open && isPresent ? "open" : "closed");
      setAnimated(false);
      const skippedIntent = openingIntent;
      if (skippedIntent)
        consumedIntent.current = {
          key: skippedIntent,
          startAt: Date.now(),
          started: true,
          completed: true,
        };
      if (!open || !isPresent) setShownReward(undefined);
    } else if (
      closingReward &&
      (returningHome || (!isPresent && transition?.from === "activity"))
    ) {
      setShownReward(rewardRef.current ?? closingReward);
      close();
    } else if (!isPresent) {
      // Exiting unrelated routes retain a static, inert illustration only.
      update(open ? "open" : "closed");
    } else if (!open) {
      setAnimated(false);
      // Losing access to a result clears private paper immediately, even while
      // the non-sensitive envelope is finishing its closing movement.
      setShownReward(undefined);
      if (currentPhase.current === "open" || currentPhase.current === "opening")
        close();
      else update("closed");
    } else {
      const intent = openingIntent;
      if (intent) {
        if (consumedIntent.current?.key !== intent) {
          consumedIntent.current = {
            key: intent,
            // Start time belongs to the actual reveal, after layout and the
            // shared move. A slow response never spends its reveal duration.
            startAt: 0,
            started: false,
            completed: false,
          };
          setShownReward(rewardRef.current);
          update("closed");
        }
        const event = consumedIntent.current;
        if (!event.completed) {
          const start = () => {
            update("opening");
            setAnimated(true);
            if (!event.started) {
              event.started = true;
              event.startAt = Date.now();
              setOpeningCount((count) => count + 1);
            }
            later(
              () => {
                event.completed = true;
                update("open");
              },
              Math.max(0, event.startAt + openingDuration * 1_000 - Date.now()),
            );
          };
          if (event.started) start();
          else {
            cancelLayoutWait = afterNavigationLayout(() => {
              if (generation.current !== attempt) return;
              const readyAt =
                navigatedOpen && transitionId !== undefined
                  ? beginMovement(transitionId) + moveDuration * 1_000
                  : Date.now();
              const delay = Math.max(0, readyAt - Date.now());
              if (delay > 0) later(start, delay);
              else start();
              return undefined;
            }, true);
          }
        } else update("open");
      } else {
        update("open");
        setAnimated(false);
      }
    }
    return () => {
      generation.current++;
      cancelLayoutWait?.();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [
    closingReward,
    isPresent,
    moveDuration,
    navigatedOpen,
    openingIntent,
    open,
    reduced,
    returningHome,
    beginMovement,
    // Movement's start timestamp and reward values are not event identities.
    // Neither may clean up or shorten an in-progress reveal.
    transition?.from,
    transitionId,
  ]);

  const hasPaper =
    Boolean(shownReward) &&
    phase !== "closed" &&
    (open || Boolean(closingReward));
  const stageHeight =
    size === "small"
      ? 150
      : open || reserveResultSpace || phase === "closing"
        ? 340
        : compact
          ? 250
          : 280;
  const stage = useRef<HTMLDivElement>(null);
  const minimumHeight = useMotionValue(stageHeight);
  useLayoutEffect(() => {
    const node = stage.current;
    if (reduced || Math.abs(minimumHeight.get() - stageHeight) < 0.5) {
      minimumHeight.set(stageHeight);
      if (node) {
        node.style.minHeight = `${stageHeight}px`;
        delete node.dataset.layoutSettling;
      }
      return;
    }
    if (node) node.dataset.layoutSettling = "true";
    let frame = 0;
    let resize: ReturnType<typeof animateValue> | undefined;
    const shrinking = stageHeight < minimumHeight.get();
    const start = () => {
      // Let incoming text establish the row height before reducing its other
      // column. Otherwise the row first contracts, then grows past its start.
      const settling = node
        ?.closest(".activity-page")
        ?.querySelectorAll(
          '[data-layout-settling="true"], [data-disclosure-animating="true"]',
        );
      if (
        shrinking &&
        settling &&
        Array.from(settling).some((region) => region !== node)
      ) {
        frame = requestAnimationFrame(start);
        return;
      }
      resize = animateValue(minimumHeight, stageHeight, {
        duration: 0.22,
        ease: "easeOut",
        onUpdate: (height) => {
          if (node) node.style.minHeight = `${height}px`;
        },
        onComplete: () => {
          if (node) delete node.dataset.layoutSettling;
        },
      });
    };
    if (shrinking) {
      // ResizeObserver runs after the first frame; observe its region markers
      // before deciding that the surrounding layout is already settled.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(start);
      });
    } else start();
    return () => {
      cancelAnimationFrame(frame);
      resize?.stop();
      if (node) delete node.dataset.layoutSettling;
    };
  }, [minimumHeight, reduced, stageHeight]);
  // Presence controls interaction, while the exiting source keeps its original
  // layout allocation until the shared movement finishes.
  return (
    <div
      ref={stage}
      className={`envelope-stage redemption-envelope ${visualOpen ? "is-open" : ""}`}
      data-testid={isPresent ? "envelope" : undefined}
      data-size={size}
      data-open={open}
      data-reserve-result-space={reserveResultSpace || undefined}
      data-phase={phase}
      data-animate={animated && !reduced && open && isPresent}
      data-opening-count={openingCount}
      data-entry-token={entryToken ?? undefined}
      aria-hidden={!isPresent || size === "small" || undefined}
      inert={!isPresent || size === "small" || undefined}
      style={{ minHeight: minimumHeight.get() }}
    >
      <SharedEnvelope page={size === "small" ? "home" : "activity"}>
        <motion.div
          className="envelope"
          initial={{
            y: initialVisualOpen.current ? openedEnvelopeOffset * ratio : 0,
          }}
          animate={{ y: visualOpen ? openedEnvelopeOffset * ratio : 0 }}
          transition={{
            layout: { duration: moveDuration, ease: "easeInOut" },
            y: { duration, ease: openingEase },
          }}
        >
          <div className="envelope-back" aria-hidden="true" />
          <motion.div
            className="envelope-flap"
            aria-hidden="true"
            initial={{ rotateX: initialVisualOpen.current ? -165 : 0 }}
            animate={{ rotateX: visualOpen ? -165 : 0 }}
            style={{ zIndex: visualOpen ? 0 : 4 }}
            transition={{
              duration: duration ? (closing ? 0.27 : 0.4) : 0,
              delay: duration && closing ? 0.03 : 0,
              ease: "easeInOut",
            }}
          />
          {hasPaper && (
            <div className="envelope-paper-clip">
              <motion.div
                className="reward-slip"
                style={{ y: paperY, opacity: paperOpacity }}
                inert={phase !== "open" || !isPresent || undefined}
                aria-hidden={phase !== "open" || !isPresent || undefined}
              >
                {shownReward?.kind === "text" ? (
                  <>
                    <strong className="slip-text-title">
                      {TEXT_REWARD_LABEL}
                    </strong>
                    <span className="slip-unit">已领取</span>
                  </>
                ) : shownReward?.kind === "ldc" ? (
                  <>
                    <div className="slip-value">
                      <strong className="slip-amount">
                        +{shownReward.amount}
                      </strong>
                    </div>
                    <div className="slip-unit-row">
                      <span className="slip-unit">LDC</span>
                      <PaymentConfirmation
                        status={payment?.status}
                        confirmedAt={payment?.confirmedAt}
                        tone="paper"
                      />
                    </div>
                  </>
                ) : shownReward ? (
                  <strong className="slip-result-title">
                    {shownReward.kind === "missed"
                      ? "错过了"
                      : shownReward.kind === "not-won"
                        ? "未中奖"
                        : "已结束"}
                  </strong>
                ) : null}
                {onOpenRoster && size === "detail" && (
                  <button
                    type="button"
                    className="envelope-roster-link"
                    aria-haspopup="dialog"
                    disabled={phase !== "open" || !isPresent}
                    onClick={() => {
                      if (phase === "open" && isPresent) onOpenRoster();
                    }}
                  >
                    {rosterLabel}
                  </button>
                )}
              </motion.div>
            </div>
          )}
          <div className="envelope-front" aria-hidden="true">
            <div className="envelope-side left" />
            <div className="envelope-side right" />
            <div className="envelope-bottom" />
          </div>
          {author && (
            <div
              className="envelope-author"
              title={author.displayName || author.username}
            >
              {isPresent && size === "detail" ? (
                <UserIdentity profile={author} className="user-identity" />
              ) : (
                <span className="envelope-author-static">
                  <UserAvatar profile={author} />
                  <span>{author.displayName || author.username}</span>
                </span>
              )}
            </div>
          )}
          <motion.span
            className="envelope-seal"
            aria-hidden="true"
            initial={{
              opacity: initialVisualOpen.current ? 0 : 1,
              scale: initialVisualOpen.current ? 0.65 : 1,
            }}
            animate={{
              opacity: visualOpen ? 0 : 1,
              scale: visualOpen ? 0.65 : 1,
            }}
            transition={{
              duration: duration ? (closing ? 0.12 : 0.16) : 0,
              delay: duration && closing ? 0.18 : 0,
            }}
          >
            <span>
              {waiting ? (
                <Hourglass strokeWidth={1.5} />
              ) : (
                <Gift strokeWidth={1.5} />
              )}
            </span>
          </motion.span>
        </motion.div>
      </SharedEnvelope>
    </div>
  );
}
