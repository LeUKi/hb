import type { AdminUserDetail, AdminUserListItem } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useAdminList, useAdminUser } from "../../../lib/admin";
import { cn } from "../../../lib/cn";
import { clockLabel, fullTime } from "../../../lib/roster-time";
import type { AdminSearch } from "../../../router";
import { useQueryLazyList } from "../../page/lazy-list";
import { EmptyNote } from "../../page/page";
import { Bone, PageLoad, resultOf } from "../../page/page-state";
import { useSearchChoice } from "../../shell/use-search-choice";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { CopyButton } from "../../ui/copy-button";
import { Segmented } from "../../ui/field";
import { StatusChip } from "../../ui/status-chip";
import {
  AdminFrame,
  countLine,
  DetailRetry,
  DetailRows,
  ListDetail,
  listLoad,
  SearchBox,
  useSettled,
} from "./admin-frame";

/** In the address as the page says it; the API calls 停用 disabled. */
type State = "all" | "active" | "inactive";

function dateLabel(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function RowBody({ user }: { user: AdminUserListItem }) {
  return (
    <>
      <Avatar name={user.displayName} src={user.avatarUrl} size={36} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-base text-ink">
            {user.displayName}
          </span>
          <span className="truncate text-xs text-ink-3">@{user.username}</span>
          {user.admin && <StatusChip tone="gold">管理员</StatusChip>}
          {!user.active && <StatusChip>停用</StatusChip>}
        </span>
        <span className="truncate text-xs text-ink-3">
          LINUX DO ID {user.externalId} ·{" "}
          {user.lastLoginAt
            ? `${clockLabel(user.lastLoginAt)} 登录`
            : "注册后没再登录"}
        </span>
      </span>
    </>
  );
}

function Detail({ user }: { user: AdminUserListItem }) {
  const navigate = useNavigate({ from: "/admin/users" });
  const query = useAdminUser(user.id);
  const counts = query.data?.user.counts;
  // Read with the detail: a short grey bar until it is in.
  const later = (value: (counts: AdminUserDetail["counts"]) => ReactNode) =>
    counts ? (
      value(counts)
    ) : query.isError ? (
      "—"
    ) : (
      <Bone className="h-3 w-24" />
    );
  return (
    <>
      <div className="flex items-center gap-3">
        <Avatar name={user.displayName} src={user.avatarUrl} size={44} />
        <div className="grid min-w-0 gap-0.5">
          <p className="truncate text-base font-semibold text-ink">
            {user.displayName}
          </p>
          <p className="truncate text-sm text-ink-2">@{user.username}</p>
        </div>
      </div>
      <DetailRows
        rows={[
          {
            label: "本站 ID",
            value: (
              <span className="flex items-center gap-1">
                <span className="min-w-0 font-mono text-xs">{user.id}</span>
                <CopyButton value={user.id} label="本站 ID" />
              </span>
            ),
          },
          { label: "LINUX DO ID", value: user.externalId },
          {
            label: "状态",
            value: user.active ? "可用" : "停用（LINUX DO 账号已停用）",
          },
          { label: "身份", value: user.admin ? "管理员" : "普通" },
          {
            label: "注册",
            value: (
              <span title={fullTime(user.createdAt)}>
                {dateLabel(user.createdAt)}
              </span>
            ),
          },
          {
            label: "最近登录",
            value: user.lastLoginAt ? clockLabel(user.lastLoginAt) : "—",
          },
          {
            label: "发出的红包",
            value: later((counts) => `${counts.authoredActivities} 个`),
          },
          {
            label: "参与",
            value: later(
              (counts) =>
                `领取 ${counts.claims} 次 · 报名 ${counts.registrations} 次`,
            ),
          },
          {
            label: "收到的付款",
            value: later((counts) => `${counts.paymentTasks} 笔`),
          },
          { label: "商户", value: later((counts) => `${counts.merchants} 个`) },
        ]}
      />
      <DetailRetry query={query} />
      <div className="flex flex-wrap gap-2">
        {(counts?.authoredActivities ?? 0) > 0 && (
          <Button
            size="sm"
            onClick={() =>
              void navigate({
                to: "/admin/activities",
                search: { author: user.id },
              })
            }
          >
            查看发出的红包
          </Button>
        )}
        {(counts?.paymentTasks ?? 0) > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: "/admin/payments",
                search: { recipient: user.id },
              })
            }
          >
            查看收到的付款
          </Button>
        )}
      </div>
    </>
  );
}

/**
 * /admin/users 用户: everyone who has signed in, newest first. Read-only:
 * 可用 / 停用 follows the LINUX DO account at each sign-in, and admins come
 * from the deployment's settings, so there is nothing to switch here.
 */
export function AdminUsers({ search }: { search: AdminSearch }) {
  const [query, setQuery] = useState(search.q ?? "");
  const q = useSettled(query.trim());
  const [state, setState] = useSearchChoice<State>("status", "all", [
    "all",
    "active",
    "inactive",
  ]);
  const [selected, setSelected] = useState<string | null>(null);
  const listQuery = useAdminList("users", {
    q: q || undefined,
    state:
      state === "all" ? undefined : state === "active" ? "active" : "disabled",
  });
  const detail = useAdminUser(selected);
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
  const users = pages
    .flatMap((page) => page.items)
    .filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));

  return (
    // The search and filters stay once shown; the list loads in place.
    <PageLoad load={listLoad(listQuery, selected ? detail : null)} area frame>
      <AdminFrame>
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox
            label="搜索用户"
            value={query}
            onChange={setQuery}
            maxLength={200}
            placeholder="用户名、昵称、本站 ID 或 LINUX DO ID"
          />
          <Segmented
            size="sm"
            label="账号状态"
            value={state}
            onChange={setState}
            options={[
              { value: "all", label: "全部" },
              { value: "active", label: "可用" },
              { value: "inactive", label: "停用" },
            ]}
          />
          <span
            className={cn(
              "ml-auto text-sm text-ink-3 transition-opacity",
              busy && "opacity-60",
            )}
          >
            {countLine(total, "人")}
          </span>
        </div>
        <ListDetail
          items={users}
          list={list}
          total={total}
          load={resultOf(listQuery)}
          selectedId={selected}
          onSelect={setSelected}
          placeholder="点一个人看详情。"
          unit="人"
          noun="用户"
          empty={<EmptyNote title="没有符合条件的用户" text="换个筛选看看。" />}
          row={(user) => <RowBody user={user} />}
          detail={(user) => <Detail user={user} />}
        />
      </AdminFrame>
    </PageLoad>
  );
}
