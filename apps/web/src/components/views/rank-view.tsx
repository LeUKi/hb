import type { RankBoard, RankEntry, RankMe, RankRange } from "@hb/contracts";
import { Crown, Lock } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { durations, ease, useReducedMotionPref } from "../../lib/motion";
import { useRankPages, useSetRankVisibility } from "../../lib/rank";
import { clockLabel } from "../../lib/roster-time";
import { type SessionUser, useIdentity } from "../../lib/session";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { EmptyNote, Page, PageHeader, Panel } from "../page/page";
import {
  Bone,
  PageLoad,
  PageSkeleton,
  queryLoad,
  ResultLoad,
  resultOf,
} from "../page/page-state";
import { useSearchChoice } from "../shell/use-search-choice";
import { Avatar } from "../ui/avatar";
import { Segmented, Switch } from "../ui/field";
import { MorphLabel, RollingText } from "../ui/morph-label";
import { PersonName } from "../ui/person";
import { ListItem } from "../ui/reveal";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";

// 排行榜 (docs/leaderboard-design.md, 07 §15): 发出 and 领到, over the
// last 7 days or everything. Anyone may look; signed in, one sees where
// they stand and chooses whether others see them.

const boards: readonly RankBoard[] = ["sent", "received"];
const ranges: readonly RankRange[] = ["week", "all"];

const descriptions: Record<RankBoard, string> = {
  sent: "按大家从红包里领到的金额排，退回的不算。",
  received: "按领到的金额排，领取和中奖都算；默认匿名。",
};

/** What the switch says, on or off (the same on /me). */
export function rankVisibilityNote(visible: boolean) {
  return visible
    ? "大家看得到你的头像和昵称。"
    : "别人看到的是“匿名”，名次和金额照常；红包的领取名单仍然公开。";
}

export const rankSwitchLabel: Record<RankBoard, string> = {
  sent: "在发出榜上显示我",
  received: "在领到榜上显示我",
};

/** 发出: “3 个红包 · 22 人次”; 领到: “领了 3 个红包”. */
function countsOf(
  board: RankBoard,
  entry: { activities: number; claims: number },
) {
  return board === "sent"
    ? [`${entry.activities} 个红包`, `${entry.claims} 人次`]
    : [`领了 ${entry.activities} 个红包`];
}

/** “123.94 LDC”, the unit a step smaller. */
function Amount({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn("font-semibold text-ink tabular-nums", className)}>
      <RollingText text={value} />
      <span className="ml-0.5 text-xs font-medium text-ink-3">LDC</span>
    </span>
  );
}

/** Where a 匿名 person's avatar would be: grey, with a lock. */
function HiddenAvatar({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0 place-items-center rounded-full bg-fill-2 text-ink-3"
      style={{ width: size, height: size }}
    >
      <Lock style={{ width: size * 0.4, height: size * 0.4 }} />
    </span>
  );
}

/** “大家看得到你” or “别人看到匿名”: how others see the one reading. */
function SeenAs({ visible }: { visible: boolean }) {
  return (
    <StatusChip tone={visible ? "accent" : "neutral"}>
      <MorphLabel>{visible ? "大家看得到你" : "别人看到匿名"}</MorphLabel>
    </StatusChip>
  );
}

type Face = { avatar: (size: number) => ReactNode; name: ReactNode };

/** Who a place is: oneself, someone shown, or 匿名. */
function faceOf(entry: RankEntry, user: SessionUser | null): Face {
  if (entry.me && user)
    return {
      avatar: (size) => (
        <Avatar name={user.displayName} src={user.avatarUrl} size={size} />
      ),
      name: <span className="font-medium text-accent-ink">你</span>,
    };
  if (entry.person) {
    const person = entry.person;
    return {
      avatar: (size) => (
        <Avatar name={person.displayName} src={person.avatarUrl} size={size} />
      ),
      name: (
        <PersonName
          name={person.displayName}
          username={person.username}
          avatarUrl={person.avatarUrl}
          className="text-ink"
        />
      ),
    };
  }
  return {
    avatar: (size) => <HiddenAvatar size={size} />,
    name: <span className="text-ink-3">匿名</span>,
  };
}

/** 第一名 gold with a crown, 第二名 silver, 第三名 bronze. */
const medals = ["text-gold-mark", "text-silver", "text-bronze"];
const heights = ["min-h-[12rem]", "min-h-[11rem]", "min-h-[10.5rem]"];

/** The first three, side by side: the first in the middle and tallest. */
function Podium({
  entries,
  board,
  user,
}: {
  entries: RankEntry[];
  board: RankBoard;
  user: SessionUser | null;
}) {
  // Second on the left, third on the right.
  const order = [1, 0, 2].filter((index) => entries[index]);
  return (
    <ol className="grid grid-cols-3 items-end gap-2.5">
      {order.map((index) => {
        const entry = entries[index] as RankEntry;
        const face = faceOf(entry, user);
        const first = index === 0;
        return (
          <li
            key={entry.position}
            className={cn(
              index === 1 && "col-start-1",
              first && "col-start-2",
              index === 2 && "col-start-3",
            )}
            style={{ gridRow: 1 }}
          >
            <Squircle radius={radius.card}>
              <div
                className={cn(
                  "panel flex flex-col items-center justify-end gap-1 px-2 pt-3 pb-3 text-center",
                  // The first stands tallest, the second a step above the third.
                  heights[index],
                  entry.me && "bg-accent-soft",
                )}
              >
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-xs font-semibold",
                    medals[index],
                  )}
                >
                  {first && <Crown className="size-3.5" aria-hidden="true" />}第{" "}
                  {entry.rank} 名
                </span>
                {face.avatar(first ? 52 : 44)}
                <span className="mt-0.5 max-w-full truncate text-sm">
                  {face.name}
                </span>
                <Amount value={entry.amount} className="text-base" />
                {/* A line each: a podium card is narrow on a phone. */}
                <span className="grid text-xs leading-snug text-ink-3">
                  {countsOf(board, entry).map((text) => (
                    <span key={text} className="whitespace-nowrap">
                      {text}
                    </span>
                  ))}
                </span>
              </div>
            </Squircle>
          </li>
        );
      })}
    </ol>
  );
}

/** A place from the fourth on: 名次, who, the counts, the amount. */
function Row({
  entry,
  board,
  user,
  visible,
}: {
  entry: RankEntry;
  board: RankBoard;
  user: SessionUser | null;
  visible: boolean;
}) {
  const face = faceOf(entry, user);
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2.5",
        entry.me && "rounded-[14px] bg-accent-soft",
      )}
    >
      <span
        className={cn(
          "w-8 shrink-0 text-right text-sm tabular-nums",
          entry.me ? "font-semibold text-accent-ink" : "text-ink-3",
        )}
      >
        {entry.rank}
      </span>
      {face.avatar(36)}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-2 text-base">
          <span className="min-w-0 truncate">{face.name}</span>
          {entry.me && <SeenAs visible={visible} />}
        </span>
        <span className="truncate text-xs text-ink-3">
          {countsOf(board, entry).join(" · ")}
        </span>
      </span>
      <Amount value={entry.amount} className="shrink-0 text-base" />
    </div>
  );
}

/**
 * 你的排名: one's place (or 还没上榜), how others see one, and the switch
 * for this board.
 */
function MyRank({
  me,
  total,
  board,
  user,
  csrfToken,
}: {
  me: RankMe;
  total: number;
  board: RankBoard;
  user: SessionUser;
  csrfToken: string;
}) {
  const save = useSetRankVisibility(user.id, csrfToken);
  return (
    <Panel className="grid gap-3 p-4">
      <div className="flex items-center gap-3">
        <Avatar name={user.displayName} src={user.avatarUrl} size={44} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-3">
            <span className="whitespace-nowrap">你的排名</span>
            <SeenAs visible={me.visible} />
          </p>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-xl font-semibold text-ink tabular-nums">
              {me.rank === null ? (
                "还没上榜"
              ) : (
                <RollingText text={`第 ${me.rank} 名`} />
              )}
            </span>
            <span className="text-sm text-ink-3">
              {me.rank === null ? (
                board === "sent" ? (
                  "你发的红包被领取后就会上榜。"
                ) : (
                  "领到红包后就会上榜。"
                )
              ) : (
                <RollingText text={`共 ${total} 人`} />
              )}
            </span>
          </p>
        </div>
        {me.rank !== null && (
          <div className="grid shrink-0 justify-items-end gap-0.5 text-right">
            <Amount value={me.amount} className="text-base" />
            <span className="text-xs text-ink-3">
              {countsOf(board, me).join(" · ")}
            </span>
          </div>
        )}
      </div>
      <div className="border-t border-line pt-3">
        <Switch
          checked={me.visible}
          onChange={(visible) => save.mutate({ board, visible })}
          label={rankSwitchLabel[board]}
          description={
            <MorphLabel fit={false}>
              {save.isError
                ? "没有保存，请稍后再试。"
                : rankVisibilityNote(me.visible)}
            </MorphLabel>
          }
        />
      </div>
    </Panel>
  );
}

/**
 * One's own row, held at the bottom of the window while one's place is
 * further down (or not loaded yet); gone once the place itself is in view.
 */
function useOwnRowAway(element: HTMLElement | null, loaded: boolean) {
  const [away, setAway] = useState(true);
  useEffect(() => {
    if (!loaded || !element) {
      setAway(true);
      return;
    }
    const root = element.closest(".view-scroll");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        // Below the window: still on its way. In view or passed: home.
        setAway(
          !entry.isIntersecting &&
            entry.boundingClientRect.top >
              (entry.rootBounds?.bottom ?? window.innerHeight),
        );
      },
      { root },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, loaded]);
  return away;
}

/** Bars where the places go, while a board is read first. */
function RankSkeleton() {
  return (
    <div aria-hidden="true" className="grid gap-3">
      <div className="grid grid-cols-3 items-end gap-2.5">
        <Bone className="h-36 w-full" radius={radius.card} />
        <Bone className="h-40 w-full" radius={radius.card} />
        <Bone className="h-32 w-full" radius={radius.card} />
      </div>
      <Bone className="h-64 w-full" radius={radius.card} />
    </div>
  );
}

export function RankView() {
  const identity = useIdentity();
  if (!identity.ready) return <PageSkeleton />;
  return <Rank user={identity.user} csrfToken={identity.csrfToken} />;
}

function Rank({
  user,
  csrfToken,
}: {
  user: SessionUser | null;
  csrfToken: string | null;
}) {
  const reduced = useReducedMotionPref();
  const [board, setBoard] = useSearchChoice<RankBoard>("board", "sent", boards);
  const [range, setRange] = useSearchChoice<RankRange>("range", "week", ranges);
  const query = useRankPages(board, range, user?.id ?? null);
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const pages = query.data?.pages ?? [];
  const first = pages[0];
  // A board read again between batches can repeat a place: once each.
  const seen = new Set<number>();
  const entries = pages
    .flatMap((page) => page.items)
    .filter(
      (entry) => !seen.has(entry.position) && Boolean(seen.add(entry.position)),
    );
  const me = first?.me ?? null;
  const total = first?.total ?? 0;
  const [ownRow, setOwnRow] = useState<HTMLElement | null>(null);
  const ownLoaded =
    me?.position !== null &&
    me?.position !== undefined &&
    seen.has(me.position) &&
    me.position >= 3;
  const away = useOwnRowAway(ownRow, ownLoaded);
  const ownEntry: RankEntry | null =
    me && me.rank !== null && me.position !== null
      ? {
          position: me.position,
          rank: me.rank,
          person: null,
          me: true,
          amount: me.amount,
          activities: me.activities,
          claims: me.claims,
        }
      : null;
  // On the podium it is in view already; below it, held until reached.
  const holdOwnRow =
    ownEntry !== null && ownEntry.position >= 3 && away && entries.length > 0;

  return (
    // The title and the switchers stay once shown; the board loads in place.
    <PageLoad load={queryLoad(query)} frame>
      <Page>
        <PageHeader
          refreshable
          title="排行榜"
          description={descriptions[board]}
          actions={
            <Segmented
              size="sm"
              label="时间范围"
              value={range}
              onChange={setRange}
              options={[
                { value: "week", label: "近 7 天" },
                { value: "all", label: "全部" },
              ]}
            />
          }
        />
        <Segmented
          label="榜单"
          value={board}
          onChange={setBoard}
          options={[
            { value: "sent", label: "发出" },
            { value: "received", label: "领到" },
          ]}
        />
        <ResultLoad
          id={`${board}:${range}:${entries.length === 0 ? "empty" : "rows"}`}
          load={resultOf(query)}
          skeleton={<RankSkeleton />}
        >
          <div className="flex flex-col gap-3">
            {user && csrfToken && me && (
              <MyRank
                me={me}
                total={total}
                board={board}
                user={user}
                csrfToken={csrfToken}
              />
            )}
            {entries.length === 0 ? (
              <EmptyNote
                title={
                  range === "week" ? "近 7 天还没有人上榜" : "还没有人上榜"
                }
                text={range === "week" ? "换到“全部”看看。" : undefined}
              />
            ) : (
              <>
                <Podium
                  entries={entries.slice(0, 3)}
                  board={board}
                  user={user}
                />
                {entries.length > 3 && (
                  <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
                    <AnimatePresence initial={false}>
                      {entries.slice(3).map((entry) => (
                        <ListItem key={entry.position}>
                          <div ref={entry.me ? setOwnRow : undefined}>
                            <Row
                              entry={entry}
                              board={board}
                              user={user}
                              visible={me?.visible ?? false}
                            />
                          </div>
                        </ListItem>
                      ))}
                    </AnimatePresence>
                  </Panel>
                )}
                <LazyListEnd list={list} done={`共 ${total} 人`} />
              </>
            )}
            {first && (
              <p className="px-1 text-center text-xs text-ink-3">
                每 5 分钟更新一次 · 更新于 {clockLabel(first.computedAt)}
              </p>
            )}
          </div>
        </ResultLoad>
        <AnimatePresence>
          {holdOwnRow && ownEntry && (
            <motion.div
              key="own"
              className="sticky bottom-3 z-10"
              initial={{ opacity: 0, y: reduced ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduced ? 0 : 8 }}
              transition={{ duration: reduced ? 0 : durations.fadeOut, ease }}
            >
              {/* Floating over the list: the menus' glass, opaque enough
                  that the rows beneath do not read through. */}
              <div className="relative">
                <SquirclePlate className="pop-plate" radius={radius.card} />
                <Squircle radius={radius.card}>
                  <div className="glass-pop p-1.5">
                    <Row
                      entry={ownEntry}
                      board={board}
                      user={user}
                      visible={me?.visible ?? false}
                    />
                  </div>
                </Squircle>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Page>
    </PageLoad>
  );
}
