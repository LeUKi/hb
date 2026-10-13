import {
  type ActivityImagePresentation,
  renderActivityImage,
} from "@hb/contracts";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { usePrototypeNow } from "../time";
import type { PaymentProgress } from "../types";
import { PaymentConfirmation } from "./payment-confirmation";
import {
  useEnvelopeSnapshot,
  useRedemptionTransition,
} from "./redemption-transition";
import "./envelope.css";

export type EnvelopeReward =
  | { kind: "ldc"; amount: string }
  | { kind: "missed" | "not-won" | "ended" };
export type EnvelopePhase = "closed" | "opening" | "open" | "closing";

export interface EnvelopeProps {
  open: boolean;
  waiting?: boolean;
  reward?: EnvelopeReward;
  presentation?: ActivityImagePresentation;
  presentationIdentity?: string;
  size?: "small" | "detail";
  /** Reserve the eventual paper layout while an instant redemption is pending. */
  reserveResultSpace?: boolean;
  /** A confirmed result event. Re-rendering with the same token never replays it. */
  animationToken?: string | number | null;
  /** A page visit. Once its successful LDC paper arrives, show one full reveal. */
  entryToken?: string | number | null;
  shared?: boolean;
  author?: { name: string; username: string; color?: string };
  payment?: {
    status: PaymentProgress | null | undefined;
    confirmedAt?: string | null;
  };
  onOpenRoster?: () => void;
  rosterLabel?: string;
}

const openingDuration = 1.8;
const closingDuration = 0.3;

/** Presentation only: it never reads activities or dispatches reward operations. */
export function Envelope({
  open,
  waiting = false,
  reward,
  presentation,
  presentationIdentity,
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
  useEnvelopeSnapshot(
    size === "detail" && open
      ? { presentation, identity: presentationIdentity }
      : undefined,
  );
  const instanceId = useId();
  const now = usePrototypeNow(size === "detail");
  const reduced = useReducedMotion();
  const {
    transition,
    shared: sharedNavigation,
    sharedLayoutEnabled,
    isPresent,
    moveDuration,
  } = useRedemptionTransition();
  const successfulReward = reward?.kind === "ldc";
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
  const entryIntent =
    successfulReward && entryToken !== null ? `entry:${entryToken}` : null;
  const navigatedOpen = navigationIntent !== null && sharedNavigation;
  // A page visit and the result that arrives during it share one display event.
  // Query updates, dialogs, and same-page re-renders must not restart it.
  const openingIntent =
    entryIntent ?? (navigatedOpen ? navigationIntent : resultIntent);
  const closingReward =
    shared &&
    sharedNavigation &&
    transition?.from === "activity" &&
    transition.to === "home" &&
    (transition.closingIdentity === undefined ||
      transition.closingIdentity === presentationIdentity)
      ? transition.closingReward
      : undefined;
  const closingPresentation = closingReward
    ? transition?.closingPresentation
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
  const visualOpen = phase === "open" || phase === "opening";

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
      setShownReward(undefined);
      if (currentPhase.current === "open" || currentPhase.current === "opening")
        close();
      else update("closed");
    } else {
      // Navigation opens any factual paper from home; successful LDC visits
      // also reveal on direct entry, reload, and history traversal.
      const intent = openingIntent;
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
    openingIntent,
    open,
    reduced,
    returningHome,
    // These are event identities; reward updates should not restart a timeline.
    transition?.from,
    transition?.startedAt,
  ]);

  const hasPaper =
    Boolean(shownReward) &&
    phase !== "closed" &&
    (open || Boolean(closingReward));
  const source = hasPaper
    ? (presentation ?? closingPresentation)
    : presentation;
  const image: ActivityImagePresentation = source ?? {
    title: "",
    sender: author?.name || author?.username || "",
    state: hasPaper
      ? shownReward?.kind === "ldc"
        ? "claimed"
        : shownReward?.kind === "not-won"
          ? "not_won"
          : "ended"
      : "neutral",
    sealLabel: hasPaper
      ? shownReward?.kind === "not-won"
        ? "未中奖"
        : shownReward?.kind === "missed"
          ? "错过了"
          : "已结束"
      : waiting
        ? "读取中"
        : "",
    amount: shownReward?.kind === "ldc" ? `${shownReward.amount} LDC` : null,
    updatedAt: new Date(0),
  };
  const frozenSvg = useRef<{ key: string; markup: string } | null>(null);
  const revealKey = `${presentationIdentity ?? ""}:${openingIntent ?? ""}`;
  const incomingSvg = renderActivityImage({
    ...image,
    state: !hasPaper && image.state === "claimed" ? "active" : image.state,
    amount: hasPaper ? image.amount : null,
    instanceId,
    now: new Date(now),
    animated: phase === "opening" && !reduced,
    revealPhase: phase,
  });
  if (phase === "opening" && !reduced && open && isPresent && hasPaper) {
    if (frozenSvg.current?.key !== revealKey)
      frozenSvg.current = { key: revealKey, markup: incomingSvg };
  } else frozenSvg.current = null;
  const svg = frozenSvg.current?.markup ?? incomingSvg;
  const controlsVisible = hasPaper && size === "detail" && isPresent;
  // Presence controls interaction while the exiting source keeps its geometry.
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
      data-entry-token={entryToken ?? undefined}
      aria-hidden={!isPresent || size === "small" || undefined}
      inert={!isPresent || size === "small" || undefined}
    >
      <motion.div
        className="envelope"
        layoutId={
          shared && sharedLayoutEnabled ? "redemption-envelope" : undefined
        }
        transition={{ layout: { duration: moveDuration, ease: "easeInOut" } }}
      >
        <div
          className="envelope-svg"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Only the shared renderer emits escaped, scoped SVG with no links or scripts.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </motion.div>
      {controlsVisible && (
        <div
          className="envelope-actions"
          inert={phase !== "open" || undefined}
          aria-hidden={phase !== "open" || undefined}
        >
          {shownReward?.kind === "ldc" && (
            <PaymentConfirmation
              status={payment?.status}
              confirmedAt={payment?.confirmedAt}
            />
          )}
          {onOpenRoster && (
            <button
              type="button"
              className="envelope-roster-link"
              aria-haspopup="dialog"
              disabled={phase !== "open"}
              onClick={() => {
                if (phase === "open" && isPresent) onOpenRoster();
              }}
            >
              {rosterLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
