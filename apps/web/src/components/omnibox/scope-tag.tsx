import { Braces, KeyRound, X } from "lucide-react";
import {
  animate,
  type MotionValue,
  motion,
  useMotionValue,
  useTransform,
} from "motion/react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { durations, ease, useReducedMotionPref } from "../../lib/motion";
import { SMOOTHING, squirclePath } from "../../lib/squircle-path";
import { buttonHeight, buttonRadius } from "../ui/button";
import { HongbaoIcon } from "../ui/hongbao-icon";
import { useContentWidth } from "../ui/morph-label";
import { TagHint } from "../ui/tag-hint";
import { omniboxMetrics } from "./state";

// 作用域标签 (redesign/02 §4, 2026-10-29; its shape and motion 2026-11-16):
// a 主标签 6px above the box, its left edge on the box's, with the 红包's
// name and ×; an 图标标签 inside the box, the same squircle as its 提交
// button; and a neck between them across the box's top edge. One fill and
// one rim (gold on 代码判定's lacquer, which a dark page behind would
// swallow) around them as one shape.
//
// The neck is liquid: the parts are drawn twice, once blurred and cut at
// half (a "goo" filter), which melts them together with smooth curves
// wherever they come close, and once exactly, so the 主标签 and the
// 图标标签 keep their squircle corners. The rim follows the whole outline.
//
// It grows like a drop (user 2026-11-16): the 图标标签 pops into the box,
// pushing what is typed along; a drop draws up out of it through the box's
// top edge, swelling into a bud as the box moves down to make room; then
// the words come and push the bud out into the 主标签. Springs, so each
// part overshoots a little and settles. Going, the other way round: the
// words out first, the 主标签 drawn back into the bud, the bud sinking into
// the 图标标签 as the box comes back up, and the 图标标签 shrinking away,
// what is typed staying where the 协议标签 comes back. Folding back to the
// top bar it does none of that: the whole group fades with the box's
// contents as the box flies, and the room it made for the 主标签 is given
// back in the same flight (02 §4 收回顶栏).

export type ScopePurpose = "claim" | "verify" | "code";

/** Between the 主标签 and the box. */
const GAP = 6;
const TAG_RADIUS = 9;
/** The neck as drawn: the goo melts it down to about half, with its joins. */
const NECK = 10;
/** How far the goo reaches: the size of the curves where the parts meet. */
const GOO_BLUR = 4;

/**
 * The 图标标签: as tall as the box's 提交 button and as far from the box's
 * top, bottom and left as the button is from its top, bottom and right
 * (02 §4) — 44 and 10 on a wide window, 40 and 8 on a narrow one.
 */
function badgeOf(compact: boolean) {
  const size = compact ? buttonHeight.bar : buttonHeight.md;
  const left = (omniboxMetrics(compact).base - size) / 2;
  return {
    size,
    left,
    radius: compact ? buttonRadius.bar : buttonRadius.md,
    /** The neck's middle, the 图标标签's. */
    middle: left + size / 2,
  };
}

/** The box's inner padding either side: the 图标标签's and the button's. */
export const boxInset = (compact: boolean) => badgeOf(compact).left;

/** The 主标签's height. */
const tagHeight = (compact: boolean) => (compact ? 24 : 26);

/** What the box gives up above it for the 主标签 (02 §4: 30px / 32px). */
export const scopeTagSpace = (compact: boolean) => tagHeight(compact) + GAP;

/**
 * Black lacquer with a gold rim and gold words for 代码判定, the accent
 * with a faint light rim for the rest (02 §4).
 */
const tones: Record<
  ScopePurpose,
  { top: string; bottom: string; rim: string; ink: string }
> = {
  code: {
    top: "#2c2724",
    bottom: "#12100e",
    rim: "rgb(232 192 121 / 0.8)",
    ink: "#f3d38b",
  },
  claim: {
    top: "var(--color-accent-top)",
    bottom: "var(--color-accent-bottom)",
    rim: "rgb(255 255 255 / 0.5)",
    ink: "#fff",
  },
  verify: {
    top: "var(--color-accent-top)",
    bottom: "var(--color-accent-bottom)",
    rim: "rgb(255 255 255 / 0.5)",
    ink: "#fff",
  },
};

const icons = { claim: HongbaoIcon, verify: KeyRound, code: Braces };

/** A name for a 红包 with none (it should not happen). */
const fallbacks: Record<ScopePurpose, string> = {
  claim: "本红包",
  verify: "验证口令",
  code: "代码判定",
};

/**
 * The 协议标签's width with nothing typed (its icon alone, chips.tsx): what
 * the 图标标签's room gives way to, or grows from, in a box already open.
 */
export const SCHEME_CHIP_REST = 38;

/** How it goes: folding back in the open box, or with the box's contents. */
export type ScopeLeave = "fold" | "fade";

/** Each stage's progress, 0 to 1 (a spring may carry one past 1). */
export type ScopeGrowth = {
  /** Still drawn: growing, grown, or going. */
  rendered: boolean;
  badge: MotionValue<number>;
  /** The drop rising into the bud, and the box moving down for it, as one. */
  rise: MotionValue<number>;
  /** The words pushing the bud out into the 主标签. */
  spread: MotionValue<number>;
  /** The 主标签's words: out first when it folds, before it draws in. */
  words: MotionValue<number>;
  /** The whole group, fading with the box's contents (收回顶栏). */
  fade: MotionValue<number>;
  /** Where the 图标标签's room starts and ends: the 协议标签's, or nothing. */
  rest: MotionValue<number>;
};

type Stage = {
  value: "badge" | "rise" | "spread" | "words";
  delay: number;
} & (
  | { spring: { visualDuration: number; bounce: number } }
  | { duration: number; ease: [number, number, number, number] }
);

/**
 * Growing, like a drop: each stage a spring taking over from the one
 * before, so each part goes a little past and settles (02 §4 过渡).
 */
const GROW: Stage[] = [
  // Lands in the box: past its size, and back.
  { value: "badge", delay: 0, spring: { visualDuration: 0.32, bounce: 0.35 } },
  // Draws up and swells; a drop's give at the top.
  { value: "rise", delay: 0.16, spring: { visualDuration: 0.4, bounce: 0.18 } },
  // Pushed wide by the words: wider than they need, then settling.
  {
    value: "spread",
    delay: 0.44,
    spring: { visualDuration: 0.42, bounce: 0.28 },
  },
];

/**
 * Going: the words out first (02 §4: never cut short as it draws in on
 * them), the 主标签 back into the bud, the bud sinking (and the box with it),
 * then the 图标标签 with a breath in. Curves that speed up into each stage:
 * it is pulled back, not thrown.
 */
const SHRINK: Stage[] = [
  { value: "words", delay: 0, duration: 0.09, ease: [0.4, 0, 1, 1] },
  { value: "spread", delay: 0.03, duration: 0.22, ease: [0.4, 0, 0.6, 0.5] },
  { value: "rise", delay: 0.18, duration: 0.28, ease: [0.6, 0, 0.35, 1] },
  { value: "badge", delay: 0.38, duration: 0.24, ease: [0.36, 0, 0.66, -0.4] },
];

function stageTransition(stage: Stage, delay: number) {
  return "spring" in stage
    ? { type: "spring" as const, ...stage.spring, delay }
    : { duration: stage.duration, ease: stage.ease, delay };
}

/**
 * The 作用域标签 growing in while `present`, and away after: its stages, and
 * whether to draw it at all. `wait` (seconds, read as it starts) lets the
 * box arrive first when it opened with the scope; `leave` (read as it
 * goes) says whether the box stays open (fold) or flies away (fade).
 */
export function useScopeGrowth(
  present: boolean,
  wait: RefObject<number>,
  leave: RefObject<ScopeLeave>,
): ScopeGrowth {
  const reduced = useReducedMotionPref();
  const badge = useMotionValue(0);
  const rise = useMotionValue(0);
  const spread = useMotionValue(0);
  const words = useMotionValue(1);
  const fade = useMotionValue(1);
  const rest = useMotionValue(0);
  const [rendered, setRendered] = useState(present);
  const values = useRef({ badge, rise, spread, words });
  useEffect(() => {
    const all = values.current;
    const stages = [all.badge, all.rise, all.spread];
    const settle = () => {
      for (const value of stages) value.jump(0);
      all.words.jump(1);
      fade.jump(1);
    };
    if (present) setRendered(true);
    if (reduced) {
      if (present) for (const value of stages) value.jump(1);
      else settle();
      if (!present) setRendered(false);
      return;
    }
    let controls: ReturnType<typeof animate>[];
    if (present) {
      // Coming back while it was still going: from where it is, at once.
      const resumed = all.badge.get() > 0.01 || fade.get() < 1;
      const start = resumed ? 0 : wait.current;
      // Opened with the box, it grows from nothing; in a box already open,
      // from the 协议标签 it takes the place of.
      if (!resumed) rest.jump(start > 0 ? 0 : SCHEME_CHIP_REST);
      all.words.jump(1);
      controls = [
        ...(fade.get() < 1
          ? [animate(fade, 1, { duration: durations.fadeIn, ease })]
          : []),
        ...GROW.map((stage) =>
          animate(
            all[stage.value],
            1,
            stageTransition(stage, start + stage.delay * (resumed ? 0.5 : 1)),
          ),
        ),
      ];
    } else if (leave.current === "fade") {
      // With the box's contents, as the box flies: the room above it is
      // given back in the same flight, so it lands where its slot is.
      controls = [
        animate(fade, 0, { duration: durations.exit, ease }),
        animate(all.rise, 0, { duration: durations.travel, ease }),
      ];
    } else {
      rest.jump(SCHEME_CHIP_REST);
      controls = SHRINK.map((stage) =>
        animate(all[stage.value], 0, stageTransition(stage, stage.delay)),
      );
    }
    let stopped = false;
    if (!present)
      void Promise.all(controls).then(() => {
        if (stopped) return;
        settle();
        setRendered(false);
      });
    return () => {
      stopped = true;
      for (const control of controls) control.stop();
    };
  }, [present, reduced, wait, leave, fade, rest]);
  return { rendered, badge, rise, spread, words, fade, rest };
}

/**
 * The 图标标签's room in the box's row, where the protocol label would be:
 * it grows with the 图标标签, pushing what is typed along (the label itself
 * is drawn with the 主标签, ScopeTag).
 */
export function ScopeBadgeSpace({
  compact,
  growth,
  children,
}: {
  compact: boolean;
  growth: ScopeGrowth;
  /**
   * The 协议标签 coming back as the 图标标签 shrinks away over it (folding
   * in the open box): it fades in where it will stay.
   */
  children?: ReactNode;
}) {
  const { size } = badgeOf(compact);
  // From the 协议标签's width in a box already open (it never slides under
  // the 图标标签 nor jumps when the 协议标签 comes back), from nothing as
  // the box arrives; the row's gap (8px) comes and goes with it then.
  const width = useTransform(() => {
    const rest = growth.rest.get();
    return rest + (size - rest) * Math.max(0, growth.badge.get());
  });
  const marginRight = useTransform(() => {
    const rest = growth.rest.get();
    const b = growth.badge.get();
    return rest > 0 ? 0 : Math.min(0, b - 1) * 8;
  });
  const comeback = useTransform(() =>
    Math.max(0, Math.min(1, (1 - growth.badge.get()) * 1.5)),
  );
  return (
    <motion.span
      aria-hidden="true"
      className="relative shrink-0 self-stretch"
      style={{ width, marginRight }}
    >
      {children && (
        <motion.span
          className="absolute inset-y-0 left-0 flex items-center"
          style={{ opacity: comeback }}
        >
          {children}
        </motion.span>
      )}
    </motion.span>
  );
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const mix = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;

/**
 * The 作用域标签 over the box (from the box's top-left), as far grown as
 * `growth` says. `title` null: still being read, its place kept by a
 * sweeping placeholder.
 */
export function ScopeTag({
  purpose,
  title,
  compact,
  maxWidth,
  growth,
  onRemove,
}: {
  purpose: ScopePurpose;
  title: string | null;
  compact: boolean;
  /** The box's width: the 主标签 is never wider (02 §4). */
  maxWidth: number;
  growth: ScopeGrowth;
  onRemove: () => void;
}) {
  const reduced = useReducedMotionPref();
  const [contentRef, measured] = useContentWidth();
  const fillId = useId();
  const rimId = useId();
  const gooId = useId();
  const tone = tones[purpose];
  const Icon = icons[purpose];
  const height = tagHeight(compact);
  const { size, left, radius, middle } = badgeOf(compact);
  const name = title?.trim() || fallbacks[purpose];
  const label =
    purpose === "verify" && title?.trim() ? `验证 · ${title.trim()}` : name;

  // The 主标签's full width: its words' up to the box's, eased as they change.
  // A pixel to spare: the width is read whole, the words are not.
  const natural = measured === null ? left + size : measured.width + 1;
  const target = Math.max(height, Math.min(natural, maxWidth));
  const truncated = natural > maxWidth;
  const full = useMotionValue(target);
  useEffect(() => {
    if (reduced || measured?.instant) full.jump(target);
    else animate(full, target, { duration: 0.2, ease });
  }, [target, reduced, measured?.instant, full]);

  // The drop: out of the 图标标签's middle, up through the box's top edge
  // to where the 主标签 will sit, swelling into a bud as tall as it.
  const { badge, rise, spread, fade } = growth;
  const bud = useTransform(
    () => height * clamp01(Math.max(0, rise.get()) * 1.25) ** 0.8,
  );
  const budMiddle = useTransform(() =>
    mix(left + size * 0.4, -GAP - height / 2, Math.min(1.05, rise.get())),
  );
  // The bud pushed out by the words: its left edge to the box's, its right
  // to the words' end (a spring may carry it a little past, never past the
  // box), its round ends into the 主标签's squircle corners.
  const headLeft = useTransform(
    () =>
      middle - bud.get() / 2 - (middle - bud.get() / 2) * clamp01(spread.get()),
  );
  const headRight = useTransform(() =>
    Math.min(
      maxWidth,
      mix(middle + bud.get() / 2, full.get(), Math.max(0, spread.get())),
    ),
  );
  const headWidth = useTransform(() =>
    Math.max(0, headRight.get() - headLeft.get()),
  );
  const headTop = useTransform(() => budMiddle.get() - bud.get() / 2);
  const words = useTransform(
    () => clamp01((spread.get() - 0.12) / 0.45) * growth.words.get(),
  );
  // Squeezed out of the bud: the words come from a little to its side.
  const wordsShift = useTransform(() => mix(-6, 0, clamp01(spread.get())));
  // Where the words sit inside the bud as it moves: their own place.
  const rowLeft = useTransform(() => -headLeft.get());
  const rowTop = useTransform(() => bud.get() / 2 - height / 2);

  // A computed value follows only what its first run read: everything is
  // read before anything is decided.
  const exact = useTransform(() => {
    const b = Math.max(0, badge.get());
    const tall = bud.get();
    const s = clamp01(spread.get());
    const head = [headLeft.get(), headTop.get(), headWidth.get()] as const;
    const side = size * b;
    const parts = [
      squirclePath(
        middle - side / 2,
        left + size / 2 - side / 2,
        side,
        side,
        radius * Math.min(1, b),
      ),
    ];
    if (tall > 0.5)
      parts.push(
        squirclePath(
          head[0],
          head[1],
          head[2],
          tall,
          mix(tall / 2, TAG_RADIUS, s),
          mix(0, SMOOTHING, s),
        ),
      );
    return parts.join("");
  });
  // What the goo melts together: the parts and a neck from the 图标标签's
  // middle to the bud's, thicker while the drop is still drawing up.
  const molten = useTransform(() => {
    const parts = exact.get();
    const q = rise.get();
    const b = badge.get();
    const top = budMiddle.get();
    if (q <= 0.02 || b <= 0.3) return parts;
    const width = mix(NECK + 4, NECK, clamp01(q));
    const bottom = left + size / 2;
    return `${parts}M${middle - width / 2} ${top}h${width}V${bottom}h${-width}Z`;
  });

  const iconScale = useTransform(() => Math.max(0, badge.get()));
  const iconOpacity = useTransform(() =>
    Math.max(0, Math.min(1, badge.get() * 1.6 - 0.3)),
  );
  // Room above for a drop that rises a little past its place.
  const top = -(height + GAP + 12);

  const titleClass = "min-w-0 flex-1 truncate text-[13px] font-medium";
  const row = "items-center gap-0.5 pr-0.5 pl-2.5";
  const placeholder = (
    // Known to be a scope, its name not yet read (02 §4).
    <span
      className={cn(
        "loading-sheen h-3 w-[6em] shrink-0 rounded-full opacity-40",
        purpose === "code" && "loading-sheen-gold",
      )}
      style={{ background: tone.ink }}
    />
  );

  return (
    <motion.div
      className="pointer-events-none absolute inset-0"
      style={{ opacity: fade }}
    >
      <svg
        aria-hidden="true"
        className="absolute top-0 left-0 overflow-visible"
        width={maxWidth}
        height={left + size}
      >
        <defs>
          <linearGradient
            id={fillId}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1={-(height + GAP)}
            x2="0"
            y2={left + size}
          >
            <stop offset="0" stopColor={tone.top} />
            <stop offset="1" stopColor={tone.bottom} />
          </linearGradient>
          {/* Blurred and cut at half: the parts melt where they come close,
              and straight edges stay where they are. */}
          <filter
            id={gooId}
            filterUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
            x={-16}
            y={top - 16}
            width={maxWidth + 32}
            height={left + size - top + 32}
          >
            <feGaussianBlur stdDeviation={GOO_BLUR} />
            <feColorMatrix
              type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -12"
            />
          </filter>
          {/* One hairline round the whole outline, however far grown. */}
          <filter
            id={rimId}
            filterUnits="userSpaceOnUse"
            x={-16}
            y={top - 16}
            width={maxWidth + 32}
            height={left + size - top + 32}
          >
            <feMorphology
              in="SourceAlpha"
              operator="dilate"
              radius="0.9"
              result="grown"
            />
            <feFlood floodColor={tone.rim} result="ink" />
            <feComposite in="ink" in2="grown" operator="in" result="rim" />
            <feMerge>
              <feMergeNode in="rim" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g filter={`url(#${rimId})`}>
          <motion.path
            d={molten}
            fill={`url(#${fillId})`}
            filter={`url(#${gooId})`}
          />
          <motion.path d={exact} fill={`url(#${fillId})`} />
        </g>
      </svg>
      {/* The 主标签's words and ×, in their own place, shown as the bud
          grows round them. */}
      <motion.div
        className="pointer-events-auto absolute overflow-hidden"
        style={{
          left: headLeft,
          top: headTop,
          width: headWidth,
          height: bud,
          color: tone.ink,
        }}
        data-scope-tag={purpose}
      >
        <motion.span
          className={cn("absolute flex min-w-0", row)}
          style={{
            left: rowLeft,
            top: rowTop,
            height,
            width: full,
            x: wordsShift,
            opacity: words,
          }}
        >
          {title === null ? (
            placeholder
          ) : truncated ? (
            // Cut short: the whole name on hover or a tap (02 §4).
            <TagHint
              hint={label}
              aria-label={label}
              onMouseDown={(event) => event.preventDefault()}
              className={cn(titleClass, "cursor-help text-left")}
            >
              {label}
            </TagHint>
          ) : (
            <span className={titleClass}>{label}</span>
          )}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onRemove}
            aria-label="改为查找全部红包"
            title="改为查找全部红包（退格）"
            className="grid size-5 shrink-0 place-items-center rounded-full opacity-80 hover:bg-white/15 hover:opacity-100"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </motion.span>
      </motion.div>
      {/* Its natural width, unbounded: what the 主标签 spreads to. */}
      <span
        ref={contentRef}
        aria-hidden="true"
        className={cn(
          "invisible absolute top-0 left-0 inline-flex w-max whitespace-nowrap",
          row,
        )}
        style={{ height }}
      >
        {title === null ? (
          placeholder
        ) : (
          <span className="text-[13px] font-medium">{label}</span>
        )}
        <span className="size-5 shrink-0" />
      </span>
      {/* The 图标标签's icon, swelling with it. */}
      <motion.span
        aria-hidden="true"
        className="absolute grid place-items-center"
        style={{
          left,
          top: left,
          width: size,
          height: size,
          color: tone.ink,
          scale: iconScale,
          opacity: iconOpacity,
        }}
      >
        <Icon className="size-[18px]" />
      </motion.span>
    </motion.div>
  );
}
