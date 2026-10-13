import {
  type CreateMerchantInput,
  createMerchantSchema,
  type PaymentMode,
} from "@hb/contracts";
import {
  createFileRoute,
  Outlet,
  useBlocker,
  useMatchRoute,
  useRouter,
} from "@tanstack/react-router";
import { Check } from "lucide-react";
import {
  type MouseEvent,
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
import { MerchantPaymentDialog } from "../components/merchants/merchant-payment-dialog";
import { Help } from "../components/presentation/context-help";
import { SkeletonRows } from "../components/presentation/loading";
import {
  ActionButton,
  useActionFeedback,
} from "../components/ui/action-feedback";
import { ActivityRequestError } from "../lib/activities";
import {
  isMerchantResourceId,
  merchantSearch,
} from "../lib/merchant-navigation";
import {
  useMerchants,
  useMerchantViewScope,
  useMerchantWrites,
} from "../lib/merchants";
import {
  useCursorRecovery,
  useEntryNavigate,
  useViewState,
} from "../lib/navigation-state";
import { isBlockingQueryError } from "../lib/query-view";
import { PageTitle } from "../prototype-ui/workbench-ui";

export const Route = createFileRoute("/my/merchants")({
  validateSearch: merchantSearch,
  component: MerchantsPage,
});

function MerchantsPage() {
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/my/merchants/$id", fuzzy: true })) return <Outlet />;
  return (
    <RequireAccount requireLdc>
      {({ userId, csrfToken }) => (
        <Merchants
          key={`${userId}:${csrfToken}`}
          userId={userId}
          csrfToken={csrfToken}
        />
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
  const search = Route.useSearch();
  const router = useRouter();
  const navigate = useEntryNavigate();
  const scope = useMerchantViewScope(userId);
  const [cursors, setCursors] = useViewState<Array<string | null>>(
    "merchant-create-history-cursors",
    [null],
    scope,
  );
  const setHistoryCursors = useCallback(
    (value: SetStateAction<Array<string | null>>) => {
      setCursors((current) =>
        typeof value === "function" ? value(current) : value,
      );
    },
    [setCursors],
  );
  const query = useMerchants(userId, cursors.at(-1) ?? null);
  const cursorRecovery = useCursorRecovery(
    query.error,
    cursors,
    setHistoryCursors,
  );
  const selectedId = search.merchantId ?? query.data?.currentMerchantId ?? null;
  const trigger = useRef<HTMLElement | null>(null);
  function selectMerchant(id: string) {
    void navigate({
      to: "/my/merchants",
      search: { merchantId: id },
      resetScroll: false,
    });
  }
  function openPayments(event: MouseEvent<HTMLAnchorElement>) {
    if (
      !selectedId ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    trigger.current = event.currentTarget;
    const base = router.state.location.state.__TSR_index;
    void navigate({
      to: "/my/merchants",
      search: { merchantId: selectedId, dialog: "payments" },
      resetScroll: false,
      state: {
        hbMerchantDialog: { merchantId: selectedId, base, listIndex: null },
      },
    });
  }
  function openPayment(taskId: string) {
    if (!selectedId) return;
    const location = router.state.location;
    const marker = location.state.hbMerchantDialog;
    void navigate({
      to: "/my/merchants",
      search: { merchantId: selectedId, dialog: "payment", taskId },
      resetScroll: false,
      state: {
        hbMerchantDialog: {
          merchantId: selectedId,
          base: marker?.merchantId === selectedId ? marker.base : null,
          listIndex: location.state.__TSR_index,
        },
      },
    });
  }
  function closeDialog() {
    const location = router.state.location;
    const marker = location.state.hbMerchantDialog;
    if (
      marker?.merchantId === selectedId &&
      marker.base !== null &&
      marker.base < location.state.__TSR_index
    ) {
      router.history.go(marker.base - location.state.__TSR_index);
    } else
      void navigate({
        to: "/my/merchants",
        search: selectedId !== null ? { merchantId: selectedId } : {},
        replace: true,
        resetScroll: false,
      });
  }
  function backToList() {
    const location = router.state.location;
    const marker = location.state.hbMerchantDialog;
    if (
      marker?.merchantId === selectedId &&
      marker.listIndex === location.state.__TSR_index - 1
    )
      router.history.back();
    else if (selectedId !== null)
      void navigate({
        to: "/my/merchants",
        search: { merchantId: selectedId, dialog: "payments" },
        replace: true,
        resetScroll: false,
      });
  }
  const selection =
    query.data &&
    (query.data.items.length > 1 ||
      cursors.length > 1 ||
      query.data.nextCursor) ? (
      <section className="merchant-selection" aria-label="选择商户">
        <label htmlFor="merchant-selection">商户</label>
        <select
          id="merchant-selection"
          value={selectedId ?? ""}
          onChange={(event) => selectMerchant(event.target.value)}
        >
          {selectedId &&
          !query.data.items.some((item) => item.id === selectedId) ? (
            <option value={selectedId}>当前选择的商户</option>
          ) : null}
          {query.data.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
              {item.usageStatus === "legacy" ? "（历史）" : ""}
            </option>
          ))}
        </select>
        {cursorRecovery}
        {query.data.nextCursor || cursors.length > 1 ? (
          <ListPagination
            cursors={cursors}
            setCursors={setHistoryCursors}
            nextCursor={query.data.nextCursor}
            busy={query.isFetching}
          />
        ) : null}
      </section>
    ) : null;
  return (
    <>
      {selectedId !== null && !isMerchantResourceId(selectedId) ? (
        <div className="work-page">
          <PageTitle title="商户配置" />
          <p role="alert">未找到商户，或你无权查看。</p>
        </div>
      ) : selectedId ? (
        <LoadMerchant
          key={selectedId}
          id={selectedId}
          userId={userId}
          csrfToken={csrfToken}
          selection={selection}
          onOpenPayments={openPayments}
        />
      ) : isBlockingQueryError(query) ? (
        <div className="work-page">
          <PageTitle title="商户配置" />
          {cursorRecovery}
          <ActivityErrorView
            error={query.error ?? new Error("读取失败")}
            retry={() => query.refetch()}
            notFoundMessage="未找到商户，或你无权查看。"
          />
        </div>
      ) : !query.data ? (
        <div className="work-page">
          <PageTitle title="商户配置" />
          <section className="activity-panel" aria-busy="true">
            <p role="status">正在读取商户…</p>
            <SkeletonRows />
          </section>
        </div>
      ) : (
        <CreateMerchant
          userId={userId}
          csrfToken={csrfToken}
          canCreate={query.data.canCreate}
          canSimulate={query.data.canSimulate}
          onCreated={(id) => selectMerchant(id)}
        />
      )}
      {selectedId !== null && search.dialog ? (
        <MerchantPaymentDialog
          merchantId={selectedId}
          taskId={search.dialog === "payment" ? search.taskId : null}
          userId={userId}
          csrfToken={csrfToken}
          onClose={closeDialog}
          onBack={search.dialog === "payment" ? backToList : undefined}
          onSelectPayment={openPayment}
          restoreFocus={trigger.current}
        />
      ) : null}
    </>
  );
}

function CreateMerchant({
  userId,
  csrfToken,
  canCreate,
  canSimulate,
  onCreated,
}: {
  userId: string;
  csrfToken: string;
  canCreate: boolean;
  canSimulate: boolean;
  onCreated: (id: string) => void;
}) {
  const [label, setLabel] = useState("默认商户");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [mode, setMode] = useState<PaymentMode>(
    canSimulate ? "simulation" : "real",
  );
  const createFeedback = useActionFeedback(`merchant-create:${userId}`);
  const [pending, setPending] = useState<CreateMerchantInput | null>(null);
  const leavingAfterSave = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const writes = useMerchantWrites(userId, csrfToken);
  const dirty = label !== "默认商户" || Boolean(clientId || secret || pending);
  const valid = createMerchantSchema.safeParse({
    requestId: crypto.randomUUID(),
    label,
    clientId,
    secret,
    mode,
  }).success;
  const locked = writes.create.isPending || Boolean(pending);
  useBlocker({
    shouldBlockFn: () =>
      !leavingAfterSave.current &&
      dirty &&
      !window.confirm("还有未保存的商户配置，确定离开吗？"),
    enableBeforeUnload: () => dirty && !leavingAfterSave.current,
  });
  async function create() {
    if (writes.create.isPending || (!pending && (!canCreate || !valid))) return;
    const checked = createMerchantSchema.safeParse(
      pending ?? {
        requestId: crypto.randomUUID(),
        label,
        clientId,
        secret,
        mode,
      },
    );
    if (!checked.success) return;
    setPending(checked.data);
    createFeedback.clear();
    try {
      const result = await writes.create.mutateAsync(checked.data);
      if (!alive.current || !writes.isCurrentSession()) return;
      setSecret("");
      setPending(null);
      leavingAfterSave.current = true;
      onCreated(result.merchant.id);
    } catch (error) {
      if (!alive.current || !writes.isCurrentSession()) return;
      if (!(error instanceof ActivityRequestError) || error.status >= 500)
        createFeedback.show("重试原提交", "尚未确认保存结果，请重试原提交。");
      else {
        setPending(null);
        createFeedback.show("保存失败", error.message);
      }
    }
  }
  return (
    <div className="work-page">
      <PageTitle title="商户配置" />
      {canCreate || pending ? (
        <div className="work-merchant-layout">
          <form
            className="work-merchant-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="field">
              <label htmlFor="merchant-create-label">商户名称</label>
              <input
                id="merchant-create-label"
                value={label}
                disabled={locked}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            {canSimulate ? (
              <div className="field">
                <label htmlFor="merchant-mode">
                  付款模式（保存后不可修改）
                </label>
                <select
                  id="merchant-mode"
                  value={mode}
                  disabled={locked}
                  onChange={(event) => {
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
            ) : null}
            <div className="field">
              <label htmlFor="merchant-client">Client ID</label>
              <input
                id="merchant-client"
                value={clientId}
                autoComplete="off"
                disabled={locked}
                onChange={(event) => setClientId(event.target.value)}
              />
            </div>
            <div className="field">
              <div className="work-field-label">
                <label htmlFor="merchant-secret">商户密钥</label>
                <Help label="商户密钥">
                  密钥加密保存，不会回显。保存后自动检查。
                </Help>
              </div>
              <input
                id="merchant-secret"
                type="password"
                value={secret}
                disabled={locked}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="work-merchant-actions">
              <ActionButton
                className="button"
                type="submit"
                label={
                  writes.create.isPending
                    ? "正在保存…"
                    : pending
                      ? "重试原提交"
                      : "保存配置"
                }
                feedback={createFeedback.feedback}
                reserve={["正在保存…", "重试原提交", "保存配置", "保存失败"]}
                icon={<Check size={17} />}
                disabled={writes.create.isPending || (!pending && !valid)}
              />
            </div>
          </form>
        </div>
      ) : (
        <p role="status">暂无可配置的商户。</p>
      )}
    </div>
  );
}
