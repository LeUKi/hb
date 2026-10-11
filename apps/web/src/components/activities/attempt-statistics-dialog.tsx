import { X } from "lucide-react";
import {
  type PointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useActivityStatistics } from "../../lib/discovery";
import {
  useCursorRecovery,
  useRestoredScroll,
  useViewState,
} from "../../lib/navigation-state";
import { isAccessQueryError, listQueryState } from "../../lib/query-view";
import { CompactIconButton } from "../presentation/compact-icon-button";
import { ListPanel, Pagination } from "../presentation/list-controls";
import { RefreshNotice, SkeletonRows } from "../presentation/loading";
import { PortalTargetProvider } from "../presentation/portal-target";
import { ActivityErrorView } from "./activity-error";

type StatisticsSummarySnapshot = {
  totalAttempts: number;
  uniqueUsers: number;
  successfulClaims: number;
  validPasswords: Array<{ password: string; successfulClaims: number }>;
};

export type AttemptStatisticsDialogProps = {
  activityId: string;
  userId: string;
  title?: string;
  restoreFocus?: Element | null;
  onClose: () => void;
};

export function AttemptStatisticsDialog({
  activityId,
  userId,
  title,
  restoreFocus,
  onClose,
}: AttemptStatisticsDialogProps) {
  const titleId = useId();
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const handled = useRef(false);
  const backdropPress = useRef(false);
  const [cursors, setCursors] = useViewState<Array<string | null>>(
    "statistics-cursors",
    [null],
    activityId,
  );
  const body = useRef<HTMLDivElement>(null);
  const query = useActivityStatistics(
    userId,
    activityId,
    cursors.at(-1) ?? null,
  );
  const cursorNotice = useCursorRecovery(query.error, cursors, setCursors);
  useRestoredScroll(body, `statistics-body:${activityId}`, !query.isPending);
  const snapshot = useRef<StatisticsSummarySnapshot | null>(null);
  const accessError = query.isError && isAccessQueryError(query.error);

  useEffect(() => {
    if (accessError) {
      snapshot.current = null;
      return;
    }
    if (!query.data) return;
    snapshot.current = {
      totalAttempts: query.data.totalAttempts,
      uniqueUsers: query.data.uniqueUsers,
      successfulClaims: query.data.successfulClaims,
      validPasswords: query.data.validPasswords,
    };
  }, [accessError, query.data]);

  useLayoutEffect(() => {
    if (!dialog) return;
    opener.current = restoreFocus ?? document.activeElement;
    dialog.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
    };
  }, [dialog, restoreFocus]);

  const summary = accessError
    ? null
    : query.data
      ? {
          totalAttempts: query.data.totalAttempts,
          uniqueUsers: query.data.uniqueUsers,
          successfulClaims: query.data.successfulClaims,
          validPasswords: query.data.validPasswords,
        }
      : snapshot.current;
  const state = accessError ? "error" : listQueryState(query);

  function close() {
    if (handled.current || !dialog?.open) return;
    handled.current = true;
    dialog.close();
    onClose();
    requestAnimationFrame(() => {
      if (opener.current instanceof HTMLElement && opener.current.isConnected)
        opener.current.focus({ preventScroll: true });
    });
  }

  function isBackdrop(event: PointerEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const bounds = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  }

  return createPortal(
    <dialog
      ref={setDialog}
      className="attempt-statistics-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.defaultPrevented) return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter(
          (node) => node.offsetParent !== null && !node.closest("[inert]"),
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onPointerDown={(event) => {
        backdropPress.current = isBackdrop(event);
      }}
      onPointerUp={(event) => {
        if (backdropPress.current && isBackdrop(event)) close();
        backdropPress.current = false;
      }}
    >
      <PortalTargetProvider target={dialog}>
        <div className="attempt-statistics-dialog__frame">
          <header className="attempt-statistics-dialog__header">
            <div className="work-title-group">
              <h2 id={titleId}>兑换尝试统计</h2>
              {title ? (
                <p className="attempt-statistics-activity muted">{title}</p>
              ) : null}
            </div>
            <CompactIconButton
              ref={closeButton}
              aria-label="关闭兑换尝试统计"
              onClick={close}
            >
              <X size={16} aria-hidden="true" />
            </CompactIconButton>
          </header>
          <div ref={body} className="attempt-statistics-dialog__body">
            <div className="attempt-statistics-page">
              <StatisticsSummary summary={summary} />
              {cursorNotice}
              <section className="work-panel attempt-statistics-panel">
                <h2>提交内容聚合</h2>
                <p className="muted">
                  只展示提交内容的汇总，不展示个人失败记录；命中结果按提交当时的活动配置计算。
                </p>
                <ListPanel
                  restorationId={`statistics-records:${activityId}`}
                  keepContent
                  state={state}
                  emptyText="暂无兑换尝试。"
                  onRetry={query.isError ? () => query.refetch() : undefined}
                  loadingContent={<SkeletonRows rows={4} />}
                  refreshNotice={<RefreshNotice query={query} />}
                  resetKey={`${activityId}:${cursors.length}`}
                  footer={
                    <Pagination
                      label="兑换尝试统计分页"
                      page={cursors.length}
                      hasNext={Boolean(query.data?.nextCursor)}
                      onPageChange={(page) => {
                        if (page < cursors.length)
                          setCursors(cursors.slice(0, -1));
                        else if (query.data?.nextCursor)
                          setCursors([...cursors, query.data.nextCursor]);
                      }}
                      busy={query.isPending}
                    />
                  }
                >
                  <div className="attempt-statistics-table-wrap">
                    <table
                      className="attempt-statistics-table"
                      aria-busy={state === "loading"}
                    >
                      <thead>
                        <tr>
                          <th>提交口令</th>
                          <th>次数</th>
                          <th>人数</th>
                          <th>命中</th>
                          <th>未命中</th>
                          <th>成功领取</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state === "loading" ? (
                          <StatisticsSkeletonRows />
                        ) : state === "error" ? (
                          <tr>
                            <td colSpan={6}>
                              <ActivityErrorView
                                error={query.error ?? new Error("读取统计失败")}
                                retry={() => query.refetch()}
                              />
                            </td>
                          </tr>
                        ) : state === "empty" ? (
                          <tr>
                            <td colSpan={6}>
                              <p className="activity-rows-empty" role="status">
                                暂无兑换尝试。
                              </p>
                            </td>
                          </tr>
                        ) : (
                          query.data?.items.map((row) => (
                            <tr key={row.password}>
                              <td>
                                <span className="activity-mobile-label">
                                  提交口令
                                </span>
                                {row.password}
                              </td>
                              <td>
                                <span className="activity-mobile-label">
                                  次数
                                </span>
                                {row.attempts}
                              </td>
                              <td>
                                <span className="activity-mobile-label">
                                  人数
                                </span>
                                {row.uniqueUsers}
                              </td>
                              <td>
                                <span className="activity-mobile-label">
                                  命中 / 未命中
                                </span>
                                {row.matchedAttempts}
                              </td>
                              <td>
                                <span className="activity-mobile-label">
                                  未命中
                                </span>
                                {row.unmatchedAttempts}
                              </td>
                              <td>
                                <span className="activity-mobile-label">
                                  成功领取
                                </span>
                                {row.successfulClaims}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </ListPanel>
              </section>
              <section className="work-panel attempt-statistics-panel">
                <h2>各有效口令的领取数</h2>
                {summary?.validPasswords.length ? (
                  <ul className="attempt-statistics-valid-passwords">
                    {summary.validPasswords.map((item) => (
                      <li key={item.password}>
                        <span>
                          <span className="activity-mobile-label">
                            有效口令
                          </span>
                          {item.password}
                        </span>
                        <strong>{item.successfulClaims} 份</strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">暂无成功领取。</p>
                )}
              </section>
            </div>
          </div>
        </div>
      </PortalTargetProvider>
    </dialog>,
    document.body,
  );
}

function StatisticsSummary({
  summary,
}: {
  summary: StatisticsSummarySnapshot | null;
}) {
  return (
    <dl className="attempt-statistics-summary">
      <div>
        <dt>总尝试次数</dt>
        <dd>{summary?.totalAttempts ?? "—"}</dd>
      </div>
      <div>
        <dt>独立尝试人数</dt>
        <dd>{summary?.uniqueUsers ?? "—"}</dd>
      </div>
      <div>
        <dt>成功领取数</dt>
        <dd>{summary?.successfulClaims ?? "—"}</dd>
      </div>
    </dl>
  );
}

function StatisticsSkeletonRows() {
  const keys = ["first", "second", "third", "fourth"];
  return (
    <>
      {keys.map((key) => (
        <tr key={key}>
          <td colSpan={6}>
            <span data-skeleton-row="true" />
          </td>
        </tr>
      ))}
    </>
  );
}
