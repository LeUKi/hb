import type { ViewerCurve as Curve } from "@hb/contracts";
import { type KeyboardEvent, type PointerEvent, useState } from "react";
import { cn } from "../../lib/cn";
import { clockLabel } from "../../lib/roster-time";

// 在看人数's curve (docs/viewer-stats-design.md §6): one series, so no
// legend; the dataviz reference's slot 1 (--chart-1) for the 2px line and
// its 10% wash, a hairline baseline, the peak marked with an 8px dot on a
// 2px ring of the card, and the moment it opened as a hairline. A pointer
// or a finger on it (or the arrow keys) reads one point out underneath.

type Point = { at: number; count: number; now?: true };

const WIDTH = 1000;
const HEIGHT = 100;
/** Room above the peak for its dot and label. */
const HEADROOM = 0.78;

/**
 * The points to draw: one per stretch from the object, then the count it
 * ended on (or the live one) held until `endAt`.
 */
function pointsOf(curve: Curve, endAt: number, live: number | null) {
  const start = Date.parse(curve.start);
  const step = curve.stepSeconds * 1000;
  const points: Point[] = curve.values.map((count, index) => ({
    at: start + index * step,
    count,
  }));
  const tail = live ?? curve.last;
  const after = start + curve.values.length * step;
  const lastAt = points.at(-1)?.at ?? start;
  if (endAt > after) points.push({ at: after, count: tail });
  if (endAt > lastAt)
    points.push({
      at: endAt,
      count: tail,
      ...(live !== null ? { now: true as const } : {}),
    });
  return points;
}

export function ViewerCurve({
  curve,
  endAt,
  live,
  openedAt,
}: {
  curve: Curve;
  /** The right edge: now while it runs, its end once over. */
  endAt: number;
  /** While it runs, the count now, which the tail shows. */
  live: number | null;
  /**
   * When it opened, marked only when people were already waiting for it
   * (a timed opening): a minute or more after the curve begins.
   */
  openedAt?: number;
}) {
  const points = pointsOf(curve, endAt, live);
  const [shown, setShown] = useState<number | null>(null);
  const first = points[0]?.at ?? endAt;
  const last = Math.max(points.at(-1)?.at ?? endAt, first + 60_000);
  const top = Math.max(1, ...points.map((point) => point.count));
  const x = (at: number) => ((at - first) / (last - first)) * WIDTH;
  const y = (count: number) => HEIGHT - (count / top) * HEIGHT * HEADROOM;
  const line = points
    .map(
      (point, index) => `${index ? "L" : "M"}${x(point.at)},${y(point.count)}`,
    )
    .join("");
  const area = `${line}L${x(points.at(-1)?.at ?? last)},${HEIGHT}L${x(first)},${HEIGHT}Z`;
  const peakIndex = points.findIndex((point) => point.count === top);
  const peak = points[peakIndex];
  const step = curve.stepSeconds;
  const current = shown === null ? null : points[shown];
  const opened =
    openedAt !== undefined && openedAt - first >= 60_000 && openedAt < last
      ? openedAt
      : null;

  const readout = (point: Point) =>
    point.now
      ? `现在 ${point.count} 人在看`
      : step <= 60
        ? `${clockLabel(point.at)} · ${point.count} 人`
        : `${clockLabel(point.at)} 起 ${step / 60} 分钟 · 最多 ${point.count} 人`;

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at =
      first + ((event.clientX - box.left) / box.width) * (last - first);
    let best = 0;
    for (let index = 1; index < points.length; index++) {
      const point = points[index];
      const chosen = points[best];
      if (point && chosen && Math.abs(point.at - at) < Math.abs(chosen.at - at))
        best = index;
    }
    setShown(best);
  };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const move = event.key === "ArrowLeft" ? -1 : 1;
    setShown((index) =>
      Math.min(
        points.length - 1,
        Math.max(
          0,
          index === null ? (move < 0 ? points.length - 1 : 0) : index + move,
        ),
      ),
    );
  };

  const pin = (point: Point) => ({
    left: `${(x(point.at) / WIDTH) * 100}%`,
    top: `${(y(point.count) / HEIGHT) * 100}%`,
  });

  return (
    <div className="grid gap-1.5">
      {/* The whole plot is the target, not only the line. */}
      <div
        className="relative h-[5.5rem] touch-none border-line border-b outline-offset-4"
        // A slider over its points: the arrow keys step along the curve.
        role="slider"
        aria-label={`在看人数曲线，从 ${clockLabel(first)} 到 ${live !== null ? "现在" : clockLabel(last)}，最多 ${top} 人`}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, points.length - 1)}
        aria-valuenow={shown ?? Math.max(0, points.length - 1)}
        aria-valuetext={readout(
          current ?? points.at(-1) ?? { at: last, count: 0 },
        )}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pick(event);
        }}
        onPointerMove={(event) => {
          if (event.pointerType === "mouse" || event.buttons) pick(event);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setShown(null);
        }}
        onKeyDown={keys}
        onBlur={() => setShown(null)}
      >
        <svg
          className="absolute inset-0 size-full overflow-visible"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d={area} fill="var(--chart-1)" fillOpacity={0.1} />
          <path
            d={line}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {opened !== null && (
          <span
            aria-hidden="true"
            className="absolute top-0 bottom-0 w-px bg-line"
            style={{ left: `${(x(opened) / WIDTH) * 100}%` }}
          >
            {/* Its word on the side with room: right of the line, left near the end. */}
            <span
              className={cn(
                "absolute -top-0.5 text-[11px] leading-none whitespace-nowrap text-ink-3",
                x(opened) > WIDTH * 0.8 ? "right-1" : "left-1",
              )}
            >
              开放
            </span>
          </span>
        )}
        {peak && (
          <span
            aria-hidden="true"
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--chart-1)] shadow-[0_0_0_2px_var(--color-white)]"
            style={pin(peak)}
          />
        )}
        {current && (
          <>
            <span
              aria-hidden="true"
              className="absolute top-0 bottom-0 w-px bg-ink-3/50"
              style={{ left: pin(current).left }}
            />
            <span
              aria-hidden="true"
              className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--chart-1)] shadow-[0_0_0_2px_var(--color-white)]"
              style={pin(current)}
            />
          </>
        )}
      </div>
      <p className="flex justify-between text-xs text-ink-3 tabular-nums">
        <span>{clockLabel(first)}</span>
        <span>{live !== null ? "现在" : clockLabel(last)}</span>
      </p>
      <p className="min-h-5 text-xs text-ink-2 tabular-nums" aria-hidden="true">
        {current ? readout(current) : "指向或按住曲线，看那一刻有几人。"}
      </p>
    </div>
  );
}
