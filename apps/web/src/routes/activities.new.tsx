import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ActivityForm } from "../components/activities/activity-form";
import { RequireAccount } from "../components/activities/require-account";

export const Route = createFileRoute("/activities/new")({
  component: CreateActivityPage,
});

function CreateActivityPage() {
  const navigate = useNavigate();
  return (
    <RequireAccount>
      {({ userId, csrfToken }) => (
        <div className="space-y-6">
          <h1 className="text-2xl font-semibold">创建奖励活动</h1>
          <ActivityForm
            key={userId}
            userId={userId}
            csrfToken={csrfToken}
            onSaved={(activity) => {
              void navigate({
                to: "/my/activities/$id",
                params: { id: activity.id },
              });
            }}
          />
        </div>
      )}
    </RequireAccount>
  );
}
