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
import { buttonHeight, buttonRadius } from "../ui/button";
import { HongbaoIcon } from "../ui/hongbao-icon";
import { useContentWidth } from "../ui/morph-label";
import { TagHint } from "../ui/tag-hint";
import { omniboxMetrics } from "./state";

// 作用域标签 (redesign/02 §4, 2026-10-29): a 主标签 6px above the box, its
// left edge on the box's, with the 红包's name and ×; an 图标标签 inside the
// box, mirroring its 提交 button; and an 8px 细连杆 between them across the
// box's top edge, round where it meets either. One fill and one rim (gold
// on 代码判定's lacquer, which a dark page behind would swallow) around
// them as one shape, so nothing shows where they meet.
//
// It grows (02 §4 过渡): the 图标标签 swells in the box, pushing what is
// typed along; the 连杆 shoots up out of it through the box's top edge;
// the 主标签 buds at its tip as the box moves down to make room, then
// spreads out to either side. Going, the other way round: the sides draw
// in, the bud sinks as the box comes back up, the 连杆 draws down, and the
// 图标标签 shrinks away, what is typed sliding back to where the 协议标签
// comes back. Folding back to the top bar it does none of that: the whole
// group fades with the box's contents as the box flies, and the room it
// made for the 主标签 is given back in the same flight (02 §4 收回顶栏).

export type ScopePurpose = "claim" | "verify" | "code";

/** Between the 主标签 and the box. */
const GAP = 6;
/** The 连杆, on the 图标标签's middle, and its round joins. */
const STEM = 8;
const JOIN_TOP = 4;
const JOIN_BOTTOM = 3;
const TAG_RADIUS = 9;

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
    /** The 连杆's middle, the 图标标签's. */
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
  stem: MotionValue<number>;
  /** The 主标签 budding, and the box moving down for it, as one. */
  rise: MotionValue<number>;
  /** The 主标签 spreading out to either side. */
  spread: MotionValue<number>;
  /** The 主标签's words: out first when it folds, before the sides draw in. */
  words: MotionValue<number>;
  /** The whole group, fading with the box's contents (收回顶栏). */
  fade: MotionValue<number>;
  /** Where the 图标标签's room starts and ends: the 协议标签's, or nothing. */
  rest: MotionValue<number>;
};

type Stage = {
  value: "badge" | "stem" | "rise" | "spread" | "words";
  delay: number;
  duration: number;
  ease: [number, number, number, number];
};

/** Growing: each stage takes over from the one before (02 §4 过渡). */
const GROW: Stage[] = [
  // Swells, a little past its size, and settles.
  { value: "badge", delay: 0, duration: 0.36, ease: [0.34, 1.45, 0.64, 1] },
  { value: "stem", delay: 0.2, duration: 0.22, ease: [0.45, 0, 0.2, 1] },
  { value: "rise", delay: 0.34, duration: 0.42, ease: [0.22, 1, 0.36, 1] },
  { value: "spread", delay: 0.48, duration: 0.5, ease: [0.3, 1.32, 0.5, 1] },
];

/**
 * Going: the words out first (02 §4: never cut short as the sides close
 * on them), the sides, then the bud and the box, the 连杆, the 图标标签.
 */
const SHRINK: Stage[] = [
  { value: "words", delay: 0, duration: 0.1, ease: [0.4, 0, 1, 1] },
  { value: "spread", delay: 0.06, duration: 0.22, ease: [0.55, 0, 0.75, 0.2] },
  { value: "rise", delay: 0.18, duration: 0.3, ease: [0.6, 0, 0.3, 1] },
  { value: "stem", delay: 0.38, duration: 0.16, ease: [0.5, 0, 0.8, 0.4] },
  // A breath in before it goes.
  { value: "badge", delay: 0.48, duration: 0.26, ease: [0.36, 0, 0.66, -0.5] },
];

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
  const stem = useMotionValue(0);
  const rise = useMotionValue(0);
  const spread = useMotionValue(0);
  const words = useMotionValue(1);
  const fade = useMotionValue(1);
  const rest = useMotionValue(0);
  const [rendered, setRendered] = useState(present);
  const values = useRef({ badge, stem, rise, spread, words });
  useEffect(() => {
    const all = values.current;
    const stages = [all.badge, all.stem, all.rise, all.spread];
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
          animate(all[stage.value], 1, {
            delay: start + stage.delay * (resumed ? 0.5 : 1),
            duration: stage.duration,
            ease: stage.ease,
          }),
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
        animate(all[stage.value], 0, {
          delay: stage.delay,
          duration: stage.duration,
          ease: stage.ease,
        }),
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
  return { rendered, badge, stem, rise, spread, words, fade, rest };
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
  const marginRight = useTransform(() =>
    growth.rest.get() > 0 ? 0 : Math.min(0, growth.badge.get() - 1) * 8,
  );
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

/** A round join: `x`,`y` its inner corner, `dx`,`dy` which way it reaches. */
function join(x: number, y: number, dx: number, dy: number, r: number) {
  if (r <= 0.1) return "";
  const sweep = dx * dy > 0 ? 1 : 0;
  return `M${x} ${y}L${x + dx * r} ${y}A${r} ${r} 0 0 ${sweep} ${x} ${y + dy * r}Z`;
}

/** A rounded rectangle as a path. */
function box(x: number, y: number, w: number, h: number, r: number) {
  if (w <= 0 || h <= 0) return "";
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M${x + k} ${y}L${x + w - k} ${y}A${k} ${k} 0 0 1 ${x + w} ${y + k}L${x + w} ${y + h - k}A${k} ${k} 0 0 1 ${x + w - k} ${y + h}L${x + k} ${y + h}A${k} ${k} 0 0 1 ${x} ${y + h - k}L${x} ${y + k}A${k} ${k} 0 0 1 ${x + k} ${y}Z`;
}

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
  const tone = tones[purpose];
  const Icon = icons[purpose];
  const height = tagHeight(compact);
  const { size, left, radius, middle } = badgeOf(compact);
  const name = title?.trim() || fallbacks[purpose];
  const label =
    purpose === "verify" && title?.trim() ? `验证 · ${title.trim()}` : name;

  // The 主标签's full width: its words' up to the box's, eased as they change.
  // A pixel to spare: the width is read whole, the words are not.
  const bud = STEM + JOIN_TOP * 2;
  const natural = measured === null ? left + size : measured.width + 1;
  const target = Math.max(left + size, Math.min(natural, maxWidth));
  const truncated = natural > maxWidth;
  const full = useMotionValue(target);
  useEffect(() => {
    if (reduced || measured?.instant) full.jump(target);
    else animate(full, target, { duration: 0.2, ease });
  }, [target, reduced, measured?.instant, full]);

  // The 主标签 as it grows: a bud on the 连杆's tip, its foot GAP above the
  // box, rising out of it, then spreading to the box's left edge and to
  // its full width on the right.
  const { badge, stem, rise, spread, fade } = growth;
  const headHeight = useTransform(() => height * Math.max(0, rise.get()));
  const headTop = useTransform(() => -GAP - headHeight.get());
  const headLeft = useTransform(
    () => middle - bud / 2 - (middle - bud / 2) * spread.get(),
  );
  const headRight = useTransform(() =>
    Math.min(
      maxWidth,
      middle + bud / 2 + (full.get() - middle - bud / 2) * spread.get(),
    ),
  );
  const headWidth = useTransform(() => headRight.get() - headLeft.get());
  const words = useTransform(
    () =>
      Math.max(0, Math.min(1, (spread.get() - 0.55) / 0.4)) *
      growth.words.get(),
  );

  const shape = useTransform(() => {
    const b = Math.max(0, badge.get());
    const s = Math.max(0, Math.min(1, stem.get()));
    const h = headHeight.get();
    const parts: string[] = [];
    // The 图标标签, swelling from its middle.
    const side = size * b;
    parts.push(
      box(
        middle - side / 2,
        left + size / 2 - side / 2,
        side,
        side,
        radius * Math.min(1, b),
      ),
    );
    if (s > 0) {
      // The 连杆, up from the 图标标签 (2px into it) to the 主标签 (2px in).
      const top = left - s * (left + GAP + 2);
      const x = middle - STEM / 2;
      parts.push(box(x, top, STEM, left + 2 - top, Math.min(STEM / 2, 1.5)));
      const low = JOIN_BOTTOM * Math.min(1, s * 3);
      parts.push(join(x, left, -1, -1, low), join(x + STEM, left, 1, -1, low));
      if (h > 0) {
        const high = JOIN_TOP * Math.min(1, h / 6);
        parts.push(
          join(x, -GAP, -1, 1, high),
          join(x + STEM, -GAP, 1, 1, high),
        );
      }
    }
    if (h > 0)
      parts.push(
        box(
          headLeft.get(),
          -GAP - h,
          headWidth.get(),
          h,
          Math.min(TAG_RADIUS, h / 2),
        ),
      );
    return parts.join("");
  });

  const iconScale = useTransform(() => Math.max(0, badge.get()));
  const iconOpacity = useTransform(() =>
    Math.max(0, Math.min(1, badge.get() * 1.6 - 0.3)),
  );
  const top = -(height + GAP + 4);

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
            y1={top}
            x2="0"
            y2={left + size}
          >
            <stop offset="0" stopColor={tone.top} />
            <stop offset="1" stopColor={tone.bottom} />
          </linearGradient>
          {/* One hairline round the parts as one shape, however far grown. */}
          <filter
            id={rimId}
            filterUnits="userSpaceOnUse"
            x={-8}
            y={top - 8}
            width={maxWidth + 16}
            height={left + size - top + 16}
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
        <motion.path
          d={shape}
          fill={`url(#${fillId})`}
          filter={`url(#${rimId})`}
        />
      </svg>
      {/* The 主标签's words and ×, over its shape, rising with it. */}
      <motion.div
        className="pointer-events-auto absolute overflow-hidden"
        style={{
          left: headLeft,
          top: headTop,
          width: headWidth,
          height: headHeight,
          color: tone.ink,
        }}
        data-scope-tag={purpose}
      >
        <motion.span
          className={cn("absolute bottom-0 left-0 flex min-w-0", row)}
          style={{ height, width: headWidth, opacity: words }}
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
