// 三方积分's 发放记录 and 调用记录 (docs/third-party-points-design.md §7):
// every payout of one system and every call to its issuer, newest first, 50
// at a time. The same rows on the 站长's panel and on the issuer's own page
// (/points/:id/records); only the 站长 may settle a payout with no known
// result. Read on open and on 加载更多; nothing refreshes by itself.

import type { AmountUnit } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { activityPath } from "../../lib/activity-route";
import {
  type CallRecord,
  type PayoutFilter,
  type PayoutRecord,
  type PayoutTotals,
  payoutReasonWords,
  type RecordsScope,
  useAdminPointsActions,
  useCallRecords,
  useOwnPoints,
  usePayoutRecords,
} from "../../lib/points";
import { clockLabel } from "../../lib/roster-time";
import { useSessionUser } from "../../lib/session";
import { amountText } from "../../lib/units";
import { Page, PageHeader, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { Button } from "../ui/button";
import { PointsCapsule } from "../ui/points-mark";
import { Segmented } from "../ui/segmented";
import { StatusChip } from "../ui/status-chip";

const payoutStatus: Record<
  PayoutRecord["status"],
  { text: string; tone: "success" | "warning" | "danger" | "neutral" }
> = {
  pending: { text: "等待发放", tone: "neutral" },
  sending: { text: "发放中", tone: "neutral" },
  held: { text: "等领取的人开户", tone: "warning" },
  unknown: { text: "结果不明", tone: "danger" },
  confirmed: { text: "已到账", tone: "success" },
  failed: { text: "没发出", tone: "danger" },
};

const callKinds: Record<CallRecord["kind"], string> = {
  balance: "查余额",
  transfer: "发放",
  query: "查单",
};

const callResults: Record<string, string> = {
  ok: "成功",
  insufficient: "余额不够",
  no_recipient: "找不到收款人",
  not_allowed: "不允许",
  key_invalid: "密钥无效",
  bad_request: "参数不对",
  conflict: "单号冲突",
  not_found: "没有这一笔",
  "missed:timeout": "10 秒没回复",
  "missed:network": "连不上",
  "missed:redirect": "回了跳转（不跟）",
  "missed:too_large": "回复超过 64 KB",
  "missed:invalid": "回复看不懂",
};

/** The issuer's own page: their system's records. */
export function PointsRecordsView({ id }: { id: string }) {
  const user = useSessionUser();
  const query = useOwnPoints(user?.id ?? "", id);
  const system = query.data?.system;
  return (
    <PageLoad load={queryLoad(query)}>
      {system && (
        <Page width="wide">
          <PageHeader
            eyebrow="三方积分"
            back={{ label: "我添加的积分", href: "/points" }}
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                <PointsCapsule name={system.name} />
                发放记录
              </span>
            }
            description="红包站每一次给领取的人发积分、每一次调用你的接口，都在这里。"
          />
          <PointsRecords
            scope="own"
            systemId={system.id}
            unit={{ unit: system.unit, step: system.step }}
          />
        </Page>
      )}
    </PageLoad>
  );
}

/** 发放记录 and 调用记录 of one system. */
export function PointsRecords({
  scope,
  systemId,
  unit,
}: {
  scope: RecordsScope;
  systemId: string;
  unit: AmountUnit;
}) {
  const [kind, setKind] = useState<"payouts" | "calls">("payouts");
  return (
    <div className="grid gap-3">
      <Segmented
        label="看哪一种记录"
        value={kind}
        onChange={setKind}
        options={[
          { value: "payouts", label: "发放记录" },
          { value: "calls", label: "调用记录" },
        ]}
      />
      {kind === "payouts" ? (
        <Payouts scope={scope} systemId={systemId} unit={unit} />
      ) : (
        <Calls scope={scope} systemId={systemId} />
      )}
    </div>
  );
}

function Payouts({
  scope,
  systemId,
  unit,
}: {
  scope: RecordsScope;
  systemId: string;
  unit: AmountUnit;
}) {
  const [filter, setFilter] = useState<PayoutFilter>("all");
  const query = usePayoutRecords(scope, systemId, filter);
  const pages = query.data?.pages ?? [];
  const totals = pages[0]?.totals ?? null;
  const items = pages.flatMap((page) => page.items);
  return (
    <div className="grid gap-3">
      {totals && <Totals totals={totals} unit={unit} />}
      <Segmented
        label="按状态看"
        size="sm"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "全部" },
          { value: "confirmed", label: "已到账" },
          { value: "waiting", label: "处理中" },
          { value: "failed", label: "没发出" },
        ]}
      />
      <List
        loading={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
        empty="还没有这样的发放。"
        more={query.hasNextPage}
        loadingMore={query.isFetchingNextPage}
        onMore={() => void query.fetchNextPage()}
      >
        {items.map((payout) => (
          <PayoutRow
            key={payout.id}
            payout={payout}
            unit={unit}
            admin={scope === "admin"}
          />
        ))}
      </List>
    </div>
  );
}

function Totals({ totals, unit }: { totals: PayoutTotals; unit: AmountUnit }) {
  const line = (span: PayoutTotals["today"]) =>
    [
      `到账 ${span.confirmed.count} 笔，共 ${amountText(span.confirmed.amountMinor, unit)}`,
      `处理中 ${span.waiting.count} 笔`,
      `没发出 ${span.failed.count} 笔`,
    ].join(" · ");
  return (
    <Panel className="grid gap-1 p-4 text-sm text-ink-2">
      <span>
        <b className="text-ink">今天</b> {line(totals.today)}
      </span>
      <span>
        <b className="text-ink">近 7 天</b> {line(totals.week)}
      </span>
    </Panel>
  );
}

function PayoutRow({
  payout,
  unit,
  admin,
}: {
  payout: PayoutRecord;
  unit: AmountUnit;
  admin: boolean;
}) {
  const navigate = useNavigate();
  const status = payoutStatus[payout.status];
  const why =
    payout.status === "failed" ||
    payout.status === "held" ||
    payout.status === "unknown"
      ? (payoutReasonWords[payout.reason ?? ""] ?? payout.reason)
      : null;
  return (
    <div className="grid gap-1 rounded-xl bg-fill-2 px-3 py-2.5 text-sm">
      <span className="flex flex-wrap items-center gap-2 text-ink">
        <b>{amountText(payout.amountMinor, unit)}</b>
        <span>
          给 @{payout.recipientUsername}
          <span className="text-ink-3">（ID {payout.recipientId}）</span>
        </span>
        <StatusChip tone={status.tone}>{status.text}</StatusChip>
        {why && <span className="text-ink-2">{why}</span>}
        {payout.resent && <span className="text-ink-3">重新发送过</span>}
      </span>
      <span className="text-ink-2">
        <a
          href={activityPath(payout.activityId)}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            void navigate({ href: activityPath(payout.activityId) });
          }}
          className="font-medium text-ink underline-offset-2 hover:underline"
        >
          {payout.title}
        </a>{" "}
        · @{payout.authorUsername} 发的 · {clockLabel(payout.updatedAt)}
      </span>
      <span className="font-mono text-xs break-all text-ink-3">
        本站单号 {payout.outTradeNo}
        {payout.tradeNo ? ` · 对方单号 ${payout.tradeNo}` : ""}
        {payout.attempts > 1 ? ` · 调用了 ${payout.attempts} 次` : ""}
      </span>
      {admin && payout.status === "unknown" && <SettleButtons id={payout.id} />}
    </div>
  );
}

/** The 站长's two answers to a payout with no known result. */
function SettleButtons({ id }: { id: string }) {
  const actions = useAdminPointsActions();
  const error = actions.payout.error;
  return (
    <span className="flex flex-wrap items-center gap-2 pt-1">
      <Button
        size="xs"
        onClick={() => actions.payout.mutate({ id, action: "requery" })}
      >
        再查一次
      </Button>
      <Button
        size="xs"
        variant="quiet"
        onClick={() => actions.payout.mutate({ id, action: "fail" })}
      >
        标为未发出
      </Button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error instanceof ActivityRequestError
            ? error.message
            : "没有完成，请稍后再试。"}
        </span>
      )}
    </span>
  );
}

function Calls({ scope, systemId }: { scope: RecordsScope; systemId: string }) {
  const query = useCallRecords(scope, systemId);
  const items = (query.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <List
      loading={query.isPending}
      failed={query.isError}
      onRetry={() => void query.refetch()}
      empty="还没有调用过。"
      more={query.hasNextPage}
      loadingMore={query.isFetchingNextPage}
      onMore={() => void query.fetchNextPage()}
    >
      {items.map((call) => (
        <div
          key={call.id}
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl bg-fill-2 px-3 py-2 text-sm"
        >
          <span className="text-ink">{callKinds[call.kind] ?? call.kind}</span>
          <StatusChip
            tone={
              call.result === "ok"
                ? "success"
                : call.result.startsWith("missed:")
                  ? "danger"
                  : "warning"
            }
          >
            {callResults[call.result] ?? call.result}
          </StatusChip>
          <span className="text-ink-2">
            {call.httpStatus ? `HTTP ${call.httpStatus} · ` : ""}
            {call.ms} ms · {clockLabel(call.at)}
          </span>
          {call.outTradeNo && (
            <span className="w-full font-mono text-xs break-all text-ink-3">
              本站单号 {call.outTradeNo}
            </span>
          )}
        </div>
      ))}
    </List>
  );
}

function List({
  loading,
  failed,
  onRetry,
  empty,
  more,
  loadingMore,
  onMore,
  children,
}: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  empty: string;
  more: boolean;
  loadingMore: boolean;
  onMore: () => void;
  children: React.ReactNode[];
}) {
  if (loading)
    return <p className="loading-sheen text-sm text-ink-3">正在读记录</p>;
  if (failed && children.length === 0)
    return (
      <p className="text-sm text-danger">
        没有读到记录。
        <Button size="xs" variant="quiet" onClick={onRetry}>
          再试一次
        </Button>
      </p>
    );
  if (children.length === 0)
    return <p className="text-sm text-ink-3">{empty}</p>;
  return (
    <div className="grid gap-2">
      {children}
      {more && (
        <Button
          size="sm"
          className={loadingMore ? "loading-sheen" : undefined}
          aria-disabled={loadingMore || undefined}
          onClick={() => {
            if (!loadingMore) onMore();
          }}
        >
          加载更多
        </Button>
      )}
    </div>
  );
}
