import type { ActivityImagePresentation } from "@hb/contracts";
import { useRouter } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
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
  useState,
} from "react";
import { sessionScope, useSession } from "../../lib/auth";
import { exchangeContextAtom } from "../../lib/discovery";
import { afterNavigationLayout } from "../../lib/navigation-state";
import {
  redemptionIntentAtom,
  rewardAnimationAtom,
} from "../../lib/redemption-intent";

type Page = "home" | "activity" | "other";
type SharedPart = "password" | "label" | "hint" | "action";
type Geometry = { x: number; y: number; width: number; height: number };

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
  sourceRect?: { x: number; y: number; width: number; height: number };
  fields?: Partial<Record<SharedPart, Geometry>>;
}

const TransitionContext = createContext<RedemptionTransition | null>(null);
const MovementContext = createContext<(id: number) => number>(() => Date.now());
let nextNavigationId = 0;
const activityDocumentId = crypto.randomUUID();
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

export function RedemptionTransitionProvider({
  transition,
  children,
}: {
  transition: RedemptionTransition | null;
  children: ReactNode;
}) {
  return (
    <TransitionContext.Provider value={transition}>
      <LayoutGroup id="redemption-transition">{children}</LayoutGroup>
    </TransitionContext.Provider>
  );
}

export function useRedemptionTransition() {
  const transition = useContext(TransitionContext);
  const beginMovement = useContext(MovementContext);
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
      beginMovement,
    }),
    [beginMovement, isPresent, reduced, shared, transition],
  );
}

/** The target owns the action; the exiting counterpart is an inert visual. */
export function RedemptionAction({
  children,
  disabled,
  ...props
}: HTMLMotionProps<"button">) {
  const { sharedLayoutEnabled, moveDuration, isPresent } =
    useRedemptionTransition();
  const ref = useSharedField<HTMLButtonElement>("action", true);
  return (
    <motion.button
      ref={ref}
      data-redemption-part="action"
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
}

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

type EnvelopeSnapshot = {
  reward?: EnvelopeReward;
  presentation?: ActivityImagePresentation;
  identity?: string;
};
const SnapshotContext = createContext<
  (snapshot: EnvelopeSnapshot | undefined) => void
>(() => {});
export function useEnvelopeSnapshot(snapshot: EnvelopeSnapshot | undefined) {
  const save = useContext(SnapshotContext);
  useLayoutEffect(() => {
    save(snapshot);
  }, [save, snapshot]);
}

/** Observe real router transitions, including browser history; keep only visual facts. */
export function RedemptionNavigation({ children }: { children: ReactNode }) {
  const router = useRouter();
  const session = useSession();
  const identity = session.isSuccess
    ? sessionScope(session.data)
    : "unconfirmed";
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const setIntent = useSetAtom(redemptionIntentAtom);
  const setExchangeContext = useSetAtom(exchangeContextAtom);
  const setRewardAnimation = useSetAtom(rewardAnimationAtom);
  const previousIdentity = useRef(identity);
  const [transition, setTransition] = useState<RedemptionTransition | null>(
    null,
  );
  const snapshot = useRef<EnvelopeSnapshot | undefined>(undefined);
  const movement = useRef<{ id: number; startedAt: number } | null>(null);
  const beginMovement = useMemo(
    () => (id: number) => {
      if (movement.current?.id === id) return movement.current.startedAt;
      const startedAt = Date.now();
      movement.current = { id, startedAt };
      setTransition((current) =>
        current?.id === id ? { ...current, startedAt } : current,
      );
      return startedAt;
    },
    [],
  );
  const save = useMemo(
    () => (value: EnvelopeSnapshot | undefined) => {
      snapshot.current = value;
    },
    [],
  );
  useLayoutEffect(() => {
    if (
      previousIdentity.current !== "unconfirmed" &&
      previousIdentity.current !== identity
    ) {
      setIntent(null);
      setExchangeContext(null);
      setRewardAnimation(null);
    }
    previousIdentity.current = identity;
    if (snapshot.current?.identity !== identity) snapshot.current = undefined;
    setTransition((current) =>
      current?.closingIdentity !== undefined &&
      current.closingIdentity !== identity
        ? {
            ...current,
            closingReward: undefined,
            closingPresentation: undefined,
            closingIdentity: undefined,
          }
        : current,
    );
  }, [identity, setIntent, setExchangeContext, setRewardAnimation]);
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", (event) => {
        if (event.fromLocation?.pathname === event.toLocation.pathname) return;
        const page = (path: string): Page =>
          path === "/"
            ? "home"
            : /^\/activities\/[^/]+$/.test(path) && path !== "/activities/new"
              ? "activity"
              : "other";
        const from = page(event.fromLocation?.pathname ?? "");
        const to = page(event.toLocation.pathname);
        const closing =
          from === "activity" &&
          to === "home" &&
          snapshot.current?.identity === currentIdentity.current
            ? snapshot.current
            : undefined;
        setIntent((current) =>
          current &&
          event.toLocation.pathname === `/activities/${current.activityId}`
            ? current
            : null,
        );
        const source = document
          .querySelector<HTMLElement>("[data-shared-envelope] .envelope")
          ?.getBoundingClientRect();
        const fields: Partial<Record<SharedPart, Geometry>> = {};
        for (const part of ["password", "label", "hint", "action"] as const) {
          const rect = document
            .querySelector(`[data-redemption-part="${part}"]`)
            ?.getBoundingClientRect();
          if (rect)
            fields[part] = {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            };
        }
        setTransition({
          id: ++nextNavigationId,
          fields,
          sourceRect: source
            ? {
                x: source.x,
                y: source.y,
                width: source.width,
                height: source.height,
              }
            : undefined,
          from,
          to,
          activityId:
            to === "activity"
              ? event.toLocation.pathname.split("/").at(-1)
              : undefined,
          closingReward: closing?.reward,
          closingPresentation: closing?.presentation,
          closingIdentity: closing?.identity,
        });
        snapshot.current = undefined;
      }),
    [router, setIntent],
  );
  return (
    <MovementContext.Provider value={beginMovement}>
      <SnapshotContext.Provider value={save}>
        <RedemptionTransitionProvider transition={transition}>
          {children}
        </RedemptionTransitionProvider>
      </SnapshotContext.Provider>
    </MovementContext.Provider>
  );
}

/** Animate the sole live field without scaling its text or retaining the old input. */
export function useSharedField<T extends HTMLElement>(
  part: SharedPart,
  enabled: boolean,
) {
  const ref = useRef<T>(null);
  const { transition, shared } = useRedemptionTransition();
  const transitionId = transition?.id;
  const destination = transition?.to;
  const source = transition?.fields?.[part];
  useLayoutEffect(() => {
    const node = ref.current;
    if (!enabled || !shared || transitionId === undefined || !node || !source)
      return;
    const page = node.closest(".home-page")
      ? "home"
      : node.closest(".activity-page")
        ? "activity"
        : "other";
    // onBeforeNavigate updates both the still-live source and the destination.
    // Only the destination may animate from the captured source.
    if (page !== destination) return;
    return afterNavigationLayout(() => {
      const target = node.getBoundingClientRect();
      if (!target.width || !target.height) return;
      // Inputs may arrive after the loading envelope has already moved. Give
      // the newly mounted field its full movement from its measured source.
      const duration = 300;
      const animation = node.animate(
        [
          {
            transform: `translate(${source.x - target.x}px,${source.y - target.y}px)`,
            width: `${source.width}px`,
            height: `${source.height}px`,
          },
          {
            transform: "translate(0px,0px)",
            width: `${target.width}px`,
            height: `${target.height}px`,
          },
        ],
        { duration, easing: "ease-in-out" },
      );
      return () => animation.cancel();
    });
  }, [destination, enabled, shared, source, transitionId]);
  return ref;
}

const movingRects = new Map<
  number,
  { x: number; y: number; width: number; height: number }
>();
/** Keep geometry across the real loading/ready route boundary without retaining private DOM. */
export function SharedEnvelope({
  children,
  page,
}: {
  children: ReactNode;
  page: "home" | "activity";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const beginMovement = useContext(MovementContext);
  const { transition, shared } = useRedemptionTransition();
  const transitionId = transition?.id;
  const destination = transition?.to;
  const sourceRect = transition?.sourceRect;
  useLayoutEffect(() => {
    const node = ref.current;
    const source =
      transitionId !== undefined
        ? (movingRects.get(transitionId) ?? sourceRect)
        : undefined;
    if (
      !node ||
      !shared ||
      transitionId === undefined ||
      destination !== page ||
      !source
    )
      return;
    const body = node.querySelector<HTMLElement>(".envelope");
    if (!body) return;
    const sourceTransform = (target: DOMRect) =>
      `translate(${source.x - target.x}px,${source.y - target.y}px) scale(${source.width / target.width})`;
    const mountedTarget = body.getBoundingClientRect();
    // A newly mounted skeleton or live route must paint at the source pose.
    // Waiting for scroll/layout in a frame must not expose the final pose first.
    if (source.width && mountedTarget.width)
      node.style.transform = sourceTransform(mountedTarget);
    const cancelLayoutWait = afterNavigationLayout(() => {
      // Measure the destination without our source-pose transform.
      node.style.transform = "";
      const target = body.getBoundingClientRect();
      if (!source.width || !target.width) return;
      const startedAt = beginMovement(transitionId);
      const duration = Math.max(0, 300 - (Date.now() - startedAt));
      if (!duration) return;
      const initialTransform = sourceTransform(target);
      node.style.transform = initialTransform;
      const move = node.animate(
        [
          {
            transform: initialTransform,
          },
          { transform: "translate(0px,0px) scale(1)" },
        ],
        { duration, easing: "ease-in-out" },
      );
      move.onfinish = () => {
        node.style.transform = "";
      };
      return () => {
        const current = body.getBoundingClientRect();
        movingRects.clear();
        if (current.width)
          movingRects.set(transitionId, {
            x: current.x,
            y: current.y,
            width: current.width,
            height: current.height,
          });
        move.cancel();
        node.style.transform = "";
      };
    });
    return () => {
      cancelLayoutWait();
      node.style.transform = "";
    };
  }, [transitionId, destination, sourceRect, shared, beginMovement, page]);
  return (
    <div
      ref={ref}
      data-shared-envelope
      style={{
        width: "var(--envelope-width)",
        height: "var(--envelope-height)",
        transformOrigin: "top left",
      }}
    >
      {children}
    </div>
  );
}
