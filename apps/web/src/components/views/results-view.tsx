import type { DiscoveryCard } from "@hb/contracts";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { ArrowUpRight, ChevronRight, SearchX } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { activityCode } from "../../lib/activity-route";
import { getAttemptTicket, settleAttempt } from "../../lib/attempt-history";
import {
  exchangeContextAtom,
  useRedemptionResultPages,
  useTopicActivityPages,
} from "../../lib/discovery";
import {
  deadlineLine,
  mineOf,
  rewardSummaryOf,
  statusOf,
} from "../../lib/hongbao-text";
import { redemptionIntentAtom } from "../../lib/redemption-intent";
import { useIdentity } from "../../lib/session";
import { resultCountsAtom } from "../../lib/store";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { Page, PageHeader, Panel } from "../page/page";
import { PageLoad, PageSkeleton, queryLoad } from "../page/page-state";
import { usePageTitle } from "../shell/use-page-title";
import { ButtonLink } from "../ui/button-link";
import { MiniEnvelope } from "../ui/mini-envelope";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { MessageView } from "./message-view";

type Props =
  | { kind: "redeem"; resultId: string }
  | { kind: "topic"; topicId: string; postNumber: number };

/** The parts of an infinite query a results list reads. */
type PagedQuery = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
  data?: { pages: unknown[] };
};

/** Multi-match results: one list for 口令 matches and post lookups. */
export function ResultsView(props: Props) {
  const identity = useIdentity();
  if (!identity.ready) return <PageSkeleton />;
  if (props.kind === "topic")
    return (
      <TopicResults
        topicId={props.topicId}
        postNumber={props.postNumber}
        userId={identity.user?.id ?? null}
      />
    );
  // A result belongs to the account that looked it up (as on the server).
  if (!identity.user) return <ExpiredResult />;
  return <RedeemResults resultId={props.resultId} userId={identity.user.id} />;
}

function ExpiredResult() {
  return (
    <MessageView
      icon={SearchX}
      title="查找结果已失效"
      text="请重新输入口令。"
    />
  );
}

function RedeemResults({
  resultId,
  userId,
}: {
  resultId: string;
  userId: string;
}) {
  const navigate = useNavigate();
  const query = useRedemptionResultPages(userId, resultId);
  const [context, setContext] = useAtom(exchangeContextAtom);
  const setIntent = useSetAtom(redemptionIntentAtom);
  const setCounts = useSetAtom(resultCountsAtom);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? items.length;
  // The 口令 is only in memory, for the lookup made in this visit.
  const own =
    context?.userId === userId && context.resultId === resultId
      ? context
      : null;
  usePageTitle(items.length > 0 ? "选择红包" : null);
  useEffect(() => {
    if (items.length > 0)
      setCounts((current) =>
        current[resultId] === total
          ? current
          : { ...current, [resultId]: total },
      );
  }, [items.length, resultId, setCounts, total]);

  if (query.isError && !query.data) return <ExpiredResult />;
  return (
    <PageLoad load={queryLoad(query)}>
      {items.length === 0 ? (
        <ExpiredResult />
      ) : (
        <ResultsPage
          title="选择红包"
          description={
            <>
              {own ? (
                <>
                  口令{" "}
                  <span className="font-mono text-ink">{own.password}</span>{" "}
                  匹配到 {total} 个红包
                </>
              ) : (
                `匹配到 ${total} 个红包`
              )}
              {!own && (
                // After a reload or a change of account the 口令 is gone
                // (it is never stored).
                <span className="mt-1 block text-xs text-ink-3">
                  口令没有保留（刷新过页面或换过账号）：打开红包后要重新输入口令。
                </span>
              )}
            </>
          }
          items={items}
          list={query}
          done={`共 ${total} 个`}
          onOpen={(card) => {
            const status = statusOf(card);
            if (own?.claimSubmissionId && !status.ended && !mineOf(card)) {
              const ticket = getAttemptTicket(userId, resultId);
              if (ticket) void settleAttempt(ticket, true, [card.id]);
              setContext({ ...own, selectedActivityId: card.id });
              setIntent({
                userId,
                activityId: card.id,
                operation: {
                  submissionId: own.claimSubmissionId,
                  discoveryId: resultId,
                  password: own.password,
                },
              });
            }
            // A consumed choice is replaced so back does not re-offer it.
            void navigate({
              to: "/🧧/$code",
              params: { code: activityCode(card.id) },
              replace: true,
            });
          }}
        />
      )}
    </PageLoad>
  );
}

function TopicResults({
  topicId,
  postNumber,
  userId,
}: {
  topicId: string;
  postNumber: number;
  userId: string | null;
}) {
  const navigate = useNavigate();
  const query = useTopicActivityPages(topicId, postNumber, userId);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? items.length;
  const only = items.length === 1 && !query.hasNextPage ? items[0] : undefined;
  usePageTitle(items.length > 0 ? "帖子里的红包" : "未匹配到红包");
  // A post with one 红包 opens it, whether from the 指令框 or the address.
  if (only)
    return (
      <Navigate
        to="/🧧/$code"
        params={{ code: activityCode(only.id) }}
        replace
      />
    );
  const topicUrl = `https://linux.do/t/topic/${topicId}/${postNumber}`;
  return (
    <PageLoad load={queryLoad(query)}>
      {items.length === 0 ? (
        <MessageView
          icon={SearchX}
          title="未匹配到红包"
          text="这个帖子里还没有红包。"
        />
      ) : (
        <ResultsPage
          title="帖子里的红包"
          description={
            <>
              {`帖子 ${topicId} · ${postNumber} 楼，共 ${total} 个红包`}
              {/* Anyone can link a post to their 红包 (production's notice). */}
              <span className="mt-1 block text-xs text-ink-3">
                每个红包都写明了红包作者；和帖子关联不代表楼主认可。
              </span>
            </>
          }
          actions={
            <ButtonLink href={topicUrl} className="gap-1.5">
              查看社区帖子
              <ArrowUpRight aria-hidden="true" />
            </ButtonLink>
          }
          items={items}
          list={query}
          done={`共 ${total} 个`}
          onOpen={(card) =>
            void navigate({
              to: "/🧧/$code",
              params: { code: activityCode(card.id) },
            })
          }
        />
      )}
    </PageLoad>
  );
}

function ResultsPage({
  title,
  description,
  actions,
  items,
  list: query,
  done,
  onOpen,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  items: DiscoveryCard[];
  list: PagedQuery;
  done: string;
  onOpen: (card: DiscoveryCard) => void;
}) {
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  return (
    <Page>
      <PageHeader
        refreshable
        title={title}
        description={description}
        actions={actions}
      />
      <Panel as="ul" className="grid gap-0.5 p-1.5">
        {items.map((card) => (
          <ResultRow key={card.id} card={card} onOpen={() => onOpen(card)} />
        ))}
      </Panel>
      <LazyListEnd list={list} done={done} className="-mt-3" />
    </Page>
  );
}

function ResultRow({
  card,
  onOpen,
}: {
  card: DiscoveryCard;
  onOpen: () => void;
}) {
  const status = statusOf(card);
  // Taken part: how it went, as 红包记录 says it; otherwise the 红包's state.
  const chip = mineOf(card) ?? status;
  const deadline = status.ended ? null : deadlineLine(card);
  return (
    <li>
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center gap-3.5 p-3 text-left transition-colors hover:bg-fill-2"
        >
          <MiniEnvelope
            ended={status.ended}
            code={card.participationMode === "code"}
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-base font-medium text-ink">
              {card.title}
            </span>
            <span className="truncate text-sm text-ink-2">
              {card.author.displayName} · {rewardSummaryOf(card.reward)}
            </span>
            {deadline && (
              <span className="truncate text-xs text-ink-3">{deadline}</span>
            )}
          </span>
          <StatusChip tone={chip.tone}>{chip.text}</StatusChip>
          <ChevronRight
            className="size-5 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </button>
      </Squircle>
    </li>
  );
}
