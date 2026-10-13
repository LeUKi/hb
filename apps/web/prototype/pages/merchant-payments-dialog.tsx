import { ArrowLeft, RefreshCw, X } from "lucide-react";
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Pagination, StatusBadge } from "../components/list-controls";
import {
  allowPrototypeNavigation,
  BEFORE_PROTOTYPE_NAVIGATION,
  type HistoryOrigin,
  historyEntryIndex,
  isPrototypeHistoryRestoring,
  PROTOTYPE_HISTORY_CHANGED,
  type PrototypeNavigationDetail,
  pushPrototypeHistory,
  replacePrototypeHistory,
} from "../navigation-guard";
import { ShortTime } from "../time";
import type { Identity, Page } from "../types";
import type { WorkbenchPageProps } from "./workbench";
import type { ManagedActivity, PaymentExample } from "./workbench-store";
import "./merchant-payments-dialog.css";

type PaymentView = {
  open: boolean;
  paymentId: string | null;
  page: number;
  attemptsPage: number;
};

type PaymentHistory = {
  version: 1;
  owner: Identity;
  parentHash: string | null;
  rootHash?: string;
  depth?: number;
  scrollTop?: number;
  focusedPayment?: string;
};

function pageNumber(value: string | null) {
  if (!value || !/^[1-9]\d*$/u.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : 1;
}

function readView(identity: Identity): PaymentView {
  const params = new URLSearchParams(window.location.hash.split("?")[1]);
  const history = window.history.state?.prototypeMerchantPayments as
    | PaymentHistory
    | undefined;
  return {
    open:
      params.get("dialog") === "merchant-payments" &&
      (!history || history.owner === identity),
    paymentId: params.get("paymentId"),
    page: pageNumber(params.get("paymentPage")),
    attemptsPage: pageNumber(params.get("attemptsPage")),
  };
}

function viewHash(view: PaymentView) {
  const [page = "merchant", query = ""] = window.location.hash
    .slice(1)
    .split("?");
  const params = new URLSearchParams(query);
  if (view.open) params.set("dialog", "merchant-payments");
  else params.delete("dialog");
  if (view.open && view.paymentId) params.set("paymentId", view.paymentId);
  else params.delete("paymentId");
  if (view.open && view.page > 1) params.set("paymentPage", String(view.page));
  else params.delete("paymentPage");
  if (view.open && view.attemptsPage > 1)
    params.set("attemptsPage", String(view.attemptsPage));
  else params.delete("attemptsPage");
  return `#${page}${params.size ? `?${params}` : ""}`;
}

/** History stores IDs and reading positions; payment data and secrets stay in memory. */
export function useMerchantPaymentOverlay(identity: Identity) {
  const [view, setView] = useState(() => readView(identity));
  const opener = useRef<HTMLElement | null>(null);
  const closeGuard = useRef<(() => boolean) | null>(null);
  const currentHash = useRef(window.location.hash);
  const currentIndex = useRef(historyEntryIndex());
  useEffect(() => {
    const syncOrigin = (event: Event) => {
      const origin = (event as CustomEvent<HistoryOrigin>).detail;
      currentHash.current = origin.hash;
      currentIndex.current = origin.index;
    };
    const read = (event: PopStateEvent | HashChangeEvent) => {
      if (isPrototypeHistoryRestoring(event)) return;
      if (
        !allowPrototypeNavigation(
          window.location.hash.slice(1).split("?")[0] as Page,
          event,
          { hash: currentHash.current, index: currentIndex.current },
        )
      ) {
        return;
      }
      currentHash.current = window.location.hash;
      currentIndex.current = historyEntryIndex();
      setView(readView(identity));
    };
    const guard = (event: Event) => {
      if (event.defaultPrevented || !closeGuard.current) return;
      const detail = (event as CustomEvent<PrototypeNavigationDetail>).detail;
      const source = currentHash.current.slice(1).split("?")[0];
      if (
        detail.hash
          ? detail.hash === currentHash.current
          : detail.page === source
      )
        return;
      detail.origin = {
        hash: currentHash.current,
        index: currentIndex.current,
      };
      if (!closeGuard.current()) event.preventDefault();
    };
    window.addEventListener("popstate", read, true);
    window.addEventListener("hashchange", read, true);
    window.addEventListener(BEFORE_PROTOTYPE_NAVIGATION, guard);
    window.addEventListener(PROTOTYPE_HISTORY_CHANGED, syncOrigin);
    return () => {
      window.removeEventListener("popstate", read, true);
      window.removeEventListener("hashchange", read, true);
      window.removeEventListener(BEFORE_PROTOTYPE_NAVIGATION, guard);
      window.removeEventListener(PROTOTYPE_HISTORY_CHANGED, syncOrigin);
    };
  }, [identity]);
  const open = (paymentId?: string) => {
    if (!view.open)
      opener.current = document.activeElement as HTMLElement | null;
    const parentHash = window.location.hash;
    const history = window.history.state?.prototypeMerchantPayments as
      | PaymentHistory
      | undefined;
    const depth = view.open ? (history?.depth ?? 1) + 1 : 1;
    const next = {
      ...view,
      open: true,
      paymentId: paymentId ?? null,
      attemptsPage: 1,
    };
    const hash = viewHash(next);
    pushPrototypeHistory(
      {
        prototypeMerchantPayments: {
          version: 1,
          owner: identity,
          parentHash,
          rootHash: view.open ? (history?.rootHash ?? parentHash) : parentHash,
          depth,
        } satisfies PaymentHistory,
      },
      hash,
    );
    currentHash.current = hash;
    currentIndex.current = historyEntryIndex();
    setView(next);
  };
  const update = (next: Partial<PaymentView>) => {
    const updated = { ...view, ...next };
    const hash = viewHash(updated);
    replacePrototypeHistory(window.history.state, hash);
    currentHash.current = hash;
    currentIndex.current = historyEntryIndex();
    setView(updated);
  };
  const back = () => {
    const history = window.history.state?.prototypeMerchantPayments as
      | PaymentHistory
      | undefined;
    if (
      history?.version === 1 &&
      history.owner === identity &&
      history.parentHash
    ) {
      window.history.back();
      return;
    }
    if (closeGuard.current && !closeGuard.current()) return;
    update(
      view.paymentId && window.location.hash.startsWith("#merchant")
        ? { paymentId: null, attemptsPage: 1 }
        : { open: false, paymentId: null, attemptsPage: 1 },
    );
  };
  const close = () => {
    const history = window.history.state?.prototypeMerchantPayments as
      | PaymentHistory
      | undefined;
    if (
      history?.version === 1 &&
      history.owner === identity &&
      history.rootHash &&
      history.depth &&
      Number.isSafeInteger(history.depth) &&
      history.depth > 0
    ) {
      window.history.go(-history.depth);
      return;
    }
    if (closeGuard.current && !closeGuard.current()) return;
    update({ open: false, paymentId: null, attemptsPage: 1 });
  };
  const rememberReading = (scrollTop: number, focusedPayment?: string) => {
    const history = window.history.state?.prototypeMerchantPayments as
      | PaymentHistory
      | undefined;
    replacePrototypeHistory({
      ...window.history.state,
      prototypeMerchantPayments: {
        ...history,
        version: 1,
        owner: identity,
        parentHash: history?.parentHash ?? null,
        scrollTop,
        focusedPayment: focusedPayment ?? history?.focusedPayment,
      } satisfies PaymentHistory,
    });
  };
  return {
    view,
    open,
    update,
    back,
    close,
    opener,
    closeGuard,
    rememberReading,
  };
}

type Overlay = ReturnType<typeof useMerchantPaymentOverlay>;

export function MerchantPaymentsDialog({
  overlay,
  payments,
  activities,
  navigate,
}: {
  overlay: Overlay;
  payments: PaymentExample[];
  activities: ManagedActivity[];
  navigate: WorkbenchPageProps["navigate"];
}) {
  const { view } = overlay;
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const backdropPress = useRef(false);
  const leaving = useRef(false);
  const [notice, setNotice] = useState("");
  const [secret, setSecret] = useState("");
  const secretValue = useRef(secret);
  secretValue.current = secret;
  const [repairNotice, setRepairNotice] = useState("");
  const payment = payments.find((item) => item.id === view.paymentId);
  const totalPages = Math.max(1, Math.ceil(payments.length / 20));
  const page = Math.min(view.page, totalPages);
  const rows = payments.slice((page - 1) * 20, page * 20);
  const title = view.paymentId ? "付款详情" : "付款记录";

  const confirmLeave = useCallback(() => {
    if (
      secretValue.current &&
      !window.confirm("还有未保存的原订单凭证，确定离开吗？")
    )
      return false;
    return true;
  }, []);
  useEffect(() => {
    overlay.closeGuard.current = confirmLeave;
    return () => {
      overlay.closeGuard.current = null;
    };
  }, [overlay.closeGuard, confirmLeave]);
  useEffect(() => {
    if (!secret) return;
    const unload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("beforeunload", unload);
    };
  }, [secret]);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      if (!leaving.current)
        window.requestAnimationFrame(() => {
          const target = overlay.opener.current?.isConnected
            ? overlay.opener.current
            : document.getElementById("merchant-payments-trigger");
          target?.focus({ preventScroll: true });
        });
    };
  }, [overlay.opener]);
  useLayoutEffect(() => {
    secretValue.current = "";
    setSecret("");
    setRepairNotice("");
    const history = window.history.state?.prototypeMerchantPayments as
      | PaymentHistory
      | undefined;
    window.requestAnimationFrame(() => {
      if (!content.current) return;
      content.current.scrollTop = view.paymentId
        ? 0
        : (history?.scrollTop ?? 0);
      const row =
        !view.paymentId && history?.focusedPayment
          ? Array.from(
              content.current.querySelectorAll<HTMLElement>(
                "[data-payment-id]",
              ),
            ).find((node) => node.dataset.paymentId === history.focusedPayment)
          : null;
      (
        row?.querySelector<HTMLButtonElement>("button") ?? closeButton.current
      )?.focus({ preventScroll: true });
    });
  }, [view.paymentId]);

  function isBackdrop(event: PointerEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const bounds = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  }
  function openDetail(id: string) {
    overlay.rememberReading(content.current?.scrollTop ?? 0, id);
    overlay.open(id);
  }
  function goToActivity(id: string) {
    if (navigate("activity", { activityId: id }) === false) return;
    leaving.current = true;
    dialog.current?.close();
  }
  const attempts = payment?.attempts ?? [];
  const attemptPageCount = Math.max(1, Math.ceil(attempts.length / 20));
  const attemptsPage = Math.min(view.attemptsPage, attemptPageCount);
  const currentAttempts = attempts.slice(
    (attemptsPage - 1) * 20,
    attemptsPage * 20,
  );
  return (
    <dialog
      ref={dialog}
      className="merchant-payments-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        overlay.close();
      }}
      onPointerDown={(event) => {
        backdropPress.current = isBackdrop(event);
      }}
      onPointerUp={(event) => {
        if (backdropPress.current && isBackdrop(event)) overlay.close();
        backdropPress.current = false;
      }}
    >
      <header className="merchant-payments-heading">
        <h2>{title}</h2>
        <div className="merchant-payments-tools">
          {view.paymentId && (
            <button
              className="merchant-icon-button"
              type="button"
              aria-label={
                window.location.hash.startsWith("#merchant")
                  ? "返回付款记录"
                  : "返回付款详情"
              }
              onClick={overlay.back}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
          )}
          <button
            className="merchant-icon-button"
            type="button"
            aria-label="刷新"
            title="刷新"
            onClick={() => setNotice("演示付款记录已刷新。")}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          <button
            ref={closeButton}
            className="merchant-icon-button"
            type="button"
            aria-label={view.paymentId ? "关闭付款详情" : "关闭付款记录"}
            onClick={overlay.close}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      {notice && (
        <p className="merchant-payment-feedback" role="status">
          {notice}
        </p>
      )}
      <div
        ref={content}
        className="merchant-payments-content"
        onScroll={() => {
          if (!view.paymentId)
            overlay.rememberReading(content.current?.scrollTop ?? 0);
        }}
      >
        {!view.paymentId ? (
          <div className="merchant-payment-table-scroll">
            <table className="merchant-payment-table" aria-label="商户付款记录">
              <thead>
                <tr>
                  {["金额", "状态", "来源", "业务号", "创建时间", "操作"].map(
                    (name) => (
                      <th key={name} scope="col">
                        {name}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr
                    key={item.id}
                    data-payment-id={item.id}
                    data-payment-status={item.status}
                  >
                    <td className="merchant-payment-money">
                      {item.amount} LDC
                    </td>
                    <td>
                      <StatusBadge
                        tone={
                          item.status === "confirmed" ? "success" : "pending"
                        }
                      >
                        {item.state}
                      </StatusBadge>
                    </td>
                    <td>{item.source}</td>
                    <td className="merchant-payment-business-id">
                      {item.businessId}
                    </td>
                    <td>
                      <ShortTime value={item.createdAt} full />
                    </td>
                    <td>
                      <button
                        className="work-text-link"
                        type="button"
                        onClick={() => openDetail(item.id)}
                      >
                        查看详情
                      </button>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={6}>暂无付款记录。</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : payment ? (
          <div className="merchant-payment-details">
            <section className="merchant-payment-summary" aria-label="付款概况">
              <div>
                <strong>
                  {payment.amount} <small>LDC</small>
                </strong>
                <StatusBadge
                  tone={payment.status === "confirmed" ? "success" : "pending"}
                >
                  {payment.state}
                </StatusBadge>
              </div>
              <p>
                {payment.recipient.name}{" "}
                <span>@{payment.recipient.username}</span>
              </p>
              {payment.status !== "confirmed" && payment.issue && (
                <p className="merchant-payment-warning" role="status">
                  {payment.issue}
                </p>
              )}
            </section>
            <section className="merchant-payment-section">
              <h3>订单信息</h3>
              <dl className="merchant-payment-facts">
                <div>
                  <dt>本站业务号</dt>
                  <dd>{payment.businessId}</dd>
                </div>
                <div>
                  <dt>上游交易号</dt>
                  <dd>{payment.upstreamId ?? "尚未收到"}</dd>
                </div>
                {payment.sentUsername !== payment.recipient.username && (
                  <div>
                    <dt>发送时用户名</dt>
                    <dd>@{payment.sentUsername}</dd>
                  </div>
                )}
                <div>
                  <dt>关联活动</dt>
                  <dd>
                    {payment.activityId &&
                    activities.some(
                      (activity) => activity.id === payment.activityId,
                    ) ? (
                      <button
                        className="work-text-link"
                        type="button"
                        onClick={() =>
                          goToActivity(payment.activityId as string)
                        }
                      >
                        {payment.title}
                      </button>
                    ) : (
                      payment.title
                    )}
                  </dd>
                </div>
              </dl>
            </section>
            <section className="merchant-payment-section">
              <h3>付款进度</h3>
              <ol className="merchant-payment-timeline" aria-label="付款时间线">
                {[
                  { label: "创建付款", time: payment.createdAt },
                  { label: "首次发送", time: payment.firstSendAt },
                  { label: "收到分发响应", time: payment.sendAcknowledgedAt },
                  {
                    label:
                      payment.orderEvidence === "query"
                        ? "查到订单"
                        : "发现订单",
                    time: payment.orderObservedAt,
                  },
                  { label: "本站确认发放", time: payment.confirmedAt },
                ]
                  .filter((step) => Boolean(step.time))
                  .map((step) => (
                    <li key={step.label}>
                      <span>{step.label}</span>
                      <ShortTime value={step.time as string} full />
                    </li>
                  ))}
              </ol>
            </section>
            <section className="merchant-payment-section">
              <h3>处理记录</h3>
              <div className="merchant-payment-table-scroll">
                <table
                  className="merchant-payment-table merchant-payment-attempts"
                  aria-label="付款处理记录"
                >
                  <thead>
                    <tr>
                      {["操作", "结果", "开始时间", "完成时间", "说明"].map(
                        (name) => (
                          <th scope="col" key={name}>
                            {name}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {currentAttempts.map((attempt) => (
                      <tr key={attempt.id}>
                        <td>
                          {attempt.operation === "send"
                            ? "发送付款"
                            : "核对订单"}
                        </td>
                        <td>{attempt.outcome}</td>
                        <td>
                          <ShortTime value={attempt.startedAt} full />
                        </td>
                        <td>
                          {attempt.finishedAt ? (
                            <ShortTime value={attempt.finishedAt} full />
                          ) : (
                            "处理中"
                          )}
                        </td>
                        <td>{attempt.note ?? "—"}</td>
                      </tr>
                    ))}
                    {!currentAttempts.length && (
                      <tr>
                        <td colSpan={5}>暂无处理记录。</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {attemptPageCount > 1 && (
                <Pagination
                  label="付款处理记录分页"
                  page={attemptsPage}
                  hasNext={attemptsPage < attemptPageCount}
                  onPageChange={(next) =>
                    overlay.update({ attemptsPage: next })
                  }
                />
              )}
            </section>
            {payment.status === "waiting" && payment.canRepairCredentials && (
              <form
                className="merchant-payment-section merchant-original-repair"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!secret.trim()) return;
                  setSecret("");
                  setRepairNotice("演示原订单凭证已保存。");
                }}
              >
                <h3>更新原订单密钥</h3>
                <p>
                  此订单需要原付款身份对应的密钥。保存后由系统继续核对原订单。
                </p>
                <label className="field" htmlFor="prototype-original-client">
                  原订单 Client ID
                  <input
                    id="prototype-original-client"
                    value="LJ-DEMO-2026"
                    readOnly
                  />
                </label>
                <label className="field" htmlFor="prototype-original-secret">
                  原订单商户密钥
                  <input
                    id="prototype-original-secret"
                    type="password"
                    value={secret}
                    autoComplete="new-password"
                    onChange={(event) => {
                      setSecret(event.target.value);
                      setRepairNotice("");
                    }}
                  />
                </label>
                {repairNotice && <p role="status">{repairNotice}</p>}
                <button
                  className="button"
                  type="submit"
                  disabled={!secret.trim()}
                >
                  保存原订单凭证
                </button>
              </form>
            )}
          </div>
        ) : (
          <p role="alert">未找到付款记录，请返回重新选择。</p>
        )}
      </div>
      {!view.paymentId && (
        <footer className="merchant-payments-footer">
          <span>{payments.length} 笔付款</span>
          <Pagination
            label="商户付款记录分页"
            page={page}
            hasNext={page < totalPages}
            onPageChange={(next) => {
              content.current?.scrollTo({ top: 0 });
              overlay.update({ page: next });
            }}
          />
        </footer>
      )}
    </dialog>
  );
}
