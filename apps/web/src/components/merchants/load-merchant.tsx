import {
  type Merchant,
  type MerchantChangePreview,
  paymentLabel,
  type SimulationScenario,
  type UpdateMerchantInput,
  updateMerchantSchema,
} from "@hb/contracts";
import { Link, useBlocker, useRouter } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import {
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { formatTime } from "../../lib/activities";
import {
  MerchantChangeConfirmationError,
  useMerchant,
  useMerchantPayments,
  useMerchantWrites,
} from "../../lib/merchants";
import { useCursorRecovery, useViewState } from "../../lib/navigation-state";
import { paymentReason, publicationReason } from "../../lib/payment-display";
import { isBlockingQueryError } from "../../lib/query-view";
import { PageTitle } from "../../prototype-ui/workbench-ui";
import { ActivityErrorView } from "../activities/activity-error";
import { ListPagination } from "../activities/list-pagination";
import { SimulationNotice } from "../activities/simulation-notice";
import { Help } from "../presentation/context-help";
import { RefreshNotice, SkeletonRows } from "../presentation/loading";
import { Button } from "../ui/button";
import {
  hasMerchantChangeImpact,
  MerchantConfigChangeDialog,
} from "./config-change-dialog";
import { CredentialVerificationPanel } from "./credential-verification";
import { PaymentCheckButton } from "./payment-check-button";

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

export function LoadMerchant({
  id,
  userId,
  csrfToken,
  configurationOnly = false,
  managementExtra,
}: {
  id: string;
  userId: string;
  csrfToken: string;
  configurationOnly?: boolean;
  managementExtra?: ReactNode;
}) {
  const query = useMerchant(userId, id);
  if (query.isPending)
    return (
      <div className={configurationOnly ? "work-page" : "space-y-5"}>
        {configurationOnly ? <PageTitle title="商户配置" /> : null}
        <section className="activity-panel space-y-4" aria-busy="true">
          <p role="status" className="text-sm text-subtle">
            正在读取商户…
          </p>
          <SkeletonRows />
        </section>
      </div>
    );
  if (isBlockingQueryError(query))
    return (
      <ActivityErrorView
        error={query.error ?? new Error("读取商户失败")}
        retry={() => query.refetch()}
        notFoundMessage="未找到商户，或你无权查看。"
      />
    );
  if (!query.data)
    return (
      <ActivityErrorView
        error={query.error ?? new Error("读取失败")}
        retry={() => query.refetch()}
        notFoundMessage="未找到商户，或你无权查看。"
      />
    );
  return (
    <MerchantDetails
      configurationOnly={configurationOnly}
      managementExtra={managementExtra}
      refreshNotice={<RefreshNotice query={query} />}
      merchant={query.data.merchant}
      userId={userId}
      csrfToken={csrfToken}
      refresh={async () => {
        const result = await query.refetch();
        if (!result.data) throw result.error ?? new Error("刷新失败");
        return result.data.merchant;
      }}
    />
  );
}

function MerchantDetails({
  configurationOnly = false,
  managementExtra,
  refreshNotice,
  merchant,
  userId,
  csrfToken,
  refresh,
}: {
  merchant: Merchant;
  configurationOnly?: boolean;
  managementExtra?: ReactNode;
  refreshNotice?: ReactNode;
  userId: string;
  csrfToken: string;
  refresh: () => Promise<Merchant>;
}) {
  const [label, setLabel] = useState(merchant.label);
  const [clientId, setClientId] = useState(merchant.clientId);
  const [savedClientId, setSavedClientId] = useState(merchant.clientId);
  const [secret, setSecret] = useState("");
  const [version, setVersion] = useState(merchant.version);
  const [scenario, setScenario] = useState<SimulationScenario>(
    merchant.mode === "simulation" ? merchant.scenario : "normal",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<{
    input: UpdateMerchantInput;
    change: MerchantChangePreview;
  } | null>(null);
  const requestId = useRef<string | null>(null);
  const submitted = useRef<UpdateMerchantInput | null>(null);
  const savedNavigation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submitted.current = null;
      requestId.current = null;
    };
  }, []);
  const writes = useMerchantWrites(userId, csrfToken, merchant.id);
  const busy =
    writes.update.isPending ||
    writes.changeImpact.isPending ||
    writes.check.isPending ||
    writes.verify.isPending ||
    writes.simulate.isPending;
  const dirty =
    label !== merchant.label ||
    clientId !== savedClientId ||
    Boolean(secret) ||
    Boolean(warning) ||
    Boolean(submitted.current);
  useBlocker({
    shouldBlockFn: () =>
      !savedNavigation.current &&
      dirty &&
      !window.confirm("还有未保存的商户配置，确定离开吗？"),
    enableBeforeUnload: () => dirty && !savedNavigation.current,
  });
  function editInput() {
    savedNavigation.current = false;
    submitted.current = null;
    requestId.current = null;
    setMessage(null);
  }
  function currentOperation() {
    return mounted.current && writes.isCurrentSession();
  }
  async function performSave(input: UpdateMerchantInput) {
    submitted.current = input;
    setMessage(null);
    try {
      const result = await writes.update.mutateAsync(input);
      if (!currentOperation()) return;
      submitted.current = null;
      requestId.current = null;
      setWarning(null);
      setLabel(result.merchant.label);
      setClientId(result.merchant.clientId);
      setSavedClientId(result.merchant.clientId);
      setSecret("");
      setVersion(result.merchant.version);
      setMessage("商户配置已保存。");
      savedNavigation.current = true;
      writes.update.reset();
    } catch (error) {
      if (!currentOperation()) return;
      if (error instanceof MerchantChangeConfirmationError) {
        submitted.current = null;
        setWarning({
          input: {
            ...input,
            confirmationToken: error.change.confirmationToken,
          },
          change: error.change,
        });
      }
      setMessage(error instanceof Error ? error.message : "保存失败，请重试。");
    }
  }
  async function save() {
    if (busy) return;
    setMessage(null);
    if (submitted.current) {
      await performSave(submitted.current);
      return;
    }
    const clientChanged = clientId.trim() !== savedClientId;
    if (clientChanged && !secret) {
      setMessage("修改 Client ID 时，请同时填写该应用对应的商户密钥。");
      return;
    }
    requestId.current ??= crypto.randomUUID();
    const checked = updateMerchantSchema.safeParse({
      requestId: requestId.current,
      version,
      label,
      ...(clientChanged ? { clientId } : {}),
      ...(secret ? { secret } : {}),
    });
    if (!checked.success) {
      setMessage(checked.error.issues.map((issue) => issue.message).join("；"));
      return;
    }
    try {
      if (secret || clientChanged) {
        const change = await writes.changeImpact.mutateAsync();
        if (!currentOperation()) return;
        const input = {
          ...checked.data,
          confirmationToken: change.confirmationToken,
        };
        if (hasMerchantChangeImpact(change.impact)) {
          setWarning({ input, change });
          return;
        }
        await performSave(input);
      } else {
        await performSave(checked.data);
      }
    } catch (error) {
      if (!currentOperation()) return;
      setMessage(error instanceof Error ? error.message : "保存失败，请重试。");
    }
  }
  async function check() {
    if (!merchant.capabilities.canCheck) return;
    try {
      const result = await writes.check.mutateAsync();
      setMessage(
        result.accepted === false
          ? `请等待 ${result.retryAfterSeconds ?? 30} 秒后再次检查恢复条件。`
          : "已请求检查恢复条件。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重新检查失败。");
    }
  }
  async function simulate() {
    if (merchant.mode !== "simulation" || !merchant.capabilities.canSimulate)
      return;
    try {
      await writes.simulate.mutateAsync(scenario);
      setMessage("模拟情形已设置。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "设置失败。");
    }
  }
  async function verify() {
    if (!merchant.capabilities.canVerify) return;
    try {
      await writes.verify.mutateAsync();
      setMessage("凭证检查已启动。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "凭证检查暂未完成。");
    }
  }
  async function reload() {
    if (
      (secret || label !== merchant.label || clientId !== savedClientId) &&
      !window.confirm("刷新将放弃未保存的商户修改，确定刷新吗？")
    )
      return;
    try {
      const latest = await refresh();
      if (!currentOperation()) return;
      submitted.current = null;
      requestId.current = null;
      setWarning(null);
      setLabel(latest.label);
      setClientId(latest.clientId);
      setSavedClientId(latest.clientId);
      setSecret("");
      setVersion(latest.version);
      if (latest.mode === "simulation") setScenario(latest.scenario);
      setMessage("已读取最新配置。");
      savedNavigation.current = false;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "刷新失败。");
    }
  }
  if (configurationOnly)
    return (
      <div className="work-page">
        <PageTitle title="商户配置" />
        {refreshNotice}
        <div className="work-merchant-layout">
          <form
            className="work-merchant-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="work-merchant-heading">
              <div>
                <h2>{merchant.label || "默认商户"}</h2>
              </div>
              <span className="work-status-label is-active">
                <i />
                {merchant.mode === "simulation"
                  ? "已配置 · 本地模拟"
                  : "已配置"}
              </span>
            </div>
            <div className="field">
              <div className="work-field-label">
                <label htmlFor="work-client-id">Client ID</label>
                <Help label="Client ID">
                  上游商户身份。修改时须同时填写对应密钥；商户记录 ID 不变。
                </Help>
              </div>
              <input
                id="work-client-id"
                value={clientId}
                disabled={busy || Boolean(warning)}
                onChange={(event) => {
                  editInput();
                  setClientId(event.target.value);
                }}
                autoComplete="off"
              />
            </div>
            <div className="field">
              <div className="work-field-label">
                <label htmlFor="work-merchant-secret">商户密钥</label>
                <Help label="商户密钥">
                  Client ID 未变时，留空保留现有密钥；修改 Client ID
                  时必须填写对应密钥。新凭证检查通过后才可发送付款。
                </Help>
              </div>
              <input
                id="work-merchant-secret"
                type="password"
                value={secret}
                disabled={busy || Boolean(warning)}
                onChange={(event) => {
                  editInput();
                  setSecret(event.target.value);
                }}
                placeholder="已保存；留空沿用现有密钥"
                autoComplete="new-password"
              />
            </div>
            {message && (
              <p className="work-form-error" role="status">
                {message}
              </p>
            )}
            <div className="work-merchant-actions">
              <button
                className="button"
                type="submit"
                disabled={busy || Boolean(warning)}
              >
                {busy ? "正在保存…" : "保存配置"}
                <Check size={17} />
              </button>
              <Link className="button ghost" to="/my/payments">
                查看付款记录 <ArrowRight size={16} />
              </Link>
            </div>
            {!merchant.publicationEligibility.allowed && (
              <p className="work-setting-notice" role="status">
                {publicationReason(merchant.publicationEligibility.reason)}
              </p>
            )}
            <Link
              className="work-text-link"
              to="/my/merchants/$id"
              params={{ id: merchant.id }}
            >
              凭证检查与异常恢复 <ArrowRight size={14} />
            </Link>
          </form>
        </div>
        {managementExtra}
        {warning && (
          <MerchantConfigChangeDialog
            impact={warning.change.impact}
            busy={writes.update.isPending}
            notice={message}
            confirm={() => void performSave(warning.input)}
            cancel={() => {
              submitted.current = null;
              setWarning(null);
            }}
          />
        )}
      </div>
    );
  return (
    <MerchantManagementView
      refreshNotice={refreshNotice}
      warning={warning}
      writesUpdatePending={writes.update.isPending}
      saveButtonLabel={
        writes.changeImpact.isPending
          ? "检查影响中…"
          : writes.update.isPending
            ? "保存中…"
            : "保存修改"
      }
      message={message}
      confirmWarning={() => {
        if (warning) void performSave(warning.input);
      }}
      cancelWarning={() => {
        submitted.current = null;
        setWarning(null);
      }}
      merchant={merchant}
      busy={busy}
      check={() => void check()}
      verify={() => void verify()}
      label={label}
      setLabel={(value) => {
        editInput();
        setLabel(value);
      }}
      clientId={clientId}
      setClientId={(value) => {
        editInput();
        setClientId(value);
      }}
      secret={secret}
      setSecret={(value) => {
        editInput();
        setSecret(value);
      }}
      save={() => void save()}
      reload={() => void reload()}
      scenario={scenario}
      setScenario={setScenario}
      simulate={() => void simulate()}
      userId={userId}
    />
  );
}

function MerchantManagementView({
  refreshNotice,
  warning,
  writesUpdatePending,
  saveButtonLabel,
  message,
  confirmWarning,
  cancelWarning,
  merchant,
  busy,
  check,
  verify,
  label,
  setLabel,
  clientId,
  setClientId,
  secret,
  setSecret,
  save,
  reload,
  scenario,
  setScenario,
  simulate,
  userId,
}: {
  refreshNotice?: ReactNode;
  warning: { input: UpdateMerchantInput; change: MerchantChangePreview } | null;
  writesUpdatePending: boolean;
  saveButtonLabel: string;
  message: string | null;
  confirmWarning: () => void;
  cancelWarning: () => void;
  merchant: Merchant;
  busy: boolean;
  check: () => void;
  verify: () => void;
  label: string;
  setLabel: (value: string) => void;
  clientId: string;
  setClientId: (value: string) => void;
  secret: string;
  setSecret: (value: string) => void;
  save: () => void;
  reload: () => void;
  scenario: SimulationScenario;
  setScenario: (value: SimulationScenario) => void;
  simulate: () => void;
  userId: string;
}) {
  const router = useRouter();
  return (
    <div className="space-y-5">
      {refreshNotice}
      {warning ? (
        <MerchantConfigChangeDialog
          impact={warning.change.impact}
          busy={writesUpdatePending}
          notice={message}
          confirm={confirmWarning}
          cancel={cancelWarning}
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">管理商户</h1>
        <button
          type="button"
          className="text-sm underline underline-offset-4"
          onClick={() => router.history.back()}
        >
          返回上一页
        </button>
      </div>
      {merchant.mode === "simulation" ? <SimulationNotice /> : null}
      <section className="activity-panel space-y-4">
        <h2 className="text-lg font-semibold">{merchant.label}</h2>
        <p className="text-sm">
          {merchant.usageStatus === "current"
            ? "当前商户"
            : "历史商户：保留既有活动和付款，不能用于新活动开放。"}
        </p>
        {merchant.usageStatus === "current" ? (
          <p className="text-sm text-muted">
            {merchant.publicationEligibility.allowed
              ? "当前商户可用于开放新的 LDC 活动。"
              : publicationReason(merchant.publicationEligibility.reason)}
          </p>
        ) : null}
        <p className="break-all text-sm">client_id：{merchant.clientId}</p>
        <p className="text-sm text-muted">
          凭证版本：{merchant.credentialVersion} ·{" "}
          {merchant.mode === "real"
            ? "真实模式"
            : merchant.pausedReason
              ? paymentReason(merchant.pausedReason)
              : "可用"}
        </p>
        {merchant.mode === "real" && merchant.pausedReason ? (
          <p className="text-sm text-warning">
            商户暂停原因：{paymentReason(merchant.pausedReason)}
          </p>
        ) : null}
        <PaymentCheckButton
          merchant={merchant}
          busy={busy}
          label="立即检查恢复条件"
          check={() => void check()}
        />
      </section>
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
          className="rounded-md border border-separator bg-surface p-3 text-sm"
        >
          {message}
        </p>
      ) : null}
      <form
        className="activity-panel space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className="font-semibold">维护配置</h2>
        <label className="activity-label" htmlFor="merchant-edit-label">
          商户名称
          <input
            id="merchant-edit-label"
            className="activity-input"
            value={label}
            disabled={busy || Boolean(warning)}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label className="activity-label" htmlFor="merchant-edit-client-id">
          Client ID
          <input
            id="merchant-edit-client-id"
            className="activity-input"
            value={clientId}
            autoComplete="off"
            spellCheck={false}
            disabled={busy || Boolean(warning)}
            onChange={(event) => setClientId(event.target.value)}
          />
        </label>
        <label className="activity-label" htmlFor="merchant-edit-secret">
          {merchant.mode === "simulation" ? "更换模拟密钥" : "更换商户密钥"}
          <input
            id="merchant-edit-secret"
            className="activity-input"
            type="password"
            autoComplete="new-password"
            value={secret}
            disabled={busy || Boolean(warning)}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={
              merchant.mode === "simulation"
                ? "留空保留现有密钥，请勿填写真实密钥"
                : "留空保留现有密钥"
            }
          />
        </label>
        <p className="text-xs text-subtle">
          现有密钥不会返回浏览器。修改 Client ID
          必须填写对应密钥，付款模式保存后不可修改。
          更换凭证后会自动检查，已有订单继续按安全条件核对。
        </p>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy || Boolean(warning)}>
            {saveButtonLabel}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={reload}
          >
            刷新配置
          </Button>
        </div>
      </form>
      {merchant.mode === "simulation" && merchant.capabilities.canSimulate ? (
        <section className="activity-panel space-y-4">
          <h2 className="font-semibold">模拟故障</h2>
          <label className="activity-label" htmlFor="merchant-scenario">
            付款情形
            <select
              id="merchant-scenario"
              className="activity-input"
              value={scenario}
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
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={simulate}
          >
            应用模拟情形
          </Button>
        </section>
      ) : null}
      <MerchantPayments key={merchant.id} id={merchant.id} userId={userId} />
    </div>
  );
}

function MerchantPayments({ id, userId }: { id: string; userId: string }) {
  const [cursors, setCursors] = useViewState<Array<string | null>>(
    "merchant-payments-cursors",
    [null],
    id,
  );
  const setPaymentCursors = useCallback(
    (value: SetStateAction<Array<string | null>>) => {
      setCursors((current) =>
        typeof value === "function" ? value(current) : value,
      );
    },
    [setCursors],
  );
  const query = useMerchantPayments(userId, id, cursors.at(-1) ?? null);
  const cursorRecovery = useCursorRecovery(
    query.error,
    cursors,
    setPaymentCursors,
  );
  return (
    <section className="activity-panel space-y-4">
      <h2 className="text-lg font-semibold">付款任务</h2>
      {cursorRecovery}
      {query.isPending ? (
        <div aria-busy="true">
          <p role="status" className="text-sm text-subtle">
            正在读取付款任务…
          </p>
          <SkeletonRows />
        </div>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          {query.data.items.length ? (
            <ul className="divide-y divide-separator">
              {query.data.items.map((payment) => (
                <li key={payment.id} className="space-y-2 py-4 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>{payment.amount} LDC</strong>
                    <span>{paymentLabel(payment.mode, payment.status)}</span>
                  </div>
                  <p className="break-all text-subtle">
                    来源：
                    {payment.source === "acceptance" ? "接入验收" : "活动领取"}
                  </p>
                  <p className="break-all text-subtle">
                    业务号：{payment.businessNo}
                  </p>
                  <p className="text-subtle">
                    创建：{formatTime(payment.createdAt)}
                  </p>
                  {payment.reason ? (
                    <p>{paymentReason(payment.reason)}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-4">
                    <Link
                      to="/my/merchants/$id/payments/$taskId"
                      params={{ id, taskId: payment.id }}
                      className="inline-block underline underline-offset-4"
                    >
                      查看付款详情
                    </Link>
                    {payment.source === "claim" ? (
                      <Link
                        to="/activities/$id"
                        params={{ id: payment.activityId }}
                        className="inline-block underline underline-offset-4"
                      >
                        查看活动
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-subtle">暂无付款任务。</p>
          )}
          {query.data.nextCursor || cursors.length > 1 ? (
            <ListPagination
              cursors={cursors}
              setCursors={setPaymentCursors}
              nextCursor={query.data.nextCursor}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
