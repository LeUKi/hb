import {
  type CreateMerchantInput,
  createMerchantSchema,
  type PaymentMode,
} from "@hb/contracts";
import {
  createFileRoute,
  Link,
  Outlet,
  useBlocker,
  useMatchRoute,
} from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ListPagination } from "../components/activities/list-pagination";
import { RequireAccount } from "../components/activities/require-account";
import { LoadMerchant } from "../components/merchants/load-merchant";
import { Help } from "../components/presentation/context-help";
import { SkeletonRows } from "../components/presentation/loading";
import { ActivityRequestError } from "../lib/activities";
import { useMerchants, useMerchantWrites } from "../lib/merchants";
import {
  useCursorRecovery,
  useEntryNavigate,
  useViewState,
} from "../lib/navigation-state";
import { PageTitle } from "../prototype-ui/workbench-ui";

export const Route = createFileRoute("/my/merchants")({
  component: MerchantsPage,
});

function MerchantsPage() {
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/my/merchants/$id", fuzzy: true })) return <Outlet />;
  return (
    <RequireAccount requireLdc>
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
  const [cursors, setCursors] = useViewState<Array<string | null>>(
    "merchant-create-history-cursors",
    [null],
  );
  const [label] = useState("默认商户");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [mode, setMode] = useState<PaymentMode | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<CreateMerchantInput | null>(null);
  const savedNavigation = useRef(false);
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
  const navigate = useEntryNavigate();
  const dirty =
    Boolean(clientId) || Boolean(secret) || mode !== null || Boolean(pending);
  useBlocker({
    shouldBlockFn: () =>
      !savedNavigation.current &&
      dirty &&
      !window.confirm("还有未保存的商户配置，确定离开吗？"),
    enableBeforeUnload: () => dirty && !savedNavigation.current,
  });
  const setHistoryCursors = useCallback(
    (value: SetStateAction<Array<string | null>>) => {
      setCursors((current) =>
        typeof value === "function" ? value(current) : value,
      );
    },
    [setCursors],
  );
  const cursorRecovery = useCursorRecovery(
    query.error,
    cursors,
    setHistoryCursors,
  );
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
      await writes.create.mutateAsync(checked.data);
      if (!alive.current) return;
      setSecret("");
      setPending(null);
      setClientId("");
      setMode(null);
      savedNavigation.current = true;
      void navigate({ to: "/my/merchants" });
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
  const history = query.data?.items.some(
    (item) => item.usageStatus !== "current",
  ) && (
    <details className="work-more-settings">
      <summary>历史商户与恢复</summary>
      <div className="work-more-content">
        {cursorRecovery}
        {query.data.items
          .filter((item) => item.usageStatus !== "current")
          .map((item) => (
            <p key={item.id}>
              <Link
                className="work-text-link"
                to="/my/merchants/$id"
                params={{ id: item.id }}
              >
                {item.label} · 管理商户
              </Link>
            </p>
          ))}
        <ListPagination
          cursors={cursors}
          setCursors={setHistoryCursors}
          nextCursor={query.data.nextCursor}
        />
      </div>
    </details>
  );
  const currentId = query.data?.currentMerchantId;
  if (currentId && !pending)
    return (
      <LoadMerchant
        key={currentId}
        id={currentId}
        userId={userId}
        csrfToken={csrfToken}
        configurationOnly
        managementExtra={history}
      />
    );
  return (
    <div className="work-page">
      <PageTitle title="商户配置" />
      {query.isPending ? (
        <section className="activity-panel space-y-4" aria-busy="true">
          <p role="status" className="text-sm text-subtle">
            正在读取商户…
          </p>
          <SkeletonRows />
        </section>
      ) : query.isError ? (
        <>
          {cursorRecovery}
          <ActivityErrorView
            error={query.error}
            retry={() => query.refetch()}
          />
        </>
      ) : null}
      {query.isSuccess && (query.data.canCreate || pending) && (
        <div className="work-merchant-layout">
          <form
            className="work-merchant-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="work-merchant-heading">
              <div>
                <h2>默认商户</h2>
              </div>
              <span className="work-status-label">
                <i />
                未配置
              </span>
            </div>
            {canSimulate && (
              <div className="field">
                <div className="work-field-label">
                  <label htmlFor="merchant-mode">
                    付款模式（保存后不可修改）
                  </label>
                </div>
                <select
                  id="merchant-mode"
                  value={selectedMode}
                  disabled={writes.create.isPending || Boolean(pending)}
                  onChange={(event) => {
                    savedNavigation.current = false;
                    setMode(
                      event.target.value === "real" ? "real" : "simulation",
                    );
                    setSecret("");
                  }}
                >
                  <option value="simulation">本地模拟</option>
                  <option value="real">真实 LDC</option>
                </select>
              </div>
            )}
            <div className="field">
              <div className="work-field-label">
                <label htmlFor="merchant-client">Client ID</label>
                <Help label="Client ID">
                  上游商户身份。修改时须同时填写对应密钥；商户记录 ID 不变。
                </Help>
              </div>
              <input
                id="merchant-client"
                value={clientId}
                disabled={writes.create.isPending || Boolean(pending)}
                onChange={(event) => {
                  savedNavigation.current = false;
                  setClientId(event.target.value);
                }}
                autoComplete="off"
              />
            </div>
            <div className="field">
              <div className="work-field-label">
                <label htmlFor="merchant-secret">商户密钥</label>
                <Help label="商户密钥">
                  密钥加密保存，不会回显。新凭证检查通过后才可发送付款。
                </Help>
              </div>
              <input
                id="merchant-secret"
                type="password"
                value={secret}
                disabled={writes.create.isPending || Boolean(pending)}
                onChange={(event) => {
                  savedNavigation.current = false;
                  setSecret(event.target.value);
                }}
                autoComplete="new-password"
              />
            </div>
            {message && (
              <p className="work-form-error" role="alert">
                {message}
              </p>
            )}
            <div className="work-merchant-actions">
              <button
                className="button"
                type="submit"
                disabled={writes.create.isPending}
              >
                {writes.create.isPending
                  ? "正在保存…"
                  : pending
                    ? "重试原提交"
                    : "保存配置"}
                <Check size={17} />
              </button>
              <Link className="button ghost" to="/my/payments">
                查看付款记录 <ArrowRight size={16} />
              </Link>
            </div>
          </form>
        </div>
      )}
      {history}
    </div>
  );
}
