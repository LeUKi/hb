import {
  type CreateMerchantInput,
  createMerchantSchema,
  type PaymentMode,
} from "@hb/contracts";
import {
  createFileRoute,
  Link,
  Outlet,
  useMatchRoute,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ListPagination } from "../components/activities/list-pagination";
import { RealPaymentNotice } from "../components/activities/real-payment-notice";
import { RequireAccount } from "../components/activities/require-account";
import { SimulationNotice } from "../components/activities/simulation-notice";
import { Button } from "../components/ui/button";
import { ActivityRequestError } from "../lib/activities";
import { useMerchants, useMerchantWrites } from "../lib/merchants";
import { publicationReason, verificationLabels } from "../lib/payment-display";

export const Route = createFileRoute("/my/merchants")({
  component: MerchantsPage,
});

function MerchantsPage() {
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/my/merchants/$id", fuzzy: true })) return <Outlet />;
  return (
    <RequireAccount>
      {({ userId, csrfToken }) => (
        <Merchants key={userId} userId={userId} csrfToken={csrfToken} />
      )}
    </RequireAccount>
  );
}

function Merchants({
  userId,
  csrfToken,
}: {
  userId: string;
  csrfToken: string;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [label, setLabel] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [mode, setMode] = useState<PaymentMode | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<CreateMerchantInput | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const query = useMerchants(userId, cursors.at(-1) ?? null);
  const canSimulate = query.data?.canSimulate === true;
  const selectedMode = canSimulate ? (mode ?? "simulation") : "real";
  const writes = useMerchantWrites(userId, csrfToken);
  const navigate = useNavigate();
  async function create() {
    if (writes.create.isPending || (!pending && !query.data?.canCreate)) return;
    const input = pending ?? {
      requestId: crypto.randomUUID(),
      label,
      clientId,
      secret,
      mode: selectedMode,
    };
    const checked = createMerchantSchema.safeParse(input);
    if (!checked.success) {
      setMessage(checked.error.issues.map((issue) => issue.message).join("；"));
      return;
    }
    setMessage(null);
    try {
      const result = await writes.create.mutateAsync(checked.data);
      if (!alive.current) return;
      setSecret("");
      setPending(null);
      void navigate({
        to: "/my/merchants/$id",
        params: { id: result.merchant.id },
      });
    } catch (error) {
      if (!alive.current) return;
      if (!(error instanceof ActivityRequestError) || error.status >= 500) {
        setPending(checked.data);
        setMessage("尚未确认保存结果，请重试原提交。");
      } else {
        setPending(null);
        setMessage(error.message);
      }
    }
  }
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">我的商户</h1>
      {query.isPending ? (
        <p role="status">正在读取商户…</p>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {query.data.items.map((merchant) => (
              <article key={merchant.id} className="activity-panel space-y-3">
                <h2 className="font-semibold">{merchant.label}</h2>
                <p className="text-sm">
                  {merchant.usageStatus === "current" ? "当前商户" : "历史商户"}
                </p>
                <p className="break-all text-sm text-neutral-600">
                  client_id：{merchant.clientId}
                </p>
                {merchant.usageStatus === "current" &&
                !merchant.publicationEligibility.allowed ? (
                  <p className="text-sm text-amber-800">
                    {publicationReason(merchant.publicationEligibility.reason)}
                  </p>
                ) : null}
                <p className="text-sm text-neutral-600">
                  {merchant.mode === "real"
                    ? `真实模式 · ${verificationLabels[merchant.credentialVerification.status]}`
                    : `${merchant.pausedReason ? "等待恢复" : "可用"} · 本地模拟`}
                </p>
                <Button asChild variant="secondary">
                  <Link to="/my/merchants/$id" params={{ id: merchant.id }}>
                    管理商户
                  </Link>
                </Button>
              </article>
            ))}
          </div>
          {query.data.items.length === 0 ? (
            <p className="text-sm text-neutral-600">还没有商户配置。</p>
          ) : null}
          {query.data.nextCursor || cursors.length > 1 ? (
            <ListPagination
              cursors={cursors}
              setCursors={setCursors}
              nextCursor={query.data.nextCursor}
            />
          ) : null}
        </>
      )}
      {query.isSuccess && (query.data.canCreate || pending) ? (
        <form
          className="activity-panel space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <h2 className="text-lg font-semibold">添加当前商户</h2>
          {selectedMode === "simulation" ? (
            <SimulationNotice />
          ) : (
            <>
              <RealPaymentNotice draft />
              <p className="text-sm text-neutral-600">
                保存配置不代表凭证有效或商户归属已验证。保存后自动检查当前凭证。
              </p>
            </>
          )}
          <fieldset
            className="space-y-4"
            disabled={writes.create.isPending || Boolean(pending)}
          >
            <label className="activity-label" htmlFor="merchant-mode">
              付款模式（保存后不可修改）
              <select
                id="merchant-mode"
                className="activity-input"
                value={selectedMode}
                onChange={(event) => {
                  setMode(
                    event.target.value === "real" ? "real" : "simulation",
                  );
                  setSecret("");
                }}
              >
                {canSimulate ? (
                  <option value="simulation">本地模拟</option>
                ) : null}
                <option value="real">真实 LDC</option>
              </select>
            </label>
            <label className="activity-label" htmlFor="merchant-label">
              商户名称
              <input
                id="merchant-label"
                className="activity-input"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label className="activity-label" htmlFor="merchant-client">
              Client ID
              <input
                id="merchant-client"
                className="activity-input"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder={
                  selectedMode === "simulation"
                    ? "例如 mock_merchant_1"
                    : "LDC 商户应用 client_id"
                }
              />
            </label>
            <label className="activity-label" htmlFor="merchant-secret">
              {selectedMode === "simulation" ? "模拟密钥" : "商户密钥"}
              <input
                id="merchant-secret"
                className="activity-input"
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={
                  selectedMode === "simulation"
                    ? "请填写虚拟值，不要使用真实密钥"
                    : "加密保存，不会回显"
                }
              />
            </label>
          </fieldset>
          {message ? (
            <p role="alert" className="text-sm text-amber-800">
              {message}
            </p>
          ) : null}
          <Button type="submit" disabled={writes.create.isPending}>
            {writes.create.isPending
              ? "正在保存…"
              : pending
                ? "重试原提交"
                : "保存商户"}
          </Button>
        </form>
      ) : query.isSuccess ? (
        <p className="text-sm text-neutral-600">
          每个账号只有一个当前商户，请在管理页维护当前凭证。历史商户保留原付款记录。
        </p>
      ) : null}
    </div>
  );
}
