import type { AdminUserState, AdminUserTier } from "@hb/contracts";
import { type QueryObserverResult, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SkeletonRows } from "../components/presentation/loading";
import {
  AdminDetailSurface,
  AdminGuard,
  AdminQueryError,
  AdminRefreshButton,
  AdminShell,
  adminKey,
  fetchAdminUser,
  fetchAdminUsers,
  fmtTime,
} from "../lib/admin";

type Search = {
  q?: string;
  tier?: AdminUserTier;
  state?: AdminUserState;
  cursor?: string;
  detail?: string;
};

export const Route = createFileRoute("/admin/users")({
  validateSearch: (search): Search => ({
    q: typeof search.q === "string" ? search.q : undefined,
    tier: ["standard", "lite"].includes(String(search.tier))
      ? (search.tier as AdminUserTier)
      : "all",
    state: ["active", "disabled"].includes(String(search.state))
      ? (search.state as AdminUserState)
      : "all",
    cursor: typeof search.cursor === "string" ? search.cursor : undefined,
    detail: typeof search.detail === "string" ? search.detail : undefined,
  }),
  component: AdminUsersPage,
});

function AdminUsersPage() {
  return (
    <AdminGuard>
      {({ identity }) => (
        <AdminShell active="/admin/users">
          <Users identity={identity} />
        </AdminShell>
      )}
    </AdminGuard>
  );
}

function Users({ identity }: { identity: string }) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/admin/users" });
  const [q, setQ] = useState(search.q ?? "");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const detailOpenerRef = useRef<{ id: string; element: HTMLElement } | null>(
    null,
  );
  const params = {
    q: search.q,
    tier: search.tier,
    state: search.state,
    cursor: search.cursor,
  };
  const query = useQuery({
    queryKey: adminKey(identity, "users", params),
    queryFn: ({ signal }) => fetchAdminUsers(params, signal),
    retry: false,
  });
  const detail = useQuery({
    queryKey: adminKey(identity, "user", search.detail),
    queryFn: ({ signal }) => fetchAdminUser(search.detail ?? "", signal),
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
          <h2>用户</h2>
          <AdminRefreshButton
            className="button secondary"
            scope={`admin-users:${identity}:list-refresh:${JSON.stringify(params)}`}
            busy={query.isFetching}
            title={
              query.isError && query.data
                ? `读取失败，请重试。上次读取：${fmtTime(query.dataUpdatedAt)}`
                : "刷新"
            }
            onRefresh={() => query.refetch()}
          />
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
            aria-label="搜索用户"
            placeholder="用户名、显示名称或用户 ID"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <select
            aria-label="账号类型"
            value={search.tier}
            onChange={(event) =>
              update({ tier: event.target.value as AdminUserTier })
            }
          >
            <option value="all">全部账号</option>
            <option value="standard">普通</option>
            <option value="lite">青春版</option>
          </select>
          <select
            aria-label="账号状态"
            value={search.state}
            onChange={(event) =>
              update({ state: event.target.value as AdminUserState })
            }
          >
            <option value="all">全部状态</option>
            <option value="active">可用</option>
            <option value="disabled">停用</option>
          </select>
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
                    <th>用户</th>
                    <th>Linux DO ID</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th>注册</th>
                    <th>最近登录</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <Link
                          to="/admin/users"
                          search={{ ...search, detail: item.id }}
                          onClick={(event) => {
                            detailOpenerRef.current = {
                              id: item.id,
                              element: event.currentTarget,
                            };
                          }}
                        >
                          {item.displayName}
                        </Link>
                        <span className="admin-muted-id">{item.username}</span>
                      </td>
                      <td>{item.externalId}</td>
                      <td>
                        {item.accountTier === "standard" ? "普通" : "青春版"}
                      </td>
                      <td>{item.active ? "可用" : "停用"}</td>
                      <td>{fmtTime(item.createdAt)}</td>
                      <td>{fmtTime(item.lastLoginAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!query.data.items.length && <p>没有匹配的用户。</p>}
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
        label="用户详情"
        placeholder={<p className="text-sm text-subtle">选择用户查看详情。</p>}
        onClose={closeDetail}
      >
        {detail.data ? (
          <UserDetail
            user={detail.data.user}
            busy={detail.isFetching}
            refreshScope={`admin-users:${identity}:${detail.data.user.id}:refresh`}
            stale={detail.isError}
            staleReadAt={fmtTime(detail.dataUpdatedAt)}
            onRefresh={() => detail.refetch()}
          />
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

function UserDetail({
  user,
  busy,
  refreshScope,
  stale,
  staleReadAt,
  onRefresh,
}: {
  user: Awaited<ReturnType<typeof fetchAdminUser>>["user"];
  busy: boolean;
  refreshScope: string;
  stale: boolean;
  staleReadAt: string;
  onRefresh: () => Promise<
    QueryObserverResult<Awaited<ReturnType<typeof fetchAdminUser>>, Error>
  >;
}) {
  return (
    <div>
      <div className="admin-detail-heading">
        <h2>{user.displayName}</h2>
        <AdminRefreshButton
          className="button secondary"
          scope={refreshScope}
          busy={busy}
          title={stale ? `读取失败，请重试。上次读取：${staleReadAt}` : "刷新"}
          onRefresh={onRefresh}
        />
      </div>
      <dl className="admin-detail-list">
        <Row label="本站用户 ID" value={user.id} />
        <Row label="Linux DO ID" value={user.externalId} />
        <Row label="用户名" value={user.username} />
        <Row
          label="账号类型"
          value={user.accountTier === "standard" ? "普通" : "青春版"}
        />
        <Row
          label="永久账号资格"
          value={user.officialConnectVerified ? "已获得" : "未获得"}
        />
        <Row label="账号状态" value={user.active ? "可用" : "停用"} />
        <Row label="注册时间" value={fmtTime(user.createdAt)} />
        <Row label="最近登录" value={fmtTime(user.lastLoginAt)} />
        <Row label="发起活动" value={String(user.counts.authoredActivities)} />
        <Row label="领取" value={String(user.counts.claims)} />
        <Row label="报名" value={String(user.counts.registrations)} />
        <Row label="商户" value={String(user.counts.merchants)} />
      </dl>
      <div className="work-rate-limit-actions">
        <Link
          className="button secondary"
          to="/admin/activities"
          search={{ authorId: user.id }}
        >
          筛选活动
        </Link>
        <Link
          className="button secondary"
          to="/admin/payments"
          search={{ recipientId: user.externalId }}
        >
          筛选付款
        </Link>
      </div>
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
    tier: search.tier === "all" ? undefined : search.tier,
    state: search.state === "all" ? undefined : search.state,
    cursor: search.cursor || undefined,
    detail: search.detail || undefined,
  };
}
