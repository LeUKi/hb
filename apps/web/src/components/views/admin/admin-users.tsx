import {
  ADMIN_USER_LEVELS,
  type AdminUserDetail,
  type AdminUserFish,
  type AdminUserLevel,
  type AdminUserListItem,
  type AdminUserLogin,
  type AdminUserSort,
  levelsText,
  TRUST_LEVEL_NAMES,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SlidersHorizontal, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useAdminList, useAdminUser } from "../../../lib/admin";
import { cn } from "../../../lib/cn";
import { clockLabel, fullTime } from "../../../lib/roster-time";
import type { AdminSearch } from "../../../router";
import { PlusMark } from "../../balance/plus";
import { useQueryLazyList } from "../../page/lazy-list";
import { EmptyNote } from "../../page/page";
import { Bone, PageLoad, resultOf } from "../../page/page-state";
import { WindowDialog } from "../../shell/window-dialog";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { CopyButton } from "../../ui/copy-button";
import { Field, Segmented, ToggleCards } from "../../ui/field";
import { Fish } from "../../ui/fish";
import { MorphLabel } from "../../ui/morph-label";
import { RevealInline } from "../../ui/reveal";
import { StatusChip } from "../../ui/status-chip";
import { UserBalance } from "./admin-balance";
import {
  AdminFrame,
  countLine,
  DetailRetry,
  DetailRows,
  FilterChip,
  ListDetail,
  listLoad,
  SearchBox,
  useOpenSearched,
  useSettled,
} from "./admin-frame";

/** In the address as the page says it; the API calls 停用 disabled. */
type State = "all" | "active" | "inactive" | "silenced";

type Filters = {
  sort: AdminUserSort;
  levels: AdminUserLevel[];
  fish: AdminUserFish;
  login: AdminUserLogin;
  state: State;
};

const sortLabels: Record<AdminUserSort, string> = {
  created: "最新注册",
  login: "最近登录",
  idle: "最久没登录",
  fish: "🐟额最多",
  level: "等级最高",
};
const fishLabels: Record<AdminUserFish, string> = {
  all: "全部",
  has: "有🐟额",
  plus: "PLUS",
  none: "没有🐟额",
};
const loginLabels: Record<AdminUserLogin, string> = {
  all: "全部",
  week: "7 天内",
  month: "30 天内",
  away: "超过 30 天",
};
/** The tag of a login filter: what it keeps, in a phrase. */
const loginTags: Record<AdminUserLogin, string> = {
  all: "",
  week: "7 天内登录",
  month: "30 天内登录",
  away: "超过 30 天没登录",
};
const stateLabels: Record<State, string> = {
  all: "全部",
  active: "可用",
  inactive: "停用",
  silenced: "禁言",
};

/** Lv0–Lv4 with LINUX DO's names, and those never read. */
const levelOptions = [
  ...TRUST_LEVEL_NAMES.map((name, level) => ({
    value: level as AdminUserLevel,
    title: `Lv${level}`,
    description: name,
  })),
  { value: "unknown" as const, title: "未知", description: "还没读到" },
];

const choiceOf = <T extends string>(
  labels: Record<T, string>,
  value: string | undefined,
  fallback: T,
): T => (value !== undefined && value in labels ? (value as T) : fallback);

/**
 * A 等级 as the address writes it: lv2, unknown (a bare 2 would come back
 * quoted, the router keeping it a string).
 */
const levelWord = (level: AdminUserLevel) =>
  level === "unknown" ? level : `lv${level}`;

function filtersOf(search: AdminSearch): Filters {
  const levels = search.level?.split(",") ?? [];
  return {
    sort: choiceOf(sortLabels, search.sort, "created"),
    levels: ADMIN_USER_LEVELS.filter((level) =>
      levels.includes(levelWord(level)),
    ),
    fish: choiceOf(fishLabels, search.fish, "all"),
    login: choiceOf(loginLabels, search.login, "all"),
    state: choiceOf(stateLabels, search.status, "all"),
  };
}

/** The filters as the address writes them: the defaults are left out. */
function searchOf(filters: Filters): Partial<AdminSearch> {
  return {
    sort: filters.sort === "created" ? undefined : filters.sort,
    level: filters.levels.length
      ? filters.levels.map(levelWord).join(",")
      : undefined,
    fish: filters.fish === "all" ? undefined : filters.fish,
    login: filters.login === "all" ? undefined : filters.login,
    status: filters.state === "all" ? undefined : filters.state,
  };
}

const defaults: Filters = {
  sort: "created",
  levels: [],
  fish: "all",
  login: "all",
  state: "all",
};

/** "Lv2、Lv3", "Lv2 及以上、未知": the levels picked. */
function levelTag(levels: readonly AdminUserLevel[]) {
  const known = levels.filter((level) => level !== "unknown");
  return [
    ...(known.length ? [levelsText(known)] : []),
    ...(levels.includes("unknown") ? ["未知"] : []),
  ].join("、");
}

/** "Lv3 活跃用户", or 等级未知 for one never read. */
function levelLabel(level: number | null) {
  return level === null
    ? "等级未知"
    : `Lv${level} ${TRUST_LEVEL_NAMES[level] ?? ""}`.trim();
}

const monthDay = (at: number) => {
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

function dateLabel(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** Something available, owed or held: 有🐟额. */
const holdsFish = (user: AdminUserListItem) =>
  user.fish !== null &&
  (user.fish.availableMinor !== 0 || user.fish.lockedMinor > 0);

function RowBody({
  user,
  sort,
}: {
  user: AdminUserListItem;
  sort: AdminUserSort;
}) {
  // What the list is sorted by reads a shade darker.
  const sorted = (on: boolean) => (on ? "text-ink-2" : undefined);
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
          {user.silenced && <StatusChip>禁言</StatusChip>}
          {user.plus && <PlusMark />}
        </span>
        <span className="truncate text-xs text-ink-3">
          <span className={sorted(sort === "level")}>
            {levelLabel(user.trustLevel)}
          </span>
          {user.fish && holdsFish(user) && (
            <>
              {" · "}
              <Fish
                minor={user.fish.availableMinor}
                className={sorted(sort === "fish")}
              />
            </>
          )}
          {" · "}
          <span className={sorted(sort !== "level" && sort !== "fish")}>
            {sort === "created"
              ? `${clockLabel(user.createdAt)} 注册`
              : user.lastLoginAt
                ? `${clockLabel(user.lastLoginAt)} 登录`
                : "注册后没再登录"}
          </span>
        </span>
      </span>
    </>
  );
}

function Detail({ user }: { user: AdminUserListItem }) {
  const navigate = useNavigate({ from: "/admin/users" });
  const query = useAdminUser(user.id);
  const read = query.data?.user;
  // Read with the detail: a short grey bar until it is in.
  const later = (value: (detail: AdminUserDetail) => ReactNode) =>
    read ? value(read) : query.isError ? "—" : <Bone className="h-3 w-24" />;
  const small = (text: string) => (
    <span className="ms-1.5 text-xs text-ink-3">{text}</span>
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
            label: "等级",
            value:
              user.trustLevel === null ? (
                <>未知{small("10 月 22 日以后还没登录过")}</>
              ) : (
                <>
                  {levelLabel(user.trustLevel)}
                  {user.profileSeenAt !== null &&
                    small(`${monthDay(user.profileSeenAt)}登录时读到`)}
                </>
              ),
          },
          {
            label: "状态",
            value: `${user.active ? "可用" : "停用（LINUX DO 账号已停用）"}${user.silenced ? "，论坛禁言中" : ""}`,
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
            value: later(
              (detail) =>
                `${detail.counts.authoredActivities} 个，大家领到 ${detail.amounts.sent} LDC`,
            ),
          },
          {
            label: "参与",
            value: later(
              (detail) =>
                `领取 ${detail.counts.claims} 次 · 报名 ${detail.counts.registrations} 次`,
            ),
          },
          {
            label: "领到",
            value: later((detail) => (
              <>
                {detail.amounts.received} LDC{small("领取和中奖的合计")}
              </>
            )),
          },
          {
            label: "收到的付款",
            value: later((detail) => `${detail.counts.paymentTasks} 笔`),
          },
          {
            label: "商户",
            value: later((detail) => `${detail.counts.merchants} 个`),
          },
        ]}
      />
      <DetailRetry query={query} />
      <div className="flex flex-wrap gap-2">
        {(read?.counts.authoredActivities ?? 0) > 0 && (
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
        {(read?.counts.paymentTasks ?? 0) > 0 && (
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
      <UserBalance userId={user.id} />
    </>
  );
}

/**
 * One group of the 筛选 dialog: a title over its control, or beside it
 * for a one-line switcher (under it again where the line is too short).
 */
function FilterGroup({
  title,
  inline = false,
  children,
}: {
  title: string;
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "py-3.5 first:pt-1",
        inline
          ? "flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5"
          : "grid gap-2.5",
      )}
    >
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 筛选用户 (07 §10): the order and every filter in one dialog. A choice
 * applies at once and the list behind follows; 完成, Esc or the 压暗层
 * close it.
 */
function FilterDialog({
  open,
  onClose,
  filters,
  onChange,
  total,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  total: number | undefined;
  busy: boolean;
}) {
  const titleId = useId();
  const changed = changedCount(filters) > 0;
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      // Wide enough for the five orders beside their title.
      width="30rem"
    >
      <div className="flex max-h-[min(44rem,85cqh)] min-h-0 flex-col">
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            筛选用户
          </h2>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <div className="view-scroll grid min-h-0 flex-1 grid-cols-1 content-start divide-y divide-line overflow-y-auto overscroll-contain px-5 pb-2">
          <FilterGroup title="排序" inline>
            <Segmented
              size="sm"
              label="排序"
              value={filters.sort}
              onChange={(sort) => onChange({ sort })}
              options={Object.entries(sortLabels).map(([value, label]) => ({
                value: value as AdminUserSort,
                label,
              }))}
            />
          </FilterGroup>
          <FilterGroup title="等级">
            <Field
              label="等级"
              labelHidden
              hint="登录时从 LINUX DO 读到；10 月 22 日以后没登录过的是未知。"
            >
              <ToggleCards
                label="等级"
                values={filters.levels}
                options={levelOptions}
                onChange={(levels) => onChange({ levels })}
              />
            </Field>
          </FilterGroup>
          <FilterGroup title="🐟额" inline>
            <Segmented
              size="sm"
              label="🐟额"
              value={filters.fish}
              onChange={(fish) => onChange({ fish })}
              options={Object.entries(fishLabels).map(([value, label]) => ({
                value: value as AdminUserFish,
                label,
              }))}
            />
          </FilterGroup>
          <FilterGroup title="登录" inline>
            <Segmented
              size="sm"
              label="登录"
              value={filters.login}
              onChange={(login) => onChange({ login })}
              options={Object.entries(loginLabels).map(([value, label]) => ({
                value: value as AdminUserLogin,
                label,
              }))}
            />
          </FilterGroup>
          <FilterGroup title="状态" inline>
            <Segmented
              size="sm"
              label="账号状态"
              value={filters.state}
              onChange={(state) => onChange({ state })}
              options={Object.entries(stateLabels).map(([value, label]) => ({
                value: value as State,
                label,
              }))}
            />
          </FilterGroup>
        </div>
        <footer className="flex items-center gap-2 px-5 pt-2 pb-4">
          <span
            className={cn(
              "me-auto text-sm text-ink-3 transition-opacity",
              busy && "opacity-60",
            )}
          >
            {countLine(total, "人")}
          </span>
          <RevealInline show={changed}>
            <Button variant="ghost" onClick={() => onChange(defaults)}>
              清除
            </Button>
          </RevealInline>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </footer>
      </div>
    </WindowDialog>
  );
}

/** How many of the order and filters are not the default. */
function changedCount(filters: Filters) {
  return Object.values(searchOf(filters)).filter(Boolean).length;
}

/**
 * /admin/users 用户: everyone who has signed in, newest first unless sorted
 * otherwise, narrowed by 等级, 🐟额, login and state. Read-only: 可用 /
 * 停用 and 等级 follow the LINUX DO account at each sign-in, and admins come
 * from the deployment's settings, so there is nothing to switch here.
 */
export function AdminUsers({ search }: { search: AdminSearch }) {
  const navigate = useNavigate({ from: "/admin/users" });
  const [query, setQuery] = useState(search.q ?? "");
  const q = useSettled(query.trim());
  // In the address, so a reload or the way back keeps them.
  const filters = filtersOf(search);
  const setFilters = (patch: Partial<Filters>) =>
    void navigate({
      search: (prev) => ({ ...prev, ...searchOf({ ...filters, ...patch }) }),
      replace: true,
    });
  const [filtering, setFiltering] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const listQuery = useAdminList("users", {
    q: q || undefined,
    state:
      filters.state === "all"
        ? undefined
        : filters.state === "inactive"
          ? "disabled"
          : filters.state,
    sort: filters.sort === "created" ? undefined : filters.sort,
    level: filters.levels.length ? filters.levels.join(",") : undefined,
    fish: filters.fish === "all" ? undefined : filters.fish,
    login: filters.login === "all" ? undefined : filters.login,
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
  useOpenSearched(
    search.q,
    q,
    listQuery.data && !busy ? users : undefined,
    setSelected,
  );
  const changed = changedCount(filters);
  // Each condition in force, removable on its own.
  const tags: { key: string; label: string; clear: Partial<Filters> }[] = [
    {
      key: "sort",
      label:
        filters.sort === "created" ? "" : `排序：${sortLabels[filters.sort]}`,
      clear: { sort: "created" },
    },
    { key: "level", label: levelTag(filters.levels), clear: { levels: [] } },
    {
      key: "fish",
      label: filters.fish === "all" ? "" : fishLabels[filters.fish],
      clear: { fish: "all" },
    },
    { key: "login", label: loginTags[filters.login], clear: { login: "all" } },
    {
      key: "state",
      label: filters.state === "all" ? "" : stateLabels[filters.state],
      clear: { state: "all" },
    },
  ];

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
          <Button
            aria-haspopup="dialog"
            aria-expanded={filtering}
            onClick={() => setFiltering(true)}
          >
            <SlidersHorizontal aria-hidden="true" />
            <MorphLabel>{changed ? `筛选 · ${changed}` : "筛选"}</MorphLabel>
          </Button>
          {tags.map((tag) => (
            <RevealInline key={tag.key} show={tag.label !== ""}>
              <FilterChip
                label={tag.label}
                onClear={() => setFilters(tag.clear)}
              />
            </RevealInline>
          ))}
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
          row={(user) => <RowBody user={user} sort={filters.sort} />}
          detail={(user) => <Detail user={user} />}
        />
        <FilterDialog
          open={filtering}
          onClose={() => setFiltering(false)}
          filters={filters}
          onChange={setFilters}
          total={total}
          busy={busy}
        />
      </AdminFrame>
    </PageLoad>
  );
}
