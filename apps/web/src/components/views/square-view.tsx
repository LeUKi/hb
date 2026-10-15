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
import { PageLoad, PageSkeleton, queryLoad } from "../page/page-state";
import { useSearchChoice } from "../shell/use-search-choice";
import { Segmented } from "../ui/field";

const filters: readonly SquareFilter[] = ["active", "ended", "all"];

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
  const [filter, setFilter] = useSearchChoice<SquareFilter>(
    "filter",
    "active",
    filters,
  );
  // Each filter's first page carries its count; only the shown list polls.
  const lists = {
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

  return (
    <PageLoad load={queryLoad(query)}>
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
                { value: "active", label: "进行中", count: countOf("active") },
                { value: "ended", label: "已结束", count: countOf("ended") },
                { value: "all", label: "全部", count: countOf("all") },
              ]}
            />
          }
        />
        {items.length === 0 ? (
          <EmptyNote
            title={
              filter === "active"
                ? "现在没有进行中的红包"
                : filter === "ended"
                  ? "没有已结束的红包"
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
      </Page>
    </PageLoad>
  );
}
