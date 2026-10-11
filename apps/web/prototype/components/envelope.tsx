import { Gift, Hourglass } from "lucide-react";
import {
  animate as animateValue,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import { TEXT_REWARD_LABEL } from "../activity-metadata";
import type { PaymentProgress } from "../types";
import { Avatar, UserIdentity } from "./identity";
import { PaymentConfirmation } from "./payment-confirmation";
import { useRedemptionTransition } from "./redemption-transition";
import "./envelope.css";

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
  shared?: boolean;
  author?: { name: string; username: string; color?: string };
  payment?: {
    status: PaymentProgress | null | undefined;
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
  shared = true,
  author,
  payment,
  onOpenRoster,
  rosterLabel = "领取名单",
}: EnvelopeProps) {
  const reduced = useReducedMotion();
  const {
    transition,
    shared: sharedNavigation,
    sharedLayoutEnabled,
    isPresent,
    moveDuration,
  } = useRedemptionTransition();
  const successfulReward = reward?.kind === "ldc" || reward?.kind === "text";
  const navigationIntent =
    reward &&
    shared &&
    transition?.shared !== false &&
    transition?.from === "home" &&
    transition.to === "activity"
      ? `navigation:${transition.id}`
      : null;
  const resultIntent =
    successfulReward && animationToken !== null
      ? `result:${animationToken}`
      : null;
  const navigatedOpen = navigationIntent !== null && sharedNavigation;
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
      : resultIntent !== null || navigatedOpen
        ? "closed"
        : "open";
  const [phase, setPhase] = useState<EnvelopePhase>(initialPhase);
  const [shownReward, setShownReward] = useState(reward ?? closingReward);
  const [animated, setAnimated] = useState(false);
  const [openingCount, setOpeningCount] = useState(0);
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

  useEffect(() => {
    const attempt = ++generation.current;
    const timers: ReturnType<typeof setTimeout>[] = [];
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
      const skippedIntent = navigationIntent ?? resultIntent;
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
      consumedIntent.current = null;
      setAnimated(false);
      if (currentPhase.current === "open" || currentPhase.current === "opening")
        close();
      else update("closed");
    } else {
      // Navigation opens any factual paper; only a successful reward can
      // supply a newly confirmed result event.
      const intent = navigatedOpen ? navigationIntent : resultIntent;
      if (intent) {
        if (consumedIntent.current?.key !== intent) {
          const now = Date.now();
          consumedIntent.current = {
            key: intent,
            startAt: navigatedOpen
              ? Math.max(
                  now,
                  (transition?.startedAt ?? now) + moveDuration * 1_000,
                )
              : now,
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
          const delay = event.startAt - Date.now();
          if (delay > 0) later(start, delay);
          else start();
        } else update("open");
      } else {
        update("open");
        setAnimated(false);
      }
    }
    return () => {
      generation.current++;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [
    closingReward,
    isPresent,
    moveDuration,
    navigatedOpen,
    navigationIntent,
    open,
    reduced,
    resultIntent,
    returningHome,
    // These are event identities; reward updates should not restart a timeline.
    transition?.from,
    transition?.startedAt,
  ]);

  const hasPaper = Boolean(shownReward) && phase !== "closed";
  // Presence controls interaction, while the exiting source keeps its original
  // layout allocation until the shared movement finishes.
  return (
    <div
      className={`envelope-stage redemption-envelope ${visualOpen ? "is-open" : ""}`}
      data-testid={isPresent ? "envelope" : undefined}
      data-size={size}
      data-open={open}
      data-reserve-result-space={reserveResultSpace || undefined}
      data-phase={phase}
      data-animate={animated && !reduced && open && isPresent}
      data-opening-count={openingCount}
      aria-hidden={!isPresent || size === "small" || undefined}
      inert={!isPresent || size === "small" || undefined}
    >
      <motion.div
        className="envelope"
        layoutId={
          shared && sharedLayoutEnabled ? "redemption-envelope" : undefined
        }
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
          <div className="envelope-author" title={author.name}>
            {isPresent && size === "detail" ? (
              <UserIdentity
                name={author.name}
                username={author.username}
                color={author.color}
              />
            ) : (
              <span className="envelope-author-static">
                <Avatar name={author.name} color={author.color} />
                <span>{author.name}</span>
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
    </div>
  );
}
