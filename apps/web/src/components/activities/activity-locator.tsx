import { useEffect, useRef, useState } from "react";
import { useTopicActivities } from "../../lib/discovery";
import { useViewState } from "../../lib/navigation-state";
import { isBlockingQueryError } from "../../lib/query-view";
import { RefreshNotice, SkeletonRows } from "../presentation/loading";
import { ActivitySelection } from "./activity-selection";

export function TopicMatches({
  topic,
  userId,
  onClose,
  onSelect,
  restoring,
  onMultiple,
  restoreFocus,
  isCurrent,
}: {
  topic: { topicId: string; postNumber: number };
  userId: string | null;
  onClose: (selected?: boolean) => void;
  restoring: boolean;
  onMultiple: () => void;
  onSelect: (id: string) => void;
  restoreFocus: HTMLElement | null;
  isCurrent: () => boolean;
}) {
  const [selectionShown, setSelectionShown] = useState(restoring);
  const [cursors, setCursors] = useViewState<Array<string | null>>(
    "locator-cursors",
    [null],
    `${topic.topicId}:${topic.postNumber}`,
  );
  const initialRequest = useRef(true);
  useEffect(() => {
    if (!initialRequest.current) return;
    initialRequest.current = false;
    if (!restoring) setCursors([null]);
  }, [restoring, setCursors]);
  // Fresh submissions start on page one; history restoration keeps its cursor.
  const activeCursors = !restoring && !selectionShown ? [null] : cursors;
  const query = useTopicActivities(
    topic.topicId,
    topic.postNumber,
    activeCursors.at(-1) ?? null,
    userId,
  );
  const blocked = isBlockingQueryError(query);
  const single =
    !selectionShown &&
    !blocked &&
    query.data &&
    activeCursors.length === 1 &&
    !query.data.nextCursor &&
    query.data.items.length === 1
      ? query.data.items[0]?.id
      : null;
  useEffect(() => {
    if (single && !restoring && isCurrent()) {
      onClose(true);
      onSelect(single);
    }
  }, [single, onSelect, onClose, restoring, isCurrent]);
  useEffect(() => {
    if (
      query.data &&
      !blocked &&
      !selectionShown &&
      isCurrent() &&
      (query.data.items.length > 1 || query.data.nextCursor)
    ) {
      setSelectionShown(true);
      if (!restoring) onMultiple();
    }
  }, [query.data, blocked, restoring, selectionShown, onMultiple, isCurrent]);
  if (!selectionShown && query.isPending)
    return (
      <div aria-busy="true">
        <SkeletonRows rows={1} />
      </div>
    );
  if (!selectionShown && isBlockingQueryError(query))
    return (
      <p role="alert">
        查找失败。
        <button
          type="button"
          onClick={() => {
            void query.refetch();
          }}
        >
          重试
        </button>
      </p>
    );
  if (!selectionShown && !query.data?.items.length)
    return <p role="status">未匹配到活动。</p>;
  if (single) return <p role="status">正在打开活动…</p>;
  return (
    <ActivitySelection
      total={query.data?.total}
      title="选择活动"
      restoreFocus={restoreFocus}
      refreshNotice={<RefreshNotice query={query} />}
      items={query.data?.items ?? []}
      pending={query.isPending}
      error={isBlockingQueryError(query) ? query.error : null}
      retry={() => {
        void query.refetch();
      }}
      cursors={activeCursors}
      setCursors={setCursors}
      nextCursor={query.data?.nextCursor ?? null}
      onClose={onClose}
      onSelect={(id) => {
        if (isCurrent()) onSelect(id);
      }}
    />
  );
}
