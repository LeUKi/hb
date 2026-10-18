import { CloudOff, RotateCw, Wrench } from "lucide-react";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
} from "react";
import { cn } from "../../lib/cn";
import { useMaintenance } from "../../lib/maintenance";
import { useWindowInfo } from "../shell/window-info";
import { Button } from "../ui/button";
import { MorphLabel, RollingText } from "../ui/morph-label";
import { Reveal } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";

// The frame every command page uses: one column on the glass, a title row,
// titled sections and in-page panels. Most pages are 44rem wide; the 红包
// 广场's cards and 网站管理's list beside its detail use 64rem.

const widths = {
  narrow: "max-w-[44rem]",
  wide: "max-w-[64rem]",
} as const;

export function Page({
  width = "narrow",
  children,
  className,
}: {
  width?: keyof typeof widths;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto grid w-full content-start gap-6 px-4 pt-6 pb-12 @wide/window:gap-8 @wide/window:px-8 @wide/window:pt-10",
        widths[width],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A background refresh failed (page-state.tsx sets it, PageHeader shows it). */
export const RefreshContext = createContext<{
  stale: boolean;
  retrying: boolean;
  /** 重试 after a failed background refresh. */
  retry: () => void;
  /** 刷新 by hand (the header's button). */
  reload: () => void;
} | null>(null);

/**
 * 刷新: reads the page again — production's one RefreshButton for every
 * list (it had five kinds). Focus stays on the button; "已刷新" is said.
 */
export function RefreshButton() {
  const state = useContext(RefreshContext);
  const { compact } = useWindowInfo();
  if (!state) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      // Not disabled: a disabled button drops focus, and focus stays here.
      aria-disabled={state.retrying}
      onClick={() => {
        if (!state.retrying) state.reload();
      }}
      aria-label={compact ? "刷新" : undefined}
      title="刷新"
    >
      <RotateCw
        className={state.retrying ? "motion-safe:animate-spin" : undefined}
        aria-hidden="true"
      />
      {!compact && (state.retrying ? "正在刷新…" : "刷新")}
    </Button>
  );
}

/**
 * Under a page's title when a background refresh failed: the content is
 * kept (production's "刷新失败，当前内容已保留。"), with a retry.
 */
export function RefreshNotice() {
  const state = useContext(RefreshContext);
  const maintenance = useMaintenance();
  // Opens and closes in place: the page under it moves, it does not jump.
  return (
    <Reveal show={Boolean(state?.stale)}>
      <Callout
        tone="warning"
        icon={maintenance ? Wrench : CloudOff}
        title={
          maintenance
            ? "系统维护中，当前内容已保留。"
            : "刷新失败，当前内容已保留。"
        }
      >
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>下面可能不是最新的。</span>
          <Button
            size="sm"
            variant="ghost"
            className="-my-1"
            // Not disabled, so focus stays on it while it reads again.
            aria-disabled={state?.retrying || undefined}
            onClick={() => {
              if (state && !state.retrying) state.retry();
            }}
          >
            <RotateCw
              className={
                state?.retrying ? "motion-safe:animate-spin" : undefined
              }
              aria-hidden="true"
            />
            {state?.retrying ? "正在刷新…" : "重试"}
          </Button>
        </span>
      </Callout>
    </Reveal>
  );
}

/** The page's title row: what this page is, and its main actions. */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  refreshable = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A small line above the title (where this page belongs). */
  eyebrow?: ReactNode;
  /** A list read from the server: 刷新 at the end of the actions. */
  refreshable?: boolean;
}) {
  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 px-1">
        {/* Grows, so a long description wraps beside the actions. */}
        <div className="grid min-w-0 flex-1 basis-48 gap-1">
          {eyebrow && <div className="text-sm text-ink-3">{eyebrow}</div>}
          {/* Focusable from code: where reading starts again after 重试. */}
          <h1
            tabIndex={-1}
            className="text-xl font-semibold text-balance text-ink outline-none"
          >
            {title}
          </h1>
          {/* Arrives with the data, and its words can change (网站管理's
              tabs): it opens in place and cross-fades. */}
          <Reveal show={Boolean(description)}>
            <p className="text-sm text-ink-2">
              <MorphLabel fit={false}>{description}</MorphLabel>
            </p>
          </Reveal>
        </div>
        {(actions || refreshable) && (
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {refreshable && <RefreshButton />}
          </div>
        )}
      </header>
      <RefreshNotice />
    </>
  );
}

/** A titled group on a page. */
export function PageSection({
  title,
  description,
  action,
  children,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="grid gap-3" aria-labelledby={id}>
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="grid gap-0.5">
          <h2 id={id} className="text-base font-semibold text-ink">
            {title}
          </h2>
          <Reveal show={Boolean(description)}>
            <p className="text-sm text-ink-3">
              <MorphLabel fit={false}>{description}</MorphLabel>
            </p>
          </Reveal>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** An in-page surface on the glass: a light panel, squircle 16. */
export function Panel({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "ul" | "dl";
}) {
  // A list holds only its items, not a squircle's ring: the surface is a
  // div around it.
  if (Tag === "ul" || Tag === "dl")
    return (
      <Squircle radius={radius.card}>
        <div className="panel">
          <Tag className={className}>{children}</Tag>
        </div>
      </Squircle>
    );
  return (
    <Squircle radius={radius.card}>
      <Tag className={cn("panel", className)}>{children}</Tag>
    </Squircle>
  );
}

/** A row of figures: label above, value below. */
export function Facts({
  items,
  className,
}: {
  items: { label: string; value: ReactNode; note?: ReactNode }[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-x-6 gap-y-4 @wide/window:grid-cols-4",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="grid min-w-0 content-start gap-0.5">
          <dt className="text-sm text-ink-3">{item.label}</dt>
          <dd className="truncate text-lg font-semibold text-ink tabular-nums">
            {/* Figures roll as they change (a poll, 刷新). */}
            {typeof item.value === "string" ? (
              <RollingText text={item.value} />
            ) : (
              item.value
            )}
          </dd>
          {item.note && (
            <dd className="truncate text-xs text-ink-3">{item.note}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/** Nothing to list yet: a quiet line in a panel. */
export function EmptyNote({
  title,
  text,
  action,
}: {
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <Panel className="grid justify-items-center gap-2 px-6 py-10 text-center">
      <p className="text-base font-medium text-ink">{title}</p>
      {text && <p className="text-sm text-ink-3">{text}</p>}
      {action && <div className="mt-2">{action}</div>}
    </Panel>
  );
}

export type InfoItem = {
  label: ReactNode;
  value: ReactNode;
  /** A quiet line under the value. */
  note?: ReactNode;
  /** A small control at the end of the row (copy, edit). */
  action?: ReactNode;
  key?: string;
};

/**
 * Label–value rows in a panel, divided by hairlines: the label on the left
 * on wide windows, above the value on narrow ones.
 */
export function InfoList({
  items,
  className,
}: {
  items: InfoItem[];
  className?: string;
}) {
  return (
    <Panel as="dl" className={cn("grid px-4", className)}>
      {items.map((item, index) => (
        <div
          key={
            item.key ?? (typeof item.label === "string" ? item.label : index)
          }
          className="grid gap-x-4 gap-y-1 border-line border-b py-3 last:border-b-0 @wide/window:grid-cols-[8.5rem_minmax(0,1fr)] @wide/window:items-baseline"
        >
          <dt className="text-sm text-ink-3">{item.label}</dt>
          <dd className="flex min-w-0 items-center gap-2 text-base text-ink">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {item.value}
            </span>
            {item.action}
          </dd>
          {item.note && (
            <dd className="text-xs text-ink-3 @wide/window:col-start-2">
              {item.note}
            </dd>
          )}
        </div>
      ))}
    </Panel>
  );
}

const calloutTones = {
  neutral: "bg-fill text-ink-2",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  success: "bg-success-soft text-success",
} as const;

/** A short note in a tinted squircle: what is going on and what to do. */
export function Callout({
  tone = "neutral",
  icon: Icon,
  title,
  children,
  className,
}: {
  tone?: keyof typeof calloutTones;
  icon?: ComponentType<{ className?: string }>;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Squircle radius={radius.callout}>
      <div
        className={cn(
          "flex gap-2.5 px-3.5 py-3 text-sm",
          calloutTones[tone],
          className,
        )}
      >
        {Icon && <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
        <div className="grid min-w-0 gap-0.5">
          {title && <p className="font-medium">{title}</p>}
          {children && (
            <div className={title ? "text-ink-2" : undefined}>{children}</div>
          )}
        </div>
      </div>
    </Squircle>
  );
}
