import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { DiscoveryCards } from "../components/activities/discovery-cards";
import {
  ListPanel,
  Pagination,
} from "../components/presentation/list-controls";
import {
  PageSkeleton,
  RefreshNotice,
} from "../components/presentation/loading";
import { useSession } from "../lib/auth";
import { useTopicActivities } from "../lib/discovery";
import { useCursorRecovery, useViewState } from "../lib/navigation-state";
import { listQueryState } from "../lib/query-view";

export const Route = createFileRoute("/topics/$topicId")({
  validateSearch: (search): { postNumber: number } => ({
    postNumber: search.postNumber === undefined ? 1 : Number(search.postNumber),
  }),
  component: TopicPage,
});

function TopicPage() {
  const { topicId } = Route.useParams();
  const { postNumber } = Route.useSearch();
  const session = useSession();
  if (session.isPending) return <PageSkeleton title="帖子关联活动" />;
  if (session.isError)
    return (
      <ActivityErrorView
        error={session.error}
        retry={() => session.refetch()}
      />
    );
  if (!/^[1-9]\d{0,18}$/.test(topicId))
    return <p role="alert">帖子标识无效。</p>;
  if (!Number.isSafeInteger(postNumber) || postNumber <= 0)
    return <p role="alert">回复楼层无效。</p>;
  return (
    <TopicResults
      key={`${topicId}-${postNumber}-${session.data.user?.id ?? "guest"}`}
      topicId={topicId}
      postNumber={postNumber}
      userId={session.data.user?.id ?? null}
    />
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
  const [cursors, setCursors] = useViewState<Array<string | null>>(
    "topic-cursors",
    [null],
    `${topicId}:${postNumber}`,
  );
  const query = useTopicActivities(
    topicId,
    postNumber,
    cursors.at(-1) ?? null,
    userId,
    true,
  );
  const navigate = useNavigate();
  const inspected = useRef(false);
  useEffect(() => {
    if (inspected.current || !query.data || cursors.length !== 1) return;
    inspected.current = true;
    const only = query.data.items[0];
    if (only && query.data.items.length === 1 && !query.data.nextCursor)
      void navigate({
        to: "/activities/$id",
        params: { id: only.id },
        replace: true,
      });
  }, [query.data, navigate, cursors.length]);
  const cursorNotice = useCursorRecovery(query.error, cursors, setCursors);
  const state = listQueryState(query);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">帖子关联活动</h1>
      <p className="text-sm text-muted">
        每个活动会显示实际发放者；关联不代表楼主认可。
      </p>
      <a
        href={`https://linux.do/t/${topicId}/${postNumber}`}
        className="text-sm underline underline-offset-4"
        target="_blank"
        rel="noopener noreferrer"
      >
        查看论坛帖子
      </a>
      {cursorNotice}
      <ListPanel
        restorationId="topic-activities"
        keepContent
        state={state}
        emptyText="暂无可查询的关联活动。"
        refreshNotice={<RefreshNotice query={query} />}
        resetKey={`${topicId}:${postNumber}:${cursors.length}`}
        footer={
          <Pagination
            label="帖子关联活动分页"
            page={cursors.length}
            hasNext={Boolean(query.data?.nextCursor)}
            onPageChange={(page) => {
              if (page < cursors.length) setCursors(cursors.slice(0, -1));
              else if (query.data?.nextCursor)
                setCursors([...cursors, query.data.nextCursor]);
            }}
            busy={query.isPending}
          />
        }
      >
        <DiscoveryCards
          items={query.data?.items ?? []}
          state={state}
          emptyText="暂无可查询的关联活动。"
          errorContent={
            query.isError ? (
              <ActivityErrorView
                error={query.error}
                retry={() => query.refetch()}
              />
            ) : undefined
          }
          onRetry={query.isError ? () => query.refetch() : undefined}
        />
      </ListPanel>
    </div>
  );
}
