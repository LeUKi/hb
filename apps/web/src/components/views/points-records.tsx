// 三方积分's 发放记录 and 调用记录 (docs/third-party-points-design.md §7).
// A 红包 can have hundreds of payouts, so they are not one long list: the
// sums, what needs someone (要处理的), then the system's 红包 newest first,
// each with its own sums; one opened shows its payouts, 50 at a time, by
// state. A search finds one payout by recipient or order number. The calls
// show failures first. The same on the 站长's panel and on the issuer's own
// page (/points/:id/records); only the 站长 may settle a payout with no
// known result. Read on open and on 加载更多; nothing refreshes by itself.
import type { AmountUnit } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
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
import { Page, PageHeader, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { Button } from "../ui/button";
import { TextInput } from "../ui/field";
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
    <div className="grid gap-4">
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

type Props = { scope: RecordsScope; systemId: string; unit: AmountUnit };

function Payouts(props: Props) {
  const [hongbao, setHongbao] = useState<HongbaoRecord | null>(null);
  const [searched, setSearched] = useState("");
  if (hongbao)
    return (
      <HongbaoPayouts
        {...props}
        hongbao={hongbao}
        onBack={() => setHongbao(null)}
      />
    );
  return (
    <div className="grid gap-4">
      <Overview {...props} />
      <SearchBox value={searched} onSearch={setSearched} />
      {searched ? (
        <SearchResults {...props} q={searched} />
      ) : (
        <>
          <Attention {...props} />
          <HongbaoList {...props} onOpen={setHongbao} />
        </>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function Overview({ scope, systemId, unit }: Props) {
  const query = useRecordsOverview(scope, systemId);
  const totals = query.data?.totals;
  if (!totals)
    return (
      <Panel className="loading-sheen p-4 text-sm text-ink-3">正在算合计</Panel>
    );
  return <Totals totals={totals} unit={unit} />;
}

function Totals({ totals, unit }: { totals: PayoutTotals; unit: AmountUnit }) {
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

/** Enter (or 搜索) searches; the X goes back to the lists. */
function SearchBox({
  value,
  onSearch,
}: {
  value: string;
  onSearch: (q: string) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(text.trim());
      }}
    >
      <TextInput
        className="flex-1"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (!event.target.value) onSearch("");
        }}
        placeholder="找一笔：用户名、ID 或单号"
        aria-label="找一笔发放"
        prefix={<Search className="size-4" aria-hidden="true" />}
        suffix={
          text ? (
            <button
              type="button"
              aria-label="清除"
              className="grid size-6 place-items-center rounded-full text-ink-3 hover:bg-fill-2"
              onClick={() => {
                setText("");
                onSearch("");
              }}
            >
              <X className="size-4" />
            </button>
          ) : undefined
        }
      />
      <Button type="submit">搜索</Button>
    </form>
  );
}

function SearchResults({ scope, systemId, unit, q }: Props & { q: string }) {
  const query = useSearchPayouts(scope, systemId, q);
  const items = query.data?.items ?? [];
  return (
    <Section title={`“${q}” 的发放`}>
      <List
        loading={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
        empty="没找到。用户名要写全；单号要写全。"
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
      </List>
    </Section>
  );
}

function Attention({ scope, systemId, unit }: Props) {
  const query = useRecordsOverview(scope, systemId);
  const items = query.data?.attention ?? [];
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          要处理的
          {items.length > 0 && (
            <StatusChip tone="danger" dot>
              {items.length} 笔
            </StatusChip>
          )}
        </span>
      }
    >
      <List
        loading={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
        empty="没有。结果不明、等开户和近 7 天没发出的会列在这里。"
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
      </List>
    </Section>
  );
}

function HongbaoList({
  scope,
  systemId,
  unit,
  onOpen,
}: Props & { onOpen: (hongbao: HongbaoRecord) => void }) {
  const query = useHongbaoRecords(scope, systemId);
  const items = (query.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <Section title="按红包">
      <List
        loading={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
        empty="还没有用它发的红包。"
        more={query.hasNextPage}
        loadingMore={query.isFetchingNextPage}
        onMore={() => void query.fetchNextPage()}
      >
        {items.map((hongbao) => (
          <button
            key={hongbao.id}
            type="button"
            onClick={() => onOpen(hongbao)}
            className="flex items-center gap-3 rounded-xl bg-fill-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[rgb(42_21_25/0.12)]"
          >
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <b className="truncate font-medium text-ink">{hongbao.title}</b>
                <HongbaoState hongbao={hongbao} />
              </span>
              <span className="text-ink-3">
                @{hongbao.authorUsername} 发的 · {clockLabel(hongbao.openedAt)}{" "}
                开放 · 领了 {hongbao.claimedCount} 份
              </span>
              <SumsLine hongbao={hongbao} unit={unit} />
            </span>
            <ChevronRight
              className="size-4 shrink-0 text-ink-3"
              aria-hidden="true"
            />
          </button>
        ))}
      </List>
    </Section>
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

function SumsLine({
  hongbao,
  unit,
}: {
  hongbao: HongbaoRecord;
  unit: AmountUnit;
}) {
  return (
    <span className="text-ink-2">
      已到账 {hongbao.confirmed.count} 笔，共{" "}
      {amountText(hongbao.confirmed.amountMinor, unit)}
      {hongbao.waiting.count > 0 && ` · 处理中 ${hongbao.waiting.count} 笔`}
      {hongbao.failed.count > 0 && (
        <span className="text-danger"> · 没发出 {hongbao.failed.count} 笔</span>
      )}
    </span>
  );
}

/** One 红包's payouts, by state, 50 at a time. */
function HongbaoPayouts({
  scope,
  systemId,
  unit,
  hongbao,
  onBack,
}: Props & { hongbao: HongbaoRecord; onBack: () => void }) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<PayoutFilter>("all");
  const query = useHongbaoPayouts(scope, systemId, hongbao.id, filter);
  const items = (query.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <div className="grid gap-3">
      <div>
        <Button variant="quiet" size="sm" className="gap-1" onClick={onBack}>
          <ChevronLeft aria-hidden="true" />
          所有红包
        </Button>
      </div>
      <Panel className="grid gap-1 p-4 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          <a
            href={activityPath(hongbao.id)}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              void navigate({ href: activityPath(hongbao.id) });
            }}
            className="truncate text-base font-semibold text-ink underline-offset-2 hover:underline"
          >
            {hongbao.title}
          </a>
          <HongbaoState hongbao={hongbao} />
        </span>
        <span className="text-ink-3">
          @{hongbao.authorUsername} 发的 · {clockLabel(hongbao.openedAt)} 开放 ·
          领了 {hongbao.claimedCount} 份
        </span>
        <SumsLine hongbao={hongbao} unit={unit} />
      </Panel>
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
        empty="没有这样的发放。"
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
  return (
    <div className="grid gap-0.5 rounded-xl bg-fill-2 px-3 py-2 text-sm">
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
          · @{payout.authorUsername} 发的
        </span>
      )}
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
  const [problems, setProblems] = useState(true);
  const query = useCallRecords(scope, systemId, problems);
  const items = (query.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <div className="grid gap-3">
      <Segmented
        label="看哪些调用"
        size="sm"
        value={problems ? "problems" : "all"}
        onChange={(value) => setProblems(value === "problems")}
        options={[
          { value: "problems", label: "只看出错的" },
          { value: "all", label: "全部" },
        ]}
      />
      <List
        loading={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
        empty={problems ? "近 7 天的调用都成功了。" : "还没有调用过。"}
        more={query.hasNextPage}
        loadingMore={query.isFetchingNextPage}
        onMore={() => void query.fetchNextPage()}
      >
        {items.map((call) => (
          <div
            key={call.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl bg-fill-2 px-3 py-2 text-sm"
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
          </div>
        ))}
      </List>
    </div>
  );
}

function List({
  loading,
  failed,
  onRetry,
  empty,
  more = false,
  loadingMore = false,
  onMore,
  children,
}: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  empty: string;
  more?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
  children: ReactNode[];
}) {
  if (loading)
    return <p className="loading-sheen text-sm text-ink-3">正在读记录</p>;
  if (failed && children.length === 0)
    return (
      <p className="flex items-center gap-2 text-sm text-danger">
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
      {more && onMore && (
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
