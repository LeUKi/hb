import type {
  ActivityPaymentActivity,
  ActivityPaymentTarget,
  ActivityStatus as ContractActivityStatus,
} from "@hb/contracts";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight } from "lucide-react";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RequireAccount } from "../components/activities/require-account";
import { MerchantPaymentDialog } from "../components/merchants/merchant-payment-dialog";
import { PaymentStatusText } from "../components/presentation/activity-list";
import {
  ListPanel,
  Pagination,
  SegmentedControl,
  StatusBadge,
  type StatusBadgeProps,
} from "../components/presentation/list-controls";
import {
  RefreshNotice,
  SkeletonRows,
} from "../components/presentation/loading";
import { UserAvatar } from "../components/user-identity";
import { formatTime, useManagedActivity } from "../lib/activities";
import { merchantPaymentHref } from "../lib/merchant-navigation";
import {
  useActivityPayments,
  useMerchantPayment,
  useMerchantViewScope,
  usePaymentActivities,
} from "../lib/merchants";
import {
  useCursorRecovery,
  useEntryNavigate,
  useHistoryOverlay,
  useRestoredScroll,
  useViewState,
} from "../lib/navigation-state";
import { paymentReason } from "../lib/payment-display";
import {
  isAccessQueryError,
  isBlockingQueryError,
  listQueryState,
} from "../lib/query-view";
import { Dialog, PageTitle } from "../prototype-ui/workbench-ui";

type ActivityStatus = "all" | "active" | "ended" | "archived";
type TargetStatus = "all" | "pending" | "confirmed";
type ScopedCursors = { scope: string; cursors: Array<string | null> };
type DefaultActivity = { scope: string; id: string | null };
type TargetSnapshot = {
  activityId: string;
  target: ActivityPaymentTarget | null;
  merchantId: string | null;
  summary: { pendingAmount: string; confirmedAmount: string } | null;
};
type Search = {
  activityId?: string;
  activityStatus?: ActivityStatus;
  paymentStatus?: TargetStatus;
};

const activityStatuses: ActivityStatus[] = [
  "all",
  "active",
  "ended",
  "archived",
];
const targetStatuses: TargetStatus[] = ["all", "pending", "confirmed"];
const activityLabels: Record<ActivityStatus, string> = {
  all: "全部",
  active: "进行中",
  ended: "已结束",
  archived: "已归档",
};
const targetLabels: Record<TargetStatus, string> = {
  all: "全部",
  pending: "待完成",
  confirmed: "已发放",
};

export const Route = createFileRoute("/my/payments")({
  validateSearch: (search): Search => ({
    activityId:
      typeof search.activityId === "string" ? search.activityId : undefined,
    activityStatus: activityStatuses.includes(
      search.activityStatus as ActivityStatus,
    )
      ? (search.activityStatus as ActivityStatus)
      : "all",
    paymentStatus: targetStatuses.includes(search.paymentStatus as TargetStatus)
      ? (search.paymentStatus as TargetStatus)
      : "all",
  }),
  component: PaymentsPage,
});

function PaymentsPage() {
  return (
    <RequireAccount requireLdc>
      {({ userId, csrfToken }) => (
        <Payments
          key={`${userId}:${csrfToken}`}
          userId={userId}
          csrfToken={csrfToken}
        />
      )}
    </RequireAccount>
  );
}

function setCursorPage(
  cursors: Array<string | null>,
  setCursors: (cursors: Array<string | null>) => void,
  nextCursor: string | null | undefined,
  page: number,
) {
  if (page < cursors.length) setCursors(cursors.slice(0, -1));
  else if (page > cursors.length && nextCursor)
    setCursors([...cursors, nextCursor]);
}

function CursorPagination({
  label,
  cursors,
  setCursors,
  nextCursor,
  busy = false,
}: {
  label: string;
  cursors: Array<string | null>;
  setCursors: (cursors: Array<string | null>) => void;
  nextCursor: string | null | undefined;
  busy?: boolean;
}) {
  return (
    <Pagination
      label={label}
      page={cursors.length}
      hasNext={Boolean(nextCursor)}
      onPageChange={(page) =>
        setCursorPage(cursors, setCursors, nextCursor, page)
      }
      busy={busy}
    />
  );
}

function paymentTone(
  status: ActivityPaymentTarget["status"],
): StatusBadgeProps["tone"] {
  return status === "confirmed" ? "success" : "pending";
}

function amountText(value: string) {
  return value || "0.00";
}

function activityStatusLabel(status: ContractActivityStatus) {
  return activityLabels[status as ActivityStatus] ?? status;
}

function Payments({
  userId,
  csrfToken,
}: {
  userId: string;
  csrfToken: string;
}) {
  const search = Route.useSearch();
  const navigate = useEntryNavigate();
  const router = useRouter();
  const viewScope = useMerchantViewScope(userId);
  const detailOverlay = useHistoryOverlay("payment-detail", viewScope);
  const processingOverlay = useHistoryOverlay("payment-processing", viewScope);
  const processingOpen = Boolean(processingOverlay.overlay);
  const [processingMerchantId, processingTaskId] = (
    processingOverlay.overlay?.id ?? ""
  ).split(":");
  const processingTrigger = useRef<HTMLElement | null>(null);
  const lastProcessingTask = useRef<string | null>(null);
  const [processingParent, setProcessingParent] = useViewState(
    "payments.processingParent",
    "workspace",
    viewScope,
  );
  const activityStatus = search.activityStatus ?? "all";
  const paymentStatus = search.paymentStatus ?? "all";
  const activityCursorScope = `${userId}:${viewScope}:${activityStatus}`;
  const activityColumnRef = useRef<HTMLElement>(null);
  const activityScrollTop = useRef(0);
  const activityReturnContext = useRef<string | null>(null);
  const activityReturnButton = useRef<HTMLButtonElement | null>(null);
  const restoreActivityPosition = useRef(false);
  const [activityPager, setActivityPager] = useViewState<ScopedCursors>(
    "payments.activityPager",
    {
      scope: `${userId}:${viewScope}:all`,
      cursors: [null],
    },
    viewScope,
  );
  const [selectedActivityState, setSelectedActivity] =
    useViewState<DefaultActivity>(
      "payments.selectedActivity",
      {
        scope: activityCursorScope,
        id: search.activityId ?? null,
      },
      viewScope,
    );
  const [selectedTargetId, setSelectedTargetId] = useViewState<string | null>(
    "payments.selectedTargetId",
    null,
    `${viewScope}:${search.activityId ?? selectedActivityState.id ?? "none"}`,
  );
  const [targetSnapshot, setTargetSnapshot] = useState<TargetSnapshot | null>(
    null,
  );
  const mobileTargetStep = Boolean(search.activityId);
  const [targetPager, setTargetPager] = useViewState<ScopedCursors>(
    "payments.targetPager",
    {
      scope: `${userId}:${viewScope}:${search.activityId ?? "none"}:${paymentStatus}`,
      cursors: [null],
    },
    viewScope,
  );
  const detailOpen = detailOverlay.overlay?.kind === "payment-detail";
  const detailTargetId =
    processingOpen && processingTaskId
      ? processingTaskId
      : detailOpen
        ? (detailOverlay.overlay?.id ?? selectedTargetId)
        : selectedTargetId;

  useEffect(() => {
    if (processingOpen) {
      lastProcessingTask.current = processingTaskId ?? null;
      return;
    }
    const taskId = lastProcessingTask.current;
    if (!taskId) return;
    lastProcessingTask.current = null;
    const frame = requestAnimationFrame(() => {
      const modal = document.querySelector<HTMLDialogElement>("dialog[open]");
      const root = modal ?? document;
      const target =
        Array.from(
          root.querySelectorAll<HTMLElement>("[data-processing-task-id]"),
        ).find(
          (node) =>
            node.dataset.processingTaskId === taskId &&
            node.offsetParent !== null,
        ) ??
        Array.from(
          root.querySelectorAll<HTMLElement>("[data-payment-id]"),
        ).find(
          (node) =>
            node.dataset.paymentId === taskId && node.offsetParent !== null,
        );
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [processingOpen, processingTaskId]);

  function openProcessing(
    merchantId: string,
    taskId: string,
    trigger: HTMLElement,
  ) {
    processingTrigger.current = trigger;
    setProcessingParent(detailOpen ? "summary" : "workspace");
    processingOverlay.open(`${merchantId}:${taskId}`);
  }
  const initialActivityPager = useMemo<ScopedCursors>(
    () => ({
      scope: `${userId}:${viewScope}:all`,
      cursors: [null],
    }),
    [userId, viewScope],
  );
  const activityCursors =
    activityPager.scope === activityCursorScope
      ? activityPager.cursors
      : [null];
  const setActivityCursors = useCallback(
    (value: SetStateAction<Array<string | null>>) => {
      setActivityPager((current) => {
        const currentCursors =
          current.scope === activityCursorScope ? current.cursors : [null];
        const cursors =
          typeof value === "function" ? value(currentCursors) : value;
        return { scope: activityCursorScope, cursors };
      });
    },
    [activityCursorScope, setActivityPager],
  );
  const activityCursor = activityCursors.at(-1) ?? null;

  useEffect(() => {
    setActivityPager((current) =>
      current.scope === activityCursorScope
        ? current
        : { scope: activityCursorScope, cursors: [null] },
    );
  }, [activityCursorScope, setActivityPager]);

  const activities = usePaymentActivities(
    userId,
    activityStatus,
    activityCursor,
  );
  const activityCursorRecovery = useCursorRecovery(
    activities.error,
    activityCursors,
    setActivityCursors,
  );
  const currentActivityItems = isBlockingQueryError(activities)
    ? []
    : (activities.data?.items ?? []);
  const visibleIds = useMemo(
    () => currentActivityItems?.map((item) => item.id) ?? [],
    [currentActivityItems],
  );
  useEffect(() => {
    if (!activities.data) return;
    setSelectedActivity((current) => {
      if (current.scope !== activityCursorScope)
        return {
          scope: activityCursorScope,
          id: search.activityId ?? activities.data.items[0]?.id ?? null,
        };
      if (current.id === null && activities.data.items[0])
        return { scope: activityCursorScope, id: activities.data.items[0].id };
      return current;
    });
  }, [
    activities.data,
    activityCursorScope,
    search.activityId,
    setSelectedActivity,
  ]);
  const selectedActivityId =
    search.activityId ??
    (selectedActivityState.scope === activityCursorScope
      ? selectedActivityState.id
      : null);
  const anchorActivity = useManagedActivity(
    userId,
    selectedActivityId ?? "",
    Boolean(selectedActivityId && !visibleIds.includes(selectedActivityId)),
  );
  const targetCursorScope = `${userId}:${viewScope}:${selectedActivityId ?? "none"}:${paymentStatus}`;
  const targetCursors =
    targetPager.scope === targetCursorScope ? targetPager.cursors : [null];
  const setTargetCursors = useCallback(
    (value: SetStateAction<Array<string | null>>) => {
      setTargetPager((current) => {
        const currentCursors =
          current.scope === targetCursorScope ? current.cursors : [null];
        const cursors =
          typeof value === "function" ? value(currentCursors) : value;
        return { scope: targetCursorScope, cursors };
      });
    },
    [targetCursorScope, setTargetPager],
  );
  const targetCursor = targetCursors.at(-1) ?? null;
  const targets = useActivityPayments(
    userId,
    selectedActivityId,
    paymentStatus,
    targetCursor,
  );
  const targetCursorRecovery = useCursorRecovery(
    targets.error,
    targetCursors,
    setTargetCursors,
  );
  const targetBlocked = targets.isError && isAccessQueryError(targets.error);
  const anchorBlocked =
    anchorActivity.isError && isAccessQueryError(anchorActivity.error);
  const scopeDenied = targetBlocked || anchorBlocked;
  const targetData =
    targets.data?.activityId === selectedActivityId && !scopeDenied
      ? targets.data
      : undefined;
  const selectedActivity =
    currentActivityItems?.find((item) => item.id === selectedActivityId) ??
    (!anchorBlocked && anchorActivity.data?.activity.id === selectedActivityId
      ? ({
          ...anchorActivity.data.activity,
          merchantId: "",
        } as ActivityPaymentActivity)
      : null);
  useEffect(() => {
    if (activityPager.scope === initialActivityPager.scope) return;
    if (activityPager.scope.startsWith(`${userId}:`)) return;
    setActivityPager(initialActivityPager);
  }, [activityPager.scope, initialActivityPager, setActivityPager, userId]);

  useEffect(() => {
    if (!targets.data || !selectedActivityId || scopeDenied) return;
    if (targets.data.activityId !== selectedActivityId) {
      setTargetSnapshot(null);
      return;
    }
    const target =
      (detailTargetId
        ? targets.data.items.find((item) => item.id === detailTargetId)
        : targets.data.items[0]) ?? null;
    if (!detailTargetId && target) setSelectedTargetId(target.id);
    setTargetSnapshot((previous) => ({
      activityId: selectedActivityId,
      target:
        target ??
        (previous?.activityId === selectedActivityId &&
        previous.target?.id === detailTargetId
          ? previous.target
          : null),
      merchantId: targets.data.merchantId ?? null,
      summary: targets.data.summary,
    }));
  }, [
    targets.data,
    selectedActivityId,
    detailTargetId,
    scopeDenied,
    setSelectedTargetId,
  ]);
  const targetMerchantId = !scopeDenied
    ? (targetData?.merchantId ??
      (targetSnapshot?.activityId === selectedActivityId
        ? targetSnapshot.merchantId
        : null) ??
      selectedActivity?.merchantId ??
      null)
    : null;
  const listedTarget = targetData?.items.find(
    (item) => item.id === detailTargetId,
  );
  const needsSelectedRead = Boolean(
    !scopeDenied &&
      detailTargetId &&
      targetMerchantId &&
      !listedTarget &&
      targetData,
  );
  const selectedRead = useMerchantPayment(
    userId,
    targetMerchantId ?? "",
    detailTargetId ?? "",
    null,
    needsSelectedRead,
  );
  const selectedReadDenied =
    needsSelectedRead && isBlockingQueryError(selectedRead);
  const readPayment = selectedRead.data?.payment;
  const restoredTarget =
    needsSelectedRead &&
    !selectedReadDenied &&
    readPayment?.id === detailTargetId &&
    readPayment.source === "claim" &&
    readPayment.activityId === selectedActivityId &&
    readPayment.recipientProfile
      ? { ...readPayment, recipientProfile: readPayment.recipientProfile }
      : null;
  const selectedTarget =
    !scopeDenied && !selectedReadDenied && selectedActivityId
      ? (listedTarget ??
        restoredTarget ??
        (targetSnapshot?.activityId === selectedActivityId &&
        targetSnapshot.target?.id === detailTargetId
          ? targetSnapshot.target
          : null))
      : null;
  const targetSummary =
    selectedActivityId &&
    !scopeDenied &&
    targetSnapshot?.activityId === selectedActivityId
      ? (targetData?.summary ?? targetSnapshot.summary)
      : null;

  useLayoutEffect(() => {
    if (mobileTargetStep || !restoreActivityPosition.current) return;
    restoreActivityPosition.current = false;
    const sameContext = activityReturnContext.current === activityCursorScope;
    const scroll = activityColumnRef.current?.querySelector<HTMLElement>(
      ".list-panel__scroll",
    );
    if (scroll) scroll.scrollTop = sameContext ? activityScrollTop.current : 0;
    if (sameContext && activityReturnButton.current?.isConnected)
      activityReturnButton.current.focus({ preventScroll: true });
  }, [mobileTargetStep, activityCursorScope]);

  useEffect(() => {
    setTargetPager((current) =>
      current.scope === targetCursorScope
        ? current
        : { scope: targetCursorScope, cursors: [null] },
    );
    if (targetBlocked || anchorBlocked) {
      setSelectedActivity({ scope: activityCursorScope, id: null });
      setSelectedTargetId(null);
      setTargetSnapshot(null);
    }
  }, [
    targetCursorScope,
    targetBlocked,
    anchorBlocked,
    activityCursorScope,
    setSelectedActivity,
    setSelectedTargetId,
    setTargetPager,
  ]);

  function selectActivity(
    activityId: string,
    trigger: HTMLButtonElement | null,
  ) {
    const scroll = activityColumnRef.current?.querySelector<HTMLElement>(
      ".list-panel__scroll",
    );
    activityScrollTop.current = scroll?.scrollTop ?? 0;
    activityReturnContext.current = activityCursorScope;
    activityReturnButton.current = trigger;
    const isMobileStep = window.matchMedia("(max-width: 760px)").matches;
    setSelectedActivity({ scope: activityCursorScope, id: activityId });
    if (!isMobileStep) {
      setSelectedTargetId(null);
      setTargetSnapshot(null);
    }
    void navigate({
      to: "/my/payments",
      search: {
        activityId,
        activityStatus,
        paymentStatus: "all",
      },
      replace: !isMobileStep,
      resetScroll: false,
    });
  }

  function changeActivityStatus(value: ActivityStatus) {
    setActivityCursors([null]);
    setTargetCursors([null]);
    setSelectedActivity({ scope: `${userId}:${viewScope}:${value}`, id: null });
    setSelectedTargetId(null);
    void navigate({
      to: "/my/payments",
      search: { activityStatus: value, paymentStatus: "all" },
      replace: true,
      resetScroll: false,
    });
  }

  function changeTargetStatus(value: TargetStatus) {
    setTargetCursors([null]);
    setSelectedTargetId(null);
    void navigate({
      to: "/my/payments",
      search: {
        activityId: selectedActivityId ?? undefined,
        activityStatus,
        paymentStatus: value,
      },
      replace: true,
      resetScroll: false,
    });
  }

  const activityItems = [
    ...(!anchorBlocked &&
    anchorActivity.data &&
    !visibleIds.includes(anchorActivity.data.activity.id)
      ? [
          {
            ...anchorActivity.data.activity,
            merchantId: "",
          } as ActivityPaymentActivity,
        ]
      : []),
    ...(currentActivityItems ?? []),
  ];
  const activityListState = listQueryState(activities);
  const targetListState = scopeDenied
    ? "error"
    : !selectedActivityId
      ? activities.isPending
        ? "loading"
        : "empty"
      : listQueryState(targets);

  return (
    <div
      className={`work-page work-list-page work-payment-page list-page ${
        mobileTargetStep ? "is-target-step" : ""
      }`}
    >
      <PageTitle title="付款记录" />
      <div className="work-payment-layout">
        <section
          ref={activityColumnRef}
          className="work-payment-column work-payment-activities"
          aria-label="红包活动"
        >
          <div className="work-payment-column-head">
            <h2>红包活动</h2>
          </div>
          <SegmentedControl
            label="付款活动状态筛选"
            mode="tabs"
            value={activityStatus}
            onChange={changeActivityStatus}
            options={activityStatuses.map((value) => ({
              value,
              label: activityLabels[value],
            }))}
          />
          <ListPanel
            keepContent={activityListState === "ready"}
            state={activityListState}
            onRetry={() => activities.refetch()}
            loadingContent={<SkeletonRows rows={4} />}
            refreshNotice={
              <>
                {activityCursorRecovery}
                <RefreshNotice query={activities} />
              </>
            }
            emptyText="暂无可查看付款的红包活动"
            resetKey={`${activityCursorScope}:${activityCursors.length}`}
            restorationId={`payments:activities:${activityCursorScope}`}
            footer={
              <CursorPagination
                label="付款活动分页"
                cursors={activityCursors}
                setCursors={setActivityCursors}
                nextCursor={activities.data?.nextCursor}
                busy={activities.isPending}
              />
            }
          >
            <div className="work-payment-activity-list">
              {activities.isPending && !activities.data ? (
                <SkeletonRows rows={4} />
              ) : null}
              {activityItems.map((activity) => (
                <ActivityButton
                  key={activity.id}
                  activity={activity}
                  selected={activity.id === selectedActivityId}
                  onSelect={(button) => selectActivity(activity.id, button)}
                />
              ))}
            </div>
          </ListPanel>
        </section>

        <section
          className="work-payment-column work-payment-targets"
          aria-label="发放目标"
        >
          <div className="work-payment-column-head">
            <div className="work-payment-target-title">
              <button
                className="work-payment-back"
                type="button"
                onClick={() => {
                  restoreActivityPosition.current = true;
                  router.history.back();
                }}
              >
                <ArrowLeft size={16} /> 返回上一页
              </button>
              <h2>发放目标</h2>
            </div>
            <PaymentSummary summary={targetSummary} />
          </div>
          {selectedActivity ? (
            <div className="work-payment-scope">
              <span title={selectedActivity.title}>
                {selectedActivity.title || "未命名活动"}
              </span>
            </div>
          ) : null}
          <SegmentedControl
            label="发放目标状态筛选"
            mode="tabs"
            value={paymentStatus}
            onChange={changeTargetStatus}
            options={targetStatuses.map((value) => ({
              value,
              label: targetLabels[value],
            }))}
          />
          <ListPanel
            keepContent={targetListState === "ready"}
            state={targetListState}
            onRetry={() => targets.refetch()}
            loadingContent={<SkeletonRows rows={4} />}
            refreshNotice={
              <>
                {targetCursorRecovery}
                <RefreshNotice query={targets} />
              </>
            }
            emptyText={
              selectedActivityId ? "当前活动暂无发放目标。" : "请选择活动"
            }
            resetKey={`${targetCursorScope}:${targetCursors.length}`}
            restorationId={`payments:targets:${targetCursorScope}`}
            footer={
              <CursorPagination
                label="发放目标分页"
                cursors={targetCursors}
                setCursors={setTargetCursors}
                nextCursor={targets.data?.nextCursor}
                busy={targets.isPending}
              />
            }
          >
            <div className="work-payment-list">
              {selectedActivityId && targets.isPending && !targets.data ? (
                <SkeletonRows rows={4} />
              ) : null}
              {targets.data?.items.map((target) => (
                <TargetButton
                  key={target.id}
                  target={target}
                  selected={target.id === selectedTarget?.id}
                  onSelect={() => {
                    setSelectedTargetId(target.id);
                    if (window.matchMedia("(max-width: 1119px)").matches)
                      detailOverlay.open(target.id);
                  }}
                />
              ))}
            </div>
          </ListPanel>
        </section>

        <aside className="work-payment-detail" aria-label="付款详情">
          {selectedTarget ? (
            <>
              <h2 className="work-detail-heading">付款详情</h2>
              <PaymentDetail
                target={selectedTarget}
                activityId={selectedActivityId}
                merchantId={targetMerchantId}
                openProcessing={openProcessing}
              />
            </>
          ) : (
            <div className="work-payment-detail-empty" role="status">
              {needsSelectedRead && selectedRead.isPending ? (
                <SkeletonRows rows={3} />
              ) : selectedTargetId && targetData ? (
                "无法读取原发放目标，请重新选择或重试。"
              ) : selectedActivityId ? (
                "请选择发放目标。"
              ) : (
                "请选择红包活动。"
              )}
            </div>
          )}
        </aside>
      </div>
      {detailOpen && !processingOpen ? (
        <Dialog
          title="付款详情"
          onClose={() => router.history.back()}
          footer={
            <button
              type="button"
              className="button secondary"
              onClick={() => router.history.back()}
            >
              关闭详情
            </button>
          }
        >
          <div className="work-payment-detail-content">
            {selectedTarget ? (
              <PaymentDetail
                target={selectedTarget}
                activityId={selectedActivityId}
                merchantId={targetMerchantId}
                openProcessing={openProcessing}
              />
            ) : (needsSelectedRead && selectedRead.isPending) ||
              (selectedActivityId && targets.isPending) ? (
              <SkeletonRows rows={3} />
            ) : (
              <p role="status">无法读取原发放目标，请关闭后重新选择。</p>
            )}
          </div>
        </Dialog>
      ) : null}
      {processingOpen && processingMerchantId && processingTaskId ? (
        <MerchantPaymentDialog
          userId={userId}
          csrfToken={csrfToken}
          merchantId={processingMerchantId}
          taskId={processingTaskId}
          origin="workbench"
          restoreFocus={processingTrigger.current}
          onBack={() => router.history.back()}
          onClose={() =>
            router.history.go(processingParent === "summary" ? -2 : -1)
          }
        />
      ) : null}
    </div>
  );
}

function ActivityButton({
  activity,
  selected,
  onSelect,
}: {
  activity: ActivityPaymentActivity;
  selected: boolean;
  onSelect: (button: HTMLButtonElement) => void;
}) {
  return (
    <button
      className={`work-payment-activity-row ${selected ? "is-active" : ""}`}
      type="button"
      aria-pressed={selected}
      title={activity.title || "未命名活动"}
      onClick={(event) => onSelect(event.currentTarget)}
    >
      <span className="work-payment-activity-copy">
        <strong>{activity.title || "未命名活动"}</strong>
        <span>
          <StatusBadge
            tone={activity.status === "active" ? "success" : "neutral"}
          >
            {activityStatusLabel(activity.status)}
          </StatusBadge>
        </span>
      </span>
    </button>
  );
}

function TargetButton({
  target,
  selected,
  onSelect,
}: {
  target: ActivityPaymentTarget;
  selected: boolean;
  onSelect: () => void;
}) {
  const name =
    target.recipientProfile.displayName || target.recipientProfile.username;
  return (
    <button
      className={`work-payment-row ${selected ? "is-active" : ""}`}
      type="button"
      data-payment-id={target.id}
      data-record-id={target.id}
      aria-pressed={selected}
      title={name}
      onClick={onSelect}
    >
      <span className="work-payment-copy">
        <strong>{name}</strong>
        <time>{formatTime(target.createdAt)}</time>
      </span>
      <span className="work-payment-value">
        <strong>
          {target.amount}
          <small>LDC</small>
        </strong>
        <StatusBadge tone={paymentTone(target.status)}>
          <PaymentStatusText mode={target.mode} status={target.status} />
        </StatusBadge>
      </span>
      <ChevronRight className="work-payment-chevron" size={14} aria-hidden />
    </button>
  );
}

function PaymentSummary({
  summary,
}: {
  summary: {
    pendingAmount: string;
    confirmedAmount: string;
  } | null;
}) {
  return (
    <div className="work-payment-heading-tools">
      <div className="work-payment-heading-stat">
        <span>待完成金额 </span>
        <strong>
          {summary ? amountText(summary.pendingAmount) : "—"}
          <small> LDC</small>
        </strong>
      </div>
      <div className="work-payment-heading-stat">
        <span>已发放金额 </span>
        <strong>
          {summary ? amountText(summary.confirmedAmount) : "—"}
          <small> LDC</small>
        </strong>
      </div>
    </div>
  );
}

function PaymentFactList({
  items,
}: {
  items: Array<{ label: string; value: React.ReactNode }>;
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

function PaymentDetail({
  target,
  activityId,
  merchantId,
  openProcessing,
}: {
  target: ActivityPaymentTarget;
  activityId: string | null;
  merchantId: string | null;
  openProcessing: (
    merchantId: string,
    taskId: string,
    trigger: HTMLElement,
  ) => void;
}) {
  const detailRef = useRef<HTMLDivElement>(null);
  useRestoredScroll(detailRef, `payment-detail:${activityId}:${target.id}`);
  const name =
    target.recipientProfile.displayName || target.recipientProfile.username;
  return (
    <div ref={detailRef} className="work-payment-detail-body">
      <section className="work-payment-detail-section work-payment-summary">
        <div>
          <span className="work-payment-section-kicker">发放金额</span>
          <div className="work-payment-detail-amount">
            {target.amount}
            <span>LDC</span>
          </div>
        </div>
        <StatusBadge tone={paymentTone(target.status)}>
          <PaymentStatusText mode={target.mode} status={target.status} />
        </StatusBadge>
        {target.reason ? (
          <p className="work-payment-detail-note">
            {paymentReason(target.reason)}
          </p>
        ) : null}
      </section>

      <section className="work-payment-detail-section">
        <h3>收款目标</h3>
        <div className="work-payment-recipient">
          <UserAvatar profile={target.recipientProfile} size="lg" />
          <div>
            <strong>{name}</strong>
            <span>@{target.recipientProfile.username || "未记录用户名"}</span>
          </div>
        </div>
      </section>

      <section className="work-payment-detail-section">
        <h3>订单与时间</h3>
        <PaymentFactList
          items={[
            { label: "本站业务号", value: target.businessNo },
            {
              label: "上游交易号",
              value: target.externalOrderId ?? "尚未收到",
            },
            { label: "创建时间", value: formatTime(target.createdAt) },
            {
              label: "本站确认发放时间",
              value: target.confirmedAt
                ? formatTime(target.confirmedAt)
                : "尚未确认",
            },
          ]}
        />
      </section>

      <div className="work-payment-detail-actions">
        {merchantId ? (
          <a
            className="button secondary"
            href={merchantPaymentHref(merchantId, target.id)}
            data-processing-task-id={target.id}
            onClick={(event) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              openProcessing(merchantId, target.id, event.currentTarget);
            }}
          >
            查看处理详情
          </a>
        ) : null}
        {activityId ? (
          <Link
            className="work-text-link"
            to="/activities/$id"
            params={{ id: activityId }}
          >
            查看关联活动
          </Link>
        ) : null}
      </div>
    </div>
  );
}
