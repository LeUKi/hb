import {
  type Merchant,
  type MerchantPaymentDetail,
  paymentLabel,
} from "@hb/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ListPagination } from "../components/activities/list-pagination";
import { RequireAccount } from "../components/activities/require-account";
import { SimulationNotice } from "../components/activities/simulation-notice";
import { CredentialVerificationPanel } from "../components/merchants/credential-verification";
import { PaymentCheckButton } from "../components/merchants/payment-check-button";
import { Button } from "../components/ui/button";
import { formatTime } from "../lib/activities";
import {
  useMerchant,
  useMerchantPayment,
  useMerchantWrites,
} from "../lib/merchants";
import {
  canWakePaymentQuery,
  duplicateProbeLabel,
  paymentAttemptOutcome,
  paymentNextAction,
  paymentOrderEvidence,
  paymentReason,
} from "../lib/payment-display";

export const Route = createFileRoute("/my/merchants/$id/payments/$taskId")({
  component: MerchantPaymentPage,
});

function MerchantPaymentPage() {
  const { id, taskId } = Route.useParams();
  return (
    <RequireAccount>
      {({ userId, csrfToken }) => (
        <LoadPayment
          key={`${userId}-${id}-${taskId}`}
          id={id}
          taskId={taskId}
          userId={userId}
          csrfToken={csrfToken}
        />
      )}
    </RequireAccount>
  );
}

function LoadPayment({
  id,
  taskId,
  userId,
  csrfToken,
}: {
  id: string;
  taskId: string;
  userId: string;
  csrfToken: string;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const query = useMerchantPayment(userId, id, taskId, cursors.at(-1) ?? null);
  const merchantQuery = useMerchant(userId, id);
  if (query.isPending || merchantQuery.isPending)
    return <p role="status">正在读取付款详情…</p>;
  if (query.isError || merchantQuery.isError)
    return (
      <ActivityErrorView
        error={query.error ?? merchantQuery.error ?? new Error("读取失败")}
        retry={() => {
          void query.refetch();
          void merchantQuery.refetch();
        }}
        notFoundMessage="未找到付款任务，或你无权查看。"
      />
    );
  return (
    <PaymentDetails
      merchant={merchantQuery.data.merchant}
      payment={query.data.payment}
      userId={userId}
      csrfToken={csrfToken}
      cursors={cursors}
      setCursors={setCursors}
    />
  );
}

function PaymentDetails({
  merchant,
  payment,
  userId,
  csrfToken,
  cursors,
  setCursors,
}: {
  merchant: Merchant;
  payment: MerchantPaymentDetail;
  userId: string;
  csrfToken: string;
  cursors: Array<string | null>;
  setCursors: (cursors: Array<string | null>) => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const writes = useMerchantWrites(userId, csrfToken, merchant.id);
  const busy = writes.verify.isPending || writes.check.isPending;
  const canCheck = canWakePaymentQuery(payment);
  const sendingUsername =
    payment.usernameCorrection?.correctedUsername ?? payment.recipientUsername;
  async function verify() {
    if (!merchant.capabilities.canVerify) return;
    try {
      await writes.verify.mutateAsync();
      setMessage("凭证检查已启动。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "凭证检查暂未完成。");
    }
  }
  async function check() {
    if (!canCheck || !merchant.capabilities.canCheck) return;
    try {
      const result = await writes.check.mutateAsync();
      setMessage(
        result.accepted === false
          ? `请等待 ${result.retryAfterSeconds ?? 30} 秒后再次检查恢复条件。`
          : "已请求检查恢复条件。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "核对暂未完成。");
    }
  }
  const facts = [
    {
      label: "任务来源",
      value: payment.source === "acceptance" ? "接入验收" : "活动领取",
    },
    {
      label: "付款模式",
      value: payment.mode === "real" ? "真实 LDC" : "本地模拟",
    },
    { label: "发放金额", value: `${payment.amount} LDC` },
    { label: "业务号", value: payment.businessNo },
    { label: "外部交易号", value: payment.externalOrderId ?? "尚未收到" },
    { label: "收款账号 ID", value: payment.recipientId },
    {
      label: "当前发送用户名",
      value: sendingUsername ? `@${sendingUsername}` : "未记录",
    },
    ...(payment.usernameCorrection
      ? [
          {
            label: "原始用户名快照",
            value: `@${payment.usernameCorrection.originalUsername}`,
          },
          {
            label: "用户名更正时间",
            value: formatTime(payment.usernameCorrection.createdAt),
          },
        ]
      : []),
    { label: "创建时间", value: formatTime(payment.createdAt) },
    { label: "发送尝试次数", value: String(payment.attemptCount) },
    {
      label: "首次发送",
      value: payment.firstSendAt ? formatTime(payment.firstSendAt) : "尚未发送",
    },
    { label: "查单次数", value: String(payment.reconciliationCount) },
    {
      label: "分发响应时间",
      value: payment.sendAcknowledgedAt
        ? formatTime(payment.sendAcknowledgedAt)
        : "尚未收到成功响应",
    },
    {
      label: "下一步",
      value: paymentNextAction(payment.nextAction),
    },
    {
      label: "下次发送",
      value: payment.nextSendAt ? formatTime(payment.nextSendAt) : "未安排发送",
    },
    {
      label: "下次查单",
      value: payment.nextQueryAt
        ? formatTime(payment.nextQueryAt)
        : "未安排查单",
    },
    {
      label: "订单证据",
      value: paymentOrderEvidence(payment.orderEvidence),
    },
    ...(payment.orderObservedAt
      ? [{ label: "订单观察时间", value: formatTime(payment.orderObservedAt) }]
      : []),
    ...(payment.confirmedAt
      ? [{ label: "核对确认时间", value: formatTime(payment.confirmedAt) }]
      : []),
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">付款详情</h1>
        <Link
          to="/my/merchants/$id"
          params={{ id: merchant.id }}
          className="text-sm underline underline-offset-4"
        >
          返回商户管理
        </Link>
      </div>
      {payment.mode === "simulation" ? <SimulationNotice /> : null}
      <section className="activity-panel space-y-4">
        <h2 className="text-lg font-semibold">
          {paymentLabel(payment.mode, payment.status)}
        </h2>
        {payment.reason ? (
          <p className="text-sm text-amber-800">
            {paymentReason(payment.reason)}
          </p>
        ) : null}
        {merchant.pausedReason ? (
          <p className="text-sm text-amber-800">
            商户暂停原因：{paymentReason(merchant.pausedReason)}
          </p>
        ) : null}
        {payment.unknownOutcome ? (
          <p className="text-sm text-amber-800">
            本次结果尚未核对清楚，系统继续查询原业务号。
          </p>
        ) : null}
        {payment.sendBlockReason ? (
          <p className="text-sm text-amber-800">
            发送限制：{paymentReason(payment.sendBlockReason)}
          </p>
        ) : null}
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label} className="min-w-0 space-y-1">
              <dt className="text-neutral-500">{fact.label}</dt>
              <dd className="break-all">{fact.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-neutral-500">
          发放金额为订单金额，实际结算与可用时间以 LDC 为准。
        </p>
        <div className="flex flex-wrap gap-3">
          <PaymentCheckButton
            merchant={merchant}
            busy={busy}
            disabled={!canCheck}
            label="立即检查恢复条件"
            check={() => void check()}
          />
          <Button asChild variant="secondary">
            <Link to="/my/merchants/$id" params={{ id: merchant.id }}>
              更新商户密钥
            </Link>
          </Button>
          {payment.source === "claim" ? (
            <Link
              to="/my/activities/$id"
              params={{ id: payment.activityId }}
              className="self-center text-sm underline underline-offset-4"
            >
              查看活动
            </Link>
          ) : null}
        </div>
      </section>
      {payment.source === "claim" &&
      payment.recoveryPolicy === "claim_same_order_v1" ? (
        <section className="activity-panel space-y-3">
          <h2 className="text-lg font-semibold">自动付款恢复</h2>
          <p className="text-sm text-neutral-600">
            系统保留原商户、原业务号、原收款账号和原金额。付款结果未知时先核对原订单，
            凭证或资金恢复后按安全条件继续处理。
          </p>
        </section>
      ) : null}
      {payment.source === "acceptance" && payment.retryAuthorization ? (
        <RetryAuthorization authorization={payment.retryAuthorization} />
      ) : null}
      {payment.source === "acceptance" && payment.duplicateProbe ? (
        <DuplicateProbe probe={payment.duplicateProbe} />
      ) : null}
      {merchant.mode === "real" ? (
        <CredentialVerificationPanel
          merchant={merchant}
          busy={busy}
          verify={() => void verify()}
        />
      ) : null}
      {message ? (
        <p
          role="status"
          className="rounded-md border border-neutral-200 bg-white p-3 text-sm"
        >
          {message}
        </p>
      ) : null}
      <section className="activity-panel space-y-4">
        <h2 className="text-lg font-semibold">付款尝试记录</h2>
        {payment.attempts.length ? (
          <ul className="divide-y divide-neutral-200">
            {payment.attempts.map((attempt) => (
              <li key={attempt.id} className="space-y-2 py-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>
                    {attempt.operation === "send" ? "分发请求" : "订单查询"}
                  </strong>
                  <span>{paymentAttemptOutcome(attempt.outcome)}</span>
                </div>
                <p className="text-neutral-600">
                  {attempt.purpose === "probe" ? "重复请求验证" : "原单恢复"}
                </p>
                <p className="text-neutral-600">
                  凭证版本：{attempt.credentialVersion}
                  {attempt.httpStatus ? ` · HTTP ${attempt.httpStatus}` : ""}
                </p>
                {attempt.operation === "send" ? (
                  <p className="break-all text-neutral-600">
                    发送时用户名：
                    {attempt.recipientUsername
                      ? `@${attempt.recipientUsername}`
                      : "未记录"}
                  </p>
                ) : null}
                <p className="text-neutral-600">
                  开始：{formatTime(attempt.startedAt)} ·{" "}
                  {attempt.finishedAt
                    ? `结束：${formatTime(attempt.finishedAt)}`
                    : "处理中"}
                </p>
                {attempt.reason ? <p>{paymentReason(attempt.reason)}</p> : null}
                {attempt.diagnosticSummary ? (
                  <p className="break-words text-neutral-600">
                    上游说明：{attempt.diagnosticSummary}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">暂无尝试记录。</p>
        )}
        {payment.nextAttemptsCursor || cursors.length > 1 ? (
          <ListPagination
            cursors={cursors}
            setCursors={setCursors}
            nextCursor={payment.nextAttemptsCursor}
          />
        ) : null}
      </section>
    </div>
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
    <section className="activity-panel space-y-3">
      <h2 className="text-lg font-semibold">原单恢复授权</h2>
      <p className="text-sm">授权状态：{status}</p>
      <p className="text-sm">
        已用 {authorization.usedAdditionalSends} /{" "}
        {authorization.maxAdditionalSends} 次，剩余 {remaining} 次
      </p>
      <p className="text-sm text-neutral-600">
        到期时间：{formatTime(authorization.expiresAt)}
      </p>
      {authorization.revokedAt ? (
        <p className="text-sm text-neutral-600">
          撤销时间：{formatTime(authorization.revokedAt)}
        </p>
      ) : null}
      <p className="text-sm text-neutral-600">
        仅限原商户、原业务号、原收款账号和原金额；实际发送仍取决于订单证据、调度时间及业务限制。
      </p>
    </section>
  );
}

function DuplicateProbe({
  probe,
}: {
  probe: NonNullable<MerchantPaymentDetail["duplicateProbe"]>;
}) {
  const facts = [
    { label: "验证状态", value: duplicateProbeLabel(probe.status) },
    { label: "原交易号", value: probe.baselineExternalOrderId },
    {
      label: "验证请求许可",
      value: probe.permitConsumedAt
        ? `已使用 · ${formatTime(probe.permitConsumedAt)}`
        : "尚未使用",
    },
    { label: "验证查单次数", value: String(probe.queryCount) },
    {
      label: "下次验证检查",
      value: ["passed", "inconclusive", "conflict"].includes(probe.status)
        ? "验证已结束"
        : probe.status === "awaiting_evidence" && probe.protocolVerifiedAt
          ? "等待后台交易记录证据"
          : formatTime(probe.nextRunAt),
    },
    {
      label: "协议响应证据",
      value: probe.protocolVerifiedAt
        ? `已核实 · ${formatTime(probe.protocolVerifiedAt)}`
        : "尚未核实",
    },
    {
      label: "后台交易记录证据",
      value: probe.backendVerifiedAt
        ? `已核实 · ${formatTime(probe.backendVerifiedAt)}`
        : "尚未核实",
    },
  ];
  return (
    <section className="activity-panel space-y-3">
      <h2 className="text-lg font-semibold">重复业务号验证</h2>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {facts.map((fact) => (
          <div key={fact.label} className="min-w-0 space-y-1">
            <dt className="text-neutral-500">{fact.label}</dt>
            <dd className="break-all">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {probe.reason ? (
        <p className="text-sm text-amber-800">{paymentReason(probe.reason)}</p>
      ) : null}
    </section>
  );
}
