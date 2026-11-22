// 近 14 天走势 (docs/third-party-points-design.md §17 第二批): each day's
// payouts that ended, 到账 under 发放失败, one bar a day. Two series in
// the dataviz reference slots 1–2 (--chart-1, --chart-2, validated light
// and dark), a legend, and a readout line that follows the hovered or
// focused day with its numbers and the issuer's average answer time — the
// time is a different measure, so it is told, not drawn on a second axis.
import { useState } from "react";
import type { PointsTrendDay } from "../../../lib/points";

const dayLabel = (at: number) => {
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

const readout = (day: PointsTrendDay) =>
  `${dayLabel(day.day)}：到账 ${day.confirmed} 笔，发放失败 ${day.failed} 笔${
    day.averageMs === null ? "" : `，接口平均 ${day.averageMs} ms`
  }`;

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="size-2.5 rounded-[3px]"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

export function PointsTrend({ days }: { days: PointsTrendDay[] }) {
  const [shown, setShown] = useState<number | null>(null);
  const top = Math.max(1, ...days.map((day) => day.confirmed + day.failed));
  const total = days.reduce((sum, day) => sum + day.confirmed + day.failed, 0);
  const current = shown === null ? null : days[shown];
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-ink-3">
        <span className="text-sm text-ink-2">近 14 天发放</span>
        <span className="flex items-center gap-3">
          <Swatch color="var(--chart-1)" label="到账" />
          <Swatch color="var(--chart-2)" label="发放失败" />
        </span>
      </div>
      {total === 0 ? (
        <p className="text-sm text-ink-3">近 14 天没有发放。</p>
      ) : (
        <>
          <ol
            className="flex h-20 items-end gap-0.5"
            aria-label="每天的发放笔数"
            onMouseLeave={() => setShown(null)}
          >
            {days.map((day, index) => {
              const both = day.confirmed > 0 && day.failed > 0;
              return (
                <li key={day.day} className="flex h-full min-w-0 flex-1">
                  {/* The whole column is the target, not only the bar. */}
                  <button
                    type="button"
                    className="flex h-full w-full flex-col justify-end rounded-[3px] outline-offset-1 hover:bg-fill focus-visible:bg-fill"
                    aria-label={readout(day)}
                    onMouseEnter={() => setShown(index)}
                    onFocus={() => setShown(index)}
                    onBlur={() => setShown(null)}
                  >
                    {day.failed > 0 && (
                      <span
                        aria-hidden="true"
                        className="w-full rounded-t-[4px]"
                        style={{
                          height: `${(day.failed / top) * 100}%`,
                          minHeight: 3,
                          background: "var(--chart-2)",
                          // 2px of surface between the two parts.
                          marginBottom: both ? 2 : 0,
                        }}
                      />
                    )}
                    {day.confirmed > 0 && (
                      <span
                        aria-hidden="true"
                        className={`w-full ${both ? "" : "rounded-t-[4px]"}`}
                        style={{
                          height: `${(day.confirmed / top) * 100}%`,
                          minHeight: 3,
                          background: "var(--chart-1)",
                        }}
                      />
                    )}
                    {day.confirmed + day.failed === 0 && (
                      <span
                        aria-hidden="true"
                        className="h-px w-full bg-line"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="flex justify-between text-xs text-ink-3 tabular-nums">
            <span>{days[0] ? dayLabel(days[0].day) : ""}</span>
            <span>今天</span>
          </p>
          <p
            className="min-h-5 text-xs text-ink-2 tabular-nums"
            aria-live="polite"
          >
            {current ? readout(current) : null}
          </p>
        </>
      )}
    </div>
  );
}
