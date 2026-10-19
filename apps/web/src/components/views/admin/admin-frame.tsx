import type { UseQueryResult } from "@tanstack/react-query";
import { useMatches } from "@tanstack/react-router";
import { RotateCw, Search, X } from "lucide-react";
import { AnimatePresence, useIsPresent } from "motion/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../../../lib/cn";
import { type LazyList, LazyListEnd } from "../../page/lazy-list";
import { Page, PageHeader, Panel, RefreshContext } from "../../page/page";
import {
  Bone,
  ListSkeleton,
  type Loadable,
  ResultError,
  readFailed,
  type resultOf,
} from "../../page/page-state";
import { WindowDialog } from "../../shell/window-dialog";
import { useWindowInfo } from "../../shell/window-info";
import { Button } from "../../ui/button";
import { TextInput } from "../../ui/field";
import { RollingText } from "../../ui/morph-label";
import { ListItem, Swap } from "../../ui/reveal";
import { SegmentedNav } from "../../ui/segmented";
import { radius, Squircle } from "../../ui/squircle";

// 网站管理: one header and one row of tabs over six pages, which stay while
// the pages below them change (ViewStage keeps one frame for all of /admin).
// Production's admin area is read-only except the 尝试间隔 settings, and so
// is this one.

const tabs: {
  to: string;
  label: string;
  /** Under the title while this tab shows (概览 says when it last read). */
  description?: string;
  /** A list read from the server: 刷新 in the header. */
  refreshable: boolean;
}[] = [
  { to: "/admin", label: "概览", refreshable: true },
  {
    to: "/admin/activities",
    label: "红包",
    description: "全站的红包，草稿也在内。只能查看，不能修改、结束或删除。",
    refreshable: true,
  },
  {
    to: "/admin/users",
    label: "用户",
    description:
      "登录过本站的人。状态跟随 LINUX DO 账号，每次登录时同步；这里只能查看。",
    refreshable: true,
  },
  {
    to: "/admin/payments",
    label: "付款",
    description: "全站的付款。重试和查单都是系统自己做的，这里只能查看。",
    refreshable: true,
  },
  {
    to: "/admin/balance",
    label: "🐟额",
    description:
      "站内🐟额：替大家存着多少、哪些转入要看一下，以及每一笔调整。平台应用和费率在网站设置里。",
    refreshable: true,
  },
  {
    to: "/admin/settings",
    label: "网站设置",
    description: "口令尝试间隔、站内🐟额和它的平台应用，保存后立即生效。",
    refreshable: false,
  },
  {
    to: "/admin/audit",
    label: "操作记录",
    description: "尝试间隔和🐟额设置的每一次修改。记录一直保留。",
    refreshable: true,
  },
];

function AdminTabs() {
  const current = useMatches({
    select: (matches) => matches.at(-1)?.routeId ?? "",
  });
  return <SegmentedNav label="管理入口" items={tabs} current={current} />;
}

/** What the page below tells the header: its state of reading. */
type HeaderState = {
  routeId: string;
  description?: string;
  stale: boolean;
  retrying: boolean;
};

const AdminHeaderContext = createContext<{
  register: (state: HeaderState) => void;
  /** The shown page's 刷新 and 重试 (kept current by AdminFrame). */
  actions: { current: { retry: () => void; reload: () => void } };
} | null>(null);
/** Which tab's page this is (a leaving page keeps its own). */
const AdminRouteContext = createContext("");

/**
 * 网站管理's frame, kept across its pages: the title, its line and 刷新 (the
 * shown page's), the tabs, then the page itself, which fades in over the
 * one before as it changes (each page loads in place, PageLoad area).
 */
export function AdminArea({
  routeId,
  children,
}: {
  routeId: string;
  children: ReactNode;
}) {
  const tab = tabs.find((item) => item.to === routeId) ?? tabs[0];
  const [header, setHeader] = useState<HeaderState | null>(null);
  const actions = useRef({ retry: () => {}, reload: () => {} });
  const register = useCallback(
    (next: HeaderState) =>
      setHeader((current) =>
        current &&
        current.routeId === next.routeId &&
        current.description === next.description &&
        current.stale === next.stale &&
        current.retrying === next.retrying
          ? current
          : next,
      ),
    [],
  );
  const shown = header?.routeId === routeId ? header : null;
  const context = useMemo(() => ({ register, actions }), [register]);
  return (
    <AdminHeaderContext.Provider value={context}>
      <Page width="wide">
        <div className="flex flex-col gap-4">
          {/* Until the page below has read once, 刷新 turns as it reads. */}
          <RefreshContext.Provider
            value={{
              stale: shown?.stale ?? false,
              retrying: shown ? shown.retrying : true,
              retry: () => actions.current.retry(),
              reload: () => actions.current.reload(),
            }}
          >
            <PageHeader
              title="网站管理"
              description={shown?.description ?? tab?.description}
              refreshable={tab?.refreshable}
            />
          </RefreshContext.Provider>
          <AdminTabs />
        </div>
        <Swap id={routeId}>
          <AdminRouteContext.Provider value={routeId}>
            {children}
          </AdminRouteContext.Provider>
        </Swap>
      </Page>
    </AdminHeaderContext.Provider>
  );
}

/**
 * A 网站管理 page's content, inside its PageLoad: tells the frame's header
 * how its reading goes (and, on 概览, when it last read).
 */
export function AdminFrame({
  description,
  children,
}: {
  description?: string;
  children: ReactNode;
}) {
  const header = useContext(AdminHeaderContext);
  const refresh = useContext(RefreshContext);
  const routeId = useContext(AdminRouteContext);
  const present = useIsPresent();
  if (header && refresh && present)
    header.actions.current = { retry: refresh.retry, reload: refresh.reload };
  const stale = refresh?.stale ?? false;
  const retrying = refresh?.retrying ?? false;
  useLayoutEffect(() => {
    if (present) header?.register({ routeId, description, stale, retrying });
  }, [header, routeId, description, stale, retrying, present]);
  return <div className="grid gap-6 @wide/window:gap-8">{children}</div>;
}

type Readable = {
  data: unknown;
  isError: boolean;
  isFetchNextPageError?: boolean;
  isFetching: boolean;
  refetch: () => Promise<{ isError: boolean }>;
};

/**
 * A list page's data: the list (its loaded pages), and the selected row's
 * detail, read again with it by 刷新.
 */
export function listLoad(
  list: Readable,
  detail?: { refetch: () => Promise<unknown> } | null,
): Loadable {
  return {
    hasData: list.data !== undefined,
    isError: readFailed(list),
    isFetching: list.isFetching,
    refetch: async () => {
      const [read] = await Promise.all([list.refetch(), detail?.refetch()]);
      return !read.isError;
    },
  };
}

/** What was typed, once typing pauses: one read per search, not per key. */
export function useSettled(value: string, delay = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** The search box over a list: searches as you type (the server's search). */
export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
  maxLength,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  /** As long as the server takes. */
  maxLength: number;
}) {
  return (
    <TextInput
      aria-label={label}
      type="search"
      className="min-w-0 flex-1 basis-64"
      prefix={<Search className="size-4" aria-hidden="true" />}
      placeholder={placeholder}
      maxLength={maxLength}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** A filter that came with the address (from another page): removable. */
export function FilterChip({
  label,
  onClear,
}: {
  label: ReactNode;
  onClear: () => void;
}) {
  return (
    <Squircle radius={11}>
      <span className="inline-flex h-8 min-w-0 items-center gap-1 bg-accent-soft pr-1 pl-3 text-sm text-accent-ink">
        <span className="truncate">{label}</span>
        <button
          type="button"
          onClick={onClear}
          aria-label="清除这个筛选"
          className="grid size-6 shrink-0 place-items-center rounded-full hover:bg-white/60"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </span>
    </Squircle>
  );
}

/** A toggle that narrows a list (开奖异常, 结果未知 …). */
export function ToggleChip({
  pressed,
  onChange,
  children,
}: {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Squircle radius={11}>
      <button
        type="button"
        aria-pressed={pressed}
        onClick={() => onChange(!pressed)}
        className={cn(
          // The raised face eases in and out with its colour.
          "inline-flex h-8 items-center px-3 text-sm transition-[color,background-color,box-shadow] duration-200",
          pressed
            ? "bg-white font-medium text-ink raised"
            : "bg-fill-2 text-ink-2 hover:text-ink",
        )}
      >
        {children}
      </button>
    </Squircle>
  );
}

/** "63 笔" once the count is known (its figure rolls); until then, nothing. */
export function countLine(total: number | undefined, unit: string) {
  return total === undefined ? null : <RollingText text={`${total} ${unit}`} />;
}

/**
 * A list with a detail beside it (wide windows) or over it (narrow ones,
 * in a dialog). Selecting a row shows its detail; the list stays put. The
 * rows come from the server 20 at a time (`list`).
 */
export function ListDetail<T extends { id: string }>({
  items,
  list,
  total,
  load,
  selectedId,
  onSelect,
  row,
  detail,
  empty,
  placeholder,
  unit,
  noun,
}: {
  items: T[];
  list: LazyList;
  /** How many match, when the server said. */
  total: number | undefined;
  /**
   * The list's read (resultOf): a new filter's rows on their way keep the
   * old ones, dimmed; a list not read yet shows bars, a failed one 重试.
   */
  load: ReturnType<typeof resultOf>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  row: (item: T, selected: boolean) => ReactNode;
  detail: (item: T) => ReactNode;
  empty: ReactNode;
  placeholder: string;
  /** What the list counts by, as its header does: 个 / 人 / 笔. */
  unit: string;
  /** What one row is, for the dialog's title: 红包 / 用户 / 付款. */
  noun: string;
}) {
  const { roomy } = useWindowInfo();
  const titleId = useId();
  const selected = items.find((item) => item.id === selectedId) ?? null;
  // The compact dialog keeps showing the last item while it animates out.
  const last = useRef<T | null>(null);
  if (selected) last.current = selected;
  const dialogItem = selected ?? last.current;
  const busy = load.placeholder;
  const content = !load.hasData ? (
    load.isError ? (
      <ResultError onRetry={load.retry} />
    ) : (
      <ListSkeleton />
    )
  ) : items.length === 0 ? (
    <div className={cn("transition-opacity", busy && "opacity-60")}>
      {empty}
    </div>
  ) : (
    <Panel className="grid gap-0.5 p-1.5">
      <ul
        className={cn(
          "flex flex-col gap-0.5 transition-opacity",
          busy && "opacity-60",
        )}
        aria-busy={busy || list.state === "loading" || undefined}
      >
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <ListItem key={item.id}>
              <Squircle radius={radius.row}>
                <button
                  type="button"
                  aria-current={item.id === selectedId ? "true" : undefined}
                  onClick={() =>
                    onSelect(item.id === selectedId ? null : item.id)
                  }
                  className={cn(
                    "flex w-full items-center gap-3 p-3 text-left transition-colors",
                    item.id === selectedId ? "bg-white/80" : "hover:bg-fill-2",
                  )}
                >
                  {row(item, item.id === selectedId)}
                </button>
              </Squircle>
            </ListItem>
          ))}
        </AnimatePresence>
      </ul>
      <LazyListEnd
        list={list}
        done={total === undefined ? "已全部加载" : `共 ${total} ${unit}`}
      />
    </Panel>
  );

  // Bars, an error, nothing found or the rows: each fades in place.
  const shownContent = (
    <Swap
      id={
        !load.hasData
          ? load.isError
            ? "error"
            : "loading"
          : items.length === 0
            ? "empty"
            : "rows"
      }
    >
      {content}
    </Swap>
  );

  if (!roomy)
    return (
      <>
        {shownContent}
        <WindowDialog
          open={selected !== null}
          onClose={() => onSelect(null)}
          labelledBy={titleId}
        >
          {dialogItem && (
            <div className="grid gap-4 p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 id={titleId} className="text-lg font-semibold text-ink">
                  {noun}详情
                </h2>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="关闭"
                  className="-mr-2 shrink-0"
                  onClick={() => onSelect(null)}
                >
                  <X />
                </Button>
              </div>
              {detail(dialogItem)}
            </div>
          )}
        </WindowDialog>
      </>
    );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_22rem] items-start gap-6">
      <div className="min-w-0">{shownContent}</div>
      {/* Sticky offsets count from the scroller's content box, which
          already starts under the 顶栏. */}
      <aside
        aria-label="详情"
        className="sticky top-4 max-h-[calc(100cqh-var(--bar-h)-2rem)] overflow-y-auto overscroll-contain"
      >
        {/* Another row's detail fades in over the last one's. */}
        <Swap id={selected?.id ?? "none"}>
          {selected ? (
            <Panel className="grid gap-4 p-4">{detail(selected)}</Panel>
          ) : (
            <Panel className="grid min-h-40 place-items-center p-6 text-center">
              <p className="text-sm text-ink-3">{placeholder}</p>
            </Panel>
          )}
        </Swap>
      </aside>
    </div>
  );
}

/** A detail's own read failed: say so, with 重试 (the rest stays). */
export function DetailRetry({ query }: { query: UseQueryResult<unknown> }) {
  if (!query.isError || query.data !== undefined) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
      <span role="alert">详情读取失败。</span>
      <Button
        size="sm"
        variant="ghost"
        className="-my-1"
        aria-disabled={query.isFetching || undefined}
        onClick={() => {
          if (!query.isFetching) void query.refetch();
        }}
      >
        <RotateCw
          className={query.isFetching ? "motion-safe:animate-spin" : undefined}
          aria-hidden="true"
        />
        {query.isFetching ? "正在读取…" : "重试"}
      </Button>
    </div>
  );
}

/**
 * The part of a detail read on its own (the list row already gave the
 * rest): grey bars while it reads, a line and 重试 if that failed.
 */
export function DetailPart<T>({
  query,
  lines = 4,
  children,
}: {
  query: UseQueryResult<T>;
  lines?: number;
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return children(query.data);
  if (query.isError) return <DetailRetry query={query} />;
  return (
    <div className="grid gap-3">
      <p role="status" className="sr-only">
        正在读取…
      </p>
      {Array.from({ length: lines }, (_, index) => index).map((index) => (
        <div
          key={index}
          aria-hidden="true"
          className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3"
        >
          <Bone className="h-3 w-14" />
          <Bone className={cn("h-3", index % 2 ? "w-2/3" : "w-5/6")} />
        </div>
      ))}
    </div>
  );
}

/** Label–value rows for a detail pane (narrower than InfoList). */
export function DetailRows({
  rows,
}: {
  rows: { label: string; value: ReactNode }[];
}) {
  return (
    <dl className="grid gap-2.5 text-sm">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3"
        >
          <dt className="text-ink-3">{row.label}</dt>
          <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
