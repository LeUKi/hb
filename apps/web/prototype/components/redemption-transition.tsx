import type { ActivityImagePresentation } from "@hb/contracts";
import {
  type HTMLMotionProps,
  LayoutGroup,
  motion,
  useIsPresent,
  usePresence,
  useReducedMotion,
} from "motion/react";
import {
  createContext,
  forwardRef,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { Page } from "../types";
import type { EnvelopeReward } from "./envelope";

export interface RedemptionTransition {
  id: number;
  /** Wall-clock navigation start, so late results do not restart the move wait. */
  startedAt?: number;
  from: Page;
  to: Page;
  activityId?: string;
  /** False when either visual source is unavailable or outside the viewport. */
  shared?: boolean;
  closingReward?: EnvelopeReward;
  closingPresentation?: ActivityImagePresentation;
  closingIdentity?: string;
}

const TransitionContext = createContext<RedemptionTransition | null>(null);
const activityDocumentId =
  globalThis.crypto?.randomUUID?.() ??
  `prototype-entry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let nextActivityEntryId = 0;

/** A display visit, independent of submissions and same-page dialog history. */
export function useActivityEntryToken(activityId: string) {
  const visit = useRef<{ activityId: string; token: string } | null>(null);
  if (visit.current?.activityId !== activityId)
    visit.current = {
      activityId,
      token: `${activityDocumentId}:${++nextActivityEntryId}`,
    };
  return visit.current.token;
}

type EnvelopeSnapshot = {
  presentation?: ActivityImagePresentation;
  identity?: string;
};
const SnapshotContext = createContext<
  (value: EnvelopeSnapshot | undefined) => void
>(() => {});

export function useEnvelopeSnapshot(snapshot: EnvelopeSnapshot | undefined) {
  const save = useContext(SnapshotContext);
  useLayoutEffect(() => save(snapshot), [save, snapshot]);
}

export function RedemptionTransitionProvider({
  transition,
  children,
}: {
  transition: RedemptionTransition | null;
  children: ReactNode;
}) {
  const snapshot = useRef<EnvelopeSnapshot | undefined>(undefined);
  const captured = useRef<RedemptionTransition | null>(null);
  if (!transition) captured.current = null;
  else if (captured.current?.id !== transition.id)
    captured.current = {
      ...transition,
      closingPresentation:
        transition.from === "activity" && transition.to === "home"
          ? snapshot.current?.presentation
          : undefined,
      closingIdentity:
        transition.from === "activity" && transition.to === "home"
          ? snapshot.current?.identity
          : undefined,
    };
  const save = useMemo(
    () => (value: EnvelopeSnapshot | undefined) => {
      snapshot.current = value;
    },
    [],
  );
  return (
    <SnapshotContext.Provider value={save}>
      <TransitionContext.Provider value={captured.current}>
        <LayoutGroup id="prototype-redemption-transition">
          {children}
        </LayoutGroup>
      </TransitionContext.Provider>
    </SnapshotContext.Provider>
  );
}

export function useRedemptionTransition() {
  const transition = useContext(TransitionContext);
  const reduced = useReducedMotion();
  const isPresent = useIsPresent();
  const shared =
    !reduced &&
    transition?.shared !== false &&
    ((transition?.from === "home" && transition.to === "activity") ||
      (transition?.from === "activity" && transition.to === "home"));
  return useMemo(
    () => ({
      transition,
      shared,
      // Register the idle source before navigation. Unrelated routes use zero
      // layout duration, so their shared IDs do not introduce visual movement.
      sharedLayoutEnabled: !reduced,
      isPresent,
      moveDuration: shared ? 0.3 : 0,
    }),
    [isPresent, reduced, shared, transition],
  );
}

/** The target owns the action; the exiting counterpart is an inert visual. */
export const RedemptionAction = forwardRef<
  HTMLButtonElement,
  HTMLMotionProps<"button">
>(function RedemptionAction({ children, disabled, ...props }, ref) {
  const { sharedLayoutEnabled, moveDuration, isPresent } =
    useRedemptionTransition();
  return (
    <motion.button
      ref={ref}
      {...props}
      disabled={disabled || !isPresent}
      aria-hidden={!isPresent || undefined}
      tabIndex={isPresent ? props.tabIndex : -1}
      layoutId={sharedLayoutEnabled ? "redemption-submit" : undefined}
      transition={{ layout: { duration: moveDuration, ease: "easeInOut" } }}
      data-redemption-action="true"
    >
      <motion.span
        className="redemption-action-label"
        layout="position"
        layoutId={sharedLayoutEnabled ? "redemption-submit-label" : undefined}
        transition={{ layout: { duration: moveDuration, ease: "easeInOut" } }}
      >
        {children}
      </motion.span>
    </motion.button>
  );
});

/** forwardRef lets popLayout measure this custom direct presence child. */
export const RedemptionRouteFrame = forwardRef<
  HTMLDivElement,
  {
    routeKey: string;
    children: ReactNode;
    className?: string;
  }
>(function RedemptionRouteFrame(
  { routeKey, children, className = "route-frame" },
  ref,
) {
  const { shared } = useRedemptionTransition();
  const [isPresent, safeToRemove] = usePresence();
  const reduced = useReducedMotion();
  useEffect(() => {
    if (isPresent) return;
    const timeout = setTimeout(safeToRemove, shared && !reduced ? 300 : 0);
    return () => clearTimeout(timeout);
  }, [isPresent, reduced, safeToRemove, shared]);
  if (!isPresent && !shared) return null;
  return (
    <motion.div
      ref={ref}
      className={className}
      data-route-key={routeKey}
      data-route-presence={isPresent ? "present" : "exiting"}
      inert={!isPresent}
      aria-hidden={!isPresent || undefined}
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: isPresent ? 1 : 0 }}
      transition={{ duration: reduced ? 0 : shared ? 0.3 : 0.15 }}
    >
      {children}
    </motion.div>
  );
});
