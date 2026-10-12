import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ActivityForm } from "../components/activities/activity-form";
import { RequireAccount } from "../components/activities/require-account";
import { OfficialConnectRequired } from "../components/auth/official-connect-required";

export const Route = createFileRoute("/activities/new")({
  component: CreateActivityPage,
});

function CreateActivityPage() {
  const navigate = useNavigate();
  return (
    <RequireAccount>
      {({ userId, csrfToken, canUseLdc }) => (
        <div className="work-page work-create-page">
          <div className="work-page-heading">
            <div className="work-title-group">
              <h1>发起活动</h1>
            </div>
          </div>
          {canUseLdc ? (
            <ActivityForm
              key={userId}
              userId={userId}
              csrfToken={csrfToken}
              canUseLdc={canUseLdc}
              onSaved={(activity, notice) => {
                void navigate({
                  to: "/my/activities/$id",
                  params: { id: activity.id },
                  state: notice
                    ? (state) => ({
                        ...state,
                        activityEditorNotice: notice,
                        activityEditorNoticeActivityId: activity.id,
                        activityEditorNoticeUserId: userId,
                      })
                    : undefined,
                });
              }}
            />
          ) : (
            <OfficialConnectRequired />
          )}
        </div>
      )}
    </RequireAccount>
  );
}
