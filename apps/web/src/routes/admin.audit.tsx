import type { AdminAuditType } from "@hb/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { SkeletonRows } from "../components/presentation/loading";
import {
  AdminGuard,
  AdminQueryError,
  AdminShell,
  adminKey,
  fetchAdminAudit,
  fmtTime,
} from "../lib/admin";
import { localDateTime } from "../lib/timed-draw";

type Search = {
  type?: AdminAuditType;
  actor?: string;
  from?: number;
  to?: number;
  cursor?: string;
};

export const Route = createFileRoute("/admin/audit")({
  validateSearch: (search): Search => ({
    type: ["login_settings", "attempt_rate_limits"].includes(
      String(search.type),
    )
      ? (search.type as AdminAuditType)
      : "all",
    actor: typeof search.actor === "string" ? search.actor : undefined,
    from: isSafeTimestamp(search.from) ? Number(search.from) : undefined,
    to: isSafeTimestamp(search.to) ? Number(search.to) : undefined,
    cursor: typeof search.cursor === "string" ? search.cursor : undefined,
  }),
  component: AdminAuditPage,
});

function AdminAuditPage() {
  return (
    <AdminGuard>
      {({ identity }) => (
        <AdminShell active="/admin/audit">
          <Audit identity={identity} />
        </AdminShell>
      )}
    </AdminGuard>
  );
}

function Audit({ identity }: { identity: string }) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/admin/audit" });
  const [actor, setActor] = useState(search.actor ?? "");
  const [fromDate, setFromDate] = useState(timestampToDateInput(search.from));
  const [toDate, setToDate] = useState(timestampToDateInput(search.to));
  const params = {
    type: search.type,
    actor: search.actor,
    from: search.from === undefined ? undefined : String(search.from),
    to: search.to === undefined ? undefined : String(search.to),
    cursor: search.cursor,
  };
  const query = useQuery({
    queryKey: adminKey(identity, "audit", params),
    queryFn: ({ signal }) => fetchAdminAudit(params, signal),
    retry: false,
  });
  useEffect(() => setActor(search.actor ?? ""), [search.actor]);
  useEffect(
    () => setFromDate(timestampToDateInput(search.from)),
    [search.from],
  );
  useEffect(() => setToDate(timestampToDateInput(search.to)), [search.to]);
  function update(next: Partial<Search>) {
    void navigate({
      search: cleanSearch({ ...search, ...next, cursor: undefined }),
    });
  }
  return (
    <section className="activity-panel admin-list-panel">
      <div className="admin-toolbar">
        <h2>操作记录</h2>
        <button
          className="button secondary"
          type="button"
          disabled={query.isFetching}
          aria-busy={query.isFetching}
          onClick={() => query.refetch()}
        >
          <RefreshCw size={16} aria-hidden="true" />
          刷新
        </button>
      </div>
      <form
        className="admin-filters"
        onSubmit={(event) => {
          event.preventDefault();
          update({
            actor: actor.trim() || undefined,
            from: dateInputToStartTimestamp(fromDate),
            to: dateInputToEndTimestamp(toDate),
          });
        }}
      >
        <input
          className="activity-input"
          aria-label="搜索操作者"
          placeholder="操作者名称或用户 ID"
          value={actor}
          onChange={(event) => setActor(event.target.value)}
        />
        <label className="admin-date-filter">
          <span>开始日期</span>
          <input
            className="activity-input"
            aria-label="开始日期"
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
          />
        </label>
        <label className="admin-date-filter">
          <span>结束日期</span>
          <input
            className="activity-input"
            aria-label="结束日期"
            type="date"
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
          />
        </label>
        <select
          aria-label="记录类型"
          value={search.type}
          onChange={(event) =>
            update({ type: event.target.value as AdminAuditType })
          }
        >
          <option value="all">全部类型</option>
          <option value="login_settings">登录方式</option>
          <option value="attempt_rate_limits">尝试间隔</option>
        </select>
        <button className="button" type="submit">
          搜索
        </button>
      </form>
      {!query.data ? (
        query.isError ? (
          <AdminQueryError error={query.error} retry={() => query.refetch()} />
        ) : (
          <SkeletonRows />
        )
      ) : (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>操作者</th>
                  <th>版本</th>
                  <th>前值</th>
                  <th>后值</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((item) => (
                  <tr key={`${item.type}:${item.id}`}>
                    <td>{fmtTime(item.createdAt)}</td>
                    <td>
                      {item.type === "login_settings" ? "登录方式" : "尝试间隔"}
                    </td>
                    <td>{item.actorDisplayName}</td>
                    <td>
                      {item.previousVersion} → {item.nextVersion}
                    </td>
                    <td>{values(item.before)}</td>
                    <td>{values(item.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {query.isError && (
            <p role="alert">
              读取失败，请重试。上次读取：{fmtTime(query.dataUpdatedAt)}
            </p>
          )}
          {!query.data.items.length && <p>暂无操作记录。</p>}
          <div className="admin-pager">
            <button
              className="button secondary"
              type="button"
              disabled={!search.cursor}
              onClick={() =>
                void navigate({ search: { ...search, cursor: undefined } })
              }
            >
              第一页
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={!query.data.nextCursor}
              onClick={() =>
                void navigate({
                  search: {
                    ...search,
                    cursor: query.data?.nextCursor ?? undefined,
                  },
                })
              }
            >
              下一页
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function isSafeTimestamp(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0;
}

function timestampToDateInput(value: number | undefined) {
  if (!isSafeTimestamp(value)) return "";
  const timestamp = value;
  if (timestamp === undefined) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return localDateTime(date.toISOString()).slice(0, 10);
}

function dateInputToStartTimestamp(value: string) {
  if (!value) return undefined;
  const time = new Date(`${value}T00:00:00`).getTime();
  return Number.isSafeInteger(time) ? time : undefined;
}

function dateInputToEndTimestamp(value: string) {
  if (!value) return undefined;
  const time = new Date(`${value}T23:59:59.999`).getTime();
  return Number.isSafeInteger(time) ? time : undefined;
}

function values(input: Record<string, string | number | boolean>) {
  return Object.entries(input)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "boolean" ? (value ? "开启" : "关闭") : value}`,
    )
    .join("；");
}

function cleanSearch(search: Partial<Search>): Partial<Search> {
  return {
    type: search.type === "all" ? undefined : search.type,
    actor: search.actor || undefined,
    from: search.from || undefined,
    to: search.to || undefined,
    cursor: search.cursor || undefined,
  };
}
