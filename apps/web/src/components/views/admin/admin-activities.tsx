import type { AdminActivityDetail, AdminActivityListItem } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { activityCode } from "../../../lib/activity-route";
import {
  useAdminActivity,
  useAdminList,
  useAdminUser,
  useStopCode,
  useStopPage,
} from "../../../lib/admin";
import { cn } from "../../../lib/cn";
import { type SentRecord, sentRecordOf } from "../../../lib/records";
import { clockLabel } from "../../../lib/roster-time";
import { useIdentity } from "../../../lib/session";
import type { AdminSearch } from "../../../router";
import { statusOf } from "../../hongbao/hongbao-card";
import { useOmniboxController } from "../../omnibox/use-omnibox-controller";
import { useQueryLazyList } from "../../page/lazy-list";
import { EmptyNote } from "../../page/page";
import { Bone, PageLoad, resultOf } from "../../page/page-state";
import { ConfirmDialog } from "../../shell/confirm-dialog";
import { useSearchChoice } from "../../shell/use-search-choice";
import { Button } from "../../ui/button";
import { CopyButton } from "../../ui/copy-button";
import { Segmented } from "../../ui/field";
import { MiniEnvelope } from "../../ui/mini-envelope";
import { StatusChip } from "../../ui/status-chip";
import {
  AdminFrame,
  countLine,
  DetailRetry,
  DetailRows,
  FilterChip,
  ListDetail,
  listLoad,
  SearchBox,
  ToggleChip,
  useOpenSearched,
  useSettled,
} from "./admin-frame";

type Lifecycle = "all" | "draft" | "active" | "ended" | "archived";

/** Production's draw states, in words (it showed the English names). */
const drawLabels: Record<string, string> = {
  waiting: "等待开奖",
  settling: "开奖中",
  completed: "已开奖",
  empty: "无人报名",
};

type Row = AdminActivityListItem & { record: SentRecord };

/** As the sender's own lists say it: 草稿 / 进行中 / 开奖中 / 已领完 … */
function statusLine({ record }: Row) {
  const { activity, view, archived } = record;
  const tag = statusOf(view, {
    draft: activity.draft,
    archived,
    scheduled: activity.scheduledOpenAt !== undefined,
  });
  // 开奖中 is still running (its result is to come).
  const ended =
    !activity.draft && Boolean(view.endReason) && view.endReason !== "settling";
  return { ...tag, ended };
}

/**
 * Taken so far: shares claimed, people signed up for a draw, or (protocol
 * 5, no shares) what is left of the pool.
 */
function takenLine({ record, ...item }: Row) {
  const { activity, view } = record;
  if (activity.mode === "timed_draw") return `报名 ${item.registeredCount} 人`;
  if (view.quantity.kind === "pool")
    return `${item.claimedCount} 人领到 · 奖池还剩 ${view.quantity.left}${view.quantity.share ? `（${view.quantity.share}）` : ""}`;
  return `参与 ${item.claimedCount} / ${item.totalCount}`;
}

function RowBody({ row }: { row: Row }) {
  const { activity } = row.record;
  const status = statusLine(row);
  return (
    <>
      <MiniEnvelope
        ended={status.ended}
        draft={activity.draft}
        code={activity.participation === "code"}
      />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-base font-medium text-ink">
            {activity.title}
          </span>
          <StatusChip tone={status.tone} dot>
            {status.text}
          </StatusChip>
        </span>
        <span className="truncate text-xs text-ink-3">
          {row.author.displayName || row.authorDisplayName} · {takenLine(row)} ·{" "}
          {clockLabel(row.createdAt)} 创建
        </span>
      </span>
    </>
  );
}

/**
 * 停用 (07 §10): the one exception to a read-only 红包 tab, for a running
 * 代码判定红包. It stops claims and gives the rest back to its sender
 * (a 🐟额红包's; a 商户直发's shares nobody took are not sent).
 */
function StopCode({ row, title }: { row: Row; title: string }) {
  const identity = useIdentity();
  const stop = useStopCode(identity.csrfToken ?? "");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = stop.isPending;
  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
        停用
      </Button>
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          if (busy) return;
          setConfirming(false);
          setError(null);
        }}
        busy={busy}
        title={`停用「${title}」？`}
        text={
          row.summary.funding === "balance"
            ? "停用后不能再领，剩下的退回红包作者的🐟额。"
            : "停用后不能再领，没领的份不再发。"
        }
        error={error}
        actions={
          <>
            <Button
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                setConfirming(false);
                setError(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                setError(null);
                stop.mutate(row.id, {
                  onSuccess: () => setConfirming(false),
                  onError: (failure) =>
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : "停用没有完成，请再试一次。",
                    ),
                });
              }}
            >
              {busy ? "正在停用…" : error ? "再试一次" : "停用"}
            </Button>
          </>
        }
      />
    </>
  );
}

/** 停用附带网页 (docs/attached-page-design.md §1): the page goes, for good. */
function StopPage({ row, title }: { row: Row; title: string }) {
  const identity = useIdentity();
  const stop = useStopPage(identity.csrfToken ?? "");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = stop.isPending;
  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
        停用附带网页
      </Button>
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          if (busy) return;
          setConfirming(false);
          setError(null);
        }}
        busy={busy}
        title={`停用「${title}」的附带网页？`}
        text="停用后，这个红包页不再显示附带的网页，不能恢复。"
        error={error}
        actions={
          <>
            <Button
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                setConfirming(false);
                setError(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                setError(null);
                stop.mutate(row.id, {
                  onSuccess: () => setConfirming(false),
                  onError: (failure) =>
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : "停用没有完成，请再试一次。",
                    ),
                });
              }}
            >
              {busy ? "正在停用…" : error ? "再试一次" : "停用"}
            </Button>
          </>
        }
      />
    </>
  );
}

function Detail({ row }: { row: Row }) {
  const navigate = useNavigate({ from: "/admin/activities" });
  const { leaveTo } = useOmniboxController();
  const query = useAdminActivity(row.id);
  const more: AdminActivityDetail | undefined = query.data?.activity;
  const { activity, view, archived } = row.record;
  const draw = activity.mode === "timed_draw";
  // Read with the detail: a short grey bar until it is in.
  const later = (value: (detail: AdminActivityDetail) => ReactNode) =>
    more ? value(more) : query.isError ? "—" : <Bone className="h-3 w-28" />;
  const limit = view.draw?.limit ?? null;
  return (
    <>
      <div className="grid gap-1">
        <p className="text-base font-semibold text-ink">{activity.title}</p>
        <p className="text-xs text-ink-3">
          {activity.author.displayName}的红包
          {activity.rewardSummary ? ` · ${activity.rewardSummary}` : ""}
        </p>
      </div>
      <DetailRows
        rows={[
          {
            label: "红包 ID",
            value: (
              <span className="flex items-center gap-1">
                <span className="min-w-0 font-mono text-xs">{row.id}</span>
                <CopyButton value={row.id} label="红包 ID" />
              </span>
            ),
          },
          {
            label: "地址",
            value: (
              <span className="font-emoji text-xs">
                /🧧/{activityCode(row.id)}
              </span>
            ),
          },
          {
            label: "参与方式",
            value:
              row.participationMode === "password"
                ? later(
                    (detail) =>
                      `口令 ${detail.passwordCount} 个${activity.pageOnly ? " · 关闭首页领取" : ""}`,
                  )
                : row.participationMode === "code"
                  ? "代码判定"
                  : "无需口令",
          },
          // 代码判定红包: its fingerprint and how its code is doing; never
          // the code or anyone's input.
          ...(row.participationMode === "code"
            ? [
                {
                  label: "代码指纹",
                  value: later((detail) =>
                    detail.code ? (
                      <span className="font-mono text-xs break-all">
                        {detail.code.fingerprint}
                      </span>
                    ) : (
                      "—"
                    ),
                  ),
                },
                {
                  label: "代码",
                  value: later((detail) =>
                    !detail.code
                      ? "—"
                      : detail.code.stoppedAt
                        ? `${clockLabel(detail.code.stoppedAt)} 由 ${detail.code.stoppedBy ?? "站长"} 停用`
                        : detail.code.pausedAt
                          ? `连续出错，${clockLabel(detail.code.pausedAt)} 起暂停领取`
                          : `正常 · 连续出错 ${detail.code.failuresInRow} 次`,
                  ),
                },
              ]
            : []),
          draw
            ? {
                label: "报名",
                value: `${row.registeredCount} 人 · 抽 ${activity.shares} 人${limit ? ` · 上限 ${limit} 人` : ""}`,
              }
            : {
                label: "份数",
                value: `已领 ${row.claimedCount} / ${row.totalCount} 份，剩 ${Math.max(0, row.totalCount - row.claimedCount)} 份`,
              },
          {
            label: "状态",
            value: activity.draft
              ? "草稿"
              : archived
                ? "已归档"
                : statusOf(view).text,
          },
          ...(draw && !activity.draft && row.drawState
            ? [
                {
                  label: "开奖状态",
                  value: drawLabels[row.drawState] ?? row.drawState,
                },
              ]
            : []),
          {
            label: "关联帖子",
            value: row.topicId
              ? `linux.do/t/topic/${row.topicId}/${row.postNumber}`
              : "—",
          },
          {
            label: "附带网页",
            value: later((detail) =>
              !detail.page
                ? "—"
                : detail.page.stoppedAt
                  ? `${detail.page.url} · ${clockLabel(detail.page.stoppedAt)} 由 ${detail.page.stoppedBy ?? "站长"} 停用`
                  : detail.page.url,
            ),
          },
          {
            label: "付款",
            // A 🐟额红包 pays nothing out (balance-design §14).
            value:
              row.summary.funding === "balance"
                ? "从🐟额发，没有付款"
                : later(({ payments }) =>
                    [
                      `${payments.total} 笔`,
                      `未确认 ${payments.pending}`,
                      `异常待处理 ${payments.attention}`,
                      ...(payments.unknown
                        ? [`结果未知 ${payments.unknown}`]
                        : []),
                    ].join(" · "),
                  ),
          },
          {
            label: "开放",
            value: row.openedAt ? clockLabel(row.openedAt) : "还没开放",
          },
          {
            label: draw ? "开奖时间" : "截止时间",
            // A draft's duration only starts counting when it opens.
            value: row.summary.deadlineAt
              ? clockLabel(Date.parse(row.summary.deadlineAt))
              : activity.draft
                ? "开放后开始计时"
                : "—",
          },
        ]}
      />
      <DetailRetry query={query} />
      <div className="flex flex-wrap gap-2">
        {!activity.draft && (
          <Button
            size="sm"
            onClick={() => void leaveTo({ to: "activity", id: row.id })}
          >
            打开红包
          </Button>
        )}
        {row.participationMode === "code" &&
          !activity.draft &&
          !view.endReason &&
          more?.code &&
          !more.code.stoppedAt && <StopCode row={row} title={activity.title} />}
        {more?.page && !more.page.stoppedAt && (
          <StopPage row={row} title={activity.title} />
        )}
        {(more?.payments.total ?? 0) > 0 && (
          <Button
            size="sm"
            variant="quiet"
            onClick={() =>
              void navigate({
                to: "/admin/payments",
                search: { activity: row.id },
              })
            }
          >
            看它的付款
          </Button>
        )}
      </div>
    </>
  );
}

/**
 * /admin/activities 红包: every 红包 (drafts too), newest first, searchable;
 * the detail shows its numbers and payments. Read-only: an admin cannot
 * change, end or delete someone else's 红包 (production has no such action).
 */
export function AdminActivities({ search }: { search: AdminSearch }) {
  const navigate = useNavigate({ from: "/admin/activities" });
  const [query, setQuery] = useState(search.q ?? "");
  const q = useSettled(query.trim());
  const [lifecycle, setLifecycle] = useSearchChoice<Lifecycle>(
    "status",
    "all",
    ["all", "draft", "active", "ended", "archived"],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const drawOnly = search.anomaly === "draw";
  // From a user's detail; one the server would refuse is shown, not sent.
  const authorId =
    search.author && search.author.length <= 128 ? search.author : null;
  const listQuery = useAdminList("activities", {
    q: q || undefined,
    status: lifecycle === "all" ? undefined : lifecycle,
    drawException: drawOnly ? "1" : undefined,
    authorId: authorId ?? undefined,
  });
  const detail = useAdminActivity(selected);
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
  const rows: Row[] = pages
    .flatMap((page) => page.items)
    .filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)))
    .map((item) => ({
      ...item,
      record: sentRecordOf(item.summary, item.author),
    }));
  useOpenSearched(
    search.q,
    q,
    listQuery.data && !busy ? rows : undefined,
    setSelected,
  );
  // The filter's name: from the rows, otherwise read (or cached from the
  // user's detail it came from).
  const authorRow = rows.find((row) => authorId && row.authorId === authorId);
  const author = useAdminUser(
    authorId,
    listQuery.data !== undefined && !busy && !authorRow,
  );
  const authorName =
    authorId === null
      ? "编号无效"
      : (authorRow?.author.displayName ??
        author.data?.user.displayName ??
        (author.isError ? authorId : "…"));

  return (
    // The search and filters stay once shown; the list loads in place.
    <PageLoad load={listLoad(listQuery, selected ? detail : null)} area frame>
      <AdminFrame>
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchBox
              label="搜索红包"
              value={query}
              onChange={setQuery}
              maxLength={2048}
              placeholder="标题、红包 ID、表情码、红包链接或帖子链接"
            />
            <ToggleChip
              pressed={drawOnly}
              onChange={(pressed) =>
                void navigate({
                  search: (prev) => ({
                    ...prev,
                    anomaly: pressed ? "draw" : undefined,
                  }),
                  replace: true,
                })
              }
            >
              开奖异常
            </ToggleChip>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              size="sm"
              label="状态"
              value={lifecycle}
              onChange={setLifecycle}
              options={[
                { value: "all", label: "全部" },
                { value: "draft", label: "草稿" },
                { value: "active", label: "进行中" },
                { value: "ended", label: "已结束" },
                { value: "archived", label: "已归档" },
              ]}
            />
            {search.author && (
              <FilterChip
                label={`红包作者：${authorName}`}
                onClear={() =>
                  void navigate({
                    search: (prev) => ({ ...prev, author: undefined }),
                    replace: true,
                  })
                }
              />
            )}
            <span
              className={cn(
                "ml-auto text-sm text-ink-3 transition-opacity",
                busy && "opacity-60",
              )}
            >
              {countLine(total, "个")}
            </span>
          </div>
        </div>
        <ListDetail
          items={rows}
          list={list}
          total={total}
          load={resultOf(listQuery)}
          selectedId={selected}
          onSelect={setSelected}
          placeholder="点一个红包看详情。"
          unit="个"
          noun="红包"
          empty={<EmptyNote title="没有符合条件的红包" text="换个筛选看看。" />}
          row={(row) => <RowBody row={row} />}
          detail={(row) => <Detail row={row} />}
        />
      </AdminFrame>
    </PageLoad>
  );
}
