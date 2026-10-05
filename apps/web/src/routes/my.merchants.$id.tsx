import {
  type Merchant,
  paymentLabel,
  type SimulationScenario,
  updateMerchantSchema,
} from "@hb/contracts";
import {
  createFileRoute,
  Link,
  Outlet,
  useMatchRoute,
} from "@tanstack/react-router";
import { useState } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ListPagination } from "../components/activities/list-pagination";
import { RealPaymentNotice } from "../components/activities/real-payment-notice";
import { RequireAccount } from "../components/activities/require-account";
import { SimulationNotice } from "../components/activities/simulation-notice";
import { CredentialVerificationPanel } from "../components/merchants/credential-verification";
import { PaymentCheckButton } from "../components/merchants/payment-check-button";
import { Button } from "../components/ui/button";
import { formatTime } from "../lib/activities";
import {
  useMerchant,
  useMerchantPayments,
  useMerchantWrites,
} from "../lib/merchants";
import { paymentReason, publicationReason } from "../lib/payment-display";

export const Route = createFileRoute("/my/merchants/$id")({
  component: MerchantPage,
});

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

function MerchantPage() {
  const { id } = Route.useParams();
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/my/merchants/$id/payments/$taskId", fuzzy: true }))
    return <Outlet />;
  return (
    <RequireAccount>
      {({ userId, csrfToken }) => (
        <LoadMerchant
          key={`${userId}-${id}`}
          id={id}
          userId={userId}
          csrfToken={csrfToken}
        />
      )}
    </RequireAccount>
  );
}

function LoadMerchant({
  id,
  userId,
  csrfToken,
}: {
  id: string;
  userId: string;
  csrfToken: string;
}) {
  const query = useMerchant(userId, id);
  if (query.isPending) return <p role="status">正在读取商户…</p>;
  if (query.isError)
    return (
      <ActivityErrorView
        error={query.error}
        retry={() => query.refetch()}
        notFoundMessage="未找到商户，或你无权查看。"
      />
    );
  return (
    <MerchantDetails
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
  merchant,
  userId,
  csrfToken,
  refresh,
}: {
  merchant: Merchant;
  userId: string;
  csrfToken: string;
  refresh: () => Promise<Merchant>;
}) {
  const [label, setLabel] = useState(merchant.label);
  const [secret, setSecret] = useState("");
  const [version, setVersion] = useState(merchant.version);
  const [scenario, setScenario] = useState<SimulationScenario>(
    merchant.mode === "simulation" ? merchant.scenario : "normal",
  );
  const [message, setMessage] = useState<string | null>(null);
  const writes = useMerchantWrites(userId, csrfToken, merchant.id);
  const busy =
    writes.update.isPending ||
    writes.check.isPending ||
    writes.verify.isPending ||
    writes.simulate.isPending;
  async function save() {
    const checked = updateMerchantSchema.safeParse({
      version,
      label,
      ...(secret ? { secret } : {}),
    });
    if (!checked.success) {
      setMessage(checked.error.issues.map((issue) => issue.message).join("；"));
      return;
    }
    try {
      const result = await writes.update.mutateAsync(checked.data);
      setSecret("");
      setVersion(result.merchant.version);
      setMessage("商户配置已保存。");
    } catch (error) {
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
      (secret || label !== merchant.label) &&
      !window.confirm("刷新将放弃未保存的商户修改，确定刷新吗？")
    )
      return;
    try {
      const latest = await refresh();
      setLabel(latest.label);
      setSecret("");
      setVersion(latest.version);
      if (latest.mode === "simulation") setScenario(latest.scenario);
      setMessage("已读取最新配置。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "刷新失败。");
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">管理商户</h1>
        <Link
          to="/my/merchants"
          className="text-sm underline underline-offset-4"
        >
          我的商户
        </Link>
      </div>
      {merchant.mode === "simulation" ? (
        <SimulationNotice />
      ) : (
        <RealPaymentNotice />
      )}
      <section className="activity-panel space-y-4">
        <h2 className="text-lg font-semibold">{merchant.label}</h2>
        <p className="text-sm">
          {merchant.usageStatus === "current"
            ? "当前商户"
            : "历史商户：保留既有活动和付款，不能用于新活动开放。"}
        </p>
        {merchant.usageStatus === "current" ? (
          <p className="text-sm text-neutral-600">
            {merchant.publicationEligibility.allowed
              ? "当前商户可用于开放新的 LDC 活动。"
              : publicationReason(merchant.publicationEligibility.reason)}
          </p>
        ) : null}
        <p className="break-all text-sm">client_id：{merchant.clientId}</p>
        <p className="text-sm text-neutral-600">
          凭证版本：{merchant.credentialVersion} ·{" "}
          {merchant.mode === "real"
            ? "真实模式"
            : merchant.pausedReason
              ? paymentReason(merchant.pausedReason)
              : "可用"}
        </p>
        {merchant.mode === "real" && merchant.pausedReason ? (
          <p className="text-sm text-amber-800">
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
          className="rounded-md border border-neutral-200 bg-white p-3 text-sm"
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
            onChange={(event) => setLabel(event.target.value)}
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
            onChange={(event) => setSecret(event.target.value)}
            placeholder={
              merchant.mode === "simulation"
                ? "留空保留现有密钥，请勿填写真实密钥"
                : "留空保留现有密钥"
            }
          />
        </label>
        <p className="text-xs text-neutral-500">
          现有密钥不会返回浏览器。付款模式与 client_id
          固定，更新密钥不会更换付款主体。
        </p>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy}>
            保存修改
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void reload()}
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
            onClick={() => void simulate()}
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
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const query = useMerchantPayments(userId, id, cursors.at(-1) ?? null);
  return (
    <section className="activity-panel space-y-4">
      <h2 className="text-lg font-semibold">付款任务</h2>
      {query.isPending ? (
        <p role="status">正在读取付款任务…</p>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          {query.data.items.length ? (
            <ul className="divide-y divide-neutral-200">
              {query.data.items.map((payment) => (
                <li key={payment.id} className="space-y-2 py-4 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>{payment.amount} LDC</strong>
                    <span>{paymentLabel(payment.mode, payment.status)}</span>
                  </div>
                  <p className="break-all text-neutral-500">
                    来源：
                    {payment.source === "acceptance" ? "接入验收" : "活动领取"}
                  </p>
                  <p className="break-all text-neutral-500">
                    业务号：{payment.businessNo}
                  </p>
                  <p className="text-neutral-500">
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
                        to="/my/activities/$id"
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
            <p className="text-sm text-neutral-500">暂无付款任务。</p>
          )}
          {query.data.nextCursor || cursors.length > 1 ? (
            <ListPagination
              cursors={cursors}
              setCursors={setCursors}
              nextCursor={query.data.nextCursor}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
