import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { isActivityDeadlineReached } from "../activity-metadata";
import { projectActivityTableState } from "../activity-table-state";
import {
  ListPanel,
  Pagination,
  SegmentedControl,
  StatusBadge,
  usePagination,
} from "../components/list-controls";
import { getDrawRoster, useDrawRosterRevision } from "../draw-rosters";
import { ShortTime, useClockSelector } from "../time";
import type { ActivityLifecycle, ActivityViewState } from "../types";
import { projectActivityViewState } from "../view-state";
import {
  MerchantPaymentsDialog,
  useMerchantPaymentOverlay,
} from "./merchant-payments-dialog";
import type { WorkbenchPageProps } from "./workbench";
import {
  type ManagedActivity,
  type PaymentExample,
  toPrototypeActivity,
  useWorkbenchStore,
} from "./workbench-store";
import { Dialog, GuestAccountPrompt, PageTitle } from "./workbench-ui";
import "./payment-page.css";

type PaymentActivityFilter = "all" | "active" | "ended" | "archived";
type PaymentTargetFilter = "all" | "pending" | "confirmed";

function cents(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function money(value: number) {
  return (value / 100).toFixed(2);
}

function missing(value: string | null | undefined, fallback = "未记录") {
  return value?.trim() ? value : fallback;
}

function statusTone(status: PaymentExample["status"]) {
  return status === "confirmed" ? "success" : "pending";
}

const activityStatusLabels: Record<ActivityLifecycle, string> = {
  draft: "准备中",
  active: "进行中",
  ended: "已结束",
  archived: "已归档",
};

function paymentActivityState(activity: ManagedActivity): ActivityViewState {
  const publicActivity = toPrototypeActivity(activity);
  const roster =
    publicActivity.type === "draw" ? getDrawRoster(publicActivity) : null;
  return projectActivityTableState(
    publicActivity,
    projectActivityViewState(
      publicActivity,
      "none",
      roster ? { drawProgress: roster.progress } : {},
    ),
  );
}

function PaymentFactList({
  items,
}: {
  items: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="work-payment-facts">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function paymentTotal(payments: PaymentExample[], confirmed: boolean) {
  return payments
    .filter((payment) => (payment.status === "confirmed") === confirmed)
    .reduce((amount, payment) => amount + (cents(payment.amount) ?? 0), 0);
}

function statusSummary(payments: PaymentExample[]) {
  return {
    pendingAmount: paymentTotal(payments, false),
    confirmedAmount: paymentTotal(payments, true),
  };
}

function paymentTime(value: string | null | undefined, empty = "未记录") {
  return value ? <ShortTime value={value} full /> : empty;
}

function PaymentDetail({
  payment,
  activity,
  navigate,
  onProcessingDetail,
}: {
  payment: PaymentExample;
  activity?: ManagedActivity;
  navigate: WorkbenchPageProps["navigate"];
  onProcessingDetail: () => void;
}) {
  const sentUsername =
    payment.sentUsername && payment.sentUsername !== payment.recipient.username
      ? `@${payment.sentUsername}`
      : null;
  const currentNote = payment.status === "waiting" ? payment.issue : null;
  return (
    <div className="work-payment-detail-body">
      <section className="work-payment-detail-section work-payment-summary">
        <div>
          <span className="work-payment-section-kicker">发放金额</span>
          <div className="work-payment-detail-amount">
            {payment.amount}
            <span>LDC</span>
          </div>
        </div>
        <StatusBadge tone={statusTone(payment.status)}>
          {payment.state}
        </StatusBadge>
        {currentNote && (
          <p className="work-payment-detail-note">{currentNote}</p>
        )}
      </section>

      <section className="work-payment-detail-section">
        <h3>收款目标</h3>
        <div className="work-payment-recipient">
          <span
            className={`work-payment-avatar avatar-${payment.recipient.color ?? "blue"}`}
            aria-hidden="true"
          >
            {payment.recipient.name.slice(0, 2)}
          </span>
          <div>
            <strong>{payment.recipient.name}</strong>
            <span>@{missing(payment.recipient.username, "未记录用户名")}</span>
          </div>
        </div>
      </section>

      <section className="work-payment-detail-section">
        <h3>订单与时间</h3>
        <PaymentFactList
          items={[
            { label: "本站业务号", value: payment.businessId },
            { label: "上游交易号", value: payment.upstreamId ?? "尚未收到" },
            { label: "创建时间", value: paymentTime(payment.createdAt) },
            {
              label: "本站确认发放时间",
              value: paymentTime(payment.confirmedAt, "尚未确认"),
            },
            ...(sentUsername
              ? [{ label: "实际发送用户名", value: sentUsername }]
              : []),
          ]}
        />
      </section>

      <div className="work-payment-detail-actions">
        <button
          className="button secondary work-payment-processing-trigger"
          type="button"
          onClick={onProcessingDetail}
        >
          查看处理详情
        </button>
        {payment.status === "waiting" && (
          <button
            className="button secondary"
            type="button"
            onClick={() => navigate("merchant")}
          >
            商户配置
          </button>
        )}
        {activity && (
          <button
            className="work-text-link"
            type="button"
            onClick={() => navigate("activity", { activityId: activity.id })}
          >
            查看关联活动 <ArrowRight size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

export function PaymentPage({
  navigate,
  identity,
  activityId,
  listState = "ready",
  onRetry,
}: WorkbenchPageProps) {
  const { payments, activities } = useWorkbenchStore(identity);
  useDrawRosterRevision();
  useClockSelector((now) =>
    activities
      .map((item) =>
        isActivityDeadlineReached(toPrototypeActivity(item), now) ? "1" : "0",
      )
      .join(""),
  );
  const [activityFilter, setActivityFilter] =
    useState<PaymentActivityFilter>("all");
  const [targetFilter, setTargetFilter] = useState<PaymentTargetFilter>("all");
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(
    activityId ?? null,
  );
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(
    null,
  );
  const [refreshed, setRefreshed] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const processingOverlay = useMerchantPaymentOverlay(identity);
  const processingWasOpen = useRef(false);
  useEffect(() => {
    const wasOpen = processingWasOpen.current;
    processingWasOpen.current = processingOverlay.view.open;
    if (!wasOpen || processingOverlay.view.open || !detailOpen) return;
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          ".work-dialog[open] .work-payment-processing-trigger",
        )
        ?.focus({ preventScroll: true });
    });
  }, [processingOverlay.view.open, detailOpen]);
  const [mobileTargetStep, setMobileTargetStep] = useState(Boolean(activityId));
  const activityColumnRef = useRef<HTMLElement>(null);
  const activityScrollTop = useRef(0);
  const activityReturnContext = useRef<string | null>(null);
  const activityReturnButton = useRef<HTMLButtonElement | null>(null);
  const restoreActivityPosition = useRef(false);

  const paymentActivities = activities
    .filter((activity) => activity.status !== "draft")
    .map((activity) => ({
      ...activity,
      tableState: paymentActivityState(activity),
    }));
  const visibleActivities = paymentActivities.filter(
    (activity) =>
      activityFilter === "all" ||
      activity.tableState.lifecycle === activityFilter,
  );
  const {
    page: activityPage,
    pageItems: activityPageItems,
    hasNext: hasNextActivityPage,
    setPage: setActivityPage,
  } = usePagination(visibleActivities, `${identity}:${activityFilter}`);
  const activityResetKey = `${identity}:${activityFilter}:${activityPage}`;
  const selectedActivity =
    paymentActivities.find((activity) => activity.id === selectedActivityId) ??
    null;
  const activityPayments = selectedActivity
    ? payments.filter((payment) => payment.activityId === selectedActivity.id)
    : [];
  const visiblePayments = activityPayments.filter(
    (payment) =>
      targetFilter === "all" ||
      (targetFilter === "confirmed"
        ? payment.status === "confirmed"
        : payment.status !== "confirmed"),
  );
  const { page, pageItems, hasNext, setPage } = usePagination(
    visiblePayments,
    `${identity}:${selectedActivityId ?? "none"}:${targetFilter}`,
  );
  const selectedPayment =
    pageItems.find((payment) => payment.id === selectedPaymentId) ??
    pageItems[0];
  const totals = statusSummary(activityPayments);

  useLayoutEffect(() => {
    if (mobileTargetStep || !restoreActivityPosition.current) return;
    restoreActivityPosition.current = false;
    const sameContext = activityReturnContext.current === activityResetKey;
    const scroll = activityColumnRef.current?.querySelector<HTMLElement>(
      ".list-panel__scroll",
    );
    if (scroll) scroll.scrollTop = sameContext ? activityScrollTop.current : 0;
    if (sameContext && activityReturnButton.current?.isConnected)
      activityReturnButton.current.focus({ preventScroll: true });
  }, [mobileTargetStep, activityResetKey]);

  const initializedScope = useRef<string | undefined>(undefined);
  const initialActivityIndex = paymentActivities.findIndex(
    (item) => item.id === activityId,
  );
  useEffect(() => {
    const scopeKey = `${identity}:${activityId}`;
    if (!activityId || initializedScope.current === scopeKey) return;
    initializedScope.current = scopeKey;
    setSelectedActivityId(activityId);
    if (initialActivityIndex >= 0)
      setActivityPage(Math.floor(initialActivityIndex / 20) + 1);
    setMobileTargetStep(true);
  }, [activityId, identity, initialActivityIndex, setActivityPage]);

  useEffect(() => {
    const nextActivityId =
      selectedActivity &&
      visibleActivities.some((item) => item.id === selectedActivity.id)
        ? selectedActivity.id
        : (activityPageItems[0]?.id ?? null);
    if (selectedActivityId !== nextActivityId) {
      setSelectedActivityId(nextActivityId);
      setSelectedPaymentId(null);
      setTargetFilter("all");
      setDetailOpen(false);
    }
  }, [
    selectedActivity,
    selectedActivityId,
    activityPageItems,
    visibleActivities,
  ]);

  useEffect(() => {
    if (
      selectedPaymentId &&
      !pageItems.some((payment) => payment.id === selectedPaymentId)
    )
      setSelectedPaymentId(null);
  }, [selectedPaymentId, pageItems]);

  if (identity === "guest") return <GuestAccountPrompt navigate={navigate} />;

  if (activityId && !paymentActivities.some((item) => item.id === activityId))
    return (
      <div className="work-page">
        <PageTitle title="活动不存在" />
        <p role="alert">
          活动尚未开放、不属于 LDC 活动，或当前账号无权查看付款记录。
        </p>
        <button
          className="button secondary"
          type="button"
          onClick={() => navigate("payment")}
        >
          全部付款
        </button>
      </div>
    );

  return (
    <div
      className={`work-page work-list-page work-payment-page list-page ${
        mobileTargetStep ? "is-target-step" : ""
      }`}
    >
      <PageTitle title="付款记录" />
      {refreshed && (
        <p className="work-inline-success" role="status">
          <CheckCircle2 size={16} /> 演示记录已更新。
        </p>
      )}
      <div className="work-payment-layout">
        <section
          ref={activityColumnRef}
          className="work-payment-column work-payment-activities"
        >
          <div className="work-payment-column-head">
            <h2>红包活动</h2>
          </div>
          <SegmentedControl
            label="付款活动状态筛选"
            mode="tabs"
            value={activityFilter}
            onChange={(next) => {
              setActivityFilter(next);
              setSelectedActivityId(null);
              setSelectedPaymentId(null);
              setMobileTargetStep(false);
              setDetailOpen(false);
            }}
            options={[
              { value: "all", label: "全部" },
              { value: "active", label: "进行中" },
              { value: "ended", label: "已结束" },
              { value: "archived", label: "已归档" },
            ]}
          />
          <ListPanel
            state={
              listState === "ready" && !visibleActivities.length
                ? "empty"
                : listState
            }
            onRetry={onRetry}
            emptyText="暂无可查看付款的红包活动"
            resetKey={activityResetKey}
            footer={
              <Pagination
                label="付款活动分页"
                page={activityPage}
                hasNext={hasNextActivityPage}
                onPageChange={(next) => {
                  setActivityPage(next);
                  setSelectedActivityId(null);
                  setSelectedPaymentId(null);
                  setTargetFilter("all");
                  setDetailOpen(false);
                }}
                busy={listState !== "ready"}
              />
            }
          >
            <div className="work-payment-activity-list">
              {activityPageItems.map((activity) => {
                const tableState = activity.tableState;
                const drawing =
                  tableState.lifecycle !== "draft" &&
                  tableState.drawProgress === "settling";
                return (
                  <button
                    className={`work-payment-activity-row ${
                      selectedActivityId === activity.id ? "is-active" : ""
                    }`}
                    key={activity.id}
                    type="button"
                    aria-pressed={selectedActivityId === activity.id}
                    title={activity.title}
                    onClick={(event) => {
                      const scroll =
                        activityColumnRef.current?.querySelector<HTMLElement>(
                          ".list-panel__scroll",
                        );
                      activityScrollTop.current = scroll?.scrollTop ?? 0;
                      activityReturnContext.current = activityResetKey;
                      activityReturnButton.current = event.currentTarget;
                      if (selectedActivityId !== activity.id) {
                        setSelectedActivityId(activity.id);
                        setSelectedPaymentId(null);
                        setTargetFilter("all");
                        setDetailOpen(false);
                      }
                      setMobileTargetStep(true);
                      setRefreshed(false);
                    }}
                  >
                    <span className="work-payment-activity-copy">
                      <strong>{activity.title}</strong>
                      <span>
                        <StatusBadge
                          tone={
                            tableState.lifecycle === "active"
                              ? "success"
                              : "neutral"
                          }
                        >
                          {drawing
                            ? "正在开奖"
                            : activityStatusLabels[tableState.lifecycle]}
                        </StatusBadge>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </ListPanel>
        </section>

        <section className="work-payment-column work-payment-targets">
          <div className="work-payment-column-head">
            <div className="work-payment-target-title">
              <button
                className="work-payment-back"
                type="button"
                onClick={() => {
                  restoreActivityPosition.current = true;
                  setMobileTargetStep(false);
                }}
              >
                <ArrowLeft size={16} /> 返回活动列表
              </button>
              <h2>发放目标</h2>
            </div>
            <div className="work-payment-heading-tools">
              <div className="work-payment-heading-stat">
                <span>待完成</span>
                <strong>
                  {money(totals.pendingAmount)}
                  <small>LDC</small>
                </strong>
              </div>
              <div className="work-payment-heading-stat">
                <span>已发放</span>
                <strong>
                  {money(totals.confirmedAmount)}
                  <small>LDC</small>
                </strong>
              </div>
              <button
                className="button secondary work-payment-refresh"
                type="button"
                onClick={() => setRefreshed(true)}
              >
                刷新记录
              </button>
            </div>
          </div>
          {selectedActivity && (
            <div className="work-payment-scope">
              <span title={selectedActivity.title}>
                {selectedActivity.title}
              </span>
            </div>
          )}
          <SegmentedControl
            label="发放目标状态筛选"
            mode="tabs"
            value={targetFilter}
            onChange={(next) => {
              setTargetFilter(next);
              setSelectedPaymentId(null);
              setDetailOpen(false);
            }}
            options={[
              { value: "all", label: "全部" },
              { value: "pending", label: "待完成" },
              { value: "confirmed", label: "已发放" },
            ]}
          />
          <ListPanel
            state={
              listState === "ready" && !visiblePayments.length
                ? "empty"
                : listState
            }
            onRetry={onRetry}
            emptyText="当前活动暂无匹配的发放目标"
            resetKey={`${identity}:${selectedActivityId ?? "none"}:${targetFilter}:${page}`}
            footer={
              <Pagination
                label="发放目标分页"
                page={page}
                hasNext={hasNext}
                onPageChange={(next) => {
                  setPage(next);
                  setSelectedPaymentId(null);
                  setDetailOpen(false);
                }}
                busy={listState !== "ready"}
              />
            }
          >
            <div className="work-payment-list">
              {pageItems.map((payment) => (
                <button
                  className={`work-payment-row ${
                    selectedPayment?.id === payment.id ? "is-active" : ""
                  }`}
                  key={payment.id}
                  type="button"
                  data-payment-id={payment.id}
                  aria-pressed={selectedPayment?.id === payment.id}
                  title={payment.recipient.name}
                  onClick={() => {
                    setSelectedPaymentId(payment.id);
                    setRefreshed(false);
                    if (window.matchMedia("(max-width: 1119px)").matches)
                      setDetailOpen(true);
                  }}
                >
                  <span className="work-payment-copy">
                    <strong>{payment.recipient.name}</strong>
                    <ShortTime value={payment.date} />
                  </span>
                  <span className="work-payment-value">
                    <strong>
                      {payment.amount}
                      <small>LDC</small>
                    </strong>
                    <StatusBadge tone={statusTone(payment.status)}>
                      {payment.state}
                    </StatusBadge>
                  </span>
                  <ChevronRight
                    className="work-payment-chevron"
                    size={14}
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          </ListPanel>
        </section>

        {selectedPayment && listState === "ready" && (
          <aside className="work-payment-detail">
            <h2 className="work-detail-heading">付款详情</h2>
            <PaymentDetail
              key={selectedPayment.id}
              payment={selectedPayment}
              activity={selectedActivity ?? undefined}
              navigate={navigate}
              onProcessingDetail={() =>
                processingOverlay.open(selectedPayment.id)
              }
            />
          </aside>
        )}
      </div>
      {detailOpen && selectedPayment && !processingOverlay.view.open && (
        <Dialog
          title="付款详情"
          onClose={() => setDetailOpen(false)}
          footer={
            <button
              type="button"
              className="button secondary"
              onClick={() => setDetailOpen(false)}
            >
              关闭详情
            </button>
          }
        >
          <div className="work-payment-detail-content">
            <PaymentDetail
              key={`dialog-${selectedPayment.id}`}
              payment={selectedPayment}
              activity={selectedActivity ?? undefined}
              navigate={navigate}
              onProcessingDetail={() =>
                processingOverlay.open(selectedPayment.id)
              }
            />
          </div>
        </Dialog>
      )}
      {processingOverlay.view.open && (
        <MerchantPaymentsDialog
          overlay={processingOverlay}
          payments={payments}
          activities={activities}
          navigate={navigate}
        />
      )}
    </div>
  );
}
