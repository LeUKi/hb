import { findActivity } from "../../fixtures/activities";
import { attemptStatsOf } from "../../fixtures/attempts";
import { cn } from "../../lib/cn";
import { LazyListEnd, useLazyList } from "../page/lazy-list";
import {
  EmptyNote,
  Facts,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import { Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { MessageView } from "./message-view";

type AttemptRow = ReturnType<typeof attemptStatsOf>["rows"][number];

/** What people typed, the most frequent first; 20 more as its end nears. */
function AttemptList({
  rows,
  max,
  verb,
}: {
  rows: AttemptRow[];
  max: number;
  verb: string;
}) {
  const list = useLazyList({ id: "attempts", total: rows.length });
  return (
    <Panel className="grid gap-0.5 p-1.5">
      <ul className="grid" aria-busy={list.state === "loading" || undefined}>
        {rows.slice(0, list.shown).map((row) => (
          <li
            key={row.text}
            className="grid gap-1.5 border-line border-b px-3 py-3 last:border-b-0"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-mono text-base text-ink">
                {row.text}
              </span>
              {row.hits > 0 && <StatusChip tone="success">是口令</StatusChip>}
              <span className="ml-auto shrink-0 text-sm text-ink-2 tabular-nums">
                {row.count} 次 · {row.people} 人
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Squircle radius={3}>
                <span
                  aria-hidden="true"
                  className="block h-1.5 flex-1 overflow-hidden bg-fill-2"
                >
                  <span
                    className={cn(
                      "block h-full",
                      row.hits > 0 ? "bg-success" : "bg-ink-3/45",
                    )}
                    style={{ width: `${(row.count / max) * 100}%` }}
                  />
                </span>
              </Squircle>
              <span className="w-28 shrink-0 text-right text-xs text-ink-3 tabular-nums">
                {row.hits > 0
                  ? `${verb} ${row.claims} 人`
                  : `未命中 ${row.misses} 次`}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <LazyListEnd list={list} done={`共 ${rows.length} 条`} />
    </Panel>
  );
}

/**
 * /🧧/<码>/📊 尝试统计: what people submitted on the 红包 page, grouped by
 * what they typed — how many times, by how many people, whether it was one
 * of the 口令. Never who typed what. Only for 口令红包 that turned it on
 * when they were sent (production: 口令尝试统计).
 */
export function StatsView({ id }: { id: string }) {
  const activity = findActivity(id);
  if (!activity) return null;
  if (
    activity.draft ||
    activity.participation !== "password" ||
    !activity.statistics
  )
    return (
      <MessageView
        title="没有尝试统计"
        text={
          activity.draft
            ? "红包开放之后才有人提交口令。"
            : "这个红包没有开启尝试统计。统计要在发红包时开启，开放后不能改。"
        }
      />
    );
  const stats = attemptStatsOf(activity.id);
  const verb = activity.mode === "timed_draw" ? "报名" : "领取";
  const max = Math.max(1, ...stats.rows.map((row) => row.count));
  const hitRate =
    stats.total > 0
      ? Math.round(
          (stats.rows.reduce((sum, row) => sum + row.hits, 0) / stats.total) *
            100,
        )
      : 0;
  const perPassword = activity.passwords.map((text) => ({
    text,
    claims: stats.rows.find((row) => row.text === text)?.claims ?? 0,
  }));

  return (
    <Page>
      <PageHeader
        eyebrow={activity.title}
        title="尝试统计"
        description="大家在红包页提交的口令，按内容汇总。只有汇总，不显示谁提交了什么。"
      />
      <Panel className="p-5">
        <Facts
          items={[
            { label: "提交次数", value: `${stats.total} 次` },
            { label: "提交的人", value: `${stats.people} 人` },
            { label: `成功${verb}`, value: `${stats.claims} 人` },
            { label: "猜中的比例", value: `${hitRate}%`, note: "按次数算" },
          ]}
        />
      </Panel>

      <PageSection title={`每个口令${verb}了多少`}>
        <Panel as="ul" className="grid px-4">
          {perPassword.map((item) => (
            <li
              key={item.text}
              className="flex items-center justify-between gap-3 border-line border-b py-3 last:border-b-0"
            >
              <span className="min-w-0 truncate font-mono text-base text-ink">
                {item.text}
              </span>
              <span className="shrink-0 text-sm text-ink-2 tabular-nums">
                {item.claims} {activity.mode === "timed_draw" ? "人" : "份"}
              </span>
            </li>
          ))}
        </Panel>
      </PageSection>

      <PageSection
        title="提交的内容"
        description="按次数从多到少。是否猜中按提交那一刻的口令判断。"
      >
        {stats.rows.length === 0 ? (
          <EmptyNote title="还没有人提交口令" />
        ) : (
          <AttemptList rows={stats.rows} max={max} verb={verb} />
        )}
      </PageSection>
    </Page>
  );
}
