import { cn } from "../../lib/cn";

/**
 * Two ends of a range on one track (领取范围's 等级): each end is its own
 * native slider (arrow keys, a name, its value said), the part between them
 * filled. The ends may meet; the one dragged last stays on top.
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
  value: { min: number; max: number };
  bounds: { min: number; max: number };
  onChange: (value: { min: number; max: number }) => void;
  /** The two ends, as said: ["最低等级", "最高等级"]. */
  names: [string, string];
  /** Each stop under the track, from the low end. */
  marks: string[];
  valueText: (value: number) => string;
  invalid?: boolean;
}) {
  const span = bounds.max - bounds.min;
  const at = (point: number) => (point - bounds.min) / span;
  // The thumb is 1.375rem wide; its centre runs from half that to 100% less half.
  const left = (point: number) =>
    `calc(0.6875rem + (100% - 1.375rem) * ${at(point)})`;
  return (
    <div className="grid gap-1.5">
      <div className="relative h-7">
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
          <input
            key={end}
            type="range"
            min={bounds.min}
            max={bounds.max}
            step={1}
            value={value[end]}
            aria-label={names[index]}
            aria-valuetext={valueText(value[end])}
            onChange={(event) => {
              const point = Number(event.target.value);
              onChange(
                end === "min"
                  ? { min: Math.min(point, value.max), max: value.max }
                  : { min: value.min, max: Math.max(point, value.min) },
              );
            }}
            // Met at the top: the low end must still be reachable.
            style={{
              zIndex:
                end === "min" &&
                value.min === value.max &&
                value.min > bounds.min
                  ? 2
                  : 1,
            }}
            className="hb-range"
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
