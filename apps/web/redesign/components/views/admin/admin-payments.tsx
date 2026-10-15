import { PAYMENT_LABELS, type PaymentState } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { findActivity } from "../../../fixtures/activities";
import { matchesAnomaly, siteUsers } from "../../../fixtures/admin";
import { findMerchant } from "../../../fixtures/merchants";
import { type FixturePayment, sitePayments } from "../../../fixtures/payments";
import { paymentTone } from "../../../lib/my-records";
import { clockLabel, clockSeconds } from "../../../lib/roster-time";
import type { AdminSearch } from "../../../router";
import { EmptyNote } from "../../page/page";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { CopyButton } from "../../ui/copy-button";
import { Segmented } from "../../ui/field";
import { StatusChip } from "../../ui/status-chip";
import { Attempts, StateNote, Timeline } from "../payment-view";
import {
  AdminFrame,
  DetailRows,
  FilterChip,
  ListDetail,
  SearchBox,
  ToggleChip,
} from "./admin-frame";

type StateFilter = "all" | PaymentState;

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
] as const satisfies readonly PaymentState[];

const stateOf = (value: string | undefined): StateFilter =>
  states.find((state) => state === value) ?? "all";

const nextStep = (payment: FixturePayment) =>
  payment.state === "confirmed" || payment.state === "attention"
    ? "无待执行操作"
    : payment.state === "reconciling"
      ? "核对原订单"
      : "等待按计划发送";

/**
 * /admin/payments 付款: every payment on the site. Search by the numbers
 * people quote (本站业务号, 任务 ID, 上游交易号); narrow by state or by one
 * of the overview's checks. The detail is the sender's 付款详情 plus the
 * fields only an admin needs. No actions: retries and checks run by
 * themselves (production keeps recovery grants in a CLI).
 */
export function AdminPayments({ search }: { search: AdminSearch }) {
  const navigate = useNavigate({ from: "/admin/payments" });
  const [query, setQuery] = useState(search.q ?? "");
  // In the address, so the overview can link to 异常待处理.
  const state = stateOf(search.state);
  const [selected, setSelected] = useState<string | null>(null);
  const text = query.trim().toLowerCase();
  const now = Date.now();
  const setSearch = (patch: Partial<AdminSearch>) =>
    void navigate({
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
    });
  const payments = sitePayments().filter(
    (payment) =>
      (state === "all" || payment.state === state) &&
      (!search.anomaly || matchesAnomaly(payment, search.anomaly, now)) &&
      (!search.activity || payment.activityId === search.activity) &&
      (!search.recipient || payment.recipient.username === search.recipient) &&
      (!text ||
        payment.id === text ||
        payment.businessNo.toLowerCase().includes(text) ||
        payment.externalOrderId?.includes(text) ||
        payment.activityId === text),
  );
  const activity = search.activity ? findActivity(search.activity) : null;
  const recipient = search.recipient
    ? siteUsers().find((user) => user.username === search.recipient)
    : null;

  return (
    <AdminFrame
      refreshable
      description="全站的付款。重试和查单都是系统自己做的，这里只能查看。"
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox
            label="搜索付款"
            value={query}
            onChange={setQuery}
            placeholder="本站业务号、任务 ID、上游交易号或红包 ID"
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
          {anomalies.map((item) => (
            <ToggleChip
              key={item.key}
              pressed={search.anomaly === item.key}
              onChange={(pressed) =>
                setSearch({ anomaly: pressed ? item.key : undefined })
              }
            >
              {item.label}
            </ToggleChip>
          ))}
          {activity && (
            <FilterChip
              label={`红包：${activity.title}`}
              onClear={() => setSearch({ activity: undefined })}
            />
          )}
          {search.recipient && (
            <FilterChip
              label={`收款人：${recipient?.displayName ?? search.recipient}`}
              onClear={() => setSearch({ recipient: undefined })}
            />
          )}
          <span className="ml-auto text-sm text-ink-3">
            {payments.length} 笔
          </span>
        </div>
      </div>
      <ListDetail<FixturePayment>
        items={payments}
        selectedId={selected}
        onSelect={setSelected}
        placeholder="点一笔付款看详情。"
        unit="笔"
        noun="付款"
        empty={<EmptyNote title="没有符合条件的付款" text="换个筛选看看。" />}
        row={(payment) => (
          <>
            <Avatar name={payment.recipient.displayName} size={36} />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-base text-ink">
                  {payment.recipient.displayName}
                </span>
                <span className="truncate text-xs text-ink-3">
                  {findActivity(payment.activityId)?.title}
                </span>
              </span>
              <span className="truncate font-mono text-xs text-ink-3">
                {payment.businessNo.slice(0, 15)}… ·{" "}
                <span className="font-sans">
                  {clockLabel(payment.createdAt)}
                </span>
              </span>
            </span>
            <span className="grid shrink-0 justify-items-end gap-1">
              <span className="text-sm font-semibold text-ink tabular-nums">
                {payment.amount} LDC
              </span>
              <StatusChip tone={paymentTone(payment.state)} dot>
                {PAYMENT_LABELS[payment.state]}
              </StatusChip>
            </span>
          </>
        )}
        detail={(payment) => {
          const merchant = findMerchant(payment.merchantId);
          const source = findActivity(payment.activityId);
          const user = siteUsers().find(
            (item) => item.username === payment.recipient.username,
          );
          return (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xl font-semibold text-ink tabular-nums">
                  {payment.amount}
                  <span className="ml-1 text-sm font-medium text-ink-3">
                    LDC
                  </span>
                </p>
                <StatusChip tone={paymentTone(payment.state)} dot>
                  {PAYMENT_LABELS[payment.state]}
                </StatusChip>
              </div>
              {payment.state !== "confirmed" && (
                <StateNote payment={payment} admin />
              )}
              <DetailRows
                rows={[
                  {
                    label: "收款人",
                    value: `${payment.recipient.displayName} @${payment.recipient.username}${user ? ` · LINUX DO ID ${user.linuxDoId}` : ""}`,
                  },
                  { label: "红包", value: source?.title ?? "—" },
                  {
                    label: "付款商户",
                    // A payment sent before a Client ID change still goes
                    // through the merchant's previous app.
                    value: merchant
                      ? `${merchant.label} · ${payment.originalClientId ?? merchant.clientId}${payment.originalClientId ? "（更换前的应用）" : ""}`
                      : `${source?.author.displayName ?? ""}的商户`,
                  },
                  {
                    label: "本站业务号",
                    value: (
                      <span className="flex items-center gap-1">
                        <span className="min-w-0 font-mono text-xs">
                          {payment.businessNo}
                        </span>
                        <CopyButton
                          value={payment.businessNo}
                          label="本站业务号"
                        />
                      </span>
                    ),
                  },
                  {
                    label: "任务 ID",
                    value: (
                      <span className="font-mono text-xs">{payment.id}</span>
                    ),
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
                    label: "结果未知",
                    value: payment.state === "reconciling" ? "是" : "否",
                  },
                  { label: "下一步", value: nextStep(payment) },
                  {
                    label: "下次处理",
                    value: payment.nextRunAt
                      ? clockSeconds(payment.nextRunAt)
                      : "—",
                  },
                  {
                    label: "发送 / 查单",
                    value: `${payment.attempts.filter((item) => item.action === "分发请求").length} 次 / ${payment.attempts.filter((item) => item.action === "订单查询").length} 次`,
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
              <div className="grid gap-2">
                <h3 className="text-sm font-medium text-ink">经过</h3>
                <Timeline steps={payment.steps} />
              </div>
              <div className="grid gap-2">
                <h3 className="text-sm font-medium text-ink">处理记录</h3>
                <Attempts payment={payment} stacked />
              </div>
              {source && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="justify-self-start"
                  onClick={() =>
                    void navigate({
                      to: "/admin/activities",
                      search: { q: source.id },
                    })
                  }
                >
                  查看这个红包
                </Button>
              )}
            </>
          );
        }}
      />
    </AdminFrame>
  );
}
