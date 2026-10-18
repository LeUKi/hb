import { PAYMENT_LABELS } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, LayoutGrid, Plus } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useHistorySummary } from "../../lib/activities";
import { activityCode } from "../../lib/activity-route";
import { cn } from "../../lib/cn";
import { paymentTone } from "../../lib/hongbao-text";
import {
  type JoinedRecord,
  joinedRecordOf,
  type SentRecord,
  sentCounts,
  sentRecordOf,
  useJoinedPages,
  useSentPages,
} from "../../lib/records";
import { clockLabel } from "../../lib/roster-time";
import { type SessionUser, useSessionUser } from "../../lib/session";
import { quantityLine, statusOf } from "../hongbao/hongbao-card";
import { SenderLinks } from "../hongbao/sender-links";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { EmptyNote, Page, PageHeader, Panel } from "../page/page";
import {
  PageLoad,
  queriesLoad,
  queryLoad,
  ResultLoad,
  resultOf,
} from "../page/page-state";
import { useSearchChoice } from "../shell/use-search-choice";
import { useWindowInfo } from "../shell/window-info";
import { Button } from "../ui/button";
import { Segmented } from "../ui/field";
import { MiniEnvelope } from "../ui/mini-envelope";
import { RollingText } from "../ui/morph-label";
import { ListItem, Reveal } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";

type Tab = "sent" | "joined";
/** In the address as 已结束 reads; the API calls it finished. */
type SentFilter = "all" | "active" | "draft" | "ended";

/** 草稿 / 进行中 / 开奖中 / 已领完 … / 已归档 for a 红包 this account sent. */
function sentStatus({ activity, view, archived }: SentRecord) {
  const tag = statusOf(view, { draft: activity.draft, archived });
  // 开奖中 is still running (its result is to come), as on the square.
  const ended =
    !activity.draft && Boolean(view.endReason) && view.endReason !== "settling";
  return { ...tag, ended };
}

function SentRow({ record }: { record: SentRecord }) {
  const { leaveTo } = useOmniboxController();
  const { compact } = useWindowInfo();
  const navigate = useNavigate();
  const { activity, view } = record;
  const status = sentStatus(record);
  const draw = activity.mode === "timed_draw";
  const open = () =>
    activity.draft
      ? void navigate({
          to: "/🧧/$code/📝",
          params: { code: activityCode(activity.id) },
        })
      : void leaveTo({ to: "activity", id: activity.id });
  return (
    <ListItem
      className={cn(
        "flex items-center gap-2",
        compact ? "flex-wrap gap-y-0" : "pr-2",
      )}
    >
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={open}
          className="flex min-w-0 flex-1 items-center gap-3.5 p-3 text-left transition-colors hover:bg-fill-2"
        >
          <MiniEnvelope ended={status.ended} draft={activity.draft} />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-base font-medium text-ink">
                {activity.title}
              </span>
              <StatusChip tone={status.tone} dot>
                {status.text}
              </StatusChip>
            </span>
            <span className="truncate text-sm text-ink-2">
              {activity.rewardSummary}
              {!activity.draft && ` · ${quantityLine(activity, view)}`}
            </span>
            <span className="truncate text-xs text-ink-3">
              {activity.draft
                ? "还没开放，只有你能看到"
                : view.endReason
                  ? `${clockLabel(view.openedAt)} 开放`
                  : `${clockLabel(view.openedAt)} 开放 · ${draw ? "开奖" : "截止"} ${clockLabel(view.deadlineAt)}`}
            </span>
          </span>
        </button>
      </Squircle>
      {/* Narrow windows: labelled, in a line (or two) under the 红包. */}
      <span
        className={cn(
          "flex shrink-0 items-center gap-0.5",
          compact && "basis-full flex-wrap gap-1 pb-2 pl-[4.25rem]",
        )}
      >
        <SenderLinks activity={activity} iconsOnly={!compact} inList />
      </span>
    </ListItem>
  );
}

function JoinedRow({ item }: { item: JoinedRecord }) {
  const { leaveTo } = useOmniboxController();
  const { outcome, payment, verb } = item;
  // A running 红包's 口令 stays off the list: a screenshot of it would give
  // the 口令 away (05 §9). It is public once the 红包 ended.
  const how = !item.password
    ? `直接${verb}`
    : item.ended
      ? `用口令 ${item.password} ${verb}`
      : `用口令${verb}`;
  return (
    <ListItem>
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={() => void leaveTo({ to: "activity", id: item.activityId })}
          className="flex w-full items-center gap-3.5 p-3 text-left transition-colors hover:bg-fill-2"
        >
          <MiniEnvelope ended={item.ended} />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-base font-medium text-ink">
              {item.title}
            </span>
            <span className="truncate text-sm text-ink-2">
              {item.author}的红包 · {how}
            </span>
            <span className="truncate text-xs text-ink-3">
              {clockLabel(item.at)} {verb}
            </span>
          </span>
          <span className="grid shrink-0 justify-items-end gap-1">
            {outcome.amount ? (
              <span className="text-base font-semibold text-success tabular-nums">
                +{outcome.amount}
                <span className="ml-0.5 text-xs font-medium">LDC</span>
              </span>
            ) : (
              <StatusChip tone={outcome.tone}>{outcome.label}</StatusChip>
            )}
            {payment && (
              <StatusChip tone={paymentTone(payment)} dot>
                {PAYMENT_LABELS[payment]}
              </StatusChip>
            )}
          </span>
          <ChevronRight
            className="size-5 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </button>
      </Squircle>
    </ListItem>
  );
}

/**
 * /history 红包记录: what this account sent (drafts included; the sender's
 * pages from each row) and what it took part in (claims and sign-ups, with
 * the amount and the payment). Newest first, 20 at a time.
 */
export function HistoryView() {
  const user = useSessionUser();
  if (!user) return null;
  // Keyed: another account never sees this one's lists while it loads.
  return <History key={user.id} user={user} />;
}

function History({ user }: { user: SessionUser }) {
  const { leaveTo } = useOmniboxController();
  // In the address: back from a 红包 opened here lands on the same list.
  const [tab, setTab] = useSearchChoice<Tab>("tab", "sent", ["sent", "joined"]);
  const [filter, setFilter] = useSearchChoice<SentFilter>("filter", "all", [
    "all",
    "active",
    "draft",
    "ended",
  ]);
  const summary = useHistorySummary(user.id);
  const sent = useSentPages(user.id, filter === "ended" ? "finished" : filter);
  const joined = useJoinedPages(user.id);
  const query = tab === "sent" ? sent : joined;
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
    isPlaceholderData: query.isPlaceholderData,
  });
  const author = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
  const sentRecords =
    sent.data?.pages.flatMap((page) =>
      page.items.map((item) => sentRecordOf(item, author)),
    ) ?? [];
  const joinedRecords =
    joined.data?.pages.flatMap((page) => page.items.map(joinedRecordOf)) ?? [];
  const counts = sentCounts(sent.data?.pages[0]?.statusCounts);
  const sentTotal = sent.data?.pages[0]?.total ?? sentRecords.length;
  const joinedTotal = joined.data?.pages[0]?.total ?? joinedRecords.length;
  const totals = summary.data;

  // What the list area shows: which list, and whether it has rows.
  const shown =
    tab === "sent"
      ? `sent:${filter}:${sentRecords.length === 0 ? "empty" : "rows"}`
      : `joined:${joinedRecords.length === 0 ? "empty" : "rows"}`;

  return (
    // The title and the switchers stay once shown; the list loads in place.
    <PageLoad load={queriesLoad(summary, query)} frame={queryLoad(summary)}>
      <Page>
        <PageHeader
          refreshable
          title="红包记录"
          description={
            totals ? (
              <RollingText
                text={`已发 ${totals.initiatedCount} 个，发出 ${totals.sentAmount} LDC · 参与过 ${totals.participatedCount} 个，领到 ${totals.receivedAmount} LDC`}
              />
            ) : undefined
          }
        />
        <div className="flex flex-col gap-3">
          <Segmented
            label="红包记录分类"
            value={tab}
            onChange={setTab}
            options={[
              { value: "sent", label: "我发的", count: totals?.initiatedCount },
              {
                value: "joined",
                label: "我参与的",
                count: totals?.participatedCount,
              },
            ]}
          />
          {/* Only what this account sent has states: its own line, opening
              and closing with the tab. */}
          <Reveal show={tab === "sent" && counts.all > 0}>
            <Segmented
              size="sm"
              label="状态筛选"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "全部", count: counts.all },
                { value: "active", label: "进行中", count: counts.active },
                { value: "draft", label: "草稿", count: counts.draft },
                { value: "ended", label: "已结束", count: counts.finished },
              ]}
            />
          </Reveal>
        </div>
        <ResultLoad id={shown} load={resultOf(query)}>
          {tab === "sent" ? (
            sentRecords.length === 0 ? (
              <EmptyNote
                title={
                  counts.all === 0 ? "还没有发过红包" : "没有符合条件的红包"
                }
                text={
                  counts.all === 0
                    ? "发一个试试：填好奖励和口令，开放后把链接发到帖子里。"
                    : "换个筛选看看。"
                }
                action={
                  counts.all === 0 ? (
                    <Button
                      variant="primary"
                      onClick={() => void leaveTo({ to: "/new" })}
                    >
                      <Plus />
                      发红包
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
                  <AnimatePresence initial={false}>
                    {sentRecords.map((record) => (
                      <SentRow key={record.activity.id} record={record} />
                    ))}
                  </AnimatePresence>
                </Panel>
                <LazyListEnd list={list} done={`共 ${sentTotal} 个`} />
              </>
            )
          ) : joinedRecords.length === 0 ? (
            <EmptyNote
              title="还没有参与过红包"
              text="在起始页输入口令，或打开别人分享的红包链接；红包广场里也有公开的红包。"
              action={
                <Button
                  variant="primary"
                  onClick={() => void leaveTo({ to: "/square" })}
                >
                  <LayoutGrid />
                  逛红包广场
                </Button>
              }
            />
          ) : (
            <>
              <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
                <AnimatePresence initial={false}>
                  {joinedRecords.map((item) => (
                    <JoinedRow key={item.key} item={item} />
                  ))}
                </AnimatePresence>
              </Panel>
              <LazyListEnd list={list} done={`共 ${joinedTotal} 个`} />
            </>
          )}
        </ResultLoad>
      </Page>
    </PageLoad>
  );
}
