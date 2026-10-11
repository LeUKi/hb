import {
  type Merchant,
  type MerchantPaymentDetail,
  paymentLabel,
  type RepairPaymentCredentialInput,
  repairPaymentCredentialSchema,
} from "@hb/contracts";
import {
  createFileRoute,
  Link,
  useBlocker,
  useRouter,
} from "@tanstack/react-router";
import {
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ListPagination } from "../components/activities/list-pagination";
import { RequireAccount } from "../components/activities/require-account";
import { SimulationNotice } from "../components/activities/simulation-notice";
import { CredentialVerificationPanel } from "../components/merchants/credential-verification";
import { PaymentCheckButton } from "../components/merchants/payment-check-button";
import { PageShell, Surface } from "../components/presentation/layout";
import { SkeletonRows } from "../components/presentation/loading";
import { Button } from "../components/ui/button";
import { UserIdentity } from "../components/user-identity";
import { formatTime } from "../lib/activities";
import {
  useMerchant,
  useMerchantPayment,
  useMerchantWrites,
} from "../lib/merchants";
import { useCursorRecovery, useViewState } from "../lib/navigation-state";
import {
  canWakePaymentQuery,
  duplicateProbeLabel,
  paymentAttemptOutcome,
  paymentNextAction,
  paymentOrderEvidence,
  paymentReason,
} from "../lib/payment-display";
import { isAccessQueryError } from "../lib/query-view";

export const Route = createFileRoute("/my/merchants/$id/payments/$taskId")({
  component: MerchantPaymentPage,
});

function MerchantPaymentPage() {
  const { id, taskId } = Route.useParams();
  return (
    <RequireAccount requireLdc>
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
  const [cursors, setCursors] = useViewState<Array<string | null>>(
    "merchant-payment-attempt-cursors",
    [null],
    `${id}:${taskId}`,
  );
  const setAttemptCursors = useCallback(
    (value: SetStateAction<Array<string | null>>) => {
      setCursors((current) =>
        typeof value === "function" ? value(current) : value,
      );
    },
    [setCursors],
  );
  const query = useMerchantPayment(userId, id, taskId, cursors.at(-1) ?? null);
  const attemptCursorRecovery = useCursorRecovery(
    query.error,
    cursors,
    setAttemptCursors,
  );
  const merchantQuery = useMerchant(userId, id);
  const [paymentSnapshot, setPaymentSnapshot] =
    useState<MerchantPaymentDetail | null>(null);
  const [merchantSnapshot, setMerchantSnapshot] = useState<Merchant | null>(
    null,
  );
  useEffect(() => {
    if (query.isError && isAccessQueryError(query.error))
      setPaymentSnapshot(null);
    else if (query.data?.payment) setPaymentSnapshot(query.data.payment);
  }, [query.data?.payment, query.isError, query.error]);
  useEffect(() => {
    if (merchantQuery.isError && isAccessQueryError(merchantQuery.error))
      setMerchantSnapshot(null);
    else if (merchantQuery.data?.merchant)
      setMerchantSnapshot(merchantQuery.data.merchant);
  }, [
    merchantQuery.data?.merchant,
    merchantQuery.isError,
    merchantQuery.error,
  ]);
  const blockingError =
    (query.isError && isAccessQueryError(query.error) ? query.error : null) ??
    (merchantQuery.isError && isAccessQueryError(merchantQuery.error)
      ? merchantQuery.error
      : null);
  if (
    blockingError ||
    (!paymentSnapshot && query.isError) ||
    (!merchantSnapshot && merchantQuery.isError)
  )
    return (
      <ActivityErrorView
        error={
          blockingError ??
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
    );
  if (!paymentSnapshot || !merchantSnapshot)
    return (
      <PageShell eyebrow="付款记录" title="付款详情" action={<BackButton />}>
        <div className="payment-detail-layout" aria-busy="true">
          <aside className="payment-detail-list" aria-label="当前付款任务">
            <Surface className="payment-record-card is-active">
              <span className="payment-record-card__status">读取中</span>
              <strong>-- LDC</strong>
              <span>正在读取付款详情…</span>
            </Surface>
          </aside>
          <div className="payment-detail-main">
            <Surface className="payment-detail-section payment-detail-section--hero">
              <p role="status" className="text-sm text-subtle">
                正在读取付款详情…
              </p>
              <SkeletonRows />
            </Surface>
          </div>
        </div>
      </PageShell>
    );
  return (
    <PaymentDetails
      merchant={merchantQuery.data?.merchant ?? merchantSnapshot}
      payment={query.data?.payment ?? paymentSnapshot}
      userId={userId}
      csrfToken={csrfToken}
      cursors={cursors}
      setCursors={setAttemptCursors}
      attemptsLoading={query.isPending && Boolean(paymentSnapshot)}
      attemptsError={
        query.isError && !(query.isError && isAccessQueryError(query.error))
          ? query.error
          : null
      }
      attemptCursorRecovery={attemptCursorRecovery}
      retryPayment={() => query.refetch()}
      refreshMerchant={async () => {
        const result = await merchantQuery.refetch();
        if (!result.data) throw result.error ?? new Error("读取失败");
        return result.data.merchant;
      }}
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
  attemptsLoading = false,
  attemptsError = null,
  attemptCursorRecovery = null,
  retryPayment,
  refreshMerchant,
}: {
  merchant: Merchant;
  payment: MerchantPaymentDetail;
  userId: string;
  csrfToken: string;
  cursors: Array<string | null>;
  setCursors: (cursors: Array<string | null>) => void;
  attemptsLoading?: boolean;
  attemptsError?: unknown;
  attemptCursorRecovery?: ReactNode;
  retryPayment: () => void;
  refreshMerchant: () => Promise<Merchant>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const writes = useMerchantWrites(userId, csrfToken, merchant.id);
  const busy = writes.verify.isPending || writes.check.isPending;
  const canCheck = canWakePaymentQuery(payment);
  const sendingUsername =
    payment.usernameCorrection?.correctedUsername ?? payment.recipientUsername;
  const recipientSnapshot = {
    username: sendingUsername ?? payment.recipientId,
    displayName: sendingUsername ?? payment.recipientId,
    avatarUrl: null,
    accountTier: null,
  };
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
    ...(payment.config
      ? [
          {
            label: "原始 Client ID",
            value: payment.config.originalClientId,
          },
          {
            label: "有效付款 Client ID",
            value: payment.config.effectiveClientId,
          },
          {
            label: "付款凭证版本",
            value: String(payment.config.credentialVersion),
          },
          {
            label: "身份更正版本",
            value: String(payment.config.identityCorrectionVersion),
          },
        ]
      : []),
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
  const factMap = new Map(facts.map((fact) => [fact.label, fact.value]));
  const factRows = (labels: string[]) =>
    labels
      .map((label) => ({ label, value: factMap.get(label) }))
      .filter(
        (fact): fact is { label: string; value: string } =>
          fact.value !== undefined,
      );
  return (
    <PageShell
      eyebrow="付款记录"
      title="付款详情"
      action={
        <button
          type="button"
          className="app-link"
          onClick={() => router.history.back()}
        >
          返回上一页
        </button>
      }
    >
      <div className="payment-detail-layout">
        <aside className="payment-detail-list" aria-label="当前付款任务">
          <Surface className="payment-record-card is-active">
            <span className="payment-record-card__status">
              {paymentLabel(payment.mode, payment.status)}
            </span>
            <strong>{payment.amount} LDC</strong>
            <span>
              {payment.source === "acceptance" ? "接入验收" : "活动领取"}
            </span>
            <span className="payment-record-card__meta">
              {formatTime(payment.createdAt)}
            </span>
          </Surface>
          <p className="payment-detail-list__hint">
            付款列表保持窄列，详情区展示完整处理信息。
          </p>
        </aside>
        <div className="payment-detail-main">
          {payment.mode === "simulation" ? <SimulationNotice /> : null}
          <Surface className="payment-detail-section payment-detail-section--hero">
            <div>
              <p className="payment-detail-kicker">发放概况</p>
              <h2>{payment.amount} LDC</h2>
              <p>{paymentLabel(payment.mode, payment.status)}</p>
            </div>
            <div className="payment-detail-actions">
              <PaymentCheckButton
                merchant={merchant}
                busy={busy}
                disabled={!canCheck}
                label="检查恢复条件"
                check={() => void check()}
              />
              <Button asChild variant="secondary" size="sm">
                <Link to="/my/merchants/$id" params={{ id: merchant.id }}>
                  商户配置
                </Link>
              </Button>
              {payment.source === "claim" ? (
                <Link
                  to="/activities/$id"
                  params={{ id: payment.activityId }}
                  className="app-link"
                >
                  查看活动
                </Link>
              ) : null}
            </div>
            {payment.reason ? (
              <p className="payment-detail-alert">
                {paymentReason(payment.reason)}
              </p>
            ) : null}
            {merchant.pausedReason ? (
              <p className="payment-detail-alert">
                商户暂停原因：{paymentReason(merchant.pausedReason)}
              </p>
            ) : null}
            {payment.unknownOutcome ? (
              <p className="payment-detail-alert">
                本次结果尚未核对清楚，系统继续查询原业务号。
              </p>
            ) : null}
            {payment.sendBlockReason ? (
              <p className="payment-detail-alert">
                发送限制：{paymentReason(payment.sendBlockReason)}
              </p>
            ) : null}
          </Surface>
          <div className="payment-detail-grid">
            <PaymentDetailSection
              title="收款与来源"
              rows={factRows([
                "任务来源",
                "付款模式",
                "收款账号 ID",
                "当前发送用户名",
                "原始用户名快照",
                "用户名更正时间",
              ])}
            >
              <div className="payment-recipient-card">
                <p>
                  {payment.recipientProfile
                    ? "当前领取账号资料"
                    : "收款用户名快照"}
                </p>
                <UserIdentity
                  profile={payment.recipientProfile ?? recipientSnapshot}
                />
              </div>
            </PaymentDetailSection>
            <PaymentDetailSection
              title="订单信息"
              rows={factRows([
                "业务号",
                "外部交易号",
                "原始 Client ID",
                "有效付款 Client ID",
                "付款凭证版本",
                "身份更正版本",
              ])}
            />
            <PaymentDetailSection
              title="关键时间"
              rows={factRows([
                "创建时间",
                "首次发送",
                "分发响应时间",
                "订单观察时间",
                "核对确认时间",
              ])}
            />
            <PaymentDetailSection
              title="后续处理"
              rows={factRows([
                "下一步",
                "下次发送",
                "下次查单",
                "发送尝试次数",
                "查单次数",
                "订单证据",
              ])}
            />
          </div>
          <p className="payment-detail-note">
            本站确认发放时间只表示本站确认上游发放成功；不推算实际到账时间、手续费或净到账金额。
          </p>
          {payment.config?.canRepairCredentials && payment.mode === "real" ? (
            <OriginalOrderCredentialRepair
              key={`${userId}-${payment.id}-${payment.config.effectiveClientId}`}
              merchant={merchant}
              payment={payment}
              userId={userId}
              csrfToken={csrfToken}
              refreshMerchant={refreshMerchant}
            />
          ) : null}
          {payment.identityCorrections?.length ? (
            <Surface className="payment-detail-section">
              <h2>付款身份更正记录</h2>
              <ul className="payment-event-list">
                {payment.identityCorrections.map((correction) => (
                  <li key={correction.version}>
                    <strong>更正版本：{correction.version}</strong>
                    <span className="break-all">
                      {correction.originalClientId} →{" "}
                      {correction.correctedClientId}
                    </span>
                    <span>
                      依据：
                      {correction.evidence === "never_sent"
                        ? "从未发送，没有在途请求"
                        : "已有发送均明确拒绝且未建单"}
                    </span>
                    <span>时间：{formatTime(correction.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </Surface>
          ) : null}
          {payment.source === "claim" &&
          payment.recoveryPolicy === "claim_same_order_v1" ? (
            <Surface className="payment-detail-section">
              <h2>自动付款恢复</h2>
              <p>
                系统保留同一个商户、原业务号、原收款账号和原金额。付款结果未知时先核对原订单；仅在从未发送或所有发送都有可信未建单证据时，才允许使用修正后的商户配置继续付款。
              </p>
            </Surface>
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
            <p role="status" className="activity-panel text-sm">
              {message}
            </p>
          ) : null}
          <Surface className="payment-detail-section">
            <h2>处理记录</h2>
            {attemptCursorRecovery}
            {attemptsLoading ? (
              <div aria-busy="true">
                <p role="status" className="app-muted">
                  正在读取处理记录…
                </p>
                <SkeletonRows />
              </div>
            ) : attemptsError ? (
              <div role="alert" className="space-y-3">
                <p className="app-muted">处理记录刷新失败。</p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => retryPayment()}
                >
                  重试
                </Button>
              </div>
            ) : payment.attempts.length ? (
              <ul className="payment-event-list">
                {payment.attempts.map((attempt) => (
                  <li key={attempt.id}>
                    <div className="payment-event-list__head">
                      <strong>
                        {attempt.operation === "send" ? "分发请求" : "订单查询"}
                      </strong>
                      <span>{paymentAttemptOutcome(attempt.outcome)}</span>
                    </div>
                    <span>
                      {attempt.purpose === "probe"
                        ? "重复请求验证"
                        : "原单恢复"}
                    </span>
                    <span>
                      凭证版本：{attempt.credentialVersion}
                      {attempt.httpStatus
                        ? ` · HTTP ${attempt.httpStatus}`
                        : ""}
                    </span>
                    {attempt.clientId ? (
                      <span className="break-all">
                        请求 Client ID：{attempt.clientId}
                        {attempt.identityCorrectionVersion !== undefined
                          ? ` · 身份更正版本：${attempt.identityCorrectionVersion}`
                          : ""}
                      </span>
                    ) : null}
                    {attempt.noOrderEvidence ? (
                      <span>未建单证据：已核实该次请求被明确拒绝</span>
                    ) : null}
                    {attempt.operation === "send" ? (
                      <span className="break-all">
                        发送时用户名：
                        {attempt.recipientUsername
                          ? `@${attempt.recipientUsername}`
                          : "未记录"}
                      </span>
                    ) : null}
                    <span>
                      开始：{formatTime(attempt.startedAt)} ·{" "}
                      {attempt.finishedAt
                        ? `结束：${formatTime(attempt.finishedAt)}`
                        : "处理中"}
                    </span>
                    {attempt.reason ? (
                      <span>{paymentReason(attempt.reason)}</span>
                    ) : null}
                    {attempt.diagnosticSummary ? (
                      <span className="break-words">
                        上游说明：{attempt.diagnosticSummary}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="app-muted">暂无尝试记录。</p>
            )}
            <ListPagination
              cursors={cursors}
              setCursors={setCursors}
              nextCursor={payment.nextAttemptsCursor}
            />
          </Surface>
        </div>
      </div>
    </PageShell>
  );
}

function PaymentDetailSection({
  title,
  rows,
  children,
}: {
  title: string;
  rows: Array<{ label: string; value: string }>;
  children?: ReactNode;
}) {
  return (
    <Surface className="payment-detail-section">
      <h2>{title}</h2>
      {children}
      <dl>
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value || "未记录"}</dd>
          </div>
        ))}
      </dl>
    </Surface>
  );
}

function OriginalOrderCredentialRepair({
  merchant,
  payment,
  userId,
  csrfToken,
  refreshMerchant,
}: {
  merchant: Merchant;
  payment: MerchantPaymentDetail;
  userId: string;
  csrfToken: string;
  refreshMerchant: () => Promise<Merchant>;
}) {
  const [secret, setSecret] = useState("");
  const [version, setVersion] = useState(merchant.version);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submitted = useRef<RepairPaymentCredentialInput | null>(null);
  const savedNavigation = useRef(false);
  const mounted = useRef(true);
  const writes = useMerchantWrites(userId, csrfToken, merchant.id);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submitted.current = null;
    };
  }, []);
  function currentOperation() {
    return mounted.current && writes.isCurrentSession();
  }
  const dirty = Boolean(secret) || Boolean(submitted.current);
  useBlocker({
    shouldBlockFn: () =>
      !savedNavigation.current &&
      dirty &&
      !window.confirm("还有未保存的原订单凭证，确定离开吗？"),
    enableBeforeUnload: () => dirty && !savedNavigation.current,
  });
  async function repair() {
    setMessage(null);
    const checked = repairPaymentCredentialSchema.safeParse(
      submitted.current ?? {
        requestId: crypto.randomUUID(),
        version,
        secret,
      },
    );
    if (!checked.success) {
      setMessage("请填写原订单 Client ID 对应的商户密钥。");
      return;
    }
    submitted.current = checked.data;
    try {
      const result = await writes.repairPaymentCredentials.mutateAsync({
        taskId: payment.id,
        input: checked.data,
      });
      if (!currentOperation()) return;
      submitted.current = null;
      setSecret("");
      setVersion(result.merchant.version);
      setMessage("原订单凭证已保存，系统将继续安全核对原订单。");
      savedNavigation.current = true;
      writes.repairPaymentCredentials.reset();
    } catch (error) {
      if (!currentOperation()) return;
      setMessage(
        error instanceof Error ? error.message : "保存失败，请用同一请求重试。",
      );
    }
  }
  async function refreshVersion() {
    setRefreshing(true);
    try {
      const latest = await refreshMerchant();
      if (!currentOperation()) return;
      submitted.current = null;
      setVersion(latest.version);
      setMessage("已读取最新商户版本，密钥输入已保留。");
    } catch (error) {
      if (!currentOperation()) return;
      setMessage(error instanceof Error ? error.message : "读取失败，请重试。");
    } finally {
      if (currentOperation()) setRefreshing(false);
    }
  }
  const busy = writes.repairPaymentCredentials.isPending || refreshing;
  return (
    <form
      className="activity-panel space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void repair();
      }}
    >
      <h2 className="text-lg font-semibold">修复原订单凭证</h2>
      <p className="text-sm text-muted">
        这个订单仍需使用原付款身份核对。只更新该身份的密钥，不更换 Client ID、
        业务号、收款人或金额，也不会强制重新发送。
      </p>
      <label className="activity-label" htmlFor="payment-original-client-id">
        原订单 Client ID
        <input
          id="payment-original-client-id"
          className="activity-input bg-panel"
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
          disabled={busy}
          value={secret}
          placeholder="填写该 Client ID 对应的密钥"
          onChange={(event) => {
            savedNavigation.current = false;
            submitted.current = null;
            setSecret(event.target.value);
            setMessage(null);
          }}
        />
      </label>
      {message ? (
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {writes.repairPaymentCredentials.isPending
            ? "保存中…"
            : "保存原订单凭证"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => void refreshVersion()}
        >
          刷新商户版本
        </Button>
      </div>
    </form>
  );
}

function BackButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="app-link"
      onClick={() => router.history.back()}
    >
      返回上一页
    </button>
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
      <p className="text-sm text-muted">
        到期时间：{formatTime(authorization.expiresAt)}
      </p>
      {authorization.revokedAt ? (
        <p className="text-sm text-muted">
          撤销时间：{formatTime(authorization.revokedAt)}
        </p>
      ) : null}
      <p className="text-sm text-muted">
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
            <dt className="text-subtle">{fact.label}</dt>
            <dd className="break-all">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {probe.reason ? (
        <p className="text-sm text-warning">{paymentReason(probe.reason)}</p>
      ) : null}
    </section>
  );
}
