import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { activities, type FixtureActivity } from "../../../fixtures/activities";
import { createdAtOf, siteUsers } from "../../../fixtures/admin";
import {
  drawStateOf,
  isArchived,
  publicOf,
  takenOf,
} from "../../../fixtures/hongbao";
import { isOpenPayment, sitePayments } from "../../../fixtures/payments";
import {
  activityCode,
  activityIdFromCode,
  parseRedPacketAddress,
} from "../../../lib/activity-route";
import { clockLabel } from "../../../lib/roster-time";
import { drawSimAtom } from "../../../lib/store";
import type { AdminSearch } from "../../../router";
import { statusOf } from "../../hongbao/hongbao-card";
import { normalizeTopic } from "../../hongbao-form/form-state";
import { useOmniboxController } from "../../omnibox/use-omnibox-controller";
import { EmptyNote } from "../../page/page";
import { useSearchChoice } from "../../shell/use-search-choice";
import { Button } from "../../ui/button";
import { CopyButton } from "../../ui/copy-button";
import { Segmented } from "../../ui/field";
import { MiniEnvelope } from "../../ui/mini-envelope";
import { StatusChip } from "../../ui/status-chip";
import {
  AdminFrame,
  DetailRows,
  FilterChip,
  ListDetail,
  SearchBox,
  ToggleChip,
} from "./admin-frame";

type Lifecycle = "all" | "draft" | "active" | "ended" | "archived";

const drawLabels = {
  waiting: "等待开奖",
  settling: "开奖中",
  completed: "已开奖",
  empty: "无人报名",
} as const;

/** Title, ID, emoji code, a 红包 link or a post link, like production. */
function matches(activity: FixtureActivity, query: string) {
  const text = query.trim();
  if (!text) return true;
  const exact =
    activityIdFromCode(text) ??
    parseRedPacketAddress(text, window.location.origin) ??
    (/^[0-9a-f-]{36}$/i.test(text) ? text.toLowerCase() : null);
  if (exact) return activity.id === exact;
  const topic = normalizeTopic(text);
  if (topic.ok && "topicId" in topic && topic.topicId)
    return (
      activity.topic?.topicId === topic.topicId &&
      activity.topic.postNumber === topic.postNumber
    );
  return activity.title.toLowerCase().includes(text.toLowerCase());
}

/**
 * /admin/activities 红包: every 红包 (drafts too), newest first, searchable;
 * the detail shows its numbers and payments. Read-only: an admin cannot
 * change, end or delete someone else's 红包 (production has no such action).
 */
export function AdminActivities({ search }: { search: AdminSearch }) {
  const navigate = useNavigate({ from: "/admin/activities" });
  const drawSim = useAtomValue(drawSimAtom);
  const { leaveTo } = useOmniboxController();
  const [query, setQuery] = useState(search.q ?? "");
  const [lifecycle, setLifecycle] = useSearchChoice<Lifecycle>(
    "status",
    "all",
    ["all", "draft", "active", "ended", "archived"],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const drawOnly = search.anomaly === "draw";
  const now = Date.now();
  const payments = sitePayments();

  const rows = activities
    .map((activity) => {
      const view = publicOf(activity, { solved: [], drawSim, now });
      const group: Exclude<Lifecycle, "all"> = activity.draft
        ? "draft"
        : !view.endReason || view.endReason === "settling"
          ? "active"
          : isArchived(activity, view, now)
            ? "archived"
            : "ended";
      return { id: activity.id, activity, view, group };
    })
    .filter(
      (row) =>
        (lifecycle === "all" || row.group === lifecycle) &&
        (!search.author || row.activity.author.username === search.author) &&
        (!drawOnly ||
          (row.activity.mode === "timed_draw" &&
            row.view.endReason === "settling")) &&
        matches(row.activity, query),
    )
    .sort((a, b) => createdAtOf(b.id) - createdAtOf(a.id));
  const author = search.author
    ? siteUsers().find((user) => user.username === search.author)
    : null;

  return (
    <AdminFrame
      refreshable
      description="全站的红包，草稿也在内。只能查看，不能修改、结束或删除。"
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox
            label="搜索红包"
            value={query}
            onChange={setQuery}
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
              label={`发红包的人：${author?.displayName ?? search.author}`}
              onClear={() =>
                void navigate({
                  search: (prev) => ({ ...prev, author: undefined }),
                  replace: true,
                })
              }
            />
          )}
          <span className="ml-auto text-sm text-ink-3">{rows.length} 个</span>
        </div>
      </div>
      <ListDetail
        items={rows}
        selectedId={selected}
        onSelect={setSelected}
        placeholder="点一个红包看详情。"
        empty={<EmptyNote title="没有符合条件的红包" />}
        row={({ activity, view, group }) => {
          const status = activity.draft
            ? { text: "草稿", tone: "neutral" as const }
            : group === "archived"
              ? { text: "已归档", tone: "neutral" as const }
              : statusOf(view);
          const taken =
            view.quantity.kind === "exact"
              ? `${view.quantity.taken} / ${view.quantity.total}`
              : `${activity.entries.length} / ${activity.shares}`;
          return (
            <>
              <MiniEnvelope
                ended={group === "ended" || group === "archived"}
                draft={Boolean(activity.draft)}
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
                  {activity.author.displayName} · 参与 {taken} ·{" "}
                  {clockLabel(createdAtOf(activity.id))} 创建
                </span>
              </span>
            </>
          );
        }}
        detail={({ activity, view, group }) => {
          const own = payments.filter(
            (payment) => payment.activityId === activity.id,
          );
          // Counts include the demo account's own earlier claim (`mine`).
          const taken = takenOf(activity, { solved: [], drawSim, now });
          const draw =
            activity.mode === "timed_draw" && !activity.draft
              ? drawStateOf(activity, drawSim, now, taken)
              : null;
          return (
            <>
              <div className="grid gap-1">
                <p className="text-base font-semibold text-ink">
                  {activity.title}
                </p>
                <p className="text-xs text-ink-3">
                  {activity.author.displayName}的红包 · {activity.rewardSummary}
                </p>
              </div>
              <DetailRows
                rows={[
                  {
                    label: "红包 ID",
                    value: (
                      <span className="flex items-center gap-1">
                        <span className="min-w-0 font-mono text-xs">
                          {activity.id}
                        </span>
                        <CopyButton value={activity.id} label="红包 ID" />
                      </span>
                    ),
                  },
                  {
                    label: "地址",
                    value: (
                      <span className="font-emoji text-xs">
                        /🧧/{activityCode(activity.id)}
                      </span>
                    ),
                  },
                  {
                    label: "参与方式",
                    value:
                      activity.participation === "password"
                        ? `口令 ${activity.passwords.length} 个${activity.statistics ? " · 统计尝试" : ""}`
                        : "无需口令",
                  },
                  activity.mode === "timed_draw"
                    ? {
                        label: "报名",
                        value: `${taken} 人 · 名额 ${activity.shares} 个${activity.participantLimit ? ` · 上限 ${activity.participantLimit} 人` : ""}`,
                      }
                    : {
                        label: "份数",
                        value: `已领 ${taken} / ${activity.shares}，剩 ${Math.max(0, activity.shares - taken)}`,
                      },
                  {
                    label: "状态",
                    value: activity.draft
                      ? "草稿"
                      : group === "archived"
                        ? "已归档"
                        : statusOf(view).text,
                  },
                  ...(draw
                    ? [{ label: "开奖状态", value: drawLabels[draw] }]
                    : []),
                  {
                    label: "关联帖子",
                    value: activity.topic
                      ? `linux.do/t/topic/${activity.topic.topicId}/${activity.topic.postNumber}`
                      : "—",
                  },
                  {
                    label: "付款",
                    value: `${own.length} 笔 · 没确认 ${own.filter(isOpenPayment).length} · 异常待处理 ${own.filter((payment) => payment.state === "attention").length}`,
                  },
                  {
                    label: "开放",
                    value: activity.draft
                      ? "还没开放"
                      : clockLabel(view.openedAt),
                  },
                  {
                    label:
                      activity.mode === "timed_draw" ? "开奖时间" : "截止时间",
                    value: clockLabel(view.deadlineAt),
                  },
                ]}
              />
              <div className="flex flex-wrap gap-2">
                {!activity.draft && (
                  <Button
                    size="sm"
                    onClick={() =>
                      void leaveTo({ to: "activity", id: activity.id })
                    }
                  >
                    打开红包
                  </Button>
                )}
                {own.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void navigate({
                        to: "/admin/payments",
                        search: { activity: activity.id },
                      })
                    }
                  >
                    看它的付款
                  </Button>
                )}
              </div>
              <p className="text-xs text-ink-3">
                管理后台只读：不能修改、结束或删除别人的红包。
              </p>
            </>
          );
        }}
      />
    </AdminFrame>
  );
}
