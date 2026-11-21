// 网站管理 · 三方积分 (docs/third-party-points-design.md §7), laid out as
// the other admin lists (redesign 07 §10): the site switch; 需要留意 cards
// that open the list filtered; the systems as a list with a detail beside
// it (a dialog on a narrow window). The detail holds a system's state, its
// review and actions, its key facts and today's calls, and the way to its
// own pages — 配置, 发放记录, 调用记录, 文案改动, 接口测试记录 — each one
// level down with its way back. Read on 刷新; the chosen row is in the
// address (?id=), the filters too (?status=, ?anomaly=).
import { type AmountUnit, POINTS_LIMITS } from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, Clock } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ActivityRequestError } from "../../../lib/activities";
import { cn } from "../../../lib/cn";
import {
  type AdminPointsRow,
  failedShare,
  type PayoutQuality,
  pointsKeys,
  statusWords,
  useAdminPoints,
  useAdminPointsActions,
  useAdminPointsUsage,
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
import { MorphLabel } from "../../ui/morph-label";
import { PersonName } from "../../ui/person";
import { PointsCapsule } from "../../ui/points-mark";
import { radius, Squircle } from "../../ui/squircle";
import { StatusChip } from "../../ui/status-chip";
import { statusTones } from "../points-view";
import {
  AdminFrame,
  countLine,
  DetailRetry,
  DetailRows,
  FilterChip,
  ListDetail,
  listLoad,
} from "./admin-frame";
import { PointsTrend } from "./points-trend";

type StatusFilter =
  | "all"
  | "reviewing"
  | "online"
  | "paused"
  | "draft"
  | "retired";
type Anomaly = "payouts" | "changes" | "breaker" | "owner_paused" | "failing";

const anomalyWords: Record<Anomaly, string> = {
  payouts: "有出问题的发放",
  changes: "有没看的文案改动",
  breaker: "熔断中",
  owner_paused: "添加的人暂停的",
  failing: "失败率高",
};

type SortOrder = "status" | "volume" | "failed" | "online";

/** The list's order: as the server gives it (by state), or by a number. */
function sortRows(rows: AdminPointsRow[], sort: SortOrder) {
  if (sort === "status") return rows;
  const ended = (row: AdminPointsRow) =>
    row.week.confirmed +
    row.week.noRecipient +
    row.week.notAllowed +
    row.week.otherFailed;
  const key = (row: AdminPointsRow) =>
    sort === "volume"
      ? ended(row)
      : sort === "failed"
        ? (failedShare(row.week) ?? -1)
        : (row.onlineAt ?? -1);
  return [...rows].sort((a, b) => key(b) - key(a));
}

const ownerPaused = (row: AdminPointsRow) =>
  row.status === "paused" && row.pausedBy !== "admin";

/** "12%", or "—" with nothing ended. */
const percent = (share: number | null) =>
  share === null ? "—" : `${Math.round(share * 100)}%`;

/** 发放质量 (§17) in a line: through, and each failure by why. */
function qualityLine(quality: PayoutQuality) {
  const parts = [`到账 ${quality.confirmed} 笔`];
  if (quality.noRecipient) parts.push(`找不到收款人 ${quality.noRecipient}`);
  if (quality.notAllowed) parts.push(`不允许 ${quality.notAllowed}`);
  if (quality.otherFailed) parts.push(`其他失败 ${quality.otherFailed}`);
  if (quality.waiting) parts.push(`处理中 ${quality.waiting}`);
  const share = failedShare(quality);
  return `${parts.join(" · ")}${share === null ? "" : `（失败 ${percent(share)}）`}`;
}

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

/** Who paused it: the 站长, or the one who added it (they cannot undo the 站长's). */
const pausedByWords = (row: AdminPointsRow) =>
  row.status !== "paused"
    ? null
    : `${row.pausedBy === "admin" ? "站长" : "添加的人"}${row.pausedAt ? ` ${clockLabel(row.pausedAt)} ` : ""}暂停的`;

export function AdminPoints({ search }: { search: AdminSearch }) {
  const navigate = useNavigate({ from: "/admin/points" });
  const query = useAdminPoints();
  const [status, setStatus] = useSearchChoice<StatusFilter>("status", "all", [
    "all",
    "reviewing",
    "online",
    "paused",
    "draft",
    "retired",
  ]);
  // 列表排序 (§17 第三批), in the address with the rest.
  const [sort, setSort] = useSearchChoice<SortOrder>("sort", "status", [
    "status",
    "volume",
    "failed",
    "online",
  ]);
  const selected = useSearchStep("id");
  // The open detail's 用量 reads again on 刷新 too (sweep 2026-11-21 ADM-8).
  const usage = useAdminPointsUsage(selected.value ?? "");
  const anomaly =
    search.anomaly === "payouts" ||
    search.anomaly === "changes" ||
    search.anomaly === "breaker" ||
    search.anomaly === "owner_paused" ||
    search.anomaly === "failing"
      ? search.anomaly
      : null;
  const data = query.data;
  const systems = data?.systems ?? [];
  const rows = sortRows(
    systems.filter(
      (row) =>
        (status === "all" || row.status === status) &&
        (anomaly === null ||
          (anomaly === "payouts" && row.attention > 0) ||
          (anomaly === "changes" && row.unseenChanges > 0) ||
          (anomaly === "breaker" && resting(row)) ||
          (anomaly === "owner_paused" && ownerPaused(row)) ||
          (anomaly === "failing" && row.failing)),
    ),
    sort,
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
    // §17: worth a look, not a fault of this site's.
    {
      key: "owner_paused",
      label: "添加的人暂停的",
      count: systems.filter(ownerPaused).length,
      severe: false,
      search: { anomaly: "owner_paused" },
    },
    {
      key: "failing",
      label: "失败率高",
      count: systems.filter((row) => row.failing).length,
      severe: false,
      search: { anomaly: "failing" },
    },
  ];
  return (
    <PageLoad load={listLoad(query, selected.value ? usage : null)} area frame>
      <AdminFrame>
        {data && (
          <Panel className="p-4">
            <SiteSwitch settings={data.settings} />
          </Panel>
        )}
        <PageSection title="需要留意">
          <ul className="grid grid-cols-2 gap-3 @wide/window:grid-cols-3">
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
          <Segmented
            size="sm"
            label="排序"
            value={sort}
            onChange={setSort}
            options={[
              { value: "status", label: "按状态" },
              { value: "volume", label: "发放最多" },
              { value: "failed", label: "失败率最高" },
              { value: "online", label: "最近上线" },
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

type SiteSettings = NonNullable<
  ReturnType<typeof useAdminPoints>["data"]
>["settings"];

/**
 * 三方积分红包, the site's switch, as the other instant switches (私信通知,
 * 排行榜): the knob moves at once, goes back if the save fails and says so
 * under it. The saved settings, with their new version, go straight into
 * the list's read, so a second tap neither waits for the reload nor meets
 * a 409 over its own first one; a 409 from elsewhere reads the latest
 * (sweep 2026-11-21 ADM-3).
 */
function SiteSwitch({ settings }: { settings: SiteSettings }) {
  const save = useAdminPointsActions().settings;
  const queryClient = useQueryClient();
  const [moving, setMoving] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<"failed" | "conflict" | null>(null);
  return (
    <Switch
      checked={moving ?? settings.enabled}
      label="三方积分红包"
      description={
        <MorphLabel fit={false}>
          {problem === "conflict"
            ? "刚在别处改过，已经按最新的显示，请再看一下。"
            : problem === "failed"
              ? "没有保存，请稍后再试。"
              : "关着时不能新建、开放三方积分红包；已经开放的照常领取和发放。"}
        </MorphLabel>
      }
      onChange={(enabled) => {
        if (save.isPending) return;
        setMoving(enabled);
        setProblem(null);
        save.mutate(
          { enabled, version: settings.version },
          {
            onSuccess: (reply) => {
              // PATCH answers { settings } (points/routes.ts).
              const saved = (reply as { settings?: SiteSettings } | null)
                ?.settings;
              if (saved)
                queryClient.setQueryData<{ settings: SiteSettings }>(
                  pointsKeys.admin,
                  (data) => data && { ...data, settings: saved },
                );
              setMoving(null);
            },
            onError: (failure) => {
              setMoving(null);
              const conflict =
                failure instanceof ActivityRequestError &&
                failure.status === 409;
              setProblem(conflict ? "conflict" : "failed");
              if (conflict)
                void queryClient.invalidateQueries({
                  queryKey: pointsKeys.admin,
                  exact: true,
                });
            },
          },
        );
      }}
    />
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
        {row.status === "paused" && (
          <span className="text-xs text-ink-3">
            {row.pausedBy === "admin" ? "站长暂停的" : "添加的人暂停的"}
          </span>
        )}
        {resting(row) && <StatusChip tone="danger">熔断中</StatusChip>}
        {row.failing && <StatusChip tone="warning">失败率高</StatusChip>}
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
        近 7 天到账 {row.week.confirmed} 笔 · 失败{" "}
        {percent(failedShare(row.week))} · 今天有回复{" "}
        {percent(row.today.answeredRate)}
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
          {row.status === "paused" && (
            <span className="text-xs text-ink-3">{pausedByWords(row)}</span>
          )}
          {row.failing && <StatusChip tone="warning">失败率高</StatusChip>}
          {resting(row) && (
            <StatusChip tone="danger">
              熔断到 {clockLabel(row.breakerUntil ?? 0)}
            </StatusChip>
          )}
        </span>
      </div>
      {row.status === "paused" && row.pauseReason && (
        <p className="text-sm text-ink-2">原因：{row.pauseReason}</p>
      )}
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
          {
            label: "添加的人",
            // 联系添加的人 (§17 第三批): their card, with their 社区 profile.
            value: (
              <PersonName
                name={`@${row.ownerUsername}`}
                username={row.ownerUsername}
              />
            ),
          },
          { label: "最小单位", value: amountText(row.step, unit) },
          {
            label: "每秒最多调用",
            value:
              row.status === "retired" ? (
                `${row.rate} 次`
              ) : (
                <RateValue row={row} />
              ),
          },
          {
            label: "接口测试",
            value: row.passed ? "当前接口地址已通过" : "当前接口地址没通过",
          },
          {
            label: "上线",
            value: row.onlineAt ? clockLabel(row.onlineAt) : "还没上线",
          },
          { label: "开放中的红包", value: `${row.openHongbao} 个` },
          // 发放质量 (§17): failures by why, not only the broken answers.
          { label: "近 7 天发放", value: qualityLine(row.week) },
          { label: "近 24 小时", value: qualityLine(row.day) },
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
      <Usage id={row.id} unit={unit} />
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
        <PageLink href={`${base}/events`} label="操作记录" />
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
  // The row's hover fill is a squircle (04 §8); the line under it is its
  // wrapper's, outside the squircle, whose clip would trim the line's ends
  // (sweep 2026-11-21).
  return (
    <div className="-mx-2 border-line border-b last:border-b-0">
      <Squircle radius={radius.row}>
        <a
          href={href}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            void navigate({ href });
          }}
          className="flex items-center gap-2 px-2 py-2.5 text-sm text-ink transition-colors hover:bg-fill-2"
        >
          <span className="flex-1">{label}</span>
          {note && (
            <span className={cn("text-xs", hot ? "text-danger" : "text-ink-3")}>
              {note}
            </span>
          )}
          <ChevronRight className="size-4 text-ink-3" aria-hidden="true" />
        </a>
      </Squircle>
    </div>
  );
}

function Review({ row }: { row: AdminPointsRow }) {
  const actions = useAdminPointsActions();
  const [note, setNote] = useState("");
  const error = actions.review.error;
  // Which answer is on its way: only that button says so, not 通过 for a
  // 退回 (sweep 2026-11-21 ADM-5).
  const sending = actions.review.isPending
    ? actions.review.variables?.approve
    : undefined;
  return (
    // A fill box: the callout's squircle (04 §8; sweep 2026-11-21).
    <Squircle radius={radius.callout}>
      <div className="grid gap-2 bg-fill px-3 py-3">
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
            {sending === true ? "正在提交…" : "通过，上线"}
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
            {sending === false ? "正在退回…" : "退回"}
          </Button>
        </div>
      </div>
    </Squircle>
  );
}

/**
 * 暂停 asks for a reason (optional; §17: it goes into the 操作记录, the
 * adder's 私信 and where it shows as paused); 恢复 at once when the 站长
 * paused it, but one its adder paused themself asks first (they may be
 * fixing their side, and are told it is back); 下架 asks first (its open
 * 红包 end).
 */
function Actions({ row }: { row: AdminPointsRow }) {
  const actions = useAdminPointsActions();
  const [retiring, setRetiring] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [reason, setReason] = useState("");
  const theirs = row.status === "paused" && row.pausedBy !== "admin";
  const error = actions.act.error;
  const busy = actions.act.isPending;
  return (
    <div className="grid gap-2 border-line border-t pt-3">
      {error && !retiring && !resuming && !pausing && (
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
              actions.act.reset();
              setReason("");
              setPausing(true);
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
              if (theirs) setResuming(true);
              else if (!busy)
                actions.act.mutate({ id: row.id, action: "resume" });
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
        open={pausing}
        onClose={() => setPausing(false)}
        busy={busy}
        title={`暂停「${row.name}」`}
        text={`暂停后不能用它发新红包，开放中的 ${row.openHongbao} 个红包暂停领取和发放，恢复后接着来。添加的人 @${row.ownerUsername} 会收到私信。`}
        error={
          pausing && error
            ? error instanceof ActivityRequestError
              ? error.message
              : "暂停没有完成，请稍后再试。"
            : null
        }
        actions={
          <>
            <Button
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) setPausing(false);
              }}
            >
              返回
            </Button>
            <Button
              variant="primary"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                actions.act.mutate(
                  { id: row.id, action: "pause", reason: reason.trim() },
                  { onSuccess: () => setPausing(false) },
                );
              }}
            >
              {busy ? "正在暂停…" : "暂停"}
            </Button>
          </>
        }
      >
        <Field
          label="原因"
          htmlFor={`pause-${row.id}`}
          optional
          hint="写进操作记录和给添加的人的私信；他的积分页和详情页上也看得到。"
        >
          <TextInput
            id={`pause-${row.id}`}
            value={reason}
            maxLength={100}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={resuming}
        onClose={() => setResuming(false)}
        busy={busy}
        title={`恢复「${row.name}」`}
        text={`这是添加它的 @${row.ownerUsername}${row.pausedAt ? ` 在 ${clockLabel(row.pausedAt)} ` : " "}自己暂停的，他可能正在处理那边的网站。恢复后马上又能用它发红包和领取，他会收到私信。`}
        error={
          resuming && error
            ? error instanceof ActivityRequestError
              ? error.message
              : "恢复没有完成，请稍后再试。"
            : null
        }
        actions={
          <>
            <Button
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) setResuming(false);
              }}
            >
              返回
            </Button>
            <Button
              variant="primary"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                actions.act.mutate(
                  { id: row.id, action: "resume" },
                  { onSuccess: () => setResuming(false) },
                );
              }}
            >
              {busy ? "正在恢复…" : "恢复"}
            </Button>
          </>
        }
      />
      <ConfirmDialog
        open={retiring}
        onClose={() => setRetiring(false)}
        busy={busy}
        title={`下架「${row.name}」`}
        text={`下架后不能再用它发红包，开放中的 ${row.openHongbao} 个红包将立即结束，尚未发放的奖励将终止发放。下架不能撤回。`}
        error={
          error
            ? error instanceof ActivityRequestError
              ? error.message
              : "下架没有完成，请稍后再试。"
            : null
        }
        actions={
          <>
            <Button
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) setRetiring(false);
              }}
            >
              返回
            </Button>
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

/**
 * 用量 and 近 14 天走势 (§17 第二批), read when the detail opens: keys (how
 * many failed), 红包 and their senders, who got some, and what went out.
 */
function Usage({ id, unit }: { id: string; unit: AmountUnit }) {
  const query = useAdminPointsUsage(id);
  const data = query.data;
  // 用量读取失败。 with 重试 (07 §1; sweep 2026-11-21 ADM-8).
  if (query.isError && !data) return <DetailRetry query={query} what="用量" />;
  if (!data)
    return <p className="loading-sheen text-sm text-ink-3">正在读用量和走势</p>;
  const { usage, trend } = data;
  return (
    <div className="grid gap-3 border-line border-t pt-3">
      <DetailRows
        rows={[
          {
            label: "填了密钥",
            value: `${usage.keys} 人${usage.invalidKeys ? `（${usage.invalidKeys} 把失效）` : ""}`,
          },
          {
            label: "用它发的红包",
            value: `${usage.hongbao} 个，${usage.senders} 人发`,
          },
          { label: "领到的人", value: `${usage.claimants} 人` },
          {
            label: "近 7 天发出",
            value: `${amountText(usage.week.amountMinor, unit)}（${usage.week.count} 笔）`,
          },
          {
            label: "一共发出",
            value: `${amountText(usage.all.amountMinor, unit)}（${usage.all.count} 笔）`,
          },
        ]}
      />
      <PointsTrend days={trend} />
    </div>
  );
}

/**
 * 每秒最多调用 with 调整 (§17 第三批): the 站长 can turn it down when the
 * issuer cannot keep up; its adder is told, and it is in the 操作记录.
 */
function RateValue({ row }: { row: AdminPointsRow }) {
  const actions = useAdminPointsActions();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(row.rate));
  const rate = Number(value);
  const valid =
    Number.isSafeInteger(rate) && rate >= 1 && rate <= POINTS_LIMITS.rateMax;
  const busy = actions.rate.isPending;
  const error = actions.rate.error;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {row.rate} 次
      <Button
        size="xs"
        variant="quiet"
        aria-haspopup="dialog"
        onClick={() => {
          actions.rate.reset();
          setValue(String(row.rate));
          setOpen(true);
        }}
      >
        调整
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        busy={busy}
        title={`调整「${row.name}」的每秒最多调用`}
        text={`红包站调用 ${row.host} 的接口时，每秒不超过这个次数。对方扛不住时可以先调低；添加的人 @${row.ownerUsername} 会收到私信，操作记录里也会记下。`}
        error={
          error
            ? error instanceof ActivityRequestError
              ? error.message
              : "调整没有完成，请稍后再试。"
            : null
        }
        actions={
          <>
            <Button
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) setOpen(false);
              }}
            >
              返回
            </Button>
            <Button
              variant="primary"
              aria-disabled={busy || !valid || rate === row.rate || undefined}
              onClick={() => {
                if (busy || !valid || rate === row.rate) return;
                actions.rate.mutate(
                  { id: row.id, rate },
                  { onSuccess: () => setOpen(false) },
                );
              }}
            >
              {busy ? "正在保存…" : "保存"}
            </Button>
          </>
        }
      >
        <Field
          label="每秒最多调用"
          htmlFor={`rate-${row.id}`}
          hint={`1 到 ${POINTS_LIMITS.rateMax} 次，现在是 ${row.rate} 次。`}
          error={valid ? null : `要在 1 到 ${POINTS_LIMITS.rateMax} 之间`}
          live
        >
          <TextInput
            id={`rate-${row.id}`}
            inputMode="numeric"
            value={value}
            invalid={!valid}
            onChange={(event) => setValue(event.target.value.trim())}
          />
        </Field>
      </ConfirmDialog>
    </span>
  );
}
