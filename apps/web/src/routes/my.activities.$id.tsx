import type { ManagedActivity } from "@hb/contracts";
import {
  createFileRoute,
  Outlet,
  useMatchRoute,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ActivityForm } from "../components/activities/activity-form";
import { RequireAccount } from "../components/activities/require-account";
import {
  PageSkeleton,
  RefreshNotice,
} from "../components/presentation/loading";
import { statusLabels, useManagedActivity } from "../lib/activities";
import { useEntryNavigate } from "../lib/navigation-state";
import { isAccessQueryError, isBlockingQueryError } from "../lib/query-view";

export const Route = createFileRoute("/my/activities/$id")({
  component: EditActivityPage,
});

function EditActivityPage() {
  const matchRoute = useMatchRoute();
  const { id } = Route.useParams();
  if (matchRoute({ to: "/my/activities/$id/statistics", fuzzy: true }))
    return <Outlet />;
  return (
    <RequireAccount>
      {({ userId, csrfToken, canUseLdc }) => (
        <LoadActivityEditor
          key={`${userId}-${id}`}
          userId={userId}
          csrfToken={csrfToken}
          canUseLdc={canUseLdc}
          id={id}
        />
      )}
    </RequireAccount>
  );
}

function LoadActivityEditor({
  userId,
  csrfToken,
  canUseLdc,
  id,
}: {
  userId: string;
  csrfToken: string;
  canUseLdc: boolean;
  id: string;
}) {
  const initialNotice = useRouterState({
    select: (state) => {
      const editorState = state.location.state as {
        activityEditorNotice?: unknown;
        activityEditorNoticeActivityId?: unknown;
        activityEditorNoticeUserId?: unknown;
      };
      return typeof editorState.activityEditorNotice === "string" &&
        editorState.activityEditorNoticeActivityId === id &&
        editorState.activityEditorNoticeUserId === userId
        ? editorState.activityEditorNotice
        : null;
    },
  });
  const query = useManagedActivity(userId, id);
  const lastActivity = useRef<ManagedActivity | null>(null);
  if (query.isError && isAccessQueryError(query.error))
    lastActivity.current = null;
  else if (query.data && !query.isError)
    lastActivity.current = query.data.activity;
  if (isBlockingQueryError(query))
    return (
      <ActivityErrorView
        error={query.error ?? new Error("读取失败，请重试。")}
        retry={() => query.refetch()}
      />
    );
  const activity = query.data?.activity ?? lastActivity.current;
  if (!activity) return <PageSkeleton title="编辑活动" layout="form" />;
  return (
    <>
      <RefreshNotice query={query} />
      <ActivityEditor
        userId={userId}
        csrfToken={csrfToken}
        canUseLdc={canUseLdc}
        initial={activity}
        initialNotice={initialNotice}
        reload={async () => {
          const result = await query.refetch();
          if (result.isError || !result.data)
            throw result.error ?? new Error("刷新失败，请重试。");
          return result.data.activity;
        }}
      />
    </>
  );
}

function ActivityEditor({
  userId,
  csrfToken,
  canUseLdc,
  initial,
  initialNotice,
  reload,
}: {
  userId: string;
  csrfToken: string;
  canUseLdc: boolean;
  initial: ManagedActivity;
  initialNotice: string | null;
  reload: () => Promise<ManagedActivity>;
}) {
  // Polls update the cache; only save/refresh replaces the editing baseline.
  // A revision also resets edits when the server version has not changed.
  const [editor, setEditor] = useState({ activity: initial, revision: 0 });
  const [message, setMessage] = useState<string | null>(initialNotice);
  const navigate = useEntryNavigate();
  const router = useRouter();
  function replaceBaseline(activity: ManagedActivity, notice: string) {
    setEditor((previous) => ({
      activity,
      revision: previous.revision + 1,
    }));
    setMessage(notice);
  }
  return (
    <div className="work-page work-create-page">
      <div className="work-page-heading">
        <div className="work-title-group">
          <h1>编辑活动</h1>
          <span className="text-sm text-muted">
            {statusLabels[initial.status]}
          </span>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={() => router.history.back()}
        >
          返回上一页
        </button>
      </div>
      {message ? (
        <p role="status" className="work-setting-notice">
          {message}
        </p>
      ) : null}
      <ActivityForm
        key={`${editor.activity.id}-${editor.revision}`}
        userId={userId}
        csrfToken={csrfToken}
        canUseLdc={canUseLdc}
        initial={editor.activity}
        reload={reload}
        onRefreshed={(activity) =>
          replaceBaseline(activity, "活动内容已刷新。")
        }
        onDeleted={() => navigate({ to: "/my/activities" })}
        onSaved={(activity, notice) =>
          replaceBaseline(
            activity,
            notice ??
              (editor.activity.status === "draft"
                ? activity.status === "draft"
                  ? "草稿已保存。"
                  : "活动已开放。"
                : "修改已保存。"),
          )
        }
      />
    </div>
  );
}
