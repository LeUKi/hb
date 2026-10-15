import { Link, useMatches } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { cn } from "../../../lib/cn";
import { LazyListEnd, useLazyList } from "../../page/lazy-list";
import { Page, PageHeader, Panel } from "../../page/page";
import { WindowDialog } from "../../shell/window-dialog";
import { useWindowInfo } from "../../shell/window-info";
import { Button } from "../../ui/button";
import { TextInput } from "../../ui/field";
import { radius, Squircle } from "../../ui/squircle";

// 网站管理: one header and one row of tabs over six pages. Production's admin
// area is read-only except the 尝试间隔 settings, and so is this one.

const tabs = [
  { to: "/admin", label: "概览" },
  { to: "/admin/activities", label: "红包" },
  { to: "/admin/users", label: "用户" },
  { to: "/admin/payments", label: "付款" },
  { to: "/admin/settings", label: "网站设置" },
  { to: "/admin/audit", label: "操作记录" },
] as const;

function AdminTabs() {
  const current = useMatches({
    select: (matches) => matches.at(-1)?.routeId ?? "",
  });
  return (
    <Squircle radius={13}>
      <nav
        aria-label="管理入口"
        className="flex w-fit max-w-full overflow-x-auto bg-fill-2 p-0.5 scrollbar-none"
      >
        {tabs.map((tab) => {
          const active = current === tab.to;
          return (
            <Squircle key={tab.to} radius={11}>
              <Link
                to={tab.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center px-3.5 text-sm whitespace-nowrap transition-colors",
                  active
                    ? "bg-white font-medium text-ink raised"
                    : "text-ink-2 hover:text-ink",
                )}
              >
                {tab.label}
              </Link>
            </Squircle>
          );
        })}
      </nav>
    </Squircle>
  );
}

export function AdminFrame({
  description,
  actions,
  refreshable = false,
  children,
}: {
  description?: ReactNode;
  actions?: ReactNode;
  /** A list page: 刷新 in the header (the overview has its own). */
  refreshable?: boolean;
  children: ReactNode;
}) {
  return (
    <Page width="wide">
      <div className="grid gap-4">
        <PageHeader
          title="网站管理"
          description={description}
          actions={actions}
          refreshable={refreshable}
        />
        <AdminTabs />
      </div>
      {children}
    </Page>
  );
}

/** The search box over a list: filters as you type. */
export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <TextInput
      aria-label={label}
      type="search"
      className="min-w-0 flex-1 basis-64"
      prefix={<Search className="size-4" aria-hidden="true" />}
      placeholder={placeholder}
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
      <span className="inline-flex h-8 items-center gap-1 bg-accent-soft pr-1 pl-3 text-sm text-accent-ink">
        {label}
        <button
          type="button"
          onClick={onClear}
          aria-label="清除这个筛选"
          className="grid size-6 place-items-center rounded-full hover:bg-white/60"
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
          "inline-flex h-8 items-center px-3 text-sm transition-colors",
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

/**
 * A list with a detail beside it (wide windows) or over it (narrow ones,
 * in a dialog). Selecting a row shows its detail; the list stays put.
 */
export function ListDetail<T extends { id: string }>({
  items,
  selectedId,
  onSelect,
  row,
  detail,
  empty,
  placeholder,
  pageSize = 20,
}: {
  items: T[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  row: (item: T, selected: boolean) => ReactNode;
  detail: (item: T) => ReactNode;
  empty: ReactNode;
  placeholder: string;
  pageSize?: number;
}) {
  const { roomy } = useWindowInfo();
  // A filter in the address replaces the history entry, so a new filter
  // starts again at the first 20.
  const lazy = useLazyList({ id: "admin-list", total: items.length, pageSize });
  const titleId = useId();
  const selected = items.find((item) => item.id === selectedId) ?? null;
  // The compact dialog keeps showing the last item while it animates out.
  const last = useRef<T | null>(null);
  if (selected) last.current = selected;
  const dialogItem = selected ?? last.current;
  const list =
    items.length === 0 ? (
      empty
    ) : (
      <Panel className="grid gap-0.5 p-1.5">
        <ul
          className="grid gap-0.5"
          aria-busy={lazy.state === "loading" || undefined}
        >
          {items.slice(0, lazy.shown).map((item) => (
            <li key={item.id}>
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
            </li>
          ))}
        </ul>
        <LazyListEnd list={lazy} done={`共 ${items.length} 条`} />
      </Panel>
    );

  if (!roomy)
    return (
      <>
        {list}
        <WindowDialog
          open={selected !== null}
          onClose={() => onSelect(null)}
          labelledBy={titleId}
        >
          {dialogItem && (
            <div className="grid gap-4 p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 id={titleId} className="text-lg font-semibold text-ink">
                  详情
                </h2>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onSelect(null)}
                >
                  关闭
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
      <div className="min-w-0">{list}</div>
      {/* Sticky offsets count from the scroller's content box, which
          already starts under the 顶栏. */}
      <aside
        aria-label="详情"
        className={cn(
          "sticky top-4 max-h-[calc(100cqh-var(--bar-h)-2rem)] overflow-y-auto overscroll-contain",
        )}
      >
        {selected ? (
          <Panel className="grid gap-4 p-4">{detail(selected)}</Panel>
        ) : (
          <Panel className="grid min-h-40 place-items-center p-6 text-center">
            <p className="text-sm text-ink-3">{placeholder}</p>
          </Panel>
        )}
      </aside>
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
