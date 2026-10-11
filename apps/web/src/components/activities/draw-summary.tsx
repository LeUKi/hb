import type { DrawSummary } from "@hb/contracts";
import { formatTime } from "../../lib/activities";

const stateLabels: Record<DrawSummary["state"], string> = {
  waiting: "报名中，等待开奖",
  settling: "开奖处理中",
  completed: "已开奖",
  empty: "无人报名，已结束",
};

const reasonLabels: Record<NonNullable<DrawSummary["reason"]>, string> = {
  full: "报名人数已满",
  deadline: "到达最晚开奖时间",
  manual: "作者提前结束",
};

export function DrawSummaryPanel({ draw }: { draw: DrawSummary }) {
  return (
    <section className="rounded-md border border-separator bg-panel p-4 text-sm leading-6">
      <h2 className="font-semibold text-ink">限时开奖</h2>
      <p className="mt-1 font-medium text-ink">
        {draw.state === "waiting" && draw.deadlineAt === null
          ? "准备中，开放后开始报名"
          : stateLabels[draw.state]}
      </p>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-subtle">最晚开奖</dt>
          <dd>{formatTime(draw.deadlineAt)}</dd>
        </div>
        <div>
          <dt className="text-subtle">实际结束</dt>
          <dd>{formatTime(draw.closedAt)}</dd>
        </div>
        {draw.registeredCount !== null ? (
          <div>
            <dt className="text-subtle">报名人数</dt>
            <dd>
              {draw.registeredCount}
              {draw.participantLimit !== undefined &&
              draw.participantLimit !== null
                ? ` / ${draw.participantLimit}`
                : ""}
            </dd>
          </div>
        ) : null}
        {draw.winnerCount !== null ? (
          <div>
            <dt className="text-subtle">中奖人数</dt>
            <dd>{draw.winnerCount}</dd>
          </div>
        ) : null}
        {draw.reason ? (
          <div>
            <dt className="text-subtle">结束原因</dt>
            <dd>{reasonLabels[draw.reason]}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
