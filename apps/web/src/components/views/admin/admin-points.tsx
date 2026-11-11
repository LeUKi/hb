// 网站管理 · 三方积分 (docs/third-party-points-design.md §7), laid out as
// the other admin lists (redesign 07 §10): the site switch; 需要留意 cards
// that open the list filtered; the systems as a list with a detail beside
// it (a dialog on a narrow window). The detail holds a system's state, its
// review and actions, its key facts and today's calls, and the way to its
// own pages — 配置, 发放记录, 调用记录, 文案改动, 接口测试记录 — each one
// level down with its way back. Read on 刷新; the chosen row is in the
// address (?id=), the filters too (?status=, ?anomaly=).
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, Clock } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ActivityRequestError } from "../../../lib/activities";
import { cn } from "../../../lib/cn";
import {
  type AdminPointsRow,
  statusWords,
  useAdminPoints,
  useAdminPointsActions,
} from "../../../lib/points";
import { clockLabel } from "../../../lib/roster-time";
import { amountText } from "../../../lib/units";
import type { AdminSearch } from "../../../router";
import type { LazyList } from "../../page/lazy-list";
import { EmptyNote, PageSection, Panel } from "../../page/page";
import { PageLoad, resultOf } from "../../page/page-state";
import { ConfirmDialog } from "../../shell/confirm-dialog";
import { useSearchChoice, useSearchStep } from "../../shell/use-search-choice";
import { Button } from "../../ui/button";
import { Field, Segmented, Switch, TextInput } from "../../ui/field";
import { PointsCapsule } from "../../ui/points-mark";
import { radius, Squircle } from "../../ui/squircle";
import { StatusChip } from "../../ui/status-chip";
import { statusTones } from "../points-view";
import {
  AdminFrame,
  countLine,
  DetailRows,
  FilterChip,
  ListDetail,
  listLoad,
} from "./admin-frame";

type StatusFilter =
  | "all"
  | "reviewing"
  | "online"
  | "paused"
  | "draft"
  | "retired";
type Anomaly = "payouts" | "changes" | "breaker";

const anomalyWords: Record<Anomaly, string> = {
  payouts: "有出问题的发放",
  changes: "有没看的文案改动",
  breaker: "熔断中",
};

/** A short list, read at once: nothing more to load. */
const whole: LazyList = {
  shown: Number.POSITIVE_INFINITY,
  endRef: () => {},
  state: "done",
  retry: () => {},
  paged: false,
};

const resting = (row: AdminPointsRow) =>
  row.breakerUntil !== null && row.breakerUntil > Date.now();

export function AdminPoints({ search }: { search: AdminSearch }) {
  const navigate = useNavigate({ from: "/admin/points" });
  const query = useAdminPoints();
  const actions = useAdminPointsActions();
  const [status, setStatus] = useSearchChoice<StatusFilter>("status", "all", [
    "all",
    "reviewing",
    "online",
    "paused",
    "draft",
    "retired",
  ]);
  const selected = useSearchStep("id");
  const anomaly =
    search.anomaly === "payouts" ||
    search.anomaly === "changes" ||
    search.anomaly === "breaker"
      ? search.anomaly
      : null;
  const data = query.data;
  const systems = data?.systems ?? [];
  const rows = systems.filter(
    (row) =>
      (status === "all" || row.status === status) &&
      (anomaly === null ||
        (anomaly === "payouts" && row.attention > 0) ||
        (anomaly === "changes" && row.unseenChanges > 0) ||
        (anomaly === "breaker" && resting(row))),
  );
  const cards: Card[] = [
    {
      key: "reviewing",
      label: "待审核",
      count: systems.filter((row) => row.status === "reviewing").length,
      severe: false,
      search: { status: "reviewing" },
    },
    {
      key: "payouts",
      label: "出问题的发放",
      count: systems.reduce((sum, row) => sum + row.attention, 0),
      severe: true,
      search: { anomaly: "payouts" },
    },
    {
      key: "changes",
      label: "没看的文案改动",
      count: systems.reduce((sum, row) => sum + row.unseenChanges, 0),
      severe: false,
      search: { anomaly: "changes" },
    },
    {
      key: "breaker",
      label: "熔断中",
      count: systems.filter(resting).length,
      severe: true,
      search: { anomaly: "breaker" },
    },
  ];
  return (
    <PageLoad load={listLoad(query)} area frame>
      <AdminFrame>
        {data && (
          <Panel className="p-4">
            <Switch
              checked={data.settings.enabled}
              label="三方积分红包"
              description="关着时不能新建、开放三方积分红包；已经开放的照常领取和发放。"
              disabled={actions.settings.isPending}
              onChange={(enabled) =>
                actions.settings.mutate({
                  enabled,
                  version: data.settings.version,
                })
              }
            />
          </Panel>
        )}
        <PageSection title="需要留意">
          <ul className="grid grid-cols-2 gap-3 @wide/window:grid-cols-4">
            {cards.map((card) => (
              <li key={card.key}>
                <AttentionCard card={card} />
              </li>
            ))}
          </ul>
        </PageSection>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            label="状态"
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "全部" },
              { value: "reviewing", label: "待审核" },
              { value: "online", label: "已上线" },
              { value: "paused", label: "已暂停" },
              { value: "draft", label: "草稿" },
              { value: "retired", label: "已下架" },
            ]}
          />
          {anomaly && (
            <FilterChip
              label={anomalyWords[anomaly]}
              onClear={() =>
                void navigate({
                  search: (prev) => ({ ...prev, anomaly: undefined }),
                  replace: true,
                })
              }
            />
          )}
          <span className="ml-auto text-sm text-ink-3">
            {data ? countLine(rows.length, "种") : ""}
          </span>
        </div>
        <ListDetail
          items={rows}
          list={whole}
          total={rows.length}
          load={resultOf(query)}
          selectedId={selected.value}
          onSelect={selected.choose}
          placeholder="点一种积分看详情。"
          unit="种"
          noun="积分"
          empty={
            <EmptyNote
              title={systems.length ? "没有符合条件的积分" : "还没有人添加积分"}
              text={
                systems.length
                  ? "换个筛选看看。"
                  : "开通🐟额 PLUS 的人可以在“三方积分”里添加，提交后在这里审核。"
              }
            />
          }
          row={(row) => <RowBody row={row} />}
          detail={(row) => <Detail row={row} />}
        />
      </AdminFrame>
    </PageLoad>
  );
}

type Card = {
  key: string;
  label: string;
  count: number;
  /** Red (needs handling) rather than amber (worth a look). */
  severe: boolean;
  search: { status?: string; anomaly?: string };
};

/** As 概览's: grey at zero; red or amber with an icon, and a way in. */
function AttentionCard({ card }: { card: Card }) {
  const hot = card.count > 0;
  const body = (
    <>
      <span className="text-sm text-ink-2">{card.label}</span>
      <span
        className={cn(
          "flex items-center gap-1.5 text-2xl font-semibold tabular-nums",
          !hot ? "text-ink-3" : card.severe ? "text-danger" : "text-warning",
        )}
      >
        {hot &&
          (card.severe ? (
            <AlertTriangle className="size-5" aria-hidden="true" />
          ) : (
            <Clock className="size-5" aria-hidden="true" />
          ))}
        {card.count}
        {hot && (
          <span className="sr-only">
            {card.severe ? "，需要处理" : "，需要留意"}
          </span>
        )}
      </span>
      {hot && (
        <span className="flex items-center gap-0.5 text-xs text-ink-3">
          查看
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </span>
      )}
    </>
  );
  return hot ? (
    <Squircle radius={radius.card}>
      <Link
        to="/admin/points"
        search={card.search}
        replace
        className="panel grid h-full content-start gap-1 p-4 transition-colors hover:bg-white/80"
      >
        {body}
      </Link>
    </Squircle>
  ) : (
    <Panel className="grid h-full content-start gap-1 p-4">{body}</Panel>
  );
}

function RowBody({ row }: { row: AdminPointsRow }) {
  return (
    <span className="grid min-w-0 flex-1 gap-0.5 text-sm">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <PointsCapsule name={row.name} small />
        <span className="truncate font-medium text-ink">{row.issuerName}</span>
        <StatusChip tone={statusTones[row.status]}>
          {statusWords[row.status]}
        </StatusChip>
        {resting(row) && <StatusChip tone="danger">熔断中</StatusChip>}
        {row.attention > 0 && (
          <StatusChip tone="danger" dot>
            {row.attention} 笔出问题
          </StatusChip>
        )}
        {row.unseenChanges > 0 && (
          <StatusChip tone="warning" dot>
            {row.unseenChanges} 处改动没看
          </StatusChip>
        )}
      </span>
      <span className="truncate text-ink-3">
        {row.host} · @{row.ownerUsername} · 开放中 {row.openHongbao} 个
      </span>
      <span className="text-ink-3">
        今天发放 {row.today.calls.transfer ?? 0} 次 · 有回复{" "}
        {row.today.answeredRate === null
          ? "—"
          : `${Math.round(row.today.answeredRate * 100)}%`}
      </span>
    </span>
  );
}

function Detail({ row }: { row: AdminPointsRow }) {
  const unit = { unit: row.unit, step: row.step };
  const base = `/admin/points/${encodeURIComponent(row.id)}`;
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <span className="flex flex-wrap items-center gap-2">
          <PointsCapsule name={row.name} />
          <b className="text-base text-ink">{row.issuerName}</b>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <StatusChip tone={statusTones[row.status]}>
            {statusWords[row.status]}
          </StatusChip>
          {row.status === "paused" && row.pausedBy === "admin" && (
            <span className="text-xs text-ink-3">站长暂停的</span>
          )}
          {resting(row) && (
            <StatusChip tone="danger">
              熔断到 {clockLabel(row.breakerUntil ?? 0)}
            </StatusChip>
          )}
        </span>
      </div>
      {row.status === "reviewing" && <Review row={row} />}
      <DetailRows
        rows={[
          {
            label: "域名",
            value: (
              <a
                href={`https://${row.host}`}
                target="_blank"
                rel="noreferrer noopener"
                className="underline-offset-2 hover:underline"
              >
                {row.host}
              </a>
            ),
          },
          { label: "添加的人", value: `@${row.ownerUsername}` },
          { label: "最小单位", value: amountText(row.step, unit) },
          { label: "每秒最多调用", value: `${row.rate} 次` },
          {
            label: "接口测试",
            value: row.passed ? "当前接口地址已通过" : "当前接口地址没通过",
          },
          {
            label: "上线",
            value: row.onlineAt ? clockLabel(row.onlineAt) : "还没上线",
          },
          { label: "开放中的红包", value: `${row.openHongbao} 个` },
          {
            label: "今天调用",
            value: `查余额 ${row.today.calls.balance ?? 0} · 发放 ${row.today.calls.transfer ?? 0} · 查单 ${row.today.calls.query ?? 0}`,
          },
          {
            label: "有回复",
            value:
              row.today.answeredRate === null
                ? "今天还没调用"
                : `${Math.round(row.today.answeredRate * 100)}%，平均 ${row.today.averageMs ?? "—"} ms`,
          },
          ...(row.missedInRow > 0
            ? [{ label: "连续没回复", value: `${row.missedInRow} 次` }]
            : []),
        ]}
      />
      <nav aria-label="这种积分的页面" className="grid">
        <PageLink href={`${base}/config`} label="配置" />
        <PageLink
          href={`${base}/records`}
          label="发放记录"
          note={row.attention > 0 ? `${row.attention} 笔出问题` : undefined}
          hot={row.attention > 0}
        />
        <PageLink href={`${base}/records?tab=calls`} label="调用记录" />
        <PageLink
          href={`${base}/changes`}
          label="文案改动"
          note={
            row.unseenChanges > 0 ? `${row.unseenChanges} 处没看` : undefined
          }
          hot={row.unseenChanges > 0}
        />
        <PageLink href={`${base}/tests`} label="接口测试记录" />
      </nav>
      {row.status !== "retired" && row.status !== "reviewing" && (
        <Actions row={row} />
      )}
    </div>
  );
}

/** One of the system's own pages: a row that goes there. */
function PageLink({
  href,
  label,
  note,
  hot = false,
}: {
  href: string;
  label: string;
  note?: ReactNode;
  hot?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <a
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        void navigate({ href });
      }}
      className="-mx-2 flex items-center gap-2 rounded-lg border-line border-b px-2 py-2.5 text-sm text-ink transition-colors last:border-b-0 hover:bg-fill-2"
    >
      <span className="flex-1">{label}</span>
      {note && (
        <span className={cn("text-xs", hot ? "text-danger" : "text-ink-3")}>
          {note}
        </span>
      )}
      <ChevronRight className="size-4 text-ink-3" aria-hidden="true" />
    </a>
  );
}

function Review({ row }: { row: AdminPointsRow }) {
  const actions = useAdminPointsActions();
  const [note, setNote] = useState("");
  const error = actions.review.error;
  return (
    <div className="grid gap-2 rounded-xl bg-fill px-3 py-3">
      <p className="text-sm text-ink-2">
        提交于 {row.submittedAt ? clockLabel(row.submittedAt) : "—"}
        。通过前先看“配置”里的每段说明文字。
      </p>
      <Field label="审核意见" htmlFor={`review-${row.id}`} optional>
        <TextInput
          id={`review-${row.id}`}
          value={note}
          maxLength={200}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error instanceof ActivityRequestError
            ? error.message
            : "审核没有完成，请稍后再试。"}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          aria-disabled={actions.review.isPending || undefined}
          onClick={() => {
            if (actions.review.isPending) return;
            actions.review.mutate({
              id: row.id,
              approve: true,
              note: note.trim(),
            });
          }}
        >
          {actions.review.isPending ? "正在提交…" : "通过，上线"}
        </Button>
        <Button
          size="sm"
          aria-disabled={actions.review.isPending || undefined}
          onClick={() => {
            if (actions.review.isPending) return;
            actions.review.mutate({
              id: row.id,
              approve: false,
              note: note.trim(),
            });
          }}
        >
          退回
        </Button>
      </div>
    </div>
  );
}

/** 暂停 / 恢复 at once; 下架 asks first (its open 红包 end). */
function Actions({ row }: { row: AdminPointsRow }) {
  const actions = useAdminPointsActions();
  const [retiring, setRetiring] = useState(false);
  const error = actions.act.error;
  const busy = actions.act.isPending;
  return (
    <div className="grid gap-2 border-line border-t pt-3">
      {error && !retiring && (
        <p role="alert" className="text-sm text-danger">
          {error instanceof ActivityRequestError
            ? error.message
            : "没有完成，请稍后再试。"}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {row.status === "online" && (
          <Button
            size="sm"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) actions.act.mutate({ id: row.id, action: "pause" });
            }}
          >
            暂停
          </Button>
        )}
        {row.status === "paused" && (
          <Button
            size="sm"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) actions.act.mutate({ id: row.id, action: "resume" });
            }}
          >
            恢复
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={() => setRetiring(true)}>
          下架
        </Button>
      </div>
      <ConfirmDialog
        open={retiring}
        onClose={() => setRetiring(false)}
        busy={busy}
        title={`下架「${row.name}」`}
        text={`下架后不能再用它发红包，开放中的 ${row.openHongbao} 个红包立即结束，没发出的不再发。下架不能撤回。`}
        error={
          error
            ? error instanceof ActivityRequestError
              ? error.message
              : "下架没有完成，请稍后再试。"
            : null
        }
        actions={
          <>
            <Button onClick={() => setRetiring(false)}>返回</Button>
            <Button
              variant="danger"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                actions.act.mutate(
                  { id: row.id, action: "retire" },
                  { onSuccess: () => setRetiring(false) },
                );
              }}
            >
              {busy ? "正在下架…" : "下架"}
            </Button>
          </>
        }
      />
    </div>
  );
}
