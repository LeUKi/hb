import type {
  AccountPaymentDetail,
  AccountPaymentFilter,
  AccountPaymentList,
  MerchantPaymentDetail,
  PaymentAttemptView,
} from "@hb/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMerchantIdentity } from "./merchants";
import {
  duplicateProbeActive,
  paymentAttemptOutcome,
  paymentReason,
} from "./payment-display";

// 付款记录 (/payments, 🧾) and 付款详情 (/payments/<编号>): the account's
// payments across its merchants, and how one of them got where it is.

// Keyed by the sign-in (`useMerchantIdentity`), like the merchants: the
// cache keeps them while the session is read again, and drops them when it
// changes.
export const paymentKeys = {
  list: (identity: string) =>
    ["merchant-private", identity, "account-payments"] as const,
  detail: (identity: string, id: string) =>
    ["merchant-private", identity, "account-payment", id] as const,
};

/** The account's payments grouped by 红包 (or one 红包's), 20 at a time. */
export function useAccountPaymentPages(
  userId: string,
  filter: AccountPaymentFilter,
  activityId?: string,
) {
  const session = useMerchantIdentity(userId);
  return useInfiniteQuery({
    queryKey: [
      ...paymentKeys.list(session.identity),
      activityId ?? "*",
      filter,
    ],
    enabled: session.enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({ status: filter });
      if (activityId) query.set("activity", activityId);
      if (pageParam) query.set("cursor", pageParam);
      return session.read<AccountPaymentList>(
        await fetch(`/api/me/payments?${query.toString()}`, {
          signal,
          cache: "no-store",
        }),
      );
    },
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
    // Another filter's payments stay, dimmed, until this one's are in —
    // the same merchant identity's and the same 红包's only.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === session.identity &&
      previousQuery.queryKey[3] === (activityId ?? "*")
        ? previous
        : undefined,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

/** One payment; read again while it may still move on. */
export function useAccountPayment(userId: string, id: string) {
  const session = useMerchantIdentity(userId);
  return useQuery({
    queryKey: paymentKeys.detail(session.identity, id),
    enabled: session.enabled,
    queryFn: async ({ signal }) =>
      session.read<AccountPaymentDetail>(
        await fetch(`/api/me/payments/${encodeURIComponent(id)}`, {
          signal,
          cache: "no-store",
        }),
      ),
    retry: false,
    refetchInterval: (query) => {
      const payment = query.state.data?.payment;
      return payment?.status === "confirmed" &&
        !duplicateProbeActive(payment.duplicateProbe)
        ? false
        : 15_000;
    },
  });
}

export type PaymentStep = {
  at: number;
  title: string;
  detail?: string;
  /** done: green; now: where it stands; warn / stop: went wrong. */
  tone: "done" | "now" | "warn" | "stop";
};

const time = (value: string | null | undefined) =>
  value ? Date.parse(value) : null;

/** The current merchant's key failed: the sender fixes it on /merchant. */
export function needsMerchantKey(payment: MerchantPaymentDetail) {
  return (
    payment.status === "waiting" &&
    !payment.config?.canRepairCredentials &&
    (payment.reason === "credentials" ||
      payment.reason === "credential_rejected")
  );
}

/** What LDC made of the first send, in a phrase. */
function sendDetail(attempt: PaymentAttemptView) {
  if (attempt.outcome === "succeeded") return "LDC 已建单";
  if (attempt.outcome === "started") return "正在等 LDC 回应";
  const reason = paymentReason(attempt.reason)?.replace(/。$/u, "");
  if (attempt.outcome === "rejected")
    return reason ? `LDC 拒绝：${reason}` : "LDC 拒绝了这次请求";
  return reason ?? "没有收到结果";
}

/**
 * 经过: what happened to the payment, for people (06 §9): created, sent to
 * LDC and how LDC answered, then where it stands now. 处理记录 keeps every
 * request as it was.
 */
export function paymentSteps(
  payment: MerchantPaymentDetail,
  options: { draw: boolean; recipient: string },
): PaymentStep[] {
  const created = Date.parse(payment.createdAt);
  const steps: PaymentStep[] = [
    {
      at: created,
      title: options.draw ? "中奖，创建付款" : "领取成功，创建付款",
      detail: `${payment.amount} LDC 付给 ${options.recipient}`,
      tone: "done",
    },
  ];
  const sends = payment.attempts
    .filter((attempt) => attempt.operation === "send")
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const first = sends[0];
  const firstAt = first
    ? Date.parse(first.startedAt)
    : time(payment.firstSendAt);
  if (firstAt !== null)
    steps.push({
      at: firstAt,
      title: "发给 LDC",
      detail: first ? sendDetail(first) : "已发出",
      tone:
        !first || first.outcome === "succeeded"
          ? "done"
          : payment.status === "attention"
            ? "stop"
            : "warn",
    });
  const latest = Math.max(
    created,
    firstAt ?? 0,
    ...payment.attempts.map((attempt) => Date.parse(attempt.startedAt)),
    time(payment.orderObservedAt) ?? 0,
  );
  const lastQuery = payment.attempts
    .filter((attempt) => attempt.operation === "query")
    .map((attempt) => Date.parse(attempt.startedAt))
    .sort((a, b) => b - a)[0];
  switch (payment.status) {
    case "confirmed":
      steps.push({
        at: time(payment.confirmedAt) ?? latest,
        title: "已发放",
        detail: confirmedBy(payment),
        tone: "done",
      });
      break;
    case "attention":
      steps.push({
        at: latest,
        title: "发送已暂停",
        detail: "这笔付款不会自动重发",
        tone: "stop",
      });
      break;
    case "waiting":
      steps.push(
        payment.config?.canRepairCredentials
          ? {
              at: latest,
              title: "等待更新原订单密钥",
              detail: "这笔付款用的是更换前的应用，更新它现在的密钥后继续",
              tone: "now",
            }
          : {
              at: latest,
              title: "等待恢复",
              detail: needsMerchantKey(payment)
                ? "商户密钥更新、检查通过后自动继续"
                : "条件满足后自动继续",
              tone: "now",
            },
      );
      break;
    case "reconciling":
      steps.push({
        at: lastQuery ?? latest,
        title: "核对原订单",
        detail: "查清之前不会重新发送，不会重复付款",
        tone: "now",
      });
      break;
    default:
      if (firstAt === null)
        steps.push({
          at: created,
          title: "等待发送",
          detail: "系统会按计划发给 LDC",
          tone: "now",
        });
  }
  return steps.sort((a, b) => a.at - b.at);
}

/** How the payment was confirmed: by a check of the order, or as LDC said. */
export function confirmedBy(payment: MerchantPaymentDetail) {
  return payment.orderEvidence === "query" ||
    payment.attempts.some(
      (attempt) =>
        attempt.operation === "query" && attempt.outcome === "succeeded",
    )
    ? "查单确认到账"
    : "确认到账";
}

/**
 * 处理记录: each request to LDC and each order check, oldest first. `admin`
 * (网站管理) adds the HTTP status each request got, as production showed it.
 */
export function paymentAttempts(
  payment: MerchantPaymentDetail,
  { admin = false }: { admin?: boolean } = {},
) {
  return [...payment.attempts]
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .map((attempt) => {
      const note =
        attempt.outcome === "succeeded"
          ? attempt.operation === "send"
            ? payment.externalOrderId
              ? `LDC 已建单，上游交易号 ${payment.externalOrderId}`
              : "LDC 已建单"
            : "订单已返回"
          : (paymentReason(attempt.reason) ?? attempt.diagnosticSummary ?? "");
      const status =
        admin && attempt.httpStatus !== null
          ? `HTTP ${attempt.httpStatus}`
          : "";
      return {
        id: attempt.id,
        at: Date.parse(attempt.startedAt),
        action: attempt.operation === "send" ? "分发请求" : "订单查询",
        result: paymentAttemptOutcome(attempt.outcome),
        note: [note, status].filter(Boolean).join(" · "),
      };
    });
}
