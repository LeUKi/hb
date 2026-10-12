import type { AdminActivityStatus, AdminRewardType } from "@hb/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SkeletonRows } from "../components/presentation/loading";
import {
  AdminDetailSurface,
  AdminGuard,
  AdminQueryError,
  AdminShell,
  adminKey,
  fetchAdminActivities,
  fetchAdminActivity,
  fmtTime,
} from "../lib/admin";

type Search = {
  q?: string;
  status?: AdminActivityStatus;
  rewardType?: AdminRewardType;
  drawException?: 1;
  authorId?: string;
  cursor?: string;
  detail?: string;
};

export const Route = createFileRoute("/admin/activities")({
  validateSearch: (search): Search => ({
    q: typeof search.q === "string" ? search.q : undefined,
    status: ["draft", "active", "ended", "archived"].includes(
      String(search.status),
    )
      ? (search.status as AdminActivityStatus)
      : "all",
    rewardType: ["text", "ldc"].includes(String(search.rewardType))
      ? (search.rewardType as AdminRewardType)
      : "all",
    drawException:
      search.drawException === "1" || search.drawException === 1
        ? 1
        : undefined,
    authorId: typeof search.authorId === "string" ? search.authorId : undefined,
    cursor: typeof search.cursor === "string" ? search.cursor : undefined,
    detail: typeof search.detail === "string" ? search.detail : undefined,
  }),
  component: AdminActivitiesPage,
});

function AdminActivitiesPage() {
  return (
    <AdminGuard>
      {({ identity }) => (
        <AdminShell active="/admin/activities">
          <Activities identity={identity} />
        </AdminShell>
      )}
    </AdminGuard>
  );
}

function Activities({ identity }: { identity: string }) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/admin/activities" });
  const [q, setQ] = useState(search.q ?? "");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const detailOpenerRef = useRef<{ id: string; element: HTMLElement } | null>(
    null,
  );
  const params = {
    q: search.q,
    status: search.status,
    rewardType: search.rewardType,
    drawException: search.drawException ? "1" : undefined,
    authorId: search.authorId,
    cursor: search.cursor,
  };
  const query = useQuery({
    queryKey: adminKey(identity, "activities", params),
    queryFn: ({ signal }) => fetchAdminActivities(params, signal),
    retry: false,
  });
  const detail = useQuery({
    queryKey: adminKey(identity, "activity", search.detail),
    queryFn: ({ signal }) => fetchAdminActivity(search.detail ?? "", signal),
    enabled: Boolean(search.detail),
    retry: false,
  });
  function update(next: Partial<Search>) {
    void navigate({
      search: cleanSearch({ ...search, ...next, cursor: undefined }),
    });
  }
  function closeDetail() {
    const opener = detailOpenerRef.current;
    const focusTarget =
      opener && opener.id === search.detail && opener.element.isConnected
        ? opener.element
        : searchInputRef.current;
    void navigate({ search: cleanSearch({ ...search, detail: undefined }) });
    window.requestAnimationFrame(() => focusTarget?.focus());
  }
  useEffect(() => setQ(search.q ?? ""), [search.q]);
  return (
    <div className="admin-list-layout">
      <section className="activity-panel admin-list-panel">
        <div className="admin-toolbar">
          <h2>活动</h2>
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
            update({ q: q.trim() || undefined });
          }}
        >
          <input
            className="activity-input"
            ref={searchInputRef}
            aria-label="搜索活动"
            placeholder="名称、UUID、Emoji、活动链接或帖子"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <select
            aria-label="生命周期"
            value={search.status}
            onChange={(event) =>
              update({ status: event.target.value as AdminActivityStatus })
            }
          >
            <option value="all">全部状态</option>
            <option value="draft">草稿</option>
            <option value="active">进行中</option>
            <option value="ended">已结束</option>
            <option value="archived">已归档</option>
          </select>
          <select
            aria-label="奖励类型"
            value={search.rewardType}
            onChange={(event) =>
              update({ rewardType: event.target.value as AdminRewardType })
            }
          >
            <option value="all">全部奖励</option>
            <option value="text">文本</option>
            <option value="ldc">LDC</option>
          </select>
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={search.drawException === 1}
              onChange={(event) =>
                update({
                  drawException: event.target.checked ? 1 : undefined,
                })
              }
            />
            开奖异常
          </label>
          <button className="button" type="submit">
            搜索
          </button>
        </form>
        {!query.data ? (
          query.isError ? (
            <AdminQueryError
              error={query.error}
              retry={() => query.refetch()}
            />
          ) : (
            <SkeletonRows />
          )
        ) : (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>活动</th>
                    <th>作者</th>
                    <th>状态</th>
                    <th>奖励</th>
                    <th>参与</th>
                    <th>创建</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <Link
                          to="/admin/activities"
                          search={{
                            q: search.q,
                            status: search.status,
                            rewardType: search.rewardType,
                            drawException: search.drawException ? 1 : undefined,
                            authorId: search.authorId,
                            cursor: search.cursor,
                            detail: item.id,
                          }}
                          onClick={(event) => {
                            detailOpenerRef.current = {
                              id: item.id,
                              element: event.currentTarget,
                            };
                          }}
                        >
                          {item.title}
                        </Link>
                        <span className="admin-muted-id">{item.id}</span>
                      </td>
                      <td>{item.authorDisplayName}</td>
                      <td>{lifecycleLabel(item.lifecycle)}</td>
                      <td>{item.rewardType === "ldc" ? "LDC" : "文本"}</td>
                      <td>
                        {item.claimedCount || item.registeredCount}/
                        {item.totalCount}
                      </td>
                      <td>{fmtTime(item.createdAt)}</td>
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
            {!query.data.items.length && <p>没有匹配的活动。</p>}
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
      <AdminDetailSurface
        open={Boolean(search.detail)}
        label="活动详情"
        placeholder={<p className="text-sm text-subtle">选择活动查看详情。</p>}
        onClose={closeDetail}
      >
        {detail.data ? (
          <>
            <ActivityDetail
              activity={detail.data.activity}
              busy={detail.isFetching}
              onRefresh={() => void detail.refetch()}
            />
            {detail.isError && (
              <p role="alert">
                读取失败，请重试。上次读取：{fmtTime(detail.dataUpdatedAt)}
              </p>
            )}
          </>
        ) : detail.isError ? (
          <AdminQueryError
            error={detail.error}
            retry={() => detail.refetch()}
          />
        ) : (
          <SkeletonRows />
        )}
      </AdminDetailSurface>
    </div>
  );
}

function lifecycleLabel(value: string) {
  return (
    {
      draft: "草稿",
      active: "进行中",
      ended: "已结束",
      archived: "已归档",
    }[value] ?? value
  );
}

function ActivityDetail({
  activity,
  busy,
  onRefresh,
}: {
  activity: Awaited<ReturnType<typeof fetchAdminActivity>>["activity"];
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <div>
      <div className="admin-detail-heading">
        <h2>{activity.title}</h2>
        <button
          className="button secondary"
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={onRefresh}
        >
          <RefreshCw size={16} aria-hidden="true" />
          刷新
        </button>
      </div>
      <dl className="admin-detail-list">
        <Row label="活动 ID" value={activity.id} />
        <Row
          label="作者"
          value={`${activity.authorDisplayName} · ${activity.authorId}`}
        />
        <Row
          label="参与方式"
          value={activity.participationMode === "direct" ? "直接参与" : "口令"}
        />
        <Row
          label="奖励类型"
          value={activity.rewardType === "ldc" ? "LDC" : "文本"}
        />
        <Row label="总份数" value={String(activity.totalCount)} />
        <Row label="已领取" value={String(activity.claimedCount)} />
        <Row
          label="剩余份数"
          value={String(
            Math.max(0, activity.totalCount - activity.claimedCount),
          )}
        />
        <Row label="报名人数" value={String(activity.registeredCount)} />
        <Row label="生命周期" value={lifecycleLabel(activity.lifecycle)} />
        <Row
          label="关联帖子"
          value={
            activity.topicId
              ? `${activity.topicId}/${activity.postNumber}`
              : "无"
          }
        />
        <Row label="开奖状态" value={activity.drawState ?? "无"} />
        <Row
          label="付款"
          value={`总 ${activity.payments.total} · 未确认 ${activity.payments.pending} · 需关注 ${activity.payments.attention}`}
        />
        <Row label="更新时间" value={fmtTime(activity.updatedAt)} />
      </dl>
      <Link
        className="button secondary"
        to="/activities/$id"
        params={{ id: activity.id }}
      >
        查看活动
      </Link>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function cleanSearch(search: Partial<Search>): Partial<Search> {
  return {
    q: search.q || undefined,
    status: search.status === "all" ? undefined : search.status,
    rewardType: search.rewardType === "all" ? undefined : search.rewardType,
    drawException: search.drawException ? 1 : undefined,
    authorId: search.authorId || undefined,
    cursor: search.cursor || undefined,
    detail: search.detail || undefined,
  };
}
