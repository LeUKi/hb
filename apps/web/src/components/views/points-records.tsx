// 三方积分's 发放记录 (docs/third-party-points-design.md §7), the same page
// for the 站长 (/admin/points/:id/records) and the issuer (/points/:id/
// records), laid out as the site's other lists (redesign 07 §1): the sums
// on top, a search that runs once typing pauses, then 要处理的 / 按红包 /
// 调用记录. The tab is in the address (?tab=), and so is a 红包 opened from
// 按红包 (?hongbao=, a step of its own: Back returns to the list), with its
// state filter (?filter=). Lists load 20 at a time as their end comes near.
// Only the 站长 may settle a payout with no known result.
import type { AmountUnit } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { activityPath } from "../../lib/activity-route";
import { cn } from "../../lib/cn";
import {
  type CallRecord,
  type HongbaoRecord,
  type PayoutFilter,
  type PayoutRecord,
  type PayoutTotals,
  payoutReasonWords,
  type RecordsScope,
  useAdminPointsActions,
  useAdminPointsDetail,
  useCallRecords,
  useHongbaoPayouts,
  useHongbaoRecords,
  useOwnPoints,
  useRecordsOverview,
  useSearchPayouts,
} from "../../lib/points";
import { clockLabel } from "../../lib/roster-time";
import { useSessionUser } from "../../lib/session";
import { amountText } from "../../lib/units";
import {
  type LazyList,
  LazyListEnd,
  useQueryLazyList,
} from "../page/lazy-list";
import { EmptyNote, Page, PageHeader, Panel } from "../page/page";
import {
  Bone,
  ListSkeleton,
  PageLoad,
  queryLoad,
  ResultError,
} from "../page/page-state";
import { useSearchChoice, useSearchStep } from "../shell/use-search-choice";
import { Button } from "../ui/button";
import { PointsCapsule } from "../ui/points-mark";
import { Swap } from "../ui/reveal";
import { Segmented } from "../ui/segmented";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { SearchBox, useSettled } from "./admin/admin-frame";
import { MessageView } from "./message-view";

const payoutStatus: Record<
  PayoutRecord["status"],
  { text: string; tone: "success" | "warning" | "danger" | "neutral" }
> = {
  pending: { text: "等待发放", tone: "neutral" },
  sending: { text: "发放中", tone: "neutral" },
  held: { text: "等领取者开户", tone: "warning" },
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

type Tab = "attention" | "hongbao" | "calls";
type Props = { scope: RecordsScope; systemId: string; unit: AmountUnit };

/** The page: the system read for its name and unit, then the records. */
export function PointsRecordsView({
  scope,
  id,
}: {
  scope: RecordsScope;
  id: string;
}) {
  const user = useSessionUser();
  const own = useOwnPoints(scope === "own" ? (user?.id ?? "") : "", id);
  const admin = useAdminPointsDetail(scope === "admin" ? id : "");
  const query = scope === "admin" ? admin : own;
  const system = query.data?.system;
  if (query.error instanceof ActivityRequestError && query.error.status === 404)
    return (
      <MessageView
        title="没有找到这种积分"
        text={
          scope === "admin"
            ? "地址不对，或者它已经不在了。"
            : "地址不对，或者它不是你添加的。"
        }
      />
    );
  return (
    <PageLoad load={queryLoad(query)}>
      {system && (
        <Page>
          <PageHeader
            back={
              scope === "admin"
                ? {
                    label: "三方积分",
                    href: `/admin/points?id=${encodeURIComponent(id)}`,
                  }
                : { label: "我添加的积分", href: "/points" }
            }
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                <PointsCapsule name={system.name} />
                发放记录
              </span>
            }
            description={
              scope === "admin"
                ? system.issuerName
                : "红包站每一次给领取者发你的积分、每一次调用你的接口，都在这里。"
            }
          />
          <Records
            scope={scope}
            systemId={system.id}
            unit={{ unit: system.unit, step: system.step }}
          />
        </Page>
      )}
    </PageLoad>
  );
}

function Records(props: Props) {
  const overview = useRecordsOverview(props.scope, props.systemId);
  const [tab, setTab] = useSearchChoice<Tab>("tab", "attention", [
    "attention",
    "hongbao",
    "calls",
  ]);
  const [typed, setTyped] = useState("");
  const q = useSettled(typed.trim());
  const attention = overview.data?.attention;
  return (
    <div className="grid gap-4">
      <Totals totals={overview.data?.totals} unit={props.unit} />
      <SearchBox
        label="找一笔发放"
        value={typed}
        onChange={setTyped}
        maxLength={128}
        placeholder="找一笔：用户名、LINUX DO ID 或单号"
      />
      <Swap id={q ? `search:${q}` : "tabs"}>
        {q ? (
          <SearchResults {...props} q={q} />
        ) : (
          <div className="grid gap-3">
            <Segmented
              label="看哪一部分"
              value={tab}
              onChange={setTab}
              options={[
                {
                  value: "attention",
                  label: "要处理的",
                  count: attention?.length,
                },
                { value: "hongbao", label: "按红包" },
                { value: "calls", label: "调用记录" },
              ]}
            />
            <Swap id={tab}>
              {tab === "attention" ? (
                <Attention {...props} />
              ) : tab === "hongbao" ? (
                <ByHongbao {...props} />
              ) : (
                <Calls scope={props.scope} systemId={props.systemId} />
              )}
            </Swap>
          </div>
        )}
      </Swap>
    </div>
  );
}

function Totals({
  totals,
  unit,
}: {
  totals: PayoutTotals | undefined;
  unit: AmountUnit;
}) {
  if (!totals)
    return (
      <Panel className="grid gap-2.5 p-4" aria-hidden="true">
        <Bone className="h-3.5 w-3/4" />
        <Bone className="h-3.5 w-2/3" />
      </Panel>
    );
  // Each part kept whole when the line wraps (a phone).
  const line = (span: PayoutTotals["today"]) => (
    <>
      <span className="whitespace-nowrap">
        到账 {span.confirmed.count} 笔，共{" "}
        {amountText(span.confirmed.amountMinor, unit)}
      </span>{" "}
      ·{" "}
      <span className="whitespace-nowrap">处理中 {span.waiting.count} 笔</span>{" "}
      ·{" "}
      <span
        className={cn(
          "whitespace-nowrap",
          span.failed.count > 0 && "text-danger",
        )}
      >
        没发出 {span.failed.count} 笔
      </span>
    </>
  );
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

/** A read list's place: bars, 重试, a note when empty, or the rows. */
function ListArea({
  pending,
  failed,
  onRetry,
  empty,
  children,
  list,
  done,
}: {
  pending: boolean;
  failed: boolean;
  onRetry: () => void;
  empty: ReactNode;
  children: ReactNode[];
  list?: LazyList;
  done?: string;
}) {
  if (pending) return <ListSkeleton rows={3} />;
  if (failed && children.length === 0) return <ResultError onRetry={onRetry} />;
  if (children.length === 0) return <>{empty}</>;
  return (
    <Panel className="grid px-1.5 py-1.5">
      <ul className="grid">{children}</ul>
      {list && <LazyListEnd list={list} done={done ?? "已全部加载"} />}
    </Panel>
  );
}

function SearchResults({ scope, systemId, unit, q }: Props & { q: string }) {
  const query = useSearchPayouts(scope, systemId, q);
  const items = query.data?.items ?? [];
  return (
    <ListArea
      pending={query.isPending}
      failed={query.isError}
      onRetry={() => void query.refetch()}
      empty={
        <EmptyNote
          title="没找到"
          text="用户名、ID 和单号都要写全；用户名按他现在的名字找。"
        />
      }
    >
      {items.map((payout) => (
        <PayoutRow
          key={payout.id}
          payout={payout}
          unit={unit}
          admin={scope === "admin"}
          withHongbao
        />
      ))}
    </ListArea>
  );
}

function Attention({ scope, systemId, unit }: Props) {
  const query = useRecordsOverview(scope, systemId);
  const items = query.data?.attention ?? [];
  return (
    <ListArea
      pending={query.isPending}
      failed={query.isError}
      onRetry={() => void query.refetch()}
      empty={
        <EmptyNote
          title="没有要处理的发放"
          text="结果不明的、在等领取者开户的、近 7 天没发出的会列在这里。"
        />
      }
    >
      {items.map((payout) => (
        <PayoutRow
          key={payout.id}
          payout={payout}
          unit={unit}
          admin={scope === "admin"}
          withHongbao
        />
      ))}
    </ListArea>
  );
}

/** 按红包: the list, or the 红包 opened from it (a step in the address). */
function ByHongbao(props: Props) {
  const step = useSearchStep("hongbao");
  return (
    <Swap id={step.value ?? "list"}>
      {step.value ? (
        <HongbaoPayouts {...props} hongbaoId={step.value} onBack={step.close} />
      ) : (
        <HongbaoList {...props} onOpen={step.open} />
      )}
    </Swap>
  );
}

function HongbaoList({
  scope,
  systemId,
  unit,
  onOpen,
}: Props & { onOpen: (id: string) => void }) {
  const query = useHongbaoRecords(scope, systemId);
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const items = (query.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <ListArea
      pending={query.isPending}
      failed={query.isError}
      onRetry={() => void query.refetch()}
      empty={
        <EmptyNote
          title="还没有用它发的红包"
          text="有人用这种积分开放红包以后，会按开放时间列在这里。"
        />
      }
      list={list}
      done={`共 ${items.length} 个`}
    >
      {items.map((hongbao) => (
        <li key={hongbao.id}>
          <Squircle radius={radius.row}>
            <button
              type="button"
              onClick={() => onOpen(hongbao.id)}
              className="flex w-full items-center gap-3 p-3 text-left text-sm transition-colors hover:bg-fill-2"
            >
              <HongbaoSummary hongbao={hongbao} unit={unit} />
              <ChevronRight
                className="size-4 shrink-0 text-ink-3"
                aria-hidden="true"
              />
            </button>
          </Squircle>
        </li>
      ))}
    </ListArea>
  );
}

function HongbaoState({ hongbao }: { hongbao: HongbaoRecord }) {
  return hongbao.deleted ? (
    <StatusChip tone="neutral">已删除</StatusChip>
  ) : hongbao.endedAt ? (
    <StatusChip tone="neutral">已结束</StatusChip>
  ) : (
    <StatusChip tone="success">进行中</StatusChip>
  );
}

function HongbaoSummary({
  hongbao,
  unit,
  title,
}: {
  hongbao: HongbaoRecord;
  unit: AmountUnit;
  /** The title as a link (the opened 红包's header), else plain. */
  title?: ReactNode;
}) {
  return (
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        {title ?? (
          <b className="truncate font-medium text-ink">{hongbao.title}</b>
        )}
        <HongbaoState hongbao={hongbao} />
      </span>
      <span className="text-ink-3">
        @{hongbao.authorUsername} 发的 · {clockLabel(hongbao.openedAt)} 开放 ·
        领了 {hongbao.claimedCount} 份
      </span>
      <span className="text-ink-2">
        已到账 {hongbao.confirmed.count} 笔，共{" "}
        {amountText(hongbao.confirmed.amountMinor, unit)}
        {hongbao.waiting.count > 0 && ` · 处理中 ${hongbao.waiting.count} 笔`}
        {hongbao.failed.count > 0 && (
          <span className="text-danger">
            {" "}
            · 没发出 {hongbao.failed.count} 笔
          </span>
        )}
      </span>
    </span>
  );
}

/** One 红包's payouts, by state, 20 at a time. */
function HongbaoPayouts({
  scope,
  systemId,
  unit,
  hongbaoId,
  onBack,
}: Props & { hongbaoId: string; onBack: () => void }) {
  const navigate = useNavigate();
  const [filter, setFilter] = useSearchChoice<PayoutFilter>("filter", "all", [
    "all",
    "confirmed",
    "waiting",
    "failed",
  ]);
  const query = useHongbaoPayouts(scope, systemId, hongbaoId, filter);
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const pages = query.data?.pages ?? [];
  const hongbao = pages[0]?.hongbao ?? null;
  const items = pages.flatMap((page) => page.items);
  const href = activityPath(hongbaoId);
  return (
    <div className="grid gap-3">
      <div>
        <Button variant="quiet" size="sm" className="gap-1" onClick={onBack}>
          <ChevronLeft aria-hidden="true" />
          所有红包
        </Button>
      </div>
      {hongbao ? (
        <Panel className="flex p-4 text-sm">
          <HongbaoSummary
            hongbao={hongbao}
            unit={unit}
            title={
              <a
                href={href}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                  event.preventDefault();
                  void navigate({ href });
                }}
                className="truncate text-base font-semibold text-ink underline-offset-2 hover:underline"
              >
                {hongbao.title}
              </a>
            }
          />
        </Panel>
      ) : (
        <Panel className="grid gap-2.5 p-4" aria-hidden="true">
          <Bone className="h-4 w-1/2" />
          <Bone className="h-3.5 w-2/3" />
        </Panel>
      )}
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
      <ListArea
        pending={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
        empty={<EmptyNote title="没有这样的发放" text="换个状态看看。" />}
        list={list}
        done={`共 ${items.length} 笔`}
      >
        {items.map((payout) => (
          <PayoutRow
            key={payout.id}
            payout={payout}
            unit={unit}
            admin={scope === "admin"}
          />
        ))}
      </ListArea>
    </div>
  );
}

function PayoutRow({
  payout,
  unit,
  admin,
  withHongbao = false,
}: {
  payout: PayoutRecord;
  unit: AmountUnit;
  admin: boolean;
  /** In 要处理的 and a search: which 红包, and whose. */
  withHongbao?: boolean;
}) {
  const navigate = useNavigate();
  const status = payoutStatus[payout.status];
  const why =
    payout.status === "failed" ||
    payout.status === "held" ||
    payout.status === "unknown"
      ? (payoutReasonWords[payout.reason ?? ""] ?? payout.reason)
      : null;
  const href = activityPath(payout.activityId);
  return (
    <li className="grid gap-0.5 border-line border-b px-3 py-2.5 text-sm last:border-b-0">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ink">
        <b className="tabular-nums">{amountText(payout.amountMinor, unit)}</b>
        <span className="min-w-0">
          @{payout.recipientUsername}
          <span className="text-ink-3">（ID {payout.recipientId}）</span>
        </span>
        <StatusChip tone={status.tone}>{status.text}</StatusChip>
        {why && <span className="text-ink-2">{why}</span>}
        {payout.resent && <span className="text-ink-3">重新发送过</span>}
        <span className="ml-auto text-xs text-ink-3 tabular-nums">
          {clockLabel(payout.updatedAt)}
        </span>
      </span>
      {withHongbao && (
        <span className="text-ink-2">
          <a
            href={href}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              void navigate({ href });
            }}
            className="font-medium text-ink underline-offset-2 hover:underline"
          >
            {payout.title}
          </a>{" "}
          · @{payout.authorUsername} 发的
        </span>
      )}
      <span className="font-mono text-xs break-all text-ink-3">
        本站单号 {payout.outTradeNo}
        {payout.tradeNo ? ` · 对方单号 ${payout.tradeNo}` : ""}
        {payout.attempts > 1 ? ` · 调用了 ${payout.attempts} 次` : ""}
      </span>
      {admin && payout.status === "unknown" && <SettleButtons id={payout.id} />}
    </li>
  );
}

/** The 站长's two answers to a payout with no known result. */
function SettleButtons({ id }: { id: string }) {
  const actions = useAdminPointsActions();
  const error = actions.payout.error;
  const busy = actions.payout.isPending;
  return (
    <span className="flex flex-wrap items-center gap-2 pt-1">
      <Button
        size="xs"
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) actions.payout.mutate({ id, action: "requery" });
        }}
      >
        再查一次
      </Button>
      <Button
        size="xs"
        variant="quiet"
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) actions.payout.mutate({ id, action: "fail" });
        }}
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
  const [which, setWhich] = useSearchChoice<"problems" | "all">(
    "calls",
    "problems",
    ["problems", "all"],
  );
  const query = useCallRecords(scope, systemId, which === "problems");
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const items = (query.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <div className="grid gap-3">
      <Segmented
        label="看哪些调用"
        size="sm"
        value={which}
        onChange={setWhich}
        options={[
          { value: "problems", label: "只看出错的" },
          { value: "all", label: "全部" },
        ]}
      />
      <ListArea
        pending={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
        empty={
          <EmptyNote
            title={
              which === "problems" ? "近 7 天的调用都成功了" : "还没有调用过"
            }
          />
        }
        list={list}
        done={`共 ${items.length} 次`}
      >
        {items.map((call) => (
          <li
            key={call.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-line border-b px-3 py-2.5 text-sm last:border-b-0"
          >
            <span className="text-ink">
              {callKinds[call.kind] ?? call.kind}
            </span>
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
              {call.ms} ms
            </span>
            <span className="ml-auto text-xs text-ink-3 tabular-nums">
              {clockLabel(call.at)}
            </span>
            {call.outTradeNo && (
              <span className="w-full font-mono text-xs break-all text-ink-3">
                本站单号 {call.outTradeNo}
              </span>
            )}
          </li>
        ))}
      </ListArea>
    </div>
  );
}
