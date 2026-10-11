import type { ReactNode } from "react";
import type { Activity, ActivityViewState, PaymentProgress } from "../types";
import { activityLifecycleLabels } from "../view-state";
import { ActivityCountdown } from "./activity-countdown";
import { StatusBadge } from "./list-controls";
import { PaymentConfirmation } from "./payment-confirmation";
import "./compact-activity-table.css";

export { projectActivityTableState } from "../activity-table-state";

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
  children,
}: {
  label: string;
  variant: "participation" | "managed" | "public";
  columns: ActivityTableColumn[];
  className?: string;
  children: ReactNode;
}) {
  return (
    <table
      className={`compact-activity-table compact-activity-table--${variant} ${className}`}
      aria-label={label}
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
      <tbody>{children}</tbody>
    </table>
  );
}

export function ActivityRowTitle({
  activity,
  state,
  onOpen,
  buttonClassName = "",
  titleActions,
  children,
}: {
  activity: Activity;
  state: ActivityViewState;
  onOpen: () => void;
  buttonClassName?: string;
  titleActions?: ReactNode;
  children?: ReactNode;
}) {
  const drawing =
    state.lifecycle !== "draft" && state.drawProgress === "settling";
  const label = drawing ? "正在开奖" : activityLifecycleLabels[state.lifecycle];
  const counting = state.lifecycle === "active" && !drawing;
  return (
    <div className="activity-table-title-cell">
      <div className="activity-row-title">
        <div className="activity-row-title-main">
          <button
            type="button"
            className={`activity-table-open ${buttonClassName}`}
            onClick={onOpen}
            title={activity.title}
          >
            {activity.title}
          </button>
          {titleActions && (
            <span className="activity-row-title-actions">{titleActions}</span>
          )}
        </div>
        <div className="activity-row-title-meta">
          <StatusBadge
            tone={
              state.lifecycle === "draft"
                ? "pending"
                : state.lifecycle === "active"
                  ? "success"
                  : "neutral"
            }
          >
            {label}
            {counting && (
              <ActivityCountdown
                deadlineAt={activity.deadlineAt ?? null}
                active
                kind={activity.type === "draw" ? "draw" : "instant"}
                className="activity-row-countdown"
              />
            )}
          </StatusBadge>
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
  paymentStatus?: PaymentProgress | null;
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
      {status && (
        <span className="activity-rows-reward-status activity-reward-status">
          {status}
        </span>
      )}
    </div>
  );
}
