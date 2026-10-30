import type { AttemptStatisticsRow } from "@hb/contracts";
import { useManagedActivity } from "../../lib/activities";
import { cn } from "../../lib/cn";
import { useStatisticsPages } from "../../lib/discovery";
import {
  type LazyList,
  LazyListEnd,
  useQueryLazyList,
} from "../page/lazy-list";
import {
  EmptyNote,
  Facts,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import { PageLoad, queriesLoad, queryLoad } from "../page/page-state";
import { Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { MessageView } from "./message-view";

/** What people typed, the most frequent first; 20 more as its end nears. */
function AttemptList({
  rows,
  max,
  draw,
  code,
  list,
  total,
}: {
  rows: AttemptStatisticsRow[];
  max: number;
  draw: boolean;
  /** 代码判定: what the code paid for, not 口令. */
  code: boolean;
  list: LazyList;
  total: string;
}) {
  const verb = draw ? "报名" : "领取";
  return (
    <Panel className="grid gap-0.5 p-1.5">
      <ul className="grid" aria-busy={list.state === "loading" || undefined}>
        {rows.map((row) => {
          const hit = row.matchedAttempts > 0;
          return (
            <li
              key={row.password}
              className="grid gap-1.5 border-line border-b px-3 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate font-mono text-base text-ink">
                  {row.password}
                </span>
                {hit && (
                  <StatusChip tone="success">
                    {code ? "发了" : "是口令"}
                  </StatusChip>
                )}
                <span className="ml-auto shrink-0 text-sm text-ink-2 tabular-nums">
                  {row.attempts} 次 · {row.uniqueUsers} 人
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
                        hit ? "bg-success" : "bg-ink-3/45",
                      )}
                      style={{ width: `${(row.attempts / max) * 100}%` }}
                    />
                  </span>
                </Squircle>
                <span className="w-28 shrink-0 text-right text-xs text-ink-3 tabular-nums">
                  {hit
                    ? `${verb} ${draw ? row.matchedUsers : row.successfulClaims} 人`
                    : `${code ? "没发" : "未命中"} ${row.unmatchedAttempts} 次`}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <LazyListEnd list={list} done={total} />
    </Panel>
  );
}

/**
 * /🧧/<码>/📊 尝试统计: what people submitted on the 红包 page, grouped by
 * what they typed — how many times, by how many people, whether it was one
 * of the 口令. Never who typed what. Only for 口令红包 sent with 口令尝试统计
 * on.
 */
export function StatsView({ id, userId }: { id: string; userId: string }) {
  const managed = useManagedActivity(userId, id);
  const activity = managed.data?.activity;
  const available = Boolean(
    activity &&
      activity.status !== "draft" &&
      activity.participationMode !== "direct",
  );
  const stats = useStatisticsPages(userId, id, available);
  const list = useQueryLazyList({
    hasNextPage: stats.hasNextPage,
    isFetchingNextPage: stats.isFetchingNextPage,
    isFetchNextPageError: stats.isFetchNextPageError,
    fetchNextPage: stats.fetchNextPage,
    pageCount: stats.data?.pages.length ?? 0,
  });
  if (activity && !available)
    return (
      <MessageView
        title="没有尝试统计"
        text={
          activity.status === "draft"
            ? activity.participationMode === "code"
              ? "红包开放之后才有人提交。"
              : "红包开放之后才有人提交口令。"
            : "无需口令的红包没有口令尝试。"
        }
      />
    );
  const first = stats.data?.pages[0];
  const rows = stats.data?.pages.flatMap((page) => page.items) ?? [];
  const draw = activity?.config.money.mode === "timed_draw";
  // 代码判定: what people typed for its code, and whether it paid.
  const code = activity?.participationMode === "code";
  const verb = draw ? "报名" : "领取";
  const max = Math.max(1, ...rows.map((row) => row.attempts));
  const hitRate =
    first && first.totalAttempts > 0
      ? Math.round((first.matchedAttempts / first.totalAttempts) * 100)
      : 0;

  return (
    <PageLoad
      load={activity ? queriesLoad(managed, stats) : queryLoad(managed)}
    >
      {activity && first && (
        <Page>
          <PageHeader
            refreshable
            eyebrow={activity.title}
            title="尝试统计"
            description={
              code
                ? "大家在红包页提交的内容，按内容匿名汇总。"
                : "大家在红包页提交的口令，按内容匿名汇总。"
            }
          />
          <Panel className="p-5">
            <Facts
              items={[
                { label: "提交次数", value: `${first.totalAttempts} 次` },
                { label: "提交的人", value: `${first.uniqueUsers} 人` },
                {
                  label: `成功${verb}`,
                  value: `${draw ? (first.registeredParticipants ?? 0) : first.successfulClaims} 人`,
                },
                {
                  label: code ? "发了的比例" : "猜中的比例",
                  value: `${hitRate}%`,
                  note: "按次数算",
                },
              ]}
            />
          </Panel>

          {!code && (
            <PageSection title={`每个口令${verb}了多少`}>
              <Panel as="ul" className="grid px-4">
                {first.validPasswords.map((item) => (
                  <li
                    key={item.password}
                    className="flex items-center justify-between gap-3 border-line border-b py-3 last:border-b-0"
                  >
                    <span className="min-w-0 truncate font-mono text-base text-ink">
                      {item.password}
                    </span>
                    <span className="shrink-0 text-sm text-ink-2 tabular-nums">
                      {draw
                        ? `${item.registrations} 人`
                        : `${item.successfulClaims} 份`}
                    </span>
                  </li>
                ))}
              </Panel>
            </PageSection>
          )}

          <PageSection
            title="提交的内容"
            description={
              code
                ? "按次数从多到少。发没发按那一次判定器的判定。"
                : "按次数从多到少。是否猜中按提交那一刻的口令判断。"
            }
          >
            {rows.length === 0 ? (
              <EmptyNote title={code ? "还没有人提交" : "还没有人提交口令"} />
            ) : (
              <AttemptList
                rows={rows}
                max={max}
                draw={draw}
                code={code}
                list={list}
                total={list.state === "done" ? `共 ${rows.length} 条` : ""}
              />
            )}
          </PageSection>
        </Page>
      )}
    </PageLoad>
  );
}
