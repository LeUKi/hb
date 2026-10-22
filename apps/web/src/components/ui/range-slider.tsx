import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { cn } from "../../lib/cn";

type Range = { min: number; max: number };
type End = keyof Range;

/**
 * Two ends of a range on one track (领取范围's 等级), whole steps only. A
 * press on the track takes the nearer end; where the two meet, the way
 * the pointer then goes picks one (left the low end, right the high end),
 * so a single step can be widened either way. Each end is a slider of its
 * own for the keyboard (arrows, Home, End) and is named and said.
 */
export function RangeSlider({
  value,
  bounds,
  onChange,
  names,
  marks,
  valueText,
  invalid,
}: {
  value: Range;
  bounds: Range;
  onChange: (value: Range) => void;
  /** The two ends, as said: ["最低等级", "最高等级"]. */
  names: [string, string];
  /** Each stop under the track, from the low end. */
  marks: string[];
  valueText: (value: number) => string;
  invalid?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const thumbs = useRef<Record<End, HTMLSpanElement | null>>({
    min: null,
    max: null,
  });
  // The end being dragged; "either" while two met ends wait for a direction.
  const drag = useRef<{ end: End | "either"; from: number } | null>(null);
  const [active, setActive] = useState<End | null>(null);
  const span = bounds.max - bounds.min;
  const at = (point: number) => (point - bounds.min) / span;
  // The thumb is 1.375rem wide; its centre runs from half that to 100% less half.
  const left = (point: number) =>
    `calc(0.6875rem + (100% - 1.375rem) * ${at(point)})`;

  const set = (end: End, point: number) => {
    const clamped = Math.min(bounds.max, Math.max(bounds.min, point));
    const next =
      end === "min"
        ? { min: Math.min(clamped, value.max), max: value.max }
        : { min: value.min, max: Math.max(clamped, value.min) };
    if (next.min !== value.min || next.max !== value.max) onChange(next);
  };
  const pointAt = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box) return value.min;
    const thumb = 22;
    const share = (clientX - box.left - thumb / 2) / (box.width - thumb);
    return Math.round(bounds.min + Math.min(1, Math.max(0, share)) * span);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = pointAt(event.clientX);
    const end: End | "either" =
      value.min === value.max && point === value.min
        ? "either"
        : point <= value.min
          ? "min"
          : point >= value.max
            ? "max"
            : point - value.min <= value.max - point
              ? "min"
              : "max";
    drag.current = { end, from: point };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (end !== "either") {
      setActive(end);
      thumbs.current[end]?.focus({ preventScroll: true });
      set(end, point);
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const point = pointAt(event.clientX);
    if (current.end === "either") {
      if (point === current.from) return;
      current.end = point < current.from ? "min" : "max";
      setActive(current.end);
      thumbs.current[current.end]?.focus({ preventScroll: true });
    }
    set(current.end, point);
  };
  const onPointerEnd = () => {
    drag.current = null;
    setActive(null);
  };

  const onKey = (end: End) => (event: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[
      event.key
    ];
    let point: number | undefined;
    if (step !== undefined) point = value[end] + step;
    else if (event.key === "Home") point = bounds.min;
    else if (event.key === "End") point = bounds.max;
    if (point === undefined) return;
    event.preventDefault();
    set(end, point);
  };

  return (
    <div className="grid gap-1.5">
      <div
        ref={track}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        // A drag on a phone moves the ends, not the page.
        className="relative h-7 cursor-pointer touch-none select-none"
      >
        <span
          aria-hidden="true"
          className="absolute inset-x-[0.6875rem] top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-fill-2"
        />
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full transition-colors",
            invalid ? "bg-danger" : "bg-accent",
          )}
          style={{
            left: left(value.min),
            width: `calc((100% - 1.375rem) * ${at(value.max) - at(value.min)})`,
          }}
        />
        {(["min", "max"] as const).map((end, index) => (
          <span
            key={end}
            ref={(element) => {
              thumbs.current[end] = element;
            }}
            role="slider"
            tabIndex={0}
            aria-label={names[index]}
            aria-valuemin={bounds.min}
            aria-valuemax={bounds.max}
            aria-valuenow={value[end]}
            aria-valuetext={valueText(value[end])}
            onKeyDown={onKey(end)}
            className={cn(
              "hb-range-thumb absolute top-1/2 size-[1.375rem] -translate-x-1/2 -translate-y-1/2 rounded-full",
              invalid && "hb-range-thumb-invalid",
              active === end && "hb-range-thumb-active",
            )}
            style={{
              left: left(value[end]),
              // The one dragged or focused last stays on top where they meet.
              zIndex: active === end ? 2 : 1,
            }}
          />
        ))}
      </div>
      <div aria-hidden="true" className="relative h-4 text-xs text-ink-3">
        {marks.map((mark, index) => (
          <span
            key={mark}
            className={cn(
              "absolute -translate-x-1/2 tabular-nums",
              index + bounds.min >= value.min &&
                index + bounds.min <= value.max &&
                "text-ink",
            )}
            style={{ left: left(index + bounds.min) }}
          >
            {mark}
          </span>
        ))}
      </div>
    </div>
  );
}
