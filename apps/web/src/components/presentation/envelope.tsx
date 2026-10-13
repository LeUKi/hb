import {
  type ActivityImagePresentation,
  type PaymentState,
  type PublicUserProfile,
  renderActivityImage,
} from "@hb/contracts";
import {
  animate as animateValue,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useNow } from "../../lib/clock";
import { afterNavigationLayout } from "../../lib/navigation-state";
import { PaymentConfirmation } from "./payment-confirmation";
import {
  SharedEnvelope,
  useEnvelopeSnapshot,
  useRedemptionTransition,
} from "./redemption-transition";

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
      ? { reward, presentation, identity: presentationIdentity }
      : undefined,
  );
  const instanceId = useId();
  const now = useNow(size === "detail");
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
    transition.to === "home" &&
    (transition.closingIdentity === undefined ||
      transition.closingIdentity === presentationIdentity)
      ? transition.closingReward
      : undefined;
  const closingPresentation =
    closingReward &&
    (transition?.closingIdentity === undefined ||
      transition.closingIdentity === presentationIdentity)
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
  const source = hasPaper
    ? (presentation ?? closingPresentation)
    : presentation;
  const image: ActivityImagePresentation = source ?? {
    title: "",
    sender: author?.displayName || author?.username || "",
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
        <div className="envelope">
          <div
            className="envelope-svg"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Only the shared renderer emits escaped, scoped SVG with no links or scripts.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </SharedEnvelope>
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
