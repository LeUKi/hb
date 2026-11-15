import { Bell, BellRing } from "lucide-react";
import { useEffect } from "react";
import {
  useSetSquareWatch,
  useSquareWatch,
  watchWords,
} from "../../lib/notices";
import {
  type SquareFilter,
  squareRecordOf,
  useSquarePages,
} from "../../lib/records";
import { useIdentity } from "../../lib/session";
import { HongbaoCard } from "../hongbao/hongbao-card";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { EmptyNote, Page, PageHeader } from "../page/page";
import {
  Bone,
  PageLoad,
  PageSkeleton,
  queryLoad,
  ResultLoad,
  resultOf,
} from "../page/page-state";
import { useSearchChoice } from "../shell/use-search-choice";
import { Button } from "../ui/button";
import { Segmented } from "../ui/field";
import { RollingNumber } from "../ui/morph-label";
import { Reveal } from "../ui/reveal";
import { radius } from "../ui/squircle";

const filters: readonly SquareFilter[] = ["all", "upcoming", "active", "ended"];

/**
 * /square 红包广场: the 红包 their senders chose to list (加入红包广场),
 * newest first, until 72 hours after they end. Anyone can browse, guests
 * included; a card opens the 红包. Signed in, the cards say which ones you
 * took part in or sent.
 */
export function SquareView() {
  const identity = useIdentity();
  if (!identity.ready) return <PageSkeleton />;
  return <Square userId={identity.user?.id ?? null} />;
}

function Square({ userId }: { userId: string | null }) {
  const { leaveTo } = useOmniboxController();
  // 全部 first: 进行中 is often empty, and one sent here to find a 红包
  // sees it even if it has just ended (07 §2).
  const [filter, setFilter] = useSearchChoice<SquareFilter>(
    "filter",
    "all",
    filters,
  );
  // Each filter's first page carries its count; only the shown list polls.
  const lists = {
    upcoming: useSquarePages("upcoming", userId, filter === "upcoming"),
    active: useSquarePages("active", userId, filter === "active"),
    ended: useSquarePages("ended", userId, filter === "ended"),
    all: useSquarePages("all", userId, filter === "all"),
  };
  const query = lists[filter];
  const countOf = (key: SquareFilter) =>
    lists[key].data?.pages[0]?.total ?? undefined;
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? items.length;
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  // Only the shown list polls: one shown again after a while reads again
  // at once, instead of showing what it had for up to its next poll.
  const { isStale, isFetching, refetch } = query;
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new filter only
  useEffect(() => {
    if (isStale && !isFetching) void refetch();
  }, [filter]);

  return (
    // The title and the filter stay once shown; the cards load in place.
    <PageLoad load={queryLoad(query)} frame>
      <Page width="wide">
        <PageHeader
          refreshable
          title="红包广场"
          description="发红包时选了“加入红包广场”的红包，按开放时间排列；结束 72 小时后不再列出。"
          actions={
            <Segmented
              label="筛选"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "全部", count: countOf("all") },
                // 定时开放 before its time (scheduled-opening §7).
                {
                  value: "upcoming",
                  label: "即将开放",
                  count: countOf("upcoming"),
                },
                { value: "active", label: "进行中", count: countOf("active") },
                // Only for 72 hours after the end (archived after): 最近.
                { value: "ended", label: "最近结束", count: countOf("ended") },
              ]}
            />
          }
        />
        <SquareWatch />
        <ResultLoad
          id={`${filter}:${items.length === 0 ? "empty" : "cards"}`}
          load={resultOf(query)}
          skeleton={<CardsSkeleton />}
        >
          {items.length === 0 ? (
            <EmptyNote
              title={
                filter === "upcoming"
                  ? "现在没有即将开放的红包"
                  : filter === "active"
                    ? "现在没有进行中的红包"
                    : filter === "ended"
                      ? "最近没有结束的红包"
                      : "还没有红包"
              }
              text={
                filter === "ended"
                  ? "结束不到 72 小时的红包会列在这里。"
                  : "发红包时打开“加入红包广场”，红包就会出现在这里。"
              }
            />
          ) : (
            <>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                {items.map((card) => {
                  const record = squareRecordOf(card, userId);
                  return (
                    <li key={card.id}>
                      <HongbaoCard
                        activity={record.activity}
                        view={record.view}
                        mine={record.mine}
                        onOpen={() =>
                          void leaveTo({ to: "activity", id: card.id })
                        }
                      />
                    </li>
                  );
                })}
              </ul>
              <LazyListEnd list={list} done={`共 ${total} 个`} />
            </>
          )}
        </ResultLoad>
      </Page>
    </PageLoad>
  );
}

/** Grey cards where the 红包 cards go, while a filter is read first. */
function CardsSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3"
    >
      {[0, 1, 2].map((card) => (
        <Bone key={card} className="h-56 w-full" radius={radius.card} />
      ))}
    </div>
  );
}

/**
 * 下一个红包开放时提醒我 (docs/notification-design.md §3.1): one 私信 when
 * the next 红包 here opens, then pressed again for another. How many have
 * it on is for everyone; the button only for whom a 私信 can reach.
 */
function SquareWatch() {
  const watch = useSquareWatch();
  const save = useSetSquareWatch();
  const mine = watch.data?.squareWatch ?? null;
  const waiting = watch.data?.waiting ?? 0;
  return (
    <Reveal show={mine !== null || waiting > 0}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
        {mine &&
          (mine.watching ? (
            <span className="flex items-center gap-1">
              <span className="inline-flex items-center gap-1.5 text-sm text-ink">
                <BellRing aria-hidden="true" className="size-4 text-gold-ink" />
                {watchWords.squareOn}
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => save.mutate(false)}
              >
                {watchWords.cancel}
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="quiet" onClick={() => save.mutate(true)}>
              <Bell aria-hidden="true" />
              {watchWords.square}
            </Button>
          ))}
        {waiting > 0 && (
          <span className="text-sm text-ink-3 tabular-nums">
            <RollingNumber value={waiting} /> {watchWords.waiting}
          </span>
        )}
        {save.isError && (
          <span role="alert" className="text-sm text-danger">
            {watchWords.failed}
          </span>
        )}
      </div>
    </Reveal>
  );
}
