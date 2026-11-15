import {
  PERSONAL_TOKEN_RATE_LIMITS,
  type PersonalTokenUsage,
  type PersonalTokenUsageBucket,
} from "@hb/contracts";
import { useState } from "react";
import { Segmented } from "../ui/segmented";

// 个人令牌's usage (docs/personal-token-design.md §8), by hour for a day or by
// day for 30: what got through, in grey, and what was turned away for going
// over the minute's share, in red. Shared by 我的 and 网站管理.

const callsOf = (bucket: PersonalTokenUsageBucket) =>
  bucket.read + bucket.square + bucket.claim + bucket.identity;

function label(at: string, span: "hours" | "days") {
  const date = new Date(at);
  return span === "hours"
    ? `${date.getHours()}:00`
    : `${date.getMonth() + 1}月${date.getDate()}日`;
}

function detail(bucket: PersonalTokenUsageBucket, span: "hours" | "days") {
  const parts = [
    `读取 ${bucket.read}`,
    `红包广场 ${bucket.square}`,
    `领取和口令 ${bucket.claim}`,
    `认人 ${bucket.identity}`,
  ];
  if (bucket.limited) parts.push(`限流 ${bucket.limited}`);
  if (bucket.paused) parts.push(`总开关关着时 ${bucket.paused}`);
  return `${label(bucket.at, span)}：${parts.join("，")}`;
}

/** “每分钟最多：读取 60，红包广场 20，领取和口令 20，认人 20”. */
export const limitsLine = `每个账号每分钟最多：读取 ${PERSONAL_TOKEN_RATE_LIMITS.read} 次，红包广场列表 ${PERSONAL_TOKEN_RATE_LIMITS.square} 次，领取和口令兑换合计 ${PERSONAL_TOKEN_RATE_LIMITS.claim} 次，附带网页认人 ${PERSONAL_TOKEN_RATE_LIMITS.identity} 次。`;

export function TokenUsageChart({ usage }: { usage: PersonalTokenUsage }) {
  const [span, setSpan] = useState<"hours" | "days">("hours");
  if (!usage.available)
    return <p className="text-sm text-ink-3">用量统计暂时看不到。</p>;
  const buckets = usage[span];
  const calls = buckets.reduce((sum, bucket) => sum + callsOf(bucket), 0);
  const limited = buckets.reduce((sum, bucket) => sum + bucket.limited, 0);
  const top = Math.max(1, ...buckets.map((b) => callsOf(b) + b.limited));
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2 tabular-nums">
          {span === "hours" ? "最近 24 小时" : "最近 30 天"} {calls} 次
          {limited ? (
            <span className="text-danger">，被限流 {limited} 次</span>
          ) : null}
        </p>
        <Segmented
          label="时间段"
          value={span}
          onChange={setSpan}
          options={[
            { value: "hours", label: "24 小时" },
            { value: "days", label: "30 天" },
          ]}
        />
      </div>
      <ol
        className="flex h-16 items-end gap-px"
        aria-label={`${span === "hours" ? "每小时" : "每天"}的调用次数`}
      >
        {buckets.map((bucket) => {
          const ok = callsOf(bucket);
          return (
            <li
              key={bucket.at}
              title={detail(bucket, span)}
              className="flex h-full min-w-0 flex-1 flex-col justify-end"
            >
              <span className="sr-only">{detail(bucket, span)}</span>
              {bucket.limited > 0 && (
                <span
                  aria-hidden="true"
                  className="rounded-t-[2px] bg-danger/70"
                  style={{ height: `${(bucket.limited / top) * 100}%` }}
                />
              )}
              <span
                aria-hidden="true"
                className={`bg-ink-3/45 ${bucket.limited ? "" : "rounded-t-[2px]"}`}
                style={{
                  height: ok ? `${Math.max(4, (ok / top) * 100)}%` : "1px",
                }}
              />
            </li>
          );
        })}
      </ol>
      <p className="flex justify-between text-xs text-ink-3 tabular-nums">
        <span>{buckets[0] ? label(buckets[0].at, span) : ""}</span>
        <span>{span === "hours" ? "现在" : "今天"}</span>
      </p>
    </div>
  );
}
