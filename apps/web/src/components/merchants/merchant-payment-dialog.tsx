import {
  type Merchant,
  type MerchantPaymentDetail,
  paymentLabel,
  type RepairPaymentCredentialInput,
  repairPaymentCredentialSchema,
} from "@hb/contracts";
import { Link, useBlocker, useRouter } from "@tanstack/react-router";
import { ArrowLeft, RefreshCw, X } from "lucide-react";
import {
  type MouseEvent,
  type PointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ActivityRequestError, formatTime } from "../../lib/activities";
import { useSession } from "../../lib/auth";
import {
  isMerchantResourceId,
  merchantPaymentHref,
} from "../../lib/merchant-navigation";
import {
  merchantSessionIdentity,
  useMerchant,
  useMerchantPayment,
  useMerchantPayments,
  useMerchantViewScope,
  useMerchantWrites,
} from "../../lib/merchants";
import {
  useCursorRecovery,
  useRestoredScroll,
  useViewState,
} from "../../lib/navigation-state";
import {
  duplicateProbeLabel,
  paymentAttemptOutcome,
  paymentOrderEvidence,
  paymentReason,
} from "../../lib/payment-display";
import { isAccessQueryError, isBlockingQueryError } from "../../lib/query-view";
import { ActivityErrorView } from "../activities/activity-error";
import { ListPagination } from "../activities/list-pagination";
import { CompactIconButton } from "../presentation/compact-icon-button";
import { SkeletonRows } from "../presentation/loading";
import { PortalTargetProvider } from "../presentation/portal-target";
import {
  ActionButton,
  ActionFeedbackLabel,
  useActionFeedback,
} from "../ui/action-feedback";
import { UserIdentity } from "../user-identity";

type PaymentDialogProps = {
  userId: string;
  csrfToken: string;
  merchantId: string;
  taskId?: string | null;
  onClose: () => void;
  onBack?: () => void;
  onSelectPayment?: (taskId: string) => void;
  restoreFocus?: HTMLElement | null;
  onNavigate?: () => void;
  origin?: "merchant" | "workbench";
};

const refreshButtonStyle = {
  width: "auto",
  minWidth: "max-content",
  paddingInline: 8,
} as const;

const refreshContentStyle = {
  display: "inline-grid",
  alignItems: "center",
  justifyItems: "center",
} as const;

const refreshSlotStyle = {
  gridArea: "1 / 1",
} as const;

function RefreshFeedbackContent({
  feedback,
}: {
  feedback?: { label: string; detail?: string } | null;
}) {
  return (
    <span style={refreshContentStyle}>
      <span style={{ ...refreshSlotStyle, visibility: "hidden" }}>
        <ActionFeedbackLabel
          label="刷新"
          feedback={feedback}
          reserve={["刷新", "已刷新", "刷新失败"]}
        />
      </span>
      <span style={refreshSlotStyle}>
        {feedback ? (
          <ActionFeedbackLabel
            label="刷新"
            feedback={feedback}
            reserve={["刷新", "已刷新", "刷新失败"]}
          />
        ) : (
          <RefreshCw size={16} />
        )}
      </span>
    </span>
  );
}

/** One native top layer for the merchant table and the shared workbench detail. */
export function MerchantPaymentDialog(props: PaymentDialogProps) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backdropPress = useRef(false);
  const navigating = useRef(false);
  const restoreFocus = useRef(props.restoreFocus);
  restoreFocus.current = props.restoreFocus ?? restoreFocus.current;
  const router = useRouter();
  useLayoutEffect(() => {
    if (!dialog) return;
    dialog.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      const target =
        restoreFocus.current ??
        document.getElementById("merchant-payments-trigger");
      if (!navigating.current && target?.isConnected)
        target.focus({ preventScroll: true });
    };
  }, [dialog]);
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
  function releaseForNavigation() {
    const href = router.state.location.href;
    navigating.current = true;
    dialog?.close();
    props.onNavigate?.();
    // A cancelled leave confirmation keeps this very same view usable.
    requestAnimationFrame(() => {
      if (
        dialog?.isConnected &&
        router.state.location.href === href &&
        !dialog.open
      ) {
        navigating.current = false;
        dialog.showModal();
      }
    });
  }
  return createPortal(
    <dialog
      ref={setDialog}
      className="merchant-payment-dialog"
      aria-label={props.taskId != null ? "付款详情" : "付款记录"}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onPointerDown={(event) => {
        backdropPress.current = isBackdrop(event);
      }}
      onPointerUp={(event) => {
        if (backdropPress.current && isBackdrop(event)) props.onClose();
        backdropPress.current = false;
      }}
    >
      <PortalTargetProvider target={dialog}>
        <MerchantPaymentContent
          {...props}
          onNavigate={releaseForNavigation}
          closeButton={closeButton}
        />
      </PortalTargetProvider>
    </dialog>,
    document.body,
  );
}

export function MerchantPaymentContent({
  userId,
  csrfToken,
  merchantId,
  taskId,
  onClose,
  onBack,
  onSelectPayment,
  onNavigate,
  origin = "merchant",
  closeButton,
}: PaymentDialogProps & {
  closeButton?: React.RefObject<HTMLButtonElement | null>;
}) {
  const session = useSession();
  const identity = merchantSessionIdentity(session.data);
  const actions = (
    <CompactIconButton
      ref={closeButton}
      aria-label={taskId != null ? "关闭付款详情" : "关闭付款记录"}
      title="关闭"
      onClick={onClose}
    >
      <X size={17} />
    </CompactIconButton>
  );
  if (session.isError || !identity || session.data?.user?.id !== userId)
    return (
      <>
        <header className="merchant-payment-dialog__header">
          <h2>{taskId != null ? "付款详情" : "付款记录"}</h2>
          {actions}
        </header>
        <div className="merchant-payment-dialog__body">
          <p role="alert">身份检查失败，请重新登录或刷新后继续。</p>
        </div>
      </>
    );
  if (
    !isMerchantResourceId(merchantId) ||
    (taskId != null && !isMerchantResourceId(taskId))
  )
    return (
      <>
        <header className="merchant-payment-dialog__header">
          {taskId != null && onBack ? (
            <button type="button" className="work-text-link" onClick={onBack}>
              返回付款记录
            </button>
          ) : null}
          <h2>{taskId != null ? "付款详情" : "付款记录"}</h2>
          {actions}
        </header>
        <div className="merchant-payment-dialog__body">
          <p role="alert">
            {taskId != null
              ? "未找到付款任务，或你无权查看。"
              : "未找到商户，或你无权查看。"}
          </p>
        </div>
      </>
    );
  return taskId != null ? (
    <PaymentDetailReader
      key={`${identity}:${merchantId}:${taskId}`}
      merchantId={merchantId}
      taskId={taskId}
      userId={userId}
      csrfToken={csrfToken}
      onBack={onBack}
      onNavigate={onNavigate}
      origin={origin}
      actions={actions}
    />
  ) : (
    <MerchantPaymentTable
      key={`${identity}:${merchantId}`}
      merchantId={merchantId}
      userId={userId}
      onSelectPayment={onSelectPayment}
      onNavigate={onNavigate}
      actions={actions}
    />
  );
}

function MerchantPaymentTable({
  merchantId,
  userId,
  onSelectPayment,
  onNavigate,
  actions,
}: Pick<
  PaymentDialogProps,
  "merchantId" | "userId" | "onSelectPayment" | "onNavigate"
> & { actions: React.ReactNode }) {
  const scope = useMerchantViewScope(userId);
  const [cursors, setCursors] = useViewState<Array<string | null>>(
    "merchant-payments-cursors",
    [null],
    `${scope}:${merchantId}`,
  );
  const setPaymentCursors = useCallback(
    (value: SetStateAction<Array<string | null>>) => {
      setCursors((current) =>
        typeof value === "function" ? value(current) : value,
      );
    },
    [setCursors],
  );
  const [savedFocus, setSavedFocus] = useViewState(
    "merchant-payments-focus",
    "",
    `${scope}:${merchantId}`,
  );
  const query = useMerchantPayments(userId, merchantId, cursors.at(-1) ?? null);
  const refreshFeedback = useActionFeedback(
    `merchant-payments:${scope}:${merchantId}:refresh`,
  );
  const cursorRecovery = useCursorRecovery(
    query.error,
    cursors,
    setPaymentCursors,
  );
  const scroll = useRef<HTMLDivElement>(null);
  useRestoredScroll(
    scroll,
    `merchant-payments:${scope}:${merchantId}`,
    Boolean(query.data),
    `${cursors.length}`,
  );
  useEffect(() => {
    if (!savedFocus || !query.data) return;
    const control = Array.from(
      scroll.current?.querySelectorAll<HTMLAnchorElement>(
        "[data-payment-detail]",
      ) ?? [],
    ).find((node) => node.dataset.paymentDetail === savedFocus);
    control?.focus({ preventScroll: true });
  }, [savedFocus, query.data]);
  const blocking = isBlockingQueryError(query);
  const staleRefreshError =
    query.isError && query.data !== undefined && !blocking
      ? "刷新失败，当前内容已保留。"
      : null;
  function select(event: MouseEvent<HTMLAnchorElement>, taskId: string) {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      !onSelectPayment
    )
      return;
    event.preventDefault();
    setSavedFocus(taskId);
    onSelectPayment(taskId);
  }
  async function refreshPayments() {
    if (query.isFetching) return;
    refreshFeedback.clear();
    const result = await query.refetch();
    if (result.isError) {
      refreshFeedback.show("刷新失败", "读取失败，请重试。");
      return;
    }
    refreshFeedback.show("已刷新");
  }
  return (
    <>
      <header className="merchant-payment-dialog__header">
        <h2>付款记录</h2>
        <CompactIconButton
          className="list-refresh-button"
          aria-label={
            refreshFeedback.feedback
              ? `刷新，${refreshFeedback.feedback.label}`
              : "刷新"
          }
          title={
            refreshFeedback.feedback?.detail ?? staleRefreshError ?? "刷新"
          }
          aria-description={
            refreshFeedback.feedback?.detail ?? staleRefreshError ?? undefined
          }
          aria-busy={query.isFetching}
          aria-disabled={query.isFetching}
          style={refreshButtonStyle}
          onClick={() => void refreshPayments()}
        >
          <RefreshFeedbackContent feedback={refreshFeedback.feedback} />
        </CompactIconButton>
        {actions}
      </header>
      <div className="merchant-payment-dialog__body" ref={scroll}>
        {cursorRecovery}
        {blocking ? (
          <ActivityErrorView
            error={query.error ?? new Error("读取失败")}
            retry={() => query.refetch()}
            notFoundMessage="未找到商户，或你无权查看。"
          />
        ) : !query.data ? (
          <div aria-busy="true">
            <p role="status">正在读取付款记录…</p>
            <SkeletonRows />
          </div>
        ) : (
          <>
            <div className="merchant-payment-table-scroll">
              <table
                className="merchant-payment-table"
                aria-label="商户付款记录"
              >
                <thead>
                  <tr>
                    {["金额", "状态", "来源", "业务号", "创建时间", "操作"].map(
                      (label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((payment) => (
                    <tr key={payment.id} data-record-id={payment.id}>
                      <td className="merchant-payment-table__amount">
                        {payment.amount} LDC
                      </td>
                      <td>{paymentLabel(payment.mode, payment.status)}</td>
                      <td>
                        {payment.source === "claim" ? "活动领取" : "接入验收"}
                      </td>
                      <td>
                        <span
                          className="merchant-payment-table__order"
                          title={payment.businessNo}
                        >
                          {payment.businessNo}
                        </span>
                      </td>
                      <td>
                        <time dateTime={payment.createdAt}>
                          {formatTime(payment.createdAt)}
                        </time>
                      </td>
                      <td className="merchant-payment-table__actions">
                        <a
                          className="work-text-link"
                          data-payment-detail={payment.id}
                          href={merchantPaymentHref(merchantId, payment.id)}
                          onClick={(event) => select(event, payment.id)}
                        >
                          查看详情
                        </a>
                        {payment.source === "claim" ? (
                          <Link
                            className="work-text-link"
                            to="/activities/$id"
                            params={{ id: payment.activityId }}
                            onClick={onNavigate}
                          >
                            查看活动
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {!query.data.items.length ? (
                    <tr>
                      <td colSpan={6} className="merchant-payment-table__empty">
                        暂无付款记录。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <ListPagination
              cursors={cursors}
              setCursors={setPaymentCursors}
              nextCursor={query.data.nextCursor}
              busy={query.isFetching}
            />
          </>
        )}
      </div>
    </>
  );
}

function PaymentDetailReader({
  merchantId,
  taskId,
  userId,
  csrfToken,
  onBack,
  onNavigate,
  origin,
  actions,
}: Required<
  Pick<PaymentDialogProps, "merchantId" | "userId" | "csrfToken" | "origin">
> & {
  taskId: string;
  onBack?: () => void;
  onNavigate?: () => void;
  actions: React.ReactNode;
}) {
  const scope = useMerchantViewScope(userId);
  const [cursors, setCursors] = useViewState<Array<string | null>>(
    "merchant-payment-attempt-cursors",
    [null],
    `${scope}:${merchantId}:${taskId}`,
  );
  const setAttemptCursors = useCallback(
    (value: SetStateAction<Array<string | null>>) => {
      setCursors((current) =>
        typeof value === "function" ? value(current) : value,
      );
    },
    [setCursors],
  );
  const query = useMerchantPayment(
    userId,
    merchantId,
    taskId,
    cursors.at(-1) ?? null,
  );
  const merchantQuery = useMerchant(userId, merchantId);
  const [snapshot, setSnapshot] = useState<MerchantPaymentDetail | null>(null);
  const [repairLocked, setRepairLocked] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  useRestoredScroll(
    scroll,
    `merchant-payment:${scope}:${merchantId}:${taskId}`,
    Boolean(query.data),
    `${cursors.length}`,
  );
  const cursorRecovery = useCursorRecovery(
    query.error,
    cursors,
    setAttemptCursors,
  );
  const accessError = isAccessQueryError(query.error)
    ? query.error
    : isAccessQueryError(merchantQuery.error)
      ? merchantQuery.error
      : null;
  useEffect(() => {
    if (accessError) setSnapshot(null);
    else if (query.data?.payment) setSnapshot(query.data.payment);
  }, [accessError, query.data]);
  const payment = query.data?.payment ?? snapshot;
  const merchant = merchantQuery.data?.merchant;
  const detailRefreshFeedback = useActionFeedback(
    `merchant-payment:${scope}:${merchantId}:${taskId}:refresh`,
  );
  const staleRefreshError =
    (query.isError && query.data !== undefined) ||
    (merchantQuery.isError && merchantQuery.data !== undefined)
      ? "读取失败，当前内容已保留。"
      : null;
  async function refreshMerchant() {
    const result = await merchantQuery.refetch();
    if (result.isError || !result.data)
      throw result.error ?? new Error("读取失败");
    return result.data.merchant;
  }
  async function refreshDetail() {
    if (query.isFetching || merchantQuery.isFetching || repairLocked) return;
    detailRefreshFeedback.clear();
    const [paymentResult, merchantResult] = await Promise.all([
      query.refetch(),
      merchantQuery.refetch(),
    ]);
    if (paymentResult.isError || merchantResult.isError) {
      detailRefreshFeedback.show("刷新失败", "读取失败，请重试。");
      return;
    }
    detailRefreshFeedback.show("已刷新");
  }
  return (
    <>
      <header className="merchant-payment-dialog__header">
        {onBack ? (
          <button
            className="work-text-link merchant-payment-dialog__back"
            type="button"
            onClick={onBack}
          >
            <ArrowLeft size={15} />
            {origin === "workbench" ? "返回付款摘要" : "返回付款记录"}
          </button>
        ) : null}
        <h2>付款详情</h2>
        <CompactIconButton
          className="list-refresh-button"
          aria-label={
            detailRefreshFeedback.feedback
              ? `刷新，${detailRefreshFeedback.feedback.label}`
              : "刷新"
          }
          title={
            detailRefreshFeedback.feedback?.detail ??
            staleRefreshError ??
            "刷新"
          }
          aria-description={
            detailRefreshFeedback.feedback?.detail ??
            staleRefreshError ??
            undefined
          }
          aria-busy={
            query.isFetching || merchantQuery.isFetching || repairLocked
          }
          aria-disabled={
            query.isFetching || merchantQuery.isFetching || repairLocked
          }
          style={refreshButtonStyle}
          onClick={() => void refreshDetail()}
        >
          <RefreshFeedbackContent feedback={detailRefreshFeedback.feedback} />
        </CompactIconButton>
        {actions}
      </header>
      <div className="merchant-payment-dialog__body" ref={scroll}>
        {accessError ||
        (!payment && query.isError) ||
        (!merchant && merchantQuery.isError) ? (
          <ActivityErrorView
            error={
              accessError ??
              query.error ??
              merchantQuery.error ??
              new Error("读取失败")
            }
            retry={() => {
              void query.refetch();
              void merchantQuery.refetch();
            }}
            notFoundMessage="未找到付款任务，或你无权查看。"
          />
        ) : !payment || !merchant ? (
          <div aria-busy="true">
            <p role="status">正在读取付款详情…</p>
            <SkeletonRows />
          </div>
        ) : (
          <>
            <PaymentDetails
              merchant={merchant}
              payment={payment}
              onNavigate={onNavigate}
            />
            <section className="merchant-payment-section">
              <h3>处理记录</h3>
              {cursorRecovery}
              {query.isError ? (
                <p role="alert">处理记录读取失败，请刷新后重试。</p>
              ) : null}
              <div
                className="merchant-payment-table-scroll"
                aria-busy={query.isFetching}
              >
                <table
                  className="merchant-payment-table merchant-payment-table--attempts"
                  aria-label="付款处理记录"
                >
                  <thead>
                    <tr>
                      {["操作", "结果", "时间", "说明"].map((label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {payment.attempts.map((attempt) => (
                      <tr key={attempt.id} data-record-id={attempt.id}>
                        <td>
                          {attempt.operation === "send"
                            ? "分发请求"
                            : "订单查询"}
                        </td>
                        <td>{paymentAttemptOutcome(attempt.outcome)}</td>
                        <td>
                          <time dateTime={attempt.startedAt}>
                            {formatTime(attempt.startedAt)}
                          </time>
                          {attempt.finishedAt ? (
                            <span className="merchant-payment-table__secondary">
                              结束 {formatTime(attempt.finishedAt)}
                            </span>
                          ) : (
                            <span className="merchant-payment-table__secondary">
                              处理中
                            </span>
                          )}
                        </td>
                        <td className="merchant-payment-table__description">
                          {attempt.reason ? (
                            <span>{paymentReason(attempt.reason)}</span>
                          ) : null}
                          {attempt.httpStatus ? (
                            <span>HTTP {attempt.httpStatus}</span>
                          ) : null}
                          {attempt.clientId ? (
                            <span>请求 Client ID：{attempt.clientId}</span>
                          ) : null}
                          {attempt.operation === "send" &&
                          attempt.recipientUsername ? (
                            <span>
                              发送时用户名：@{attempt.recipientUsername}
                            </span>
                          ) : null}
                          {attempt.noOrderEvidence ? (
                            <span>该次请求已明确拒绝，未建单</span>
                          ) : null}
                          {attempt.purpose === "probe" ? (
                            <span>重复请求验证</span>
                          ) : null}
                          {attempt.diagnosticSummary ? (
                            <span>上游说明：{attempt.diagnosticSummary}</span>
                          ) : null}
                          {!attempt.reason &&
                          !attempt.httpStatus &&
                          !attempt.clientId &&
                          !attempt.diagnosticSummary
                            ? "—"
                            : null}
                        </td>
                      </tr>
                    ))}
                    {!payment.attempts.length ? (
                      <tr>
                        <td
                          colSpan={4}
                          className="merchant-payment-table__empty"
                        >
                          暂无处理记录。
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <ListPagination
                cursors={cursors}
                setCursors={setAttemptCursors}
                nextCursor={query.data?.payment.nextAttemptsCursor ?? null}
                busy={query.isFetching}
              />
            </section>
            {payment.mode === "real" && payment.config?.canRepairCredentials ? (
              <OriginalOrderCredentialRepair
                merchant={merchant}
                payment={payment}
                userId={userId}
                csrfToken={csrfToken}
                refreshMerchant={refreshMerchant}
                onLocked={setRepairLocked}
              />
            ) : null}
            {payment.source === "acceptance" ||
            payment.identityCorrections?.length ||
            payment.usernameCorrection ? (
              <MorePaymentInformation payment={payment} />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function PaymentDetails({
  merchant,
  payment,
  onNavigate,
}: {
  merchant: Merchant;
  payment: MerchantPaymentDetail;
  onNavigate?: () => void;
}) {
  const recipient = payment.recipientProfile ?? {
    username:
      payment.usernameCorrection?.correctedUsername ??
      payment.recipientUsername ??
      payment.recipientId,
    displayName:
      payment.usernameCorrection?.correctedUsername ??
      payment.recipientUsername ??
      payment.recipientId,
    avatarUrl: null,
    accountTier: null,
  };
  const reasons = [
    ...new Set(
      [payment.reason, payment.sendBlockReason].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  const timeline = [
    { label: "创建付款", at: payment.createdAt },
    { label: "首次发送", at: payment.firstSendAt },
    { label: "收到上游响应", at: payment.sendAcknowledgedAt },
    {
      label: payment.orderEvidence === "query" ? "查到订单" : "发现订单",
      at: payment.orderObservedAt,
    },
    { label: "本站确认发放", at: payment.confirmedAt },
  ]
    .filter((step): step is { label: string; at: string } => Boolean(step.at))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (
    <>
      <section className="merchant-payment-section merchant-payment-summary">
        <div className="merchant-payment-summary__amount">
          <strong>{payment.amount} LDC</strong>
          <span>{paymentLabel(payment.mode, payment.status)}</span>
        </div>
        {payment.unknownOutcome ? (
          <p role="status" className="merchant-payment-notice">
            付款结果尚未确认，正在核对原订单。
          </p>
        ) : null}
        {reasons.map((reason) => (
          <p key={reason} className="merchant-payment-notice">
            {paymentReason(reason)}
          </p>
        ))}
      </section>
      <section className="merchant-payment-section">
        <h3>收款人与订单</h3>
        <dl className="merchant-payment-facts">
          <div>
            <dt>收款人</dt>
            <dd>
              <UserIdentity profile={recipient} />
            </dd>
          </div>
          <div>
            <dt>收款账号 ID</dt>
            <dd>{payment.recipientId}</dd>
          </div>
          {payment.recipientUsername ? (
            <div>
              <dt>订单用户名</dt>
              <dd>@{payment.recipientUsername}</dd>
            </div>
          ) : null}
          {payment.usernameCorrection ? (
            <div>
              <dt>更正后用户名</dt>
              <dd>@{payment.usernameCorrection.correctedUsername}</dd>
            </div>
          ) : null}
          <div>
            <dt>本站业务号</dt>
            <dd>{payment.businessNo}</dd>
          </div>
          <div>
            <dt>上游交易号</dt>
            <dd>{payment.externalOrderId ?? "尚未收到"}</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>
              {payment.source === "claim" ? (
                <Link
                  className="work-text-link"
                  to="/activities/$id"
                  params={{ id: payment.activityId }}
                  onClick={onNavigate}
                >
                  查看活动
                </Link>
              ) : (
                "接入验收"
              )}
            </dd>
          </div>
          <div>
            <dt>商户</dt>
            <dd>
              <Link
                className="work-text-link"
                to="/my/merchants"
                search={{ merchantId: merchant.id }}
                onClick={onNavigate}
              >
                商户配置
              </Link>
            </dd>
          </div>
        </dl>
      </section>
      <section className="merchant-payment-section">
        <h3>付款时间线</h3>
        <ol className="merchant-payment-timeline" aria-label="付款时间线">
          {timeline.map((step) => (
            <li key={step.label}>
              <span>{step.label}</span>
              <time dateTime={step.at}>{formatTime(step.at)}</time>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function OriginalOrderCredentialRepair({
  merchant,
  payment,
  userId,
  csrfToken,
  refreshMerchant,
  onLocked,
}: {
  merchant: Merchant;
  payment: MerchantPaymentDetail;
  userId: string;
  csrfToken: string;
  refreshMerchant: () => Promise<Merchant>;
  onLocked: (locked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [secret, setSecret] = useState("");
  const [version, setVersion] = useState(merchant.version);
  const [refreshing, setRefreshing] = useState(false);
  const repairFeedback = useActionFeedback(
    `merchant-payment:${payment.id}:repair`,
  );
  const refreshFeedback = useActionFeedback(
    `merchant-payment:${payment.id}:merchant-refresh`,
  );
  const [pending, setPending] = useState<RepairPaymentCredentialInput | null>(
    null,
  );
  const mounted = useRef(true);
  const writes = useMerchantWrites(userId, csrfToken, merchant.id);
  const busy = writes.repairPaymentCredentials.isPending || refreshing;
  const locked = busy || Boolean(pending);
  useEffect(() => {
    onLocked(locked);
    return () => onLocked(false);
  }, [locked, onLocked]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty = Boolean(secret) || Boolean(pending);
  useBlocker({
    shouldBlockFn: () =>
      dirty && !window.confirm("还有未保存的原订单凭证，确定离开吗？"),
    enableBeforeUnload: () => dirty,
  });
  function currentOperation() {
    return mounted.current && writes.isCurrentSession();
  }
  async function repair() {
    if (busy) return;
    const checked = repairPaymentCredentialSchema.safeParse(
      pending ?? { requestId: crypto.randomUUID(), version, secret },
    );
    if (!checked.success) return;
    setPending(checked.data);
    repairFeedback.clear();
    try {
      const result = await writes.repairPaymentCredentials.mutateAsync({
        taskId: payment.id,
        input: checked.data,
      });
      if (!currentOperation()) return;
      setPending(null);
      setSecret("");
      setVersion(result.merchant.version);
      repairFeedback.show("已保存");
      writes.repairPaymentCredentials.reset();
    } catch (error) {
      if (!currentOperation()) return;
      if (!(error instanceof ActivityRequestError) || error.status >= 500)
        repairFeedback.show("重试原提交", "尚未确认保存结果，请重试原提交。");
      else {
        setPending(null);
        repairFeedback.show("保存失败", error.message);
      }
    }
  }
  async function refresh() {
    if (locked) return;
    setRefreshing(true);
    refreshFeedback.clear();
    try {
      const result = await refreshMerchant();
      if (!currentOperation()) return;
      setVersion(result.version);
      refreshFeedback.show("已刷新");
    } catch {
      if (currentOperation())
        refreshFeedback.show("刷新失败", "刷新失败，请重试。");
    } finally {
      if (currentOperation()) setRefreshing(false);
    }
  }
  return (
    <section className="merchant-payment-section">
      {!expanded ? (
        <button
          type="button"
          className="work-text-link"
          onClick={() => setExpanded(true)}
        >
          更新原订单密钥
        </button>
      ) : (
        <form
          className="merchant-payment-repair"
          onSubmit={(event) => {
            event.preventDefault();
            void repair();
          }}
        >
          <h3>更新原订单密钥</h3>
          <label
            className="activity-label"
            htmlFor="payment-original-client-id"
          >
            原订单 Client ID
            <input
              id="payment-original-client-id"
              className="activity-input"
              value={payment.config?.effectiveClientId ?? ""}
              readOnly
            />
          </label>
          <label className="activity-label" htmlFor="payment-original-secret">
            原订单商户密钥
            <input
              id="payment-original-secret"
              className="activity-input"
              type="password"
              autoComplete="new-password"
              disabled={locked}
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
                repairFeedback.clear();
              }}
            />
          </label>
          <div className="merchant-payment-repair__actions">
            <ActionButton
              className="button"
              type="submit"
              label={
                busy ? "保存中…" : pending ? "重试原提交" : "保存原订单凭证"
              }
              feedback={repairFeedback.feedback}
              reserve={[
                "保存中…",
                "重试原提交",
                "保存原订单凭证",
                "保存失败",
                "已保存",
              ]}
              disabled={busy || (!pending && !secret)}
            />
            <ActionButton
              className="button ghost"
              type="button"
              label="刷新"
              feedback={refreshFeedback.feedback}
              reserve={["刷新", "已刷新", "刷新失败"]}
              disabled={locked}
              onClick={() => void refresh()}
            />
          </div>
        </form>
      )}
    </section>
  );
}

function MorePaymentInformation({
  payment,
}: {
  payment: MerchantPaymentDetail;
}) {
  return (
    <details className="merchant-payment-more">
      <summary>更多处理信息</summary>
      <div className="merchant-payment-more__content">
        {payment.identityCorrections?.length ? (
          <section>
            <h3>付款身份更正记录</h3>
            <ul>
              {payment.identityCorrections.map((correction) => (
                <li key={correction.version}>
                  <p>
                    {correction.originalClientId} →{" "}
                    {correction.correctedClientId}
                  </p>
                  <p>
                    依据：
                    {correction.evidence === "never_sent"
                      ? "从未发送，没有在途请求"
                      : "已有发送均明确拒绝且未建单"}
                  </p>
                  <time dateTime={correction.createdAt}>
                    {formatTime(correction.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {payment.usernameCorrection ? (
          <p>
            用户名更正：@{payment.usernameCorrection.originalUsername} → @
            {payment.usernameCorrection.correctedUsername} ·{" "}
            {formatTime(payment.usernameCorrection.createdAt)}
          </p>
        ) : null}
        {payment.source === "acceptance" ? (
          <>
            <p>
              发送 {payment.attemptCount} 次 · 查单{" "}
              {payment.reconciliationCount} 次
            </p>
            {payment.orderEvidence ? (
              <p>订单证据：{paymentOrderEvidence(payment.orderEvidence)}</p>
            ) : null}
            {payment.retryAuthorization ? (
              <RetryAuthorization authorization={payment.retryAuthorization} />
            ) : null}
            {payment.duplicateProbe ? (
              <section>
                <h3>重复业务号验证</h3>
                <p>{duplicateProbeLabel(payment.duplicateProbe.status)}</p>
                <p>
                  原交易号：{payment.duplicateProbe.baselineExternalOrderId}
                </p>
                <p>查单 {payment.duplicateProbe.queryCount} 次</p>
                <p>
                  验证请求许可：
                  {payment.duplicateProbe.permitConsumedAt
                    ? `已使用 · ${formatTime(payment.duplicateProbe.permitConsumedAt)}`
                    : "尚未使用"}
                </p>
                <p>
                  下次验证检查：
                  {["passed", "inconclusive", "conflict"].includes(
                    payment.duplicateProbe.status,
                  )
                    ? "验证已结束"
                    : payment.duplicateProbe.status === "awaiting_evidence" &&
                        payment.duplicateProbe.protocolVerifiedAt
                      ? "等待后台交易记录证据"
                      : formatTime(payment.duplicateProbe.nextRunAt)}
                </p>
                <p>
                  协议证据：
                  {payment.duplicateProbe.protocolVerifiedAt
                    ? formatTime(payment.duplicateProbe.protocolVerifiedAt)
                    : "尚未核实"}
                </p>
                <p>
                  后台证据：
                  {payment.duplicateProbe.backendVerifiedAt
                    ? formatTime(payment.duplicateProbe.backendVerifiedAt)
                    : "尚未核实"}
                </p>
                {payment.duplicateProbe.reason ? (
                  <p>{paymentReason(payment.duplicateProbe.reason)}</p>
                ) : null}
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}

function RetryAuthorization({
  authorization,
}: {
  authorization: NonNullable<MerchantPaymentDetail["retryAuthorization"]>;
}) {
  const [now, setNow] = useState(Date.now);
  const expiresAt = Date.parse(authorization.expiresAt);
  useEffect(() => {
    setNow(Date.now());
    const delay = expiresAt - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  const remaining = Math.max(
    0,
    authorization.maxAdditionalSends - authorization.usedAdditionalSends,
  );
  const status = authorization.revokedAt
    ? "已撤销"
    : expiresAt <= now
      ? "已到期"
      : remaining === 0
        ? "次数已用尽"
        : "有效";
  return (
    <section>
      <h3>原单恢复授权</h3>
      <p>授权状态：{status}</p>
      <p>
        已用 {authorization.usedAdditionalSends} /{" "}
        {authorization.maxAdditionalSends} 次，剩余 {remaining} 次
      </p>
      <p>到期时间：{formatTime(authorization.expiresAt)}</p>
      {authorization.revokedAt ? (
        <p>撤销时间：{formatTime(authorization.revokedAt)}</p>
      ) : null}
    </section>
  );
}
