import { Link } from "@tanstack/react-router";
import { animate, motion, useMotionValue } from "motion/react";
import {
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import {
  durations,
  ease,
  scrollBehavior,
  useReducedMotionPref,
} from "../../lib/motion";
import { MorphLabel, RollingNumber } from "./morph-label";
import { radius, Squircle } from "./squircle";

// One switcher for tabs and filters everywhere (07 §1): a light grey bar
// whose chosen option sits on a raised white squircle. Choosing another
// slides that squircle over, at its real width, so its corners keep their
// shape (no scaling, 04 §3); counts roll and grow in place (MorphLabel).

type Size = "sm" | "md";

const sizes = {
  sm: {
    track: radius.segmentedSm,
    option: radius.segmentedSmOption,
    item: "h-8 px-2.5 text-xs",
  },
  md: {
    track: radius.segmented,
    option: radius.segmentedOption,
    item: "h-9 px-3.5 text-sm",
  },
} as const;

/**
 * Where the chosen option is, as the highlight's x and width: it slides
 * when the choice changes, and follows the option at once when the option
 * itself moves or resizes (a count arriving, an option added).
 */
function useHighlight(track: RefObject<HTMLElement | null>, index: number) {
  const reduced = useReducedMotionPref();
  const x = useMotionValue(0);
  const width = useMotionValue(0);
  const [placed, setPlaced] = useState(false);
  const shown = useRef<number | null>(null);
  const sliding = useRef(false);

  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    const option = () =>
      element.querySelectorAll<HTMLElement>("[data-segment]")[index] ?? null;
    const follow = () => {
      const target = option();
      if (!target || sliding.current) return;
      x.jump(target.offsetLeft);
      width.jump(target.offsetWidth);
    };
    const target = option();
    if (target) {
      const from = shown.current;
      shown.current = index;
      if (from === null || from === index || reduced) {
        x.jump(target.offsetLeft);
        width.jump(target.offsetWidth);
      } else {
        sliding.current = true;
        const settle = () => {
          sliding.current = false;
          follow();
        };
        animate(x, target.offsetLeft, {
          duration: durations.slide,
          ease,
          onComplete: settle,
        });
        animate(width, target.offsetWidth, {
          duration: durations.slide,
          ease,
        });
        // An option partly scrolled out of a long bar comes into view
        // (sideways only: the page itself does not move).
        const left = target.offsetLeft - 8;
        const right = target.offsetLeft + target.offsetWidth + 8;
        if (
          left < element.scrollLeft ||
          right > element.scrollLeft + element.clientWidth
        )
          element.scrollTo({
            left:
              left < element.scrollLeft ? left : right - element.clientWidth,
            behavior: scrollBehavior(),
          });
      }
      setPlaced(true);
    }
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    for (const item of element.querySelectorAll("[data-segment]"))
      observer.observe(item);
    return () => observer.disconnect();
  }, [track, index, reduced, x, width]);

  return { x, width, placed };
}

function Highlight({
  highlight,
  size,
}: {
  highlight: ReturnType<typeof useHighlight>;
  size: Size;
}) {
  return (
    <motion.span
      aria-hidden="true"
      className="pointer-events-none absolute top-0.5 bottom-0.5 left-0"
      style={{
        x: highlight.x,
        width: highlight.width,
        opacity: highlight.placed ? 1 : 0,
      }}
    >
      <Squircle radius={sizes[size].option}>
        <span className="block size-full bg-white raised" />
      </Squircle>
    </motion.span>
  );
}

/**
 * An option's face: the label (its width kept for the chosen weight, so
 * choosing does not shift the bar) and its count, which rolls as it changes
 * and grows in place when it first arrives.
 */
function Face({
  label,
  count,
  chosen,
}: {
  label: ReactNode;
  count?: number;
  chosen: boolean;
}) {
  return (
    <MorphLabel>
      {/* The chosen weight's width is kept (reserve-bold), so choosing
          does not shift the bar; the text is said once. */}
      <span
        className={cn(
          typeof label === "string" && "reserve-bold",
          chosen && "font-medium",
        )}
        data-text={typeof label === "string" ? label : undefined}
      >
        {label}
      </span>
      {/* In the label's run (MorphLabel): spaced by its own margin. */}
      {count !== undefined && (
        <span className="ms-1.5 text-ink-3">
          <RollingNumber value={count} />
        </span>
      )}
    </MorphLabel>
  );
}

const itemClass = (size: Size, chosen: boolean, stretch: boolean) =>
  cn(
    "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap transition-colors",
    stretch && "flex-1 justify-center",
    sizes[size].item,
    chosen ? "text-ink" : "text-ink-2 hover:text-ink",
  );

const trackClass = (stretch: boolean) =>
  cn(
    "relative inline-flex w-fit min-w-0 max-w-full overflow-x-auto bg-fill-2 p-0.5 scrollbar-none",
    stretch && "flex w-full",
  );

/** A few mutually exclusive options in one bar (tabs or filters). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
  disabled = false,
  stretch = false,
}: {
  value: T;
  options: { value: T; label: ReactNode; count?: number }[];
  onChange: (value: T) => void;
  label: string;
  size?: Size;
  /** Locked (开放后不能修改): shows the choice, takes no input. */
  disabled?: boolean;
  /** Fills its row, the options sharing it (the 名单弹窗's two lists). */
  stretch?: boolean;
}) {
  const track = useRef<HTMLFieldSetElement>(null);
  const highlight = useHighlight(
    track,
    options.findIndex((option) => option.value === value),
  );
  return (
    <Squircle radius={sizes[size].track}>
      <fieldset
        ref={track}
        aria-label={label}
        disabled={disabled}
        className={cn(
          trackClass(stretch),
          disabled && "opacity-60 [&_button]:cursor-not-allowed",
        )}
      >
        <Highlight highlight={highlight} size={size} />
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            data-segment=""
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={itemClass(size, value === option.value, stretch)}
          >
            <Face
              label={option.label}
              count={option.count}
              chosen={value === option.value}
            />
          </button>
        ))}
      </fieldset>
    </Squircle>
  );
}

/**
 * The same bar for pages of their own (网站管理's tabs): links, the current
 * one marked as the page. Kept mounted across those pages, its highlight
 * slides from tab to tab.
 */
export function SegmentedNav({
  label,
  items,
  current,
  size = "md",
}: {
  label: string;
  items: { to: string; label: ReactNode }[];
  /** The `to` of the page shown. */
  current: string;
  size?: Size;
}) {
  const track = useRef<HTMLElement>(null);
  const highlight = useHighlight(
    track,
    items.findIndex((item) => item.to === current),
  );
  return (
    <Squircle radius={sizes[size].track}>
      <nav ref={track} aria-label={label} className={trackClass(false)}>
        <Highlight highlight={highlight} size={size} />
        {items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            data-segment=""
            aria-current={item.to === current ? "page" : undefined}
            className={itemClass(size, item.to === current, false)}
          >
            <Face label={item.label} chosen={item.to === current} />
          </Link>
        ))}
      </nav>
    </Squircle>
  );
}
