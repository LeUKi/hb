import type { AdminAuditEntry } from "@hb/contracts";
import { useState } from "react";
import { useAdminList } from "../../../lib/admin";
import { cn } from "../../../lib/cn";
import { fullTime } from "../../../lib/roster-time";
import { LazyListEnd, useQueryLazyList } from "../../page/lazy-list";
import { EmptyNote, Panel } from "../../page/page";
import { PageLoad } from "../../page/page-state";
import { Avatar } from "../../ui/avatar";
import { TextInput } from "../../ui/field";
import { StatusChip } from "../../ui/status-chip";
import { AdminFrame, listLoad, SearchBox, useSettled } from "./admin-frame";

const labels = {
  homeIntervalSeconds: "起始页",
  activityIntervalSeconds: "红包页",
} as const;

/** Only what changed, in words: "起始页 8 秒 → 5 秒". */
function changesOf(entry: AdminAuditEntry) {
  const changes = (Object.keys(labels) as (keyof typeof labels)[])
    .filter((key) => entry.before[key] !== entry.after[key])
    .map(
      (key) =>
        `${labels[key]} ${entry.before[key]} 秒 → ${entry.after[key]} 秒`,
    );
  return changes.length > 0 ? changes.join("；") : "没有改动";
}

/** The start of a day picked in a date box, in this browser's time. */
function dayStart(value: string) {
  return value ? new Date(`${value}T00:00`).getTime() : null;
}

/**
 * /admin/audit 操作记录: every change to the site settings — who, when,
 * from which version to which, and what changed, in words (production
 * printed the raw keys). Kept for good; 尝试间隔 is the only kind.
 */
export function AdminAudit() {
  const [query, setQuery] = useState("");
  const actor = useSettled(query.trim());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const start = dayStart(from);
  const end = dayStart(to);
  const listQuery = useAdminList("audit", {
    actor: actor || undefined,
    from: start === null ? undefined : String(start),
    // The whole of the last day.
    to: end === null ? undefined : String(end + 86_400_000 - 1),
  });
  const busy = listQuery.isPlaceholderData;
  const list = useQueryLazyList({
    hasNextPage: listQuery.hasNextPage && !busy,
    isFetchingNextPage: listQuery.isFetchingNextPage,
    isFetchNextPageError: listQuery.isFetchNextPageError,
    fetchNextPage: listQuery.fetchNextPage,
    pageCount: listQuery.data?.pages.length ?? 0,
  });
  const pages = listQuery.data?.pages ?? [];
  const total = pages[0]?.total;
  const seen = new Set<string>();
  const entries = pages
    .flatMap((page) => page.items)
    .filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));

  return (
    <PageLoad load={listLoad(listQuery)}>
      <AdminFrame
        refreshable
        description="网站设置的每一次修改。记录一直保留。"
      >
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox
            label="搜索操作者"
            value={query}
            onChange={setQuery}
            maxLength={128}
            placeholder="操作者昵称或本站 ID"
          />
          <TextInput
            type="date"
            aria-label="开始日期"
            className="w-fit"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          <span className="text-sm text-ink-3">到</span>
          <TextInput
            type="date"
            aria-label="结束日期"
            className="w-fit"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        {entries.length === 0 ? (
          <div className={cn("transition-opacity", busy && "opacity-60")}>
            <EmptyNote title="没有符合条件的记录" text="换个筛选看看。" />
          </div>
        ) : (
          <div className="grid gap-0">
            <Panel
              as="ul"
              className={cn(
                "grid px-4 transition-opacity",
                busy && "opacity-60",
              )}
            >
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="grid gap-2 border-line border-b py-4 last:border-b-0 @wide/window:grid-cols-[11rem_minmax(0,1fr)_auto] @wide/window:items-center @wide/window:gap-4"
                >
                  <time
                    dateTime={new Date(entry.createdAt).toISOString()}
                    className="text-sm text-ink-2 tabular-nums"
                  >
                    {fullTime(entry.createdAt)}
                  </time>
                  <div className="grid gap-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <StatusChip>尝试间隔</StatusChip>
                      <span className="text-sm text-ink">
                        {changesOf(entry)}
                      </span>
                    </p>
                    <p className="text-xs text-ink-3">
                      第 {entry.previousVersion} 版 → 第 {entry.nextVersion} 版
                    </p>
                  </div>
                  <span className="flex items-center gap-2 text-sm text-ink-2">
                    <Avatar
                      name={entry.actorDisplayName}
                      src={entry.actorAvatarUrl}
                      size={22}
                    />
                    {entry.actorDisplayName}
                  </span>
                </li>
              ))}
            </Panel>
            <LazyListEnd
              list={list}
              done={total === undefined ? "已全部加载" : `共 ${total} 条`}
            />
          </div>
        )}
      </AdminFrame>
    </PageLoad>
  );
}
