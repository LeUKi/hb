import { useState } from "react";
import { type AuditRecord, auditRecords } from "../../../fixtures/admin";
import { fullTime } from "../../../lib/roster-time";
import { LazyRows } from "../../page/lazy-list";
import { EmptyNote, Panel } from "../../page/page";
import { Avatar } from "../../ui/avatar";
import { TextInput } from "../../ui/field";
import { StatusChip } from "../../ui/status-chip";
import { AdminFrame, SearchBox } from "./admin-frame";

const labels = { home: "起始页", page: "红包页" } as const;

/** Only what changed, in words: "起始页 8 秒 → 5 秒". */
function changesOf(record: AuditRecord) {
  return (Object.keys(labels) as (keyof typeof labels)[])
    .filter((key) => record.before[key] !== record.after[key])
    .map(
      (key) =>
        `${labels[key]} ${record.before[key]} 秒 → ${record.after[key]} 秒`,
    );
}

function dayStart(value: string) {
  return value ? new Date(`${value}T00:00`).getTime() : null;
}

/**
 * /admin/audit 操作记录: every change to the site settings — who, when,
 * from which version to which, and what changed, in words (production
 * prints the raw keys). Kept for good. With 登录方式 gone, 尝试间隔 is the
 * only kind left; old 登录方式 records are exported before the table goes.
 */
export function AdminAudit() {
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const start = dayStart(from);
  const end = dayStart(to);
  const text = query.trim().toLowerCase();
  const records = auditRecords.filter(
    (record) =>
      (!text ||
        record.operator.id === text ||
        record.operator.displayName.toLowerCase().includes(text)) &&
      (start === null || record.at >= start) &&
      (end === null || record.at < end + 86_400_000),
  );
  return (
    <AdminFrame refreshable description="网站设置的每一次修改。记录一直保留。">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          label="搜索操作者"
          value={query}
          onChange={setQuery}
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
      {records.length === 0 ? (
        <EmptyNote title="没有符合条件的记录" text="换个筛选看看。" />
      ) : (
        <LazyRows id="audit" items={records} done={`共 ${records.length} 条`}>
          {(visible) => (
            <Panel as="ul" className="grid px-4">
              {visible.map((record) => (
                <li
                  key={record.id}
                  className="grid gap-2 border-line border-b py-4 last:border-b-0 @wide/window:grid-cols-[11rem_minmax(0,1fr)_auto] @wide/window:items-center @wide/window:gap-4"
                >
                  <time
                    dateTime={new Date(record.at).toISOString()}
                    className="text-sm text-ink-2 tabular-nums"
                  >
                    {fullTime(record.at)}
                  </time>
                  <div className="grid gap-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <StatusChip>尝试间隔</StatusChip>
                      <span className="text-sm text-ink">
                        {changesOf(record).join("；")}
                      </span>
                    </p>
                    <p className="text-xs text-ink-3">
                      第 {record.from} 版 → 第 {record.to} 版
                    </p>
                  </div>
                  <span className="flex items-center gap-2 text-sm text-ink-2">
                    <Avatar name={record.operator.displayName} size={22} />
                    {record.operator.displayName}
                  </span>
                </li>
              ))}
            </Panel>
          )}
        </LazyRows>
      )}
    </AdminFrame>
  );
}
