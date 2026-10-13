import type { AdminPaymentMode, AdminPaymentStatus } from "@hb/contracts";
import { type QueryObserverResult, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { PaymentStatusText } from "../components/presentation/activity-list";
import { SkeletonRows } from "../components/presentation/loading";
import {
  AdminDetailSurface,
  AdminGuard,
  AdminQueryError,
  AdminRefreshButton,
  AdminShell,
  adminKey,
  fetchAdminPayment,
  fetchAdminPayments,
  fmtTime,
} from "../lib/admin";
import {
  paymentAttemptOutcome,
  paymentNextAction,
  paymentReason,
} from "../lib/payment-display";

type Search = {
  q?: string;
  mode?: AdminPaymentMode;
  status?: AdminPaymentStatus;
  exception?: 1;
  anomaly?: "unknown" | "attention" | "overdue" | "undelivered";
  authorId?: string;
  activityId?: string;
  merchantId?: string;
  recipientId?: string;
  cursor?: string;
  detail?: string;
  attemptsCursor?: string;
};

export const Route = createFileRoute("/admin/payments")({
  validateSearch: (search): Search => ({
    q: typeof search.q === "string" ? search.q : undefined,
    mode: ["simulation", "real"].includes(String(search.mode))
      ? (search.mode as AdminPaymentMode)
      : "all",
    status: [
      "pending",
      "sending",
      "reconciling",
      "waiting",
      "confirmed",
      "attention",
    ].includes(String(search.status))
      ? (search.status as AdminPaymentStatus)
      : "all",
    exception:
      search.exception === "1" || search.exception === 1 ? 1 : undefined,
    anomaly: ["unknown", "attention", "overdue", "undelivered"].includes(
      String(search.anomaly),
    )
      ? (search.anomaly as Search["anomaly"])
      : undefined,
    authorId: typeof search.authorId === "string" ? search.authorId : undefined,
    activityId:
      typeof search.activityId === "string" ? search.activityId : undefined,
    merchantId:
      typeof search.merchantId === "string" ? search.merchantId : undefined,
    recipientId:
      typeof search.recipientId === "string" ? search.recipientId : undefined,
    cursor: typeof search.cursor === "string" ? search.cursor : undefined,
    detail: typeof search.detail === "string" ? search.detail : undefined,
    attemptsCursor:
      typeof search.attemptsCursor === "string"
        ? search.attemptsCursor
        : undefined,
  }),
  component: AdminPaymentsPage,
});

function AdminPaymentsPage() {
  return (
    <AdminGuard>
      {({ identity }) => (
        <AdminShell active="/admin/payments">
          <Payments identity={identity} />
        </AdminShell>
      )}
    </AdminGuard>
  );
}

function Payments({ identity }: { identity: string }) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/admin/payments" });
  const [q, setQ] = useState(search.q ?? "");
  const [activityId, setActivityId] = useState(search.activityId ?? "");
  const [merchantId, setMerchantId] = useState(search.merchantId ?? "");
  const [recipientId, setRecipientId] = useState(search.recipientId ?? "");
  const detailOpenerRef = useRef<{ id: string; element: HTMLElement } | null>(
    null,
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const params = {
    q: search.q,
    mode: search.mode,
    status: search.status,
    exception: search.exception ? "1" : undefined,
    anomaly: search.anomaly,
    authorId: search.authorId,
    activityId: search.activityId,
    merchantId: search.merchantId,
    recipientId: search.recipientId,
    cursor: search.cursor,
  };
  const query = useQuery({
    queryKey: adminKey(identity, "payments", params),
    queryFn: ({ signal }) => fetchAdminPayments(params, signal),
    retry: false,
  });
  const detail = useQuery({
    queryKey: adminKey(
      identity,
      "payment",
      search.detail,
      search.attemptsCursor,
    ),
    queryFn: ({ signal }) =>
      fetchAdminPayment(search.detail ?? "", search.attemptsCursor, signal),
    enabled: Boolean(search.detail),
    retry: false,
  });
  function update(next: Partial<Search>) {
    void navigate({
      search: cleanSearch({ ...search, ...next, cursor: undefined }),
    });
  }
  useEffect(() => setQ(search.q ?? ""), [search.q]);
  useEffect(() => setActivityId(search.activityId ?? ""), [search.activityId]);
  useEffect(() => setMerchantId(search.merchantId ?? ""), [search.merchantId]);
  useEffect(
    () => setRecipientId(search.recipientId ?? ""),
    [search.recipientId],
  );
  function closeDetail() {
    const opener = detailOpenerRef.current;
    const focusTarget =
      opener && opener.id === search.detail && opener.element.isConnected
        ? opener.element
        : searchInputRef.current;
    void navigate({
      search: cleanSearch({
        ...search,
        detail: undefined,
        attemptsCursor: undefined,
      }),
    });
    window.requestAnimationFrame(() => focusTarget?.focus());
  }
  return (
    <div className="admin-list-layout">
      <section className="activity-panel admin-list-panel">
        <div className="admin-toolbar">
          <h2>付款</h2>
          <AdminRefreshButton
            className="button secondary"
            scope={`admin-payments:${identity}:list-refresh:${JSON.stringify(params)}`}
            busy={query.isFetching}
            title={
              query.isError && query.data
                ? `读取失败，请重试。上次读取：${fmtTime(query.dataUpdatedAt)}`
                : "刷新"
            }
            onRefresh={() => query.refetch()}
          />
        </div>
        <form
          className="admin-filters"
          onSubmit={(event) => {
            event.preventDefault();
            update({
              q: q.trim() || undefined,
              activityId: activityId.trim() || undefined,
              merchantId: merchantId.trim() || undefined,
              recipientId: recipientId.trim() || undefined,
            });
          }}
        >
          <input
            ref={searchInputRef}
            className="activity-input"
            aria-label="搜索付款"
            placeholder="任务 ID、业务号或外部交易号"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <input
            className="activity-input"
            aria-label="活动 ID"
            placeholder="活动 ID"
            value={activityId}
            onChange={(event) => setActivityId(event.target.value)}
          />
          <input
            className="activity-input"
            aria-label="商户 ID"
            placeholder="商户 ID"
            value={merchantId}
            onChange={(event) => setMerchantId(event.target.value)}
          />
          <input
            className="activity-input"
            aria-label="收款人 ID"
            placeholder="收款人 ID"
            value={recipientId}
            onChange={(event) => setRecipientId(event.target.value)}
          />
          <select
            aria-label="付款模式"
            value={search.mode}
            onChange={(event) =>
              update({ mode: event.target.value as AdminPaymentMode })
            }
          >
            <option value="all">全部模式</option>
            <option value="simulation">模拟</option>
            <option value="real">真实</option>
          </select>
          <select
            aria-label="付款状态"
            value={search.status}
            onChange={(event) =>
              update({ status: event.target.value as AdminPaymentStatus })
            }
          >
            <option value="all">全部状态</option>
            <option value="pending">待发放</option>
            <option value="sending">发送中</option>
            <option value="reconciling">核对中</option>
            <option value="waiting">等待恢复</option>
            <option value="confirmed">已发放</option>
            <option value="attention">需关注</option>
          </select>
          <select
            aria-label="异常类型"
            value={search.anomaly ?? "all"}
            onChange={(event) =>
              update({
                anomaly:
                  event.target.value === "all"
                    ? undefined
                    : (event.target.value as Search["anomaly"]),
                exception: undefined,
              })
            }
          >
            <option value="all">全部异常</option>
            <option value="unknown">结果未知</option>
            <option value="attention">需要关注</option>
            <option value="overdue">等待超过一小时</option>
            <option value="undelivered">未投递超过十分钟</option>
          </select>
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={search.exception === 1}
              onChange={(event) =>
                update({
                  exception: event.target.checked ? 1 : undefined,
                  anomaly: undefined,
                })
              }
            />
            任一异常
          </label>
          <button className="button" type="submit">
            搜索
          </button>
        </form>
        {!query.data ? (
          query.isError ? (
            <AdminQueryError
              error={query.error}
              retry={() => query.refetch()}
            />
          ) : (
            <SkeletonRows />
          )
        ) : (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>金额</th>
                    <th>状态</th>
                    <th>活动</th>
                    <th>收款人</th>
                    <th>创建</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <Link
                          to="/admin/payments"
                          search={{
                            q: search.q,
                            mode: search.mode,
                            status: search.status,
                            exception: search.exception ? 1 : undefined,
                            anomaly: search.anomaly,
                            authorId: search.authorId,
                            activityId: search.activityId,
                            merchantId: search.merchantId,
                            recipientId: search.recipientId,
                            cursor: search.cursor,
                            detail: item.id,
                          }}
                          onClick={(event) => {
                            detailOpenerRef.current = {
                              id: item.id,
                              element: event.currentTarget,
                            };
                          }}
                        >
                          {item.businessNo}
                        </Link>
                        <span className="admin-muted-id">{item.id}</span>
                      </td>
                      <td>{item.amount} LDC</td>
                      <td>
                        <PaymentStatusText
                          mode={item.mode}
                          status={item.status}
                        />
                        {item.unknownOutcome ? " · 未知" : ""}
                      </td>
                      <td>{item.activityTitle ?? "独立收款"}</td>
                      <td>{item.recipientUsername ?? item.recipientId}</td>
                      <td>{fmtTime(item.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!query.data.items.length && <p>没有匹配的付款。</p>}
            <div className="admin-pager">
              <button
                className="button secondary"
                type="button"
                disabled={!search.cursor}
                onClick={() =>
                  void navigate({ search: { ...search, cursor: undefined } })
                }
              >
                第一页
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={!query.data.nextCursor}
                onClick={() =>
                  void navigate({
                    search: {
                      ...search,
                      cursor: query.data?.nextCursor ?? undefined,
                    },
                  })
                }
              >
                下一页
              </button>
            </div>
          </>
        )}
      </section>
      <AdminDetailSurface
        open={Boolean(search.detail)}
        label="付款详情"
        onClose={closeDetail}
        placeholder={<p className="text-sm text-subtle">选择付款查看详情。</p>}
      >
        {detail.data ? (
          <PaymentDetail
            payment={detail.data.payment}
            refreshing={detail.isFetching}
            refreshScope={`admin-payments:${identity}:${detail.data.payment.id}:refresh`}
            stale={detail.isError}
            staleReadAt={fmtTime(detail.dataUpdatedAt)}
            onRefresh={() => detail.refetch({ cancelRefetch: false })}
            onFirst={
              search.attemptsCursor
                ? () =>
                    void navigate({
                      search: cleanSearch({
                        ...search,
                        attemptsCursor: undefined,
                      }),
                    })
                : undefined
            }
            onMore={(cursor) =>
              void navigate({
                search: cleanSearch({ ...search, attemptsCursor: cursor }),
              })
            }
          />
        ) : detail.isError ? (
          <AdminQueryError
            error={detail.error}
            retry={() => detail.refetch()}
          />
        ) : (
          <SkeletonRows />
        )}
      </AdminDetailSurface>
    </div>
  );
}

function PaymentDetail({
  payment,
  onRefresh,
  refreshing,
  refreshScope,
  stale,
  staleReadAt,
  onFirst,
  onMore,
}: {
  payment: Awaited<ReturnType<typeof fetchAdminPayment>>["payment"];
  onRefresh: () => Promise<
    QueryObserverResult<Awaited<ReturnType<typeof fetchAdminPayment>>, Error>
  >;
  refreshing: boolean;
  refreshScope: string;
  stale: boolean;
  staleReadAt: string;
  onFirst?: () => void;
  onMore: (cursor: string) => void;
}) {
  return (
    <div>
      <div className="admin-detail-heading">
        <h2>{payment.businessNo}</h2>
        <AdminRefreshButton
          className="button secondary"
          scope={refreshScope}
          label="刷新详情"
          busy={refreshing}
          title={
            stale ? `读取失败，请重试。上次读取：${staleReadAt}` : "刷新详情"
          }
          icon={null}
          onRefresh={onRefresh}
        />
      </div>
      <dl className="admin-detail-list">
        <Row label="任务 ID" value={payment.id} />
        <Row label="金额" value={`${payment.amount} LDC`} />
        <Row label="模式" value={payment.mode === "real" ? "真实" : "模拟"} />
        <Row
          label="状态"
          value={
            <PaymentStatusText mode={payment.mode} status={payment.status} />
          }
        />
        <Row label="处理原因" value={paymentReason(payment.reason) ?? "无"} />
        <Row
          label="发送阻塞原因"
          value={
            paymentReason(payment.sendBlockReason) ??
            payment.sendBlockReason ??
            "无"
          }
        />
        <Row label="结果未知" value={payment.unknownOutcome ? "是" : "否"} />
        <Row
          label="订单证据"
          value={
            payment.orderEvidence === "receipt"
              ? "发送回执"
              : payment.orderEvidence === "query"
                ? "查单结果"
                : payment.orderEvidence === "duplicate"
                  ? "重复订单证据"
                  : "暂无"
          }
        />
        <Row label="证据读取时间" value={fmtTime(payment.orderObservedAt)} />
        <Row label="发送受理时间" value={fmtTime(payment.sendAcknowledgedAt)} />
        <Row label="付款确认时间" value={fmtTime(payment.confirmedAt)} />
        <Row
          label="活动"
          value={
            payment.activityId
              ? `${payment.activityTitle ?? ""} · ${payment.activityId}`
              : "无"
          }
        />
        <Row
          label="商户"
          value={`${payment.merchantLabel ?? ""} · ${payment.merchantId}`}
        />
        <Row label="领取记录" value={payment.claimId ?? "无"} />
        <Row label="验收记录" value={payment.acceptanceId ?? "无"} />
        <Row label="外部交易号" value={payment.externalOrderId ?? "无"} />
        <Row label="收款人稳定 ID" value={payment.recipientId} />
        <Row label="订单用户名快照" value={payment.recipientUsername ?? "无"} />
        <Row
          label="当前用户名"
          value={payment.currentRecipientUsername ?? "无"}
        />
        <Row
          label="发送/查单次数"
          value={`${payment.attemptCount}/${payment.reconciliationCount}`}
        />
        <Row label="下次计划" value={fmtTime(payment.nextRunAt)} />
        <Row label="下一步" value={paymentNextAction(payment.nextAction)} />
        <Row label="下次发送" value={fmtTime(payment.nextSendAt)} />
        <Row label="下次查单" value={fmtTime(payment.nextQueryAt)} />
      </dl>
      {payment.activityId && (
        <Link
          className="button secondary"
          to="/admin/activities"
          search={{ detail: payment.activityId }}
        >
          查看关联活动
        </Link>
      )}
      <h3>尝试记录</h3>
      {onFirst && (
        <button className="button secondary" type="button" onClick={onFirst}>
          第一页尝试记录
        </button>
      )}
      {payment.attempts.length ? (
        <>
          <ol className="work-rate-limit-changes">
            {payment.attempts.map((attempt) => (
              <li key={attempt.id}>
                <p>
                  {attempt.operation === "send" ? "发送" : "查单"} ·{" "}
                  {paymentAttemptOutcome(attempt.outcome)} ·{" "}
                  {paymentReason(attempt.reason) ?? "无原因"} ·{" "}
                  {attempt.purpose === "probe" ? "探测" : "恢复"} · HTTP{" "}
                  {attempt.httpStatus ?? "—"}
                </p>
                <time className="text-sm text-subtle">
                  {fmtTime(attempt.startedAt)}
                  {attempt.finishedAt
                    ? ` → ${fmtTime(attempt.finishedAt)}`
                    : " · 尚未完成"}
                </time>
              </li>
            ))}
          </ol>
          {payment.nextAttemptsCursor && (
            <button
              className="button secondary"
              type="button"
              onClick={() => onMore(payment.nextAttemptsCursor ?? "")}
            >
              下一页尝试记录
            </button>
          )}
        </>
      ) : (
        <p className="text-sm text-subtle">暂无尝试记录</p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function cleanSearch(search: Partial<Search>): Partial<Search> {
  return {
    q: search.q || undefined,
    mode: search.mode === "all" ? undefined : search.mode,
    status: search.status === "all" ? undefined : search.status,
    exception: search.exception ? 1 : undefined,
    anomaly: search.anomaly || undefined,
    authorId: search.authorId || undefined,
    activityId: search.activityId || undefined,
    merchantId: search.merchantId || undefined,
    recipientId: search.recipientId || undefined,
    cursor: search.cursor || undefined,
    detail: search.detail || undefined,
    attemptsCursor: search.attemptsCursor || undefined,
  };
}
