import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import {
  AnimatePresence,
  type HTMLMotionProps,
  motion,
  useIsPresent,
} from "motion/react";
import { type ReactNode, type Ref, useContext, useRef } from "react";
import { cn } from "../../lib/cn";
import { durations, ease, useReducedMotionPref } from "../../lib/motion";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";
import { LockedBy } from "./fields";
import { steps } from "./steps";
import { useMorphHeight } from "./use-morph-height";

/** A collapsed step's height; the next card covers its bottom 8px. */
export const STRIP_HEIGHT = 56;
export const OVERLAP = 8;

export type StepCardProps = {
  index: number;
  title: string;
  /** Collapsed: the answer. */
  summary: string;
  open: boolean;
  /** The card is the step being answered (aria-current). */
  current?: boolean;
  /** The card above is open (📝): no overlap under it. */
  afterOpen?: boolean;
  /** A card added after the page appeared grows from a strip. */
  grow?: boolean;
  /** A strip opens its step; on 📝 an open card collapses too. */
  onToggle?: () => void;
  /** 📝: the header is a button in both states. */
  collapsible?: boolean;
  locked?: boolean;
  /** Problems on this step, once it was checked. */
  problems?: number;
  headingRef?: Ref<HTMLElement>;
  children?: ReactNode;
};

/**
 * One step of the 发红包 flow. Collapsed it is a strip — number, title,
 * answer — that the next card overlaps by 8px, so the steps read as a stack
 * of cards; open it shows the step, raised on a plate. Only real heights
 * move (no scaling): the surface animates from its height to the new one,
 * the body and the answer cross-fade in place, and the cards below follow.
 */
export function StepCard({
  index,
  title,
  summary,
  open,
  current = false,
  afterOpen = false,
  grow = false,
  onToggle,
  collapsible = false,
  locked = false,
  problems = 0,
  headingRef,
  children,
}: StepCardProps) {
  const lockedBy = useContext(LockedBy);
  const reduced = useReducedMotionPref();
  const present = useIsPresent();
  const inner = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const height = useMorphHeight({
    phase: open,
    innerRef: inner,
    surfaceRef: surface,
    transition: { duration: reduced ? 0 : durations.travel, ease },
    enterFrom: grow ? STRIP_HEIGHT : undefined,
  });
  const fadeIn = {
    initial: { opacity: 0 },
    animate: {
      opacity: 1,
      transition: {
        duration: reduced ? 0.15 : durations.enter,
        delay: reduced ? 0 : 0.06,
      },
    },
    exit: {
      opacity: 0,
      transition: { duration: reduced ? 0.1 : durations.exit },
    },
  };
  const button = collapsible || !open;
  const label = `第 ${index + 1} 步 ${title}`;
  const head = (
    <>
      <Squircle radius={8}>
        <span
          aria-hidden="true"
          className={cn(
            "grid size-6 shrink-0 place-items-center text-xs font-semibold tabular-nums",
            open ? "bg-accent-soft text-accent-ink" : "bg-fill-2 text-ink-2",
          )}
        >
          {index + 1}
        </span>
      </Squircle>
      <span className="shrink-0 text-base font-semibold text-ink">{title}</span>
      {/* A fixed line: the answer leaving keeps its place, not the row's middle. */}
      <span className="relative h-5 min-w-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          {!open && (
            <motion.span
              key="summary"
              className="block truncate text-sm text-ink-2"
              {...fadeIn}
            >
              {summary}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      {problems > 0 && !open ? (
        <span className="shrink-0 text-sm text-danger">{problems} 处要改</span>
      ) : locked ? (
        <Lock className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
      ) : collapsible ? (
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-ink-3 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      ) : !open ? (
        <span className="flex shrink-0 items-center text-sm text-accent-ink">
          改
          <ChevronRight className="size-4" aria-hidden="true" />
        </span>
      ) : null}
    </>
  );
  const headClass =
    "step-head flex h-12 w-full items-center gap-3 px-4 text-left outline-none @wide/window:px-5";

  return (
    <motion.li
      className={cn("relative", !present && "overflow-hidden")}
      style={{ zIndex: open ? 2 : 1 }}
      aria-current={current ? "step" : undefined}
      initial={{ opacity: 0, marginTop: 0 }}
      animate={{
        opacity: 1,
        marginTop: index === 0 ? 0 : afterOpen ? OVERLAP : -OVERLAP,
      }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      transition={{ duration: reduced ? 0 : durations.travel, ease }}
    >
      <AnimatePresence initial={false}>
        {open && (
          <SquirclePlate
            key="plate"
            className="step-plate"
            radius={radius.card}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : durations.travel, ease }}
          />
        )}
      </AnimatePresence>
      <Squircle radius={radius.card}>
        <motion.div
          ref={surface}
          className="step-card relative overflow-hidden"
          data-open={open || undefined}
          style={{ height }}
        >
          <div ref={inner} className={cn("relative", !open && "pb-2")}>
            <h2 className="m-0">
              {button ? (
                <button
                  type="button"
                  className={headClass}
                  aria-expanded={collapsible ? open : false}
                  aria-label={`${label}：${summary}${
                    locked
                      ? lockedBy === "scheduled"
                        ? "，定时以后不能修改"
                        : "，开放后不能修改"
                      : ""
                  }${problems > 0 ? `，有 ${problems} 处要改` : ""}${
                    open ? "" : collapsible ? "" : "，修改"
                  }`}
                  ref={
                    open ? (headingRef as Ref<HTMLButtonElement>) : undefined
                  }
                  onClick={onToggle}
                >
                  {head}
                </button>
              ) : (
                <span
                  ref={headingRef as Ref<HTMLSpanElement>}
                  tabIndex={-1}
                  className={headClass}
                >
                  <span className="sr-only">
                    第 {index + 1} 步，共 {steps.length} 步：
                  </span>
                  {head}
                </span>
              )}
            </h2>
            <AnimatePresence mode="popLayout" initial={false}>
              {open && (
                <StepBody key="body" {...fadeIn}>
                  {children}
                </StepBody>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </Squircle>
    </motion.li>
  );
}

/** A step's body; leaving (fading out), it can no longer be reached. */
function StepBody({
  ref,
  children,
  ...fade
}: {
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
} & Pick<HTMLMotionProps<"div">, "initial" | "animate" | "exit">) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      inert={!present}
      className="grid grid-cols-[minmax(0,1fr)] gap-5 px-4 pt-1 pb-5 @wide/window:px-5"
      {...fade}
    >
      {children}
    </motion.div>
  );
}

/**
 * The steps as a stack (an ordered list): cards that leave fold away. Its
 * one column never grows past the window: a long summary on a strip is cut
 * short, not the form widened (minmax(0, 1fr)).
 */
export function StepStack({ children }: { children: ReactNode }) {
  return (
    <ol className="step-stack grid grid-cols-[minmax(0,1fr)] [overflow-anchor:none]">
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </ol>
  );
}
