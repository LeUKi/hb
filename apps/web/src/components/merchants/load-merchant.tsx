import {
  type Merchant,
  type MerchantChangePreview,
  type SimulationScenario,
  type UpdateMerchantInput,
  updateMerchantSchema,
} from "@hb/contracts";
import { useBlocker } from "@tanstack/react-router";
import { ArrowRight, Check, RefreshCw } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { ActivityRequestError } from "../../lib/activities";
import {
  merchantPaymentHref,
  staysOnMerchant,
} from "../../lib/merchant-navigation";
import {
  MerchantChangeConfirmationError,
  useMerchant,
  useMerchantWrites,
} from "../../lib/merchants";
import { isBlockingQueryError } from "../../lib/query-view";
import { PageTitle } from "../../prototype-ui/workbench-ui";
import { ActivityErrorView } from "../activities/activity-error";
import { CompactIconButton } from "../presentation/compact-icon-button";
import { Help } from "../presentation/context-help";
import { SkeletonRows } from "../presentation/loading";
import {
  ActionButton,
  ActionFeedbackLabel,
  useActionFeedback,
} from "../ui/action-feedback";
import {
  hasMerchantChangeImpact,
  MerchantConfigChangeDialog,
} from "./config-change-dialog";

const scenarios: Array<{ value: SimulationScenario; label: string }> = [
  { value: "normal", label: "正常" },
  { value: "response_lost", label: "发送成功但响应丢失" },
  { value: "query_delayed", label: "查单延迟" },
  { value: "query_unavailable", label: "查单暂不可用" },
  { value: "insufficient_funds", label: "余额不足" },
  { value: "daily_limit", label: "每日额度不足" },
  { value: "invalid_credentials", label: "凭证失效" },
  { value: "conflict", label: "订单冲突" },
];

const credentialFailureReasons: Record<string, string> = {
  credentials: "凭证认证未通过，请核对 Client ID 和密钥。",
  configuration: "商户配置无法用于验证，请核对 Client ID 和密钥。",
  interrupted: "凭证验证已中断，暂时无法确认结果。",
  network: "网络连接失败，暂时无法验证凭证。",
  timeout: "验证请求超时，暂时无法确认凭证。",
  http: "上游暂时无法完成凭证验证。",
  redirect: "凭证验证返回了重定向，暂时无法确认结果。",
  invalid_response: "上游响应格式无法识别，暂时无法验证凭证。",
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

export function LoadMerchant({
  id,
  userId,
  csrfToken,
  selection,
  onOpenPayments,
}: {
  id: string;
  userId: string;
  csrfToken: string;
  selection?: ReactNode;
  onOpenPayments: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const query = useMerchant(userId, id);
  if (isBlockingQueryError(query))
    return (
      <div className="work-page">
        <PageTitle title="商户配置" />
        {selection}
        <ActivityErrorView
          error={query.error ?? new Error("读取商户失败")}
          retry={() => query.refetch()}
          notFoundMessage="未找到商户，或你无权查看。"
        />
      </div>
    );
  if (!query.data)
    return (
      <div className="work-page">
        <PageTitle title="商户配置" />
        {selection}
        <section className="activity-panel space-y-4" aria-busy="true">
          <p role="status" className="text-sm text-subtle">
            正在读取商户…
          </p>
          <SkeletonRows />
        </section>
      </div>
    );
  return (
    <MerchantConfiguration
      merchant={query.data.merchant}
      userId={userId}
      csrfToken={csrfToken}
      selection={selection}
      onOpenPayments={onOpenPayments}
      staleRefreshError={
        query.isError && query.data !== undefined
          ? "刷新失败，当前内容已保留。"
          : null
      }
      refresh={async () => {
        const result = await query.refetch();
        if (result.isError || !result.data)
          throw result.error ?? new Error("刷新失败");
        return result.data.merchant;
      }}
    />
  );
}

function MerchantConfiguration({
  merchant,
  userId,
  csrfToken,
  selection,
  onOpenPayments,
  staleRefreshError,
  refresh,
}: {
  merchant: Merchant;
  userId: string;
  csrfToken: string;
  selection?: ReactNode;
  onOpenPayments: (event: MouseEvent<HTMLAnchorElement>) => void;
  staleRefreshError?: string | null;
  refresh: () => Promise<Merchant>;
}) {
  const [baseline, setBaseline] = useState(merchant);
  const [label, setLabel] = useState(merchant.label);
  const [clientId, setClientId] = useState(merchant.clientId);
  const [secret, setSecret] = useState("");
  const [scenario, setScenario] = useState<SimulationScenario>(
    merchant.mode === "simulation" ? merchant.scenario : "normal",
  );
  const saveFeedback = useActionFeedback(`merchant:${merchant.id}:save`);
  const refreshFeedback = useActionFeedback(`merchant:${merchant.id}:refresh`);
  const simulateFeedback = useActionFeedback(
    `merchant:${merchant.id}:simulate`,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<UpdateMerchantInput | null>(null);
  const [warning, setWarning] = useState<{
    input: UpdateMerchantInput;
    change: MerchantChangePreview;
  } | null>(null);
  const requestId = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const writes = useMerchantWrites(userId, csrfToken, merchant.id);
  const busy =
    writes.update.isPending ||
    writes.changeImpact.isPending ||
    writes.simulate.isPending ||
    refreshing;
  const locked = busy || Boolean(warning) || Boolean(pending);
  const clientChanged = clientId.trim() !== baseline.clientId;
  const changed =
    label.trim() !== baseline.label || clientChanged || Boolean(secret);
  const dirty = changed || Boolean(warning) || Boolean(pending);
  const input = {
    requestId: requestId.current ?? crypto.randomUUID(),
    version: baseline.version,
    label,
    ...(clientChanged ? { clientId } : {}),
    ...(secret ? { secret } : {}),
  };
  const valid =
    updateMerchantSchema.safeParse(input).success &&
    (!clientChanged || Boolean(secret));
  const verification = merchant.credentialVerification;
  const credentialError =
    verification.credentialVersion === merchant.credentialVersion &&
    (verification.status === "rejected" ||
      verification.status === "unavailable")
      ? (credentialFailureReasons[verification.reason ?? ""] ??
        (verification.status === "rejected"
          ? "商户凭证未通过认证，请更新 Client ID 对应的密钥。"
          : "暂时无法验证商户凭证，请稍后再试。"))
      : null;
  useBlocker({
    shouldBlockFn: ({ current, next }) =>
      !staysOnMerchant(current, next, merchant.id) &&
      dirty &&
      !window.confirm("还有未保存的商户配置，确定离开吗？"),
    enableBeforeUnload: () => dirty,
  });
  function currentOperation() {
    return mounted.current && writes.isCurrentSession();
  }
  function edited() {
    requestId.current = null;
    saveFeedback.clear();
  }
  function reset(latest: Merchant) {
    setBaseline(latest);
    setLabel(latest.label);
    setClientId(latest.clientId);
    setSecret("");
    setPending(null);
    setWarning(null);
    requestId.current = null;
    if (latest.mode === "simulation") setScenario(latest.scenario);
  }
  async function performSave(submission: UpdateMerchantInput) {
    setPending(submission);
    saveFeedback.clear();
    try {
      const result = await writes.update.mutateAsync(submission);
      if (!currentOperation()) return;
      reset(result.merchant);
      saveFeedback.show("已保存");
      writes.update.reset();
    } catch (error) {
      if (!currentOperation()) return;
      if (error instanceof MerchantChangeConfirmationError) {
        setPending(null);
        setWarning({
          input: {
            ...submission,
            confirmationToken: error.change.confirmationToken,
          },
          change: error.change,
        });
        saveFeedback.show("需要确认", error.message);
      } else if (
        !(error instanceof ActivityRequestError) ||
        error.status >= 500
      ) {
        saveFeedback.show("重试原提交", "尚未确认保存结果，请重试原提交。");
      } else {
        setPending(null);
        setWarning(null);
        requestId.current = null;
        saveFeedback.show("保存失败", error.message);
      }
    }
  }
  async function save() {
    if (busy || warning || (!pending && (!changed || !valid))) return;
    if (pending) {
      await performSave(pending);
      return;
    }
    requestId.current ??= input.requestId;
    const checked = updateMerchantSchema.safeParse({
      ...input,
      requestId: requestId.current,
    });
    if (!checked.success) return;
    saveFeedback.clear();
    try {
      if (secret || clientChanged) {
        const change = await writes.changeImpact.mutateAsync();
        if (!currentOperation()) return;
        const submission = {
          ...checked.data,
          confirmationToken: change.confirmationToken,
        };
        if (hasMerchantChangeImpact(change.impact)) {
          setWarning({ input: submission, change });
          return;
        }
        await performSave(submission);
      } else await performSave(checked.data);
    } catch (error) {
      if (currentOperation())
        saveFeedback.show(
          "保存失败",
          error instanceof Error ? error.message : "保存失败，请重试。",
        );
    }
  }
  async function reload() {
    if (locked) return;
    if (changed && !window.confirm("刷新会放弃未保存的修改，是否继续？"))
      return;
    setRefreshing(true);
    refreshFeedback.clear();
    try {
      const latest = await refresh();
      if (!currentOperation()) return;
      reset(latest);
      refreshFeedback.show("已刷新");
    } catch {
      if (currentOperation())
        refreshFeedback.show("刷新失败", "刷新失败，请重试。");
    } finally {
      if (currentOperation()) setRefreshing(false);
    }
  }
  async function simulate() {
    if (
      locked ||
      merchant.mode !== "simulation" ||
      !merchant.capabilities.canSimulate
    )
      return;
    try {
      simulateFeedback.clear();
      await writes.simulate.mutateAsync(scenario);
      if (currentOperation()) simulateFeedback.show("已应用");
    } catch (error) {
      if (currentOperation())
        simulateFeedback.show(
          "设置失败",
          error instanceof Error ? error.message : "设置失败。",
        );
    }
  }
  return (
    <div className="work-page">
      <PageTitle title="商户配置" />
      {selection}
      <div className="work-merchant-layout">
        <form
          className="work-merchant-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="work-merchant-heading">
            <h2>{baseline.label}</h2>
            <CompactIconButton
              aria-label={
                refreshFeedback.feedback
                  ? `刷新，${refreshFeedback.feedback.label}`
                  : "刷新"
              }
              title={
                refreshFeedback.feedback?.detail ?? staleRefreshError ?? "刷新"
              }
              aria-description={
                refreshFeedback.feedback?.detail ??
                staleRefreshError ??
                undefined
              }
              aria-busy={refreshing}
              disabled={locked}
              style={refreshButtonStyle}
              onClick={() => void reload()}
            >
              <RefreshFeedbackContent feedback={refreshFeedback.feedback} />
            </CompactIconButton>
          </div>
          <div className="field">
            <label htmlFor="merchant-edit-label">商户名称</label>
            <input
              id="merchant-edit-label"
              value={label}
              disabled={locked}
              onChange={(event) => {
                edited();
                setLabel(event.target.value);
              }}
            />
          </div>
          <div className="field">
            <div className="work-field-label">
              <label htmlFor="merchant-edit-client-id">Client ID</label>
              <Help label="Client ID">
                修改 Client ID 时须同时填写对应密钥。
              </Help>
            </div>
            <input
              id="merchant-edit-client-id"
              value={clientId}
              autoComplete="off"
              spellCheck={false}
              disabled={locked}
              onChange={(event) => {
                edited();
                setClientId(event.target.value);
              }}
            />
          </div>
          <div className="field">
            <div className="work-field-label">
              <label htmlFor="merchant-edit-secret">商户密钥</label>
              <Help label="商户密钥">
                留空保留现有密钥。保存后自动检查，密钥不会回显。
              </Help>
            </div>
            <input
              id="merchant-edit-secret"
              type="password"
              autoComplete="new-password"
              value={secret}
              disabled={locked}
              aria-describedby={
                credentialError ? "merchant-credential-error" : undefined
              }
              onChange={(event) => {
                edited();
                setSecret(event.target.value);
              }}
              placeholder={
                merchant.mode === "simulation"
                  ? "留空保留现有密钥，请勿填写真实密钥"
                  : "留空保留现有密钥"
              }
            />
            {credentialError ? (
              <p
                id="merchant-credential-error"
                className="work-form-error"
                role="status"
              >
                {credentialError}
              </p>
            ) : null}
          </div>
          {clientChanged && !secret ? (
            <p className="work-form-error" role="status">
              修改 Client ID 时，请同时填写该应用对应的商户密钥。
            </p>
          ) : null}
          <div className="work-merchant-actions">
            <ActionButton
              className="button"
              type="submit"
              label={busy ? "正在保存…" : pending ? "重试原提交" : "保存配置"}
              feedback={saveFeedback.feedback}
              reserve={[
                "正在保存…",
                "重试原提交",
                "保存配置",
                "保存失败",
                "需要确认",
                "已保存",
              ]}
              icon={<Check size={17} />}
              disabled={
                busy || Boolean(warning) || (!pending && (!changed || !valid))
              }
            />
            <a
              id="merchant-payments-trigger"
              className="button ghost"
              href={merchantPaymentHref(merchant.id)}
              onClick={onOpenPayments}
            >
              付款记录 <ArrowRight size={16} />
            </a>
          </div>
        </form>
      </div>
      {merchant.mode === "simulation" && merchant.capabilities.canSimulate ? (
        <details className="work-more-settings">
          <summary>本地模拟设置</summary>
          <div className="work-more-content">
            <label className="activity-label" htmlFor="merchant-scenario">
              付款情形
              <select
                id="merchant-scenario"
                className="activity-input"
                value={scenario}
                disabled={locked}
                onChange={(event) => {
                  const value = scenarios.find(
                    (item) => item.value === event.target.value,
                  )?.value;
                  if (value) setScenario(value);
                }}
              >
                {scenarios.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <ActionButton
              className="button ghost"
              type="button"
              label="应用模拟情形"
              feedback={simulateFeedback.feedback}
              reserve={["应用模拟情形", "已应用", "设置失败"]}
              disabled={locked}
              onClick={() => void simulate()}
            />
          </div>
        </details>
      ) : null}
      {warning ? (
        <MerchantConfigChangeDialog
          impact={warning.change.impact}
          busy={writes.update.isPending}
          confirm={() => void performSave(warning.input)}
          cancel={() => {
            setWarning(null);
            requestId.current = null;
          }}
        />
      ) : null}
    </div>
  );
}
