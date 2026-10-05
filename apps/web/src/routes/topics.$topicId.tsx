import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { DiscoveryCards } from "../components/activities/discovery-cards";
import { ListPagination } from "../components/activities/list-pagination";
import { useSession } from "../lib/auth";
import { useTopicActivities } from "../lib/discovery";

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
  if (session.isPending) return <p role="status">正在查询关联活动…</p>;
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
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const query = useTopicActivities(
    topicId,
    postNumber,
    cursors.at(-1) ?? null,
    userId,
  );
  const navigate = useNavigate();
  const inspected = useRef(false);
  useEffect(() => {
    if (inspected.current || !query.data) return;
    inspected.current = true;
    const only = query.data.items[0];
    if (only && query.data.items.length === 1 && !query.data.nextCursor)
      void navigate({
        to: "/activities/$id",
        params: { id: only.id },
        replace: true,
      });
  }, [query.data, navigate]);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">帖子关联活动</h1>
      <p className="text-sm text-neutral-600">
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
      {query.isPending ? (
        <p role="status">正在查询关联活动…</p>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          {query.data.items.length ? (
            <DiscoveryCards items={query.data.items} />
          ) : (
            <p className="activity-panel text-sm text-neutral-600">
              暂无可查询的关联活动。
            </p>
          )}
          {query.data.nextCursor || cursors.length > 1 ? (
            <ListPagination
              cursors={cursors}
              setCursors={setCursors}
              nextCursor={query.data.nextCursor}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
