import {
  type AdminPaymentDetailResponse,
  type AdminPaymentListItem,
  normalizeActivityUuid,
  PAYMENT_LABELS,
  type PaymentState,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import {
  useAdminActivity,
  useAdminList,
  useAdminPayment,
  useAdminUser,
} from "../../../lib/admin";
import { cn } from "../../../lib/cn";
import { paymentTone } from "../../../lib/hongbao-text";
import {
  paymentNextAction,
  paymentOrderEvidence,
} from "../../../lib/payment-display";
import { paymentSteps } from "../../../lib/payments";
import { clockLabel, clockSeconds } from "../../../lib/roster-time";
import type { AdminSearch } from "../../../router";
import { useQueryLazyList } from "../../page/lazy-list";
import { Callout, EmptyNote } from "../../page/page";
import { PageLoad, resultOf } from "../../page/page-state";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { MoreLink } from "../../ui/button-link";
import { CopyButton } from "../../ui/copy-button";
import { Segmented } from "../../ui/field";
import { StatusChip } from "../../ui/status-chip";
import { Attempts, StateNote, Timeline } from "../payment-view";
import {
  AdminFrame,
  countLine,
  DetailPart,
  DetailRows,
  FilterChip,
  ListDetail,
  listLoad,
  SearchBox,
  ToggleChip,
  useSettled,
} from "./admin-frame";

type StateFilter = "all" | PaymentState;
type ModeFilter = "all" | "real" | "simulation";

// The overview's checks that are not a state of their own (异常待处理 is:
// the state filter above them).
const anomalies = [
  { key: "unknown", label: "结果未知" },
  { key: "overdue", label: "等待超过一小时" },
  { key: "undelivered", label: "未投递超过十分钟" },
] as const;

const states = [
  "pending",
  "sending",
  "reconciling",
  "waiting",
  "attention",
  "confirmed",
  "failed",
] as const satisfies readonly PaymentState[];

/** 未发出 (a 🐟额 转出 refused for good, its 🐟 given back) needs nothing. */
const stateTone = (state: string) =>
  state === "failed" ? ("neutral" as const) : paymentTone(state);

const stateOf = (value: string | undefined): StateFilter =>
  states.find((state) => state === value) ?? "all";
const modeOf = (value: string | undefined): ModeFilter =>
  value === "real" || value === "simulation" ? value : "all";
const anomalyOf = (value: string | undefined) =>
  anomalies.find((item) => item.key === value)?.key;

/** The LINUX DO ID a payment goes to (a simulated one carries a prefix). */
const linuxDoId = (recipientId: string) =>
  recipientId.replace(/^simulation:/, "");

function recipientName(payment: AdminPaymentListItem) {
  return (
    payment.recipientDisplayName ??
    payment.currentRecipientUsername ??
    payment.recipientUsername ??
    `LINUX DO ID ${linuxDoId(payment.recipientId)}`
  );
}

function RowBody({ payment }: { payment: AdminPaymentListItem }) {
  return (
    <>
      <Avatar
        name={recipientName(payment)}
        src={payment.recipientAvatarUrl}
        size={36}
      />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-base text-ink">
            {recipientName(payment)}
          </span>
          <span className="truncate text-xs text-ink-3">
            {payment.source === "withdrawal"
              ? "🐟额转出"
              : (payment.activityTitle ?? "恢复付款")}
          </span>
        </span>
        <span className="truncate font-mono text-xs text-ink-3">
          {payment.businessNo.slice(0, 15)}… ·{" "}
          <span className="font-sans">
            {clockLabel(payment.createdAt)}
            {payment.mode === "simulation" ? " · 模拟" : ""}
          </span>
        </span>
      </span>
      <span className="grid shrink-0 justify-items-end gap-1">
        <span className="text-sm font-semibold text-ink tabular-nums">
          {payment.amount} LDC
        </span>
        <StatusChip tone={stateTone(payment.status)} dot>
          {PAYMENT_LABELS[payment.status]}
        </StatusChip>
      </span>
    </>
  );
}

/** The fields only an admin needs, and the sender's own 付款详情 under them. */
function DetailBody({
  item,
  detail,
}: {
  item: AdminPaymentListItem;
  detail: AdminPaymentDetailResponse;
}) {
  const navigate = useNavigate({ from: "/admin/payments" });
  const { payment, view, draw } = detail;
  // The order's Client ID, and whether the merchant has changed it since.
  const orderClientId =
    view?.config?.effectiveClientId ?? view?.config?.originalClientId ?? null;
  const previousApp =
    orderClientId !== null &&
    payment.merchantClientId !== null &&
    orderClientId !== payment.merchantClientId;
  const current = payment.currentRecipientUsername;
  return (
    <>
      {payment.source === "withdrawal" ? (
        <Callout title="🐟额转出">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              平台应用把🐟额转回这个人自己的 Credit
              账户。发放中、已发放或未发出，以🐟额里的这笔转出为准。
            </span>
            <MoreLink
              className="-my-1"
              href="/admin/balance?status=withdrawals"
              onGo={() =>
                void navigate({
                  to: "/admin/balance",
                  search: { status: "withdrawals" },
                })
              }
            >
              在🐟额里看
            </MoreLink>
          </span>
        </Callout>
      ) : !view ? (
        <Callout
          tone="warning"
          icon={AlertTriangle}
          title="发红包的人视角读不出来"
        >
          这笔付款的记录对不上（日志里有原因），下面只列本站记下的字段。
        </Callout>
      ) : (
        payment.status !== "confirmed" && <StateNote payment={view} admin />
      )}
      <DetailRows
        rows={[
          {
            label: "收款人",
            value: `${recipientName(item)}${current ? ` @${current}` : ""} · LINUX DO ID ${linuxDoId(payment.recipientId)}`,
          },
          {
            label: "订单用户名",
            value: payment.recipientUsername
              ? `@${payment.recipientUsername}${current && current !== payment.recipientUsername ? `（现在是 @${current}）` : ""}`
              : "—",
          },
          {
            label: "红包",
            value:
              payment.source === "withdrawal"
                ? "—（🐟额转出）"
                : (payment.activityTitle ?? "—（恢复付款）"),
          },
          {
            label: "付款商户",
            value: `${payment.merchantLabel ?? "商户"} · ${orderClientId ?? payment.merchantId}${previousApp ? "（更换前的应用）" : ""}`,
          },
          {
            label: "付款模式",
            value: payment.mode === "real" ? "真实" : "模拟",
          },
          {
            label: "本站业务号",
            value: (
              <span className="flex items-center gap-1">
                <span className="min-w-0 font-mono text-xs">
                  {payment.businessNo}
                </span>
                <CopyButton value={payment.businessNo} label="本站业务号" />
              </span>
            ),
          },
          {
            label: "任务 ID",
            value: <span className="font-mono text-xs">{payment.id}</span>,
          },
          {
            label: "上游交易号",
            value: payment.externalOrderId ? (
              <span className="font-mono text-xs">
                {payment.externalOrderId}
              </span>
            ) : (
              "尚未收到"
            ),
          },
          {
            label: "订单证据",
            value: paymentOrderEvidence(payment.orderEvidence),
          },
          { label: "结果未知", value: payment.unknownOutcome ? "是" : "否" },
          { label: "下一步", value: paymentNextAction(payment.nextAction) },
          {
            label: "下次处理",
            value:
              payment.nextAction === "none"
                ? "—"
                : clockSeconds(
                    payment.nextSendAt ??
                      payment.nextQueryAt ??
                      payment.nextRunAt,
                  ),
          },
          {
            label: "发送 / 查单",
            value: `${payment.attemptCount} 次 / ${payment.reconciliationCount} 次`,
          },
          { label: "创建", value: clockSeconds(payment.createdAt) },
          {
            label: "确认发放",
            value: payment.confirmedAt
              ? clockSeconds(payment.confirmedAt)
              : "尚未确认",
          },
        ]}
      />
      {view && (
        <>
          <div className="grid gap-2">
            <h3 className="text-sm font-medium text-ink">经过</h3>
            <Timeline
              steps={paymentSteps(view, {
                draw,
                recipient: recipientName(item),
              })}
            />
          </div>
          <div className="grid gap-2">
            <h3 className="text-sm font-medium text-ink">
              处理记录
              {view.nextAttemptsCursor && (
                <span className="ml-2 font-normal text-ink-3">最近 20 条</span>
              )}
            </h3>
            <Attempts payment={view} stacked admin />
          </div>
        </>
      )}
      {payment.activityId && (
        <Button
          size="sm"
          variant="ghost"
          className="justify-self-start"
          onClick={() =>
            void navigate({
              to: "/admin/activities",
              search: { q: payment.activityId ?? undefined },
            })
          }
        >
          查看这个红包
        </Button>
      )}
    </>
  );
}

function Detail({ item }: { item: AdminPaymentListItem }) {
  const query = useAdminPayment(item.id);
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xl font-semibold text-ink tabular-nums">
          {item.amount}
          <span className="ml-1 text-sm font-medium text-ink-3">LDC</span>
        </p>
        <StatusChip tone={stateTone(item.status)} dot>
          {PAYMENT_LABELS[item.status]}
        </StatusChip>
      </div>
      <DetailPart query={query} lines={8}>
        {(detail) => <DetailBody item={item} detail={detail} />}
      </DetailPart>
    </>
  );
}

/**
 * /admin/payments 付款: every payment on the site. Search by the numbers
 * people quote (本站业务号, 任务 ID, 上游交易号); narrow by state, by mode or
 * by one of the overview's checks. The detail is the sender's 付款详情 plus
 * the fields only an admin needs. No actions: retries and checks run by
 * themselves (production keeps recovery grants in a CLI).
 */
export function AdminPayments({ search }: { search: AdminSearch }) {
  const navigate = useNavigate({ from: "/admin/payments" });
  const [query, setQuery] = useState(search.q ?? "");
  const q = useSettled(query.trim());
  // In the address, so the overview can link to 异常待处理.
  const state = stateOf(search.state);
  const mode = modeOf(search.mode);
  const anomaly = anomalyOf(search.anomaly);
  const [selected, setSelected] = useState<string | null>(null);
  const setSearch = (patch: Partial<AdminSearch>) =>
    void navigate({
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
    });
  // Filters from another page; one the server would refuse (a cut-off
  // link) is shown as such and not sent.
  const activityId = search.activity
    ? normalizeActivityUuid(search.activity)
    : null;
  const recipientId =
    search.recipient && search.recipient.length <= 128
      ? search.recipient
      : null;
  const listQuery = useAdminList("payments", {
    q: q || undefined,
    status: state === "all" ? undefined : state,
    mode: mode === "all" ? undefined : mode,
    anomaly,
    activityId: activityId ?? undefined,
    recipientUserId: recipientId ?? undefined,
  });
  const detail = useAdminPayment(selected);
  const busy = listQuery.isPlaceholderData;
  const list = useQueryLazyList({
    hasNextPage: listQuery.hasNextPage && !busy,
    isFetchingNextPage: listQuery.isFetchingNextPage,
    isFetchNextPageError: listQuery.isFetchNextPageError,
    fetchNextPage: listQuery.fetchNextPage,
    pageCount: listQuery.data?.pages.length ?? 0,
  });
  const pages = listQuery.data?.pages ?? [];
  const total = pages[0]?.total;
  const seen = new Set<string>();
  const payments = pages
    .flatMap((page) => page.items)
    .filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));
  // The filters' names: from the rows when they have them, otherwise read
  // (or cached from the page the filter came from).
  const listed = listQuery.data !== undefined && !busy;
  const activityTitle = payments.find(
    (item) => activityId && item.activityId === activityId,
  )?.activityTitle;
  const activity = useAdminActivity(activityId, listed && !activityTitle);
  const recipientTitle = listed
    ? (payments[0]?.recipientDisplayName ??
      payments[0]?.currentRecipientUsername)
    : undefined;
  const recipient = useAdminUser(recipientId, listed && !recipientTitle);
  const nameOf = (
    id: string | null,
    name: string | null | undefined,
    failed: boolean,
  ) => (id === null ? "编号无效" : (name ?? (failed ? id : "…")));

  return (
    // The search and filters stay once shown; the list loads in place.
    <PageLoad load={listLoad(listQuery, selected ? detail : null)} area frame>
      <AdminFrame>
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchBox
              label="搜索付款"
              value={query}
              onChange={setQuery}
              maxLength={2048}
              placeholder="本站业务号、任务 ID、上游交易号、红包或商户 ID"
            />
          </div>
          <Segmented
            size="sm"
            label="付款状态"
            value={state}
            onChange={(value) =>
              setSearch({ state: value === "all" ? undefined : value })
            }
            options={[
              { value: "all", label: "全部" },
              ...states.map((value) => ({
                value,
                label: PAYMENT_LABELS[value],
              })),
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              size="sm"
              label="付款模式"
              value={mode}
              onChange={(value) =>
                setSearch({ mode: value === "all" ? undefined : value })
              }
              options={[
                { value: "all", label: "全部模式" },
                { value: "real", label: "真实" },
                { value: "simulation", label: "模拟" },
              ]}
            />
            {anomalies.map((item) => (
              <ToggleChip
                key={item.key}
                pressed={anomaly === item.key}
                onChange={(pressed) =>
                  setSearch({ anomaly: pressed ? item.key : undefined })
                }
              >
                {item.label}
              </ToggleChip>
            ))}
            {search.activity && (
              <FilterChip
                label={`红包：${nameOf(activityId, activityTitle ?? activity.data?.activity.title, activity.isError)}`}
                onClear={() => setSearch({ activity: undefined })}
              />
            )}
            {search.recipient && (
              <FilterChip
                label={`收款人：${nameOf(recipientId, recipientTitle ?? recipient.data?.user.displayName, recipient.isError)}`}
                onClear={() => setSearch({ recipient: undefined })}
              />
            )}
            <span
              className={cn(
                "ml-auto text-sm text-ink-3 transition-opacity",
                busy && "opacity-60",
              )}
            >
              {countLine(total, "笔")}
            </span>
          </div>
        </div>
        <ListDetail
          items={payments}
          list={list}
          total={total}
          load={resultOf(listQuery)}
          selectedId={selected}
          onSelect={setSelected}
          placeholder="点一笔付款看详情。"
          unit="笔"
          noun="付款"
          empty={<EmptyNote title="没有符合条件的付款" text="换个筛选看看。" />}
          row={(payment) => <RowBody payment={payment} />}
          detail={(payment) => <Detail item={payment} />}
        />
      </AdminFrame>
    </PageLoad>
  );
}
