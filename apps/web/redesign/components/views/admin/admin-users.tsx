import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { type SiteUser, siteUsers } from "../../../fixtures/admin";
import { clockLabel, fullTime } from "../../../lib/roster-time";
import type { AdminSearch } from "../../../router";
import { EmptyNote } from "../../page/page";
import { useSearchChoice } from "../../shell/use-search-choice";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { CopyButton } from "../../ui/copy-button";
import { Segmented } from "../../ui/field";
import { StatusChip } from "../../ui/status-chip";
import { AdminFrame, DetailRows, ListDetail, SearchBox } from "./admin-frame";

type State = "all" | "active" | "inactive";

function dateLabel(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * /admin/users 用户: everyone who has signed in, newest first. Read-only:
 * 可用 / 停用 follows the LINUX DO account at each sign-in, and admins come
 * from the deployment's settings, so there is nothing to switch here.
 * (青春版 is gone, and with it the 账号类型 filter and column.)
 */
export function AdminUsers({ search }: { search: AdminSearch }) {
  const navigate = useNavigate({ from: "/admin/users" });
  const [query, setQuery] = useState(search.q ?? "");
  const [state, setState] = useSearchChoice<State>("status", "all", [
    "all",
    "active",
    "inactive",
  ]);
  const [selected, setSelected] = useState<string | null>(null);
  const text = query.trim().toLowerCase();
  const users = siteUsers().filter(
    (user) =>
      (state === "all" || user.active === (state === "active")) &&
      (!text ||
        user.id === text ||
        String(user.linuxDoId) === text ||
        user.username.toLowerCase().includes(text) ||
        user.displayName.toLowerCase().includes(text)),
  );

  return (
    <AdminFrame
      refreshable
      description="登录过本站的人。状态跟随 LINUX DO 账号，每次登录时同步；这里只能查看。"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          label="搜索用户"
          value={query}
          onChange={setQuery}
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
        <span className="ml-auto text-sm text-ink-3">{users.length} 人</span>
      </div>
      <ListDetail<SiteUser>
        items={users}
        selectedId={selected}
        onSelect={setSelected}
        placeholder="点一个人看详情。"
        empty={<EmptyNote title="没有符合条件的用户" />}
        row={(user) => (
          <>
            <Avatar name={user.displayName} size={36} />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-base text-ink">
                  {user.displayName}
                </span>
                <span className="truncate text-xs text-ink-3">
                  @{user.username}
                </span>
                {user.admin && <StatusChip tone="gold">管理员</StatusChip>}
                {!user.active && <StatusChip>停用</StatusChip>}
              </span>
              <span className="truncate text-xs text-ink-3">
                LINUX DO ID {user.linuxDoId} ·{" "}
                {user.lastLoginAt
                  ? `${clockLabel(user.lastLoginAt)} 登录`
                  : "注册后没再登录"}
              </span>
            </span>
          </>
        )}
        detail={(user) => (
          <>
            <div className="flex items-center gap-3">
              <Avatar name={user.displayName} size={44} />
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
                      <span className="min-w-0 font-mono text-xs">
                        {user.id}
                      </span>
                      <CopyButton value={user.id} label="本站 ID" />
                    </span>
                  ),
                },
                { label: "LINUX DO ID", value: user.linuxDoId },
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
                { label: "发出的红包", value: `${user.sent} 个` },
                {
                  label: "参与",
                  value: `领取 ${user.claims} 次 · 报名 ${user.registrations} 次`,
                },
                { label: "商户", value: `${user.merchants} 个` },
              ]}
            />
            <div className="flex flex-wrap gap-2">
              {user.sent > 0 && (
                <Button
                  size="sm"
                  onClick={() =>
                    void navigate({
                      to: "/admin/activities",
                      search: { author: user.username },
                    })
                  }
                >
                  查看发出的红包
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void navigate({
                    to: "/admin/payments",
                    search: { recipient: user.username },
                  })
                }
              >
                查看收到的付款
              </Button>
            </div>
          </>
        )}
      />
    </AdminFrame>
  );
}
