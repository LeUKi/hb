import type {
  ActivityRewardSummary,
  ActivityStatus,
  PaymentMode,
  PaymentState,
  PublicQuantity,
  RegistrationStatus,
} from "@hb/contracts";
import { paymentLabel } from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, MoreHorizontal } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { quantityText, statusLabels } from "../../lib/activities";
import { formatCountdownDuration, useNow } from "../../lib/clock";
import { useFreshNavigation } from "../../lib/navigation-state";
import { normalizeDisplayTopicLink } from "../../lib/topic-link";
import { SegmentedControl, StatusBadge } from "./list-controls";
import { PaymentConfirmation } from "./payment-confirmation";
import { portalPosition, usePortalTarget } from "./portal-target";

export function rewardKindLabel(reward?: ActivityRewardSummary) {
  if (!reward) return "LDC";
  if (reward.mode === "fixed") return "固定均分";
  if (reward.mode === "custom") return "自定义金额";
  if (reward.mode === "random") return "随机金额";
  if (reward.mode === "timed_draw") return "限时开奖";
  return "LDC";
}

export function rewardMainText(reward?: ActivityRewardSummary) {
  if (reward?.mode === "fixed" && reward.unitAmount)
    return `${reward.unitAmount} LDC / 份`;
  if (reward?.totalAmount) return `${reward.totalAmount} LDC 奖池`;
  return "LDC 奖励";
}

export type HistorySummary = {
  started: number | null;
  participated: number | null;
};

export function HistoryStats({ summary }: { summary: HistorySummary }) {
  return (
    <section className="history-statistics" aria-label="活动历史统计">
      <div data-statistic="initiated">
        <span>已发起</span>
        <span className="history-statistics-value">
          {summary.started ?? "—"}
          <small>场</small>
        </span>
      </div>
      <div data-statistic="participated">
        <span>已参与</span>
        <span className="history-statistics-value">
          {summary.participated ?? "—"}
          <small>场</small>
        </span>
      </div>
    </section>
  );
}

export type ActivityTableColumn = {
  key: string;
  label: string;
  width: string;
};

export function CompactActivityTable({
  label,
  variant,
  columns,
  className = "",
  state = "ready",
  emptyText = "暂无记录",
  errorContent,
  onRetry,
  children,
}: {
  label: string;
  variant: "participation" | "managed" | "public" | "statistics";
  columns: ActivityTableColumn[];
  className?: string;
  state?: "ready" | "empty" | "loading" | "error";
  emptyText?: string;
  errorContent?: ReactNode;
  onRetry?: () => void;
  children: ReactNode;
}) {
  const colSpan = Math.max(columns.length, 1);
  return (
    <table
      className={`compact-activity-table compact-activity-table--${variant} ${className}`.trim()}
      aria-label={label}
      aria-busy={state === "loading"}
    >
      <colgroup>
        {columns.map((column) => (
          <col key={column.key} style={{ width: column.width }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} scope="col">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {state === "loading" ? (
          <TableSkeletonRows rows={3} colSpan={colSpan} />
        ) : state === "error" ? (
          <tr className="compact-activity-table__state-row">
            <td colSpan={colSpan}>
              {errorContent ?? (
                <div className="list-panel__state">
                  <p role="alert">加载失败，请重试。</p>
                  {onRetry ? (
                    <button
                      type="button"
                      className="list-pagination__button"
                      onClick={onRetry}
                    >
                      重试
                    </button>
                  ) : null}
                </div>
              )}
            </td>
          </tr>
        ) : state === "empty" ? (
          <tr className="compact-activity-table__state-row">
            <td colSpan={colSpan}>
              <p className="activity-rows-empty" role="status">
                {emptyText}
              </p>
            </td>
          </tr>
        ) : (
          children
        )}
      </tbody>
    </table>
  );
}

function TableSkeletonRows({
  rows,
  colSpan,
}: {
  rows: number;
  colSpan: number;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <tr
          // biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton slots never contain record state.
          key={`table-skeleton-${index}`}
          className="compact-activity-row compact-activity-table__skeleton-row"
        >
          <td colSpan={colSpan}>
            <span data-skeleton-row="true" />
          </td>
        </tr>
      ))}
    </>
  );
}

export function HistoryTabs({ active }: { active: "claims" | "activities" }) {
  const navigate = useFreshNavigation();
  return (
    <SegmentedControl
      label="活动历史分类"
      mode="tabs"
      value={active}
      onChange={(value) => {
        void navigate(value === "claims" ? "/my/claims" : "/my/activities");
      }}
      options={[
        { value: "activities", label: "我发起的" },
        { value: "claims", label: "我参与的" },
      ]}
    />
  );
}

export function EmptyPanel({ children }: { children: ReactNode }) {
  return <p className="activity-empty-panel">{children}</p>;
}

export function activityStatusText(
  activity: {
    status: ActivityStatus;
    deadlineAt?: string | null;
    draw?: { state?: string } | null;
  },
  now: number,
) {
  if (activity.draw?.state === "settling") return "正在开奖";
  if (activity.draw?.state === "waiting") {
    const left = activity.deadlineAt
      ? ` ${formatCountdownDuration(Math.max(0, Date.parse(activity.deadlineAt) - now))}`
      : "";
    return `进行中${left}`;
  }
  if (activity.status === "active" && activity.deadlineAt)
    return `进行中 ${formatCountdownDuration(Math.max(0, Date.parse(activity.deadlineAt) - now))}`;
  return statusLabels[activity.status];
}

export function ActivityRowTitle({
  title,
  status,
  onOpen,
  href,
  buttonClassName = "",
  titleActions,
  children,
  deadlineAt,
  draw,
}: {
  title: string;
  status: ActivityStatus;
  onOpen?: () => void;
  href?: string;
  buttonClassName?: string;
  titleActions?: ReactNode;
  children?: ReactNode;
  deadlineAt?: string | null;
  draw?: { state?: string } | null;
}) {
  const now = useNow();
  const drawing = draw?.state === "settling";
  const label = drawing
    ? "正在开奖"
    : activityStatusText({ status, deadlineAt, draw }, now);
  const tone =
    status === "draft"
      ? "pending"
      : status === "active"
        ? "success"
        : "neutral";
  return (
    <div className="activity-table-title-cell">
      <div className="activity-row-title">
        <div className="activity-row-title-main">
          {href ? (
            <Link
              to={href}
              className={`activity-table-open ${buttonClassName}`.trim()}
              title={title || "未命名活动"}
            >
              {title || "未命名活动"}
            </Link>
          ) : (
            <button
              type="button"
              className={`activity-table-open ${buttonClassName}`.trim()}
              onClick={onOpen}
              title={title || "未命名活动"}
            >
              {title || "未命名活动"}
            </button>
          )}
          {titleActions ? (
            <span className="activity-row-title-actions">{titleActions}</span>
          ) : null}
        </div>
        <div className="activity-row-title-meta">
          <StatusBadge tone={tone}>{label}</StatusBadge>
          {children}
        </div>
      </div>
    </div>
  );
}

export function ActivityReward({
  label,
  amount,
  summary,
  status,
  paymentStatus,
  confirmedAt,
}: {
  label: string;
  amount?: string;
  summary?: string;
  status?: string;
  paymentStatus?: PaymentState | null;
  confirmedAt?: string | null;
}) {
  return (
    <div className="activity-reward">
      <span className="activity-rows-type activity-reward-label">{label}</span>
      {amount ? (
        <div className="activity-reward-primary">
          <strong className="activity-rows-amount activity-reward-amount">
            +{amount} <span>LDC</span>
          </strong>
          <PaymentConfirmation
            status={paymentStatus}
            confirmedAt={confirmedAt}
          />
        </div>
      ) : summary ? (
        <span className="activity-reward-summary">{summary}</span>
      ) : null}
      {status ? (
        <span className="activity-rows-reward-status activity-reward-status">
          {status}
        </span>
      ) : null}
    </div>
  );
}

export function QuantityCell({
  quantity,
  kind = "instant",
}: {
  quantity: PublicQuantity;
  kind?: "draw" | "instant";
}) {
  const text = quantityText(quantity, kind);
  if (!text) return <span className="activity-subtle">数量已隐藏</span>;
  return <span className="activity-subtle">{text}</span>;
}

function LinuxDoMark({ size = 14 }: { size?: number }) {
  const clipId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      aria-hidden="true"
      focusable="false"
      className="activity-forum-linuxdo-mark"
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="60" cy="60" r="47" />
        </clipPath>
      </defs>
      <circle fill="#f0f0f0" cx="60" cy="60" r="50" />
      <g clipPath={`url(#${clipId})`}>
        <rect fill="#1c1c1e" x="10" y="10" width="100" height="30" />
        <rect fill="#f0f0f0" x="10" y="40" width="100" height="40" />
        <rect fill="#ffb003" x="10" y="80" width="100" height="30" />
      </g>
    </svg>
  );
}

export function ForumLink({ href }: { href: string }) {
  const normalized = normalizeDisplayTopicLink(href);
  if (!normalized) return null;
  return (
    <a
      className="activity-forum-link"
      href={normalized.topicUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="打开关联论坛帖子"
      onClick={(event) => event.stopPropagation()}
    >
      <LinuxDoMark size={14} />
      <ArrowUpRight size={11} aria-hidden="true" />
    </a>
  );
}

export function CompactForumLink({ href }: { href: string }) {
  const normalized = normalizeDisplayTopicLink(href);
  if (!normalized) return null;
  return (
    <a
      className="activity-rows-topic-link"
      href={normalized.topicUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="打开关联论坛帖子"
      title="打开关联论坛帖子"
      onClick={(event) => event.stopPropagation()}
    >
      <LinuxDoMark size={14} />
      <ArrowUpRight size={11} aria-hidden="true" />
    </a>
  );
}

export function ViewActivityAction({
  id,
  className = "",
  onClick,
  role,
  "aria-label": ariaLabel,
}: {
  id: string;
  className?: string;
  onClick?: () => void;
  role?: "menuitem";
  "aria-label"?: string;
}) {
  return (
    <Link
      className={`row-action view-activity-action ${className}`.trim()}
      to="/activities/$id"
      params={{ id }}
      aria-label={ariaLabel ?? "查看活动"}
      role={role}
      onClick={onClick}
    >
      查看活动
    </Link>
  );
}

export type RowAction = {
  label: string;
  onSelect?: () => void;
  activityId?: string;
  href?: string;
  danger?: boolean;
  disabled?: boolean;
};

function actionClass(action: RowAction, primary = false) {
  return [
    "row-action",
    primary ? "row-action-primary" : "",
    action.danger ? "row-action--danger" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function ActionControl({
  action,
  ariaLabel,
  role,
  primary = false,
  onClick,
}: {
  action: RowAction;
  ariaLabel?: string;
  role?: "menuitem";
  primary?: boolean;
  onClick?: () => void;
}) {
  const className = actionClass(action, primary);
  const invoke = () => {
    onClick?.();
    action.onSelect?.();
  };
  if (action.href && !action.disabled)
    return (
      <Link
        to={action.href}
        className={className}
        aria-label={ariaLabel}
        role={role}
        onClick={onClick}
      >
        {action.label}
      </Link>
    );
  if (action.activityId && !action.disabled)
    return (
      <ViewActivityAction
        id={action.activityId}
        className={className}
        aria-label={ariaLabel}
        role={role}
        onClick={onClick}
      />
    );
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      role={role}
      disabled={action.disabled}
      onClick={invoke}
    >
      {action.label}
    </button>
  );
}

export function RowActions({
  label,
  actions,
}: {
  label: string;
  actions: RowAction[];
}) {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(max-width: 760px)").matches,
  );
  const reducedMotion = useReducedMotion();
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const portalTarget = usePortalTarget(trigger);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const primary = actions[0];
  const menuActions = compact ? actions.slice(1) : [];
  const ordinary = menuActions.filter((action) => !action.danger);
  const dangerous = menuActions.filter((action) => action.danger);

  function close(returnFocus = false) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => {
      setCompact(media.matches);
      setOpen(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const dimensions = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(
        12,
        Math.min(
          anchor.right - dimensions.width,
          window.innerWidth - dimensions.width - 12,
        ),
      ),
      top: Math.max(
        12,
        Math.min(
          anchor.bottom + 6,
          window.innerHeight - dimensions.height - 12,
        ),
      ),
    });
    const first = menu.current.querySelector<HTMLElement>(
      "button:not(:disabled), a[href]",
    );
    (first ?? menu.current).focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const hide = (event: Event) => {
      if (
        event.type === "pointerdown" &&
        (trigger.current?.contains(event.target as Node) ||
          menu.current?.contains(event.target as Node))
      )
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", hide);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  return (
    <div className="row-actions">
      <div className="row-actions-inline">
        {actions.map((action) => (
          <ActionControl
            key={action.label}
            ariaLabel={`${label}：${action.label}`}
            action={action}
          />
        ))}
      </div>
      {primary ? (
        <ActionControl
          ariaLabel={`${label}：${primary.label}`}
          action={primary}
          primary
        />
      ) : null}
      {menuActions.length > 0 ? (
        <button
          ref={trigger}
          type="button"
          className={`row-menu-trigger${!compact ? " row-menu-trigger--desktop" : ""}`}
          aria-label={`${label}操作`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen(!open)}
        >
          <MoreHorizontal size={19} aria-hidden="true" />
        </button>
      ) : null}
      {createPortal(
        <AnimatePresence>
          {open ? (
            <motion.div
              ref={menu}
              role="menu"
              id={id}
              aria-label={`${label}操作`}
              className="row-action-menu"
              style={portalPosition(portalTarget, position, menu.current)}
              tabIndex={-1}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.15 }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close(true);
                }
              }}
            >
              {ordinary.map((action) => (
                <ActionControl
                  key={action.label}
                  action={action}
                  role="menuitem"
                  onClick={() => close(true)}
                />
              ))}
              {ordinary.length > 0 && dangerous.length > 0 ? (
                <hr className="row-action-separator" />
              ) : null}
              {dangerous.map((action) => (
                <ActionControl
                  key={action.label}
                  action={action}
                  role="menuitem"
                  onClick={() => close()}
                />
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>,
        portalTarget,
      )}
    </div>
  );
}

export function PaymentStatusText({
  mode = "simulation",
  status,
}: {
  mode?: PaymentMode;
  status: PaymentState;
}) {
  return <span>{paymentLabel(mode, status)}</span>;
}

export function registrationLabel(status: RegistrationStatus) {
  return {
    registered: "已报名",
    drawing: "已报名",
    won: "已中奖",
    not_won: "未中奖",
  }[status];
}
