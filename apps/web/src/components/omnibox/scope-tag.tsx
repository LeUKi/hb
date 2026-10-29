import { Braces, KeyRound, X } from "lucide-react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { type Ref, useEffect, useId, useState } from "react";
import { cn } from "../../lib/cn";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { buttonHeight, buttonRadius } from "../ui/button";
import { HongbaoIcon } from "../ui/hongbao-icon";
import { useContentWidth } from "../ui/morph-label";
import { TagHint } from "../ui/tag-hint";
import { omniboxMetrics } from "./state";

// 作用域标签 (redesign/02 §4, 2026-10-29): a 主标签 6px above the box, its
// left edge on the box's, with the 红包's name and ×; an 图标标签 inside the
// box, mirroring its 提交 button; and an 8px 细连杆 between them across the box's
// top edge, round where it meets either. The three are drawn as one shape,
// one fill and one hairline rim (gold on 代码判定's lacquer, which a dark
// page behind would swallow), so nothing shows where they meet. It hangs
// over the box from the omnibox's frame; the box keeps the 图标标签's room
// in its row (ScopeBadgeSpace) and makes way above for the 主标签.

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
  const stem = left + (size - STEM) / 2;
  return {
    size,
    left,
    radius: compact ? buttonRadius.bar : buttonRadius.md,
    stem,
    /** The 主标签 is never narrower than the 图标标签 reaches. */
    reach: left + size,
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
    rim: "rgb(232 192 121 / 0.75)",
    ink: "#f3d38b",
  },
  claim: {
    top: "var(--color-accent-top)",
    bottom: "var(--color-accent-bottom)",
    rim: "rgb(255 255 255 / 0.45)",
    ink: "#fff",
  },
  verify: {
    top: "var(--color-accent-top)",
    bottom: "var(--color-accent-bottom)",
    rim: "rgb(255 255 255 / 0.45)",
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
 * The outline of the three as one, from the 主标签's top-left: `width` the
 * 主标签's, `tag` its height, `badge` the 图标标签's top.
 */
function outline(
  width: number,
  tag: number,
  badge: number,
  { size, left: x, radius: b, stem, reach }: ReturnType<typeof badgeOf>,
) {
  const w = Math.max(reach, width);
  const r = TAG_RADIUS;
  const left = stem;
  const right = stem + STEM;
  const end = x + size;
  const foot = badge + size;
  return [
    `M0 ${r}A${r} ${r} 0 0 1 ${r} 0L${w - r} 0A${r} ${r} 0 0 1 ${w} ${r}`,
    `L${w} ${tag - r}A${r} ${r} 0 0 1 ${w - r} ${tag}`,
    // Down the 连杆's right side, round at both ends.
    `L${right + JOIN_TOP} ${tag}A${JOIN_TOP} ${JOIN_TOP} 0 0 0 ${right} ${tag + JOIN_TOP}`,
    `L${right} ${badge - JOIN_BOTTOM}A${JOIN_BOTTOM} ${JOIN_BOTTOM} 0 0 0 ${right + JOIN_BOTTOM} ${badge}`,
    // Round the 图标标签.
    `L${end - b} ${badge}A${b} ${b} 0 0 1 ${end} ${badge + b}L${end} ${foot - b}`,
    `A${b} ${b} 0 0 1 ${end - b} ${foot}L${x + b} ${foot}`,
    `A${b} ${b} 0 0 1 ${x} ${foot - b}L${x} ${badge + b}`,
    `A${b} ${b} 0 0 1 ${x + b} ${badge}`,
    // Up the 连杆's left side.
    `L${left - JOIN_BOTTOM} ${badge}A${JOIN_BOTTOM} ${JOIN_BOTTOM} 0 0 0 ${left} ${badge - JOIN_BOTTOM}`,
    `L${left} ${tag + JOIN_TOP}A${JOIN_TOP} ${JOIN_TOP} 0 0 0 ${left - JOIN_TOP} ${tag}`,
    `L${r} ${tag}A${r} ${r} 0 0 1 0 ${tag - r}Z`,
  ].join("");
}

/**
 * The 图标标签's room in the box's row, where the protocol label would be:
 * the label itself is drawn with the 主标签 (ScopeTag).
 */
export function ScopeBadgeSpace({
  ref,
  compact,
}: {
  ref?: Ref<HTMLSpanElement>;
  compact: boolean;
}) {
  const { size } = badgeOf(compact);
  return (
    <motion.span
      ref={ref}
      aria-hidden="true"
      className="shrink-0"
      style={{ width: size, height: size }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    />
  );
}

/**
 * The 作用域标签 over the box from the omnibox's frame. `title` null: still
 * being read, its place kept by a sweeping placeholder. `delay`: the box is
 * still on its way (it opened with the scope), so it waits for it to be
 * halfway there. The 图标标签 stays by the box's first line, however many
 * it wraps to.
 */
export function ScopeTag({
  purpose,
  title,
  compact,
  delay,
  maxWidth,
  onRemove,
}: {
  purpose: ScopePurpose;
  title: string | null;
  compact: boolean;
  delay: number;
  /** The box's width: the 主标签 is never wider (02 §4). */
  maxWidth: number;
  onRemove: () => void;
}) {
  const reduced = useReducedMotionPref();
  // Read once, as it arrives: later renders must not move its start.
  const [wait] = useState(reduced ? 0 : delay);
  const [contentRef, measured] = useContentWidth();
  const fillId = useId();
  const clipId = useId();
  const tone = tones[purpose];
  const Icon = icons[purpose];
  const height = tagHeight(compact);
  const shapeOf = badgeOf(compact);
  const { size, left: badgeLeft, stem, reach: tagMin } = shapeOf;
  const badge = height + GAP + badgeLeft;
  const total = badge + size;
  const name = title?.trim() || fallbacks[purpose];
  const label =
    purpose === "verify" && title?.trim() ? `验证 · ${title.trim()}` : name;

  // The 主标签's width: its words' up to the box's, eased as they change.
  // A pixel to spare: the width is read whole, the words are not.
  const natural = measured === null ? tagMin : measured.width + 1;
  const target = Math.max(tagMin, Math.min(natural, maxWidth));
  const truncated = natural > maxWidth;
  const width = useMotionValue(target);
  useEffect(() => {
    if (reduced || measured?.instant) width.jump(target);
    else animate(width, target, { duration: 0.2, ease });
  }, [target, reduced, measured?.instant, width]);
  const shape = useTransform(() =>
    outline(width.get(), height, badge, shapeOf),
  );

  // The 连杆 grows down from the 主标签 to the 图标标签.
  const grown = useMotionValue(0);
  useEffect(() => {
    const controls = animate(grown, 1, {
      duration: reduced ? 0 : 0.16,
      delay: wait + (reduced ? 0 : 0.2),
      ease,
    });
    return () => controls.stop();
  }, [grown, wait, reduced]);
  const reach = useTransform(() => 2 + grown.get() * (badge - height));

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
      className="pointer-events-none absolute left-0"
      style={{ top: -(height + GAP), height: total, width: maxWidth }}
      initial={{ opacity: 0, y: reduced ? 0 : -6 }}
      animate={{
        opacity: 1,
        y: 0,
        transition: { duration: reduced ? 0 : 0.2, delay: wait, ease },
      }}
      exit={{
        opacity: 0,
        y: reduced ? 0 : -6,
        transition: { duration: reduced ? 0 : 0.16, ease },
      }}
      data-scope-tag={purpose}
    >
      <svg
        aria-hidden="true"
        className="absolute inset-0 overflow-visible"
        width={maxWidth}
        height={total}
      >
        <defs>
          <linearGradient
            id={fillId}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2="0"
            y2={total}
          >
            <stop offset="0" stopColor={tone.top} />
            <stop offset="1" stopColor={tone.bottom} />
          </linearGradient>
          {/* The 主标签 and the 图标标签 whole, the 连杆 as far as it has grown. */}
          <clipPath id={clipId}>
            <rect x="-2" y="-2" width={maxWidth + 4} height={height + 2} />
            <motion.rect
              x={stem - JOIN_TOP - 2}
              y={height - 1}
              width={STEM + JOIN_TOP * 2 + 4}
              height={reach}
            />
            <rect x="-2" y={badge} width={tagMin + 4} height={size + 2} />
          </clipPath>
        </defs>
        <motion.path
          d={shape}
          fill={`url(#${fillId})`}
          stroke={tone.rim}
          strokeWidth={1}
          clipPath={`url(#${clipId})`}
        />
      </svg>
      {/* The 主标签's words and ×, over its shape. */}
      <motion.div
        className="pointer-events-auto absolute top-0 left-0 flex overflow-hidden"
        style={{ width, height, color: tone.ink }}
      >
        <span className={cn("flex h-full w-full min-w-0", row)}>
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
        </span>
      </motion.div>
      {/* Its natural width, unbounded: what the 主标签 grows to. */}
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
      {/* The 图标标签's icon, in the box. */}
      <span
        aria-hidden="true"
        className="absolute grid place-items-center"
        style={{
          left: badgeLeft,
          top: badge,
          width: size,
          height: size,
          color: tone.ink,
        }}
      >
        <Icon className="size-[18px]" />
      </span>
    </motion.div>
  );
}
