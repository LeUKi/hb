import type {
  AttemptStatisticsRow,
  JudgeNote,
  JudgeRecordFilter,
  JudgeRecordPeopleRow,
  JudgeRecordPeopleSort,
  JudgeRecordRow,
  ManagedActivity,
} from "@hb/contracts";
import { X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useStatisticsPages } from "../../lib/discovery";
import {
  moveLabel,
  useJudgePeople,
  useJudgePersonRecord,
  useJudgeRecordFacts,
  useJudgeTimeline,
} from "../../lib/judge";
import { agoLabel, clockSeconds, fullTime } from "../../lib/roster-time";
import {
  type LazyList,
  LazyListEnd,
  useQueryLazyList,
} from "../page/lazy-list";
import {
  EmptyNote,
  Facts,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import { PageLoad, queryLoad, ResultLoad, resultOf } from "../page/page-state";
import { useSearchChoice } from "../shell/use-search-choice";
import { WindowDialog } from "../shell/window-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Segmented } from "../ui/field";
import { Reveal } from "../ui/reveal";
import { StatusChip } from "../ui/status-chip";

// 判定记录 (docs/judge-records-design.md): a 代码判定红包's 尝试统计 is its
// judgments — along a timeline with the failures among them, person by
// person, and what was typed grouped as before (按内容). Its sender's only.

const tabs = ["timeline", "people", "content"] as const;
type Tab = (typeof tabs)[number];
const filters = ["all", "claimed", "unclaimed", "failed"] as const;
const sorts = ["recent", "most", "claimed"] as const;

const failureKinds = {
  threw: "抛错",
  timeout: "超时",
  invalid: "返回不对",
  memory: "内存超了",
} as const;

/** 判定器给 0.80，按上限发 0.50 (名单's words, 07 §6). */
const pulledIn: Record<JudgeNote, string> = {
  cap: "按上限发",
  floor: "按每份至少发",
  last: "最后一份发",
};

/** Whose, and its time: a face and name to open their whole record. */
function Who({
  user,
  side,
  onOpen,
}: {
  user: { displayName: string; username: string; avatarUrl: string | null };
  side: ReactNode;
  onOpen?: () => void;
}) {
  const face = (
    <>
      <Avatar name={user.displayName} src={user.avatarUrl} size={20} />
      <span className="truncate text-ink">{user.displayName}</span>
      <span className="truncate text-ink-3">@{user.username}</span>
    </>
  );
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 items-center gap-2 hover:underline"
        >
          {face}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-2">{face}</span>
      )}
      <span className="ml-auto shrink-0 text-xs text-ink-3 tabular-nums">
        {side}
      </span>
    </div>
  );
}

/** One judgment or failure (§1.1), its words as the 红包 page says them. */
function RecordRow({
  row,
  onOpen,
}: {
  row: JudgeRecordRow;
  onOpen?: (person: JudgeRecordRow["user"]) => void;
}) {
  const at = Date.parse(row.at);
  const level = row.user.level === null ? "" : ` · 等级 ${row.user.level}`;
  return (
    <li className="grid gap-1 border-line border-b px-3 py-3 last:border-b-0">
      <Who
        user={row.user}
        onOpen={onOpen ? () => onOpen(row.user) : undefined}
        side={
          <span title={fullTime(at)}>
            {row.kind === "judged" ? `第 ${row.attempt} 次 · ` : ""}
            {clockSeconds(at)}
            {level}
          </span>
        }
      />
      {row.kind === "judged" ? (
        <>
          <p className="font-mono text-sm break-all whitespace-pre-wrap text-ink">
            {row.input}
          </p>
          <p className="text-sm">
            {/* Protocol 5: what it moved for them (multi-prize §4.2). */}
            {row.moved ? (
              row.claimed ? (
                <StatusChip tone="success">
                  {moveLabel(row.moved, row.amount)}
                </StatusChip>
              ) : (
                <span className="text-ink-2 tabular-nums">
                  {moveLabel(row.moved, row.amount)}
                </span>
              )
            ) : row.claimed ? (
              <StatusChip tone="success">
                {row.asked && row.note
                  ? `判定器给 ${row.asked}，${pulledIn[row.note]} ${row.amount}`
                  : `领到 ${row.amount}`}
              </StatusChip>
            ) : (
              <span className="text-ink-3">没领到</span>
            )}
          </p>
          {row.message && (
            <p className="text-sm text-ink-2">回复：{row.message}</p>
          )}
          {row.announce && (
            <p className="text-sm text-ink-2">动态：{row.announce}</p>
          )}
          {row.ends && (
            <p className="text-sm text-ink-2">判定器结束了这个红包</p>
          )}
        </>
      ) : (
        <p className="text-sm text-ink-3">
          出错：{failureKinds[row.failure]} · {row.detail}
        </p>
      )}
    </li>
  );
}

function RecordList({
  rows,
  list,
  onOpen,
}: {
  rows: JudgeRecordRow[];
  list: LazyList;
  onOpen?: (person: JudgeRecordRow["user"]) => void;
}) {
  return (
    <Panel className="grid gap-0.5 p-1.5">
      <ul className="grid" aria-busy={list.state === "loading" || undefined}>
        {rows.map((row) => (
          <RecordRow
            key={`${row.kind}-${row.user.id}-${row.at}-${row.kind === "judged" ? row.attempt : row.detail}`}
            row={row}
            onOpen={onOpen}
          />
        ))}
      </ul>
      <LazyListEnd list={list} done="已全部加载" />
    </Panel>
  );
}

/** One person's whole record (§1.2), the oldest first, over the page. */
function PersonDialog({
  userId,
  activityId,
  person,
  onClose,
}: {
  userId: string;
  activityId: string;
  person: { id: string; displayName: string; username: string } | null;
  onClose: () => void;
}) {
  const titleId = useId();
  // Kept while it closes.
  const [shown, setShown] = useState(person);
  if (person && person !== shown) setShown(person);
  const record = useJudgePersonRecord(userId, activityId, person?.id ?? null);
  const rows = record.data?.pages.flatMap((page) => page.items) ?? [];
  const list = useQueryLazyList({
    hasNextPage: record.hasNextPage,
    isFetchingNextPage: record.isFetchingNextPage,
    isFetchNextPageError: record.isFetchNextPageError,
    fetchNextPage: record.fetchNextPage,
    pageCount: record.data?.pages.length ?? 0,
  });
  return (
    <WindowDialog
      open={person !== null}
      onClose={onClose}
      labelledBy={titleId}
      width="36rem"
    >
      <div className="flex max-h-[min(44rem,85dvh)] flex-col">
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
          <h2 id={titleId} className="truncate text-lg font-semibold text-ink">
            {shown?.displayName}
            <span className="ml-2 text-sm font-normal text-ink-3">
              @{shown?.username}
            </span>
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            className="-mr-2"
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <div className="view-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <ResultLoad id={shown?.id ?? ""} load={resultOf(record)}>
            {rows.length === 0 ? (
              <EmptyNote title="没有记录" />
            ) : (
              <RecordList rows={rows} list={list} />
            )}
          </ResultLoad>
        </div>
      </div>
    </WindowDialog>
  );
}

function PeopleList({
  rows,
  list,
  onOpen,
}: {
  rows: JudgeRecordPeopleRow[];
  list: LazyList;
  onOpen: (person: JudgeRecordPeopleRow["user"]) => void;
}) {
  return (
    <Panel className="grid gap-0.5 p-1.5">
      <ul className="grid" aria-busy={list.state === "loading" || undefined}>
        {rows.map((row) => (
          <li key={row.user.id}>
            <button
              type="button"
              onClick={() => onOpen(row.user)}
              className="grid w-full gap-1 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-fill-2"
            >
              <Who
                user={row.user}
                side={
                  <span title={fullTime(Date.parse(row.lastAt))}>
                    {agoLabel(Date.parse(row.lastAt))}
                  </span>
                }
              />
              <span className="flex items-center gap-2 text-sm text-ink-2">
                提交 {row.judged} 次
                {/* Protocol 5: 待结算 until settled (multi-prize §4.2). */}
                {row.pending !== undefined ? (
                  <span className="tabular-nums">待结算 {row.pending}</span>
                ) : row.settled && row.amount ? (
                  <StatusChip tone="success">已结算 {row.amount}</StatusChip>
                ) : row.settled ? (
                  <span className="text-ink-3">已结算，没有领到</span>
                ) : row.amount ? (
                  <StatusChip tone="success">领到 {row.amount}</StatusChip>
                ) : (
                  <span className="text-ink-3">没领到</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <LazyListEnd list={list} done="已全部加载" />
    </Panel>
  );
}

/** 按内容 (§1.3): what was typed, grouped and anonymous, as before. */
function ContentList({
  userId,
  activityId,
  attemptList,
}: {
  userId: string;
  activityId: string;
  attemptList: (props: {
    rows: AttemptStatisticsRow[];
    max: number;
    list: LazyList;
    total: string;
  }) => ReactNode;
}) {
  const stats = useStatisticsPages(userId, activityId, true);
  const rows = stats.data?.pages.flatMap((page) => page.items) ?? [];
  const list = useQueryLazyList({
    hasNextPage: stats.hasNextPage,
    isFetchingNextPage: stats.isFetchingNextPage,
    isFetchNextPageError: stats.isFetchNextPageError,
    fetchNextPage: stats.fetchNextPage,
    pageCount: stats.data?.pages.length ?? 0,
  });
  const max = Math.max(1, ...rows.map((row) => row.attempts));
  return (
    <PageSection
      title="提交的内容"
      description="按次数从多到少。发没发按那一次判定器的判定。"
    >
      <ResultLoad
        id="content"
        load={resultOf({ ...stats, isPlaceholderData: false })}
      >
        {rows.length === 0 ? (
          <EmptyNote title="还没有人提交" />
        ) : (
          attemptList({
            rows,
            max,
            list,
            total: list.state === "done" ? `共 ${rows.length} 条` : "",
          })
        )}
      </ResultLoad>
    </PageSection>
  );
}

/**
 * /🧧/<码>/📊 for a 代码判定红包: 判定记录. `attemptList` draws 按内容 as
 * the 尝试统计 page draws its list.
 */
export function JudgeRecordsView({
  userId,
  activity,
  attemptList,
}: {
  userId: string;
  activity: ManagedActivity;
  attemptList: (props: {
    rows: AttemptStatisticsRow[];
    max: number;
    list: LazyList;
    total: string;
  }) => ReactNode;
}) {
  const id = activity.id;
  const [tab, setTab] = useSearchChoice<Tab>("tab", "timeline", tabs);
  const [filter, setFilter] = useSearchChoice<JudgeRecordFilter>(
    "filter",
    "all",
    filters,
  );
  const [sort, setSort] = useSearchChoice<JudgeRecordPeopleSort>(
    "sort",
    "recent",
    sorts,
  );
  const facts = useJudgeRecordFacts(userId, id);
  const timeline = useJudgeTimeline(userId, id, filter, tab === "timeline");
  const people = useJudgePeople(userId, id, sort, tab === "people");
  const [person, setPerson] = useState<{
    id: string;
    displayName: string;
    username: string;
  } | null>(null);
  const timelineList = useQueryLazyList({
    hasNextPage: timeline.hasNextPage,
    isFetchingNextPage: timeline.isFetchingNextPage,
    isFetchNextPageError: timeline.isFetchNextPageError,
    fetchNextPage: timeline.fetchNextPage,
    pageCount: timeline.data?.pages.length ?? 0,
    isPlaceholderData: timeline.isPlaceholderData,
  });
  const peopleList = useQueryLazyList({
    hasNextPage: people.hasNextPage,
    isFetchingNextPage: people.isFetchingNextPage,
    isFetchNextPageError: people.isFetchNextPageError,
    fetchNextPage: people.fetchNextPage,
    pageCount: people.data?.pages.length ?? 0,
    isPlaceholderData: people.isPlaceholderData,
  });
  // 有 N 次新的提交 (§1.1): what the timeline was read with, against now.
  const count = facts.data ? facts.data.judged + facts.data.failed : null;
  const [read, setRead] = useState<{ at: number; count: number } | null>(null);
  const timelineRead = timeline.dataUpdatedAt;
  // Taken as the timeline is read, not as the count moves.
  if (timelineRead > 0 && count !== null && read?.at !== timelineRead)
    setRead({ at: timelineRead, count });
  const fresh =
    tab === "timeline" && count !== null && read ? count - read.count : 0;
  const rows = timeline.data?.pages.flatMap((page) => page.items) ?? [];
  const peopleRows = people.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <PageLoad load={queryLoad(facts)}>
      {facts.data && (
        <Page>
          <PageHeader
            refreshable
            eyebrow={activity.title}
            title="判定记录"
            description="每一次提交和判定器的判定，只有你看得到。"
          />
          <Panel className="p-5">
            <Facts
              items={[
                { label: "提交", value: `${facts.data.judged} 次` },
                { label: "提交的人", value: `${facts.data.people} 人` },
                {
                  label: "领到的人",
                  value: `${facts.data.claimedPeople} 人`,
                  note: `发出 ${facts.data.paid} LDC`,
                },
                // Protocol 5: everyone's pending together (§4.2).
                ...(facts.data.pending !== undefined
                  ? [{ label: "待结算", value: `${facts.data.pending} LDC` }]
                  : []),
                { label: "出错", value: `${facts.data.failed} 次` },
              ]}
            />
          </Panel>
          <div className="flex flex-col gap-3">
            <Segmented
              label="判定记录分类"
              value={tab}
              onChange={setTab}
              options={[
                { value: "timeline", label: "时间线" },
                { value: "people", label: "按人" },
                { value: "content", label: "按内容" },
              ]}
            />
            <Reveal show={tab === "timeline"}>
              <Segmented
                size="sm"
                label="结果筛选"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "全部" },
                  { value: "claimed", label: "领到的" },
                  { value: "unclaimed", label: "没领到" },
                  { value: "failed", label: "出错" },
                ]}
              />
            </Reveal>
            <Reveal show={tab === "people"}>
              <Segmented
                size="sm"
                label="排序"
                value={sort}
                onChange={setSort}
                options={[
                  { value: "recent", label: "最近" },
                  { value: "most", label: "提交多的" },
                  { value: "claimed", label: "领到的在前" },
                ]}
              />
            </Reveal>
          </div>
          {tab === "timeline" ? (
            <div className="grid gap-3">
              <Reveal show={fresh > 0}>
                <Button
                  variant="quiet"
                  size="sm"
                  className="w-fit"
                  onClick={() => {
                    void timeline.refetch();
                  }}
                >
                  有 {fresh} 次新的提交
                </Button>
              </Reveal>
              <ResultLoad id={`timeline-${filter}`} load={resultOf(timeline)}>
                {rows.length === 0 ? (
                  <EmptyNote
                    title={
                      filter === "all" ? "还没有人提交" : "没有符合条件的记录"
                    }
                  />
                ) : (
                  <RecordList
                    rows={rows}
                    list={timelineList}
                    onOpen={(user) => setPerson(user)}
                  />
                )}
              </ResultLoad>
            </div>
          ) : tab === "people" ? (
            <ResultLoad id={`people-${sort}`} load={resultOf(people)}>
              {peopleRows.length === 0 ? (
                <EmptyNote title="还没有人提交" />
              ) : (
                <PeopleList
                  rows={peopleRows}
                  list={peopleList}
                  onOpen={(user) => setPerson(user)}
                />
              )}
            </ResultLoad>
          ) : (
            <ContentList
              userId={userId}
              activityId={id}
              attemptList={attemptList}
            />
          )}
          <PersonDialog
            userId={userId}
            activityId={id}
            person={person}
            onClose={() => setPerson(null)}
          />
        </Page>
      )}
    </PageLoad>
  );
}
