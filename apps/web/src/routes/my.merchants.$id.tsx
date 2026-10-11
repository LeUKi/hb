import { createFileRoute, Outlet, useMatchRoute } from "@tanstack/react-router";
import { RequireAccount } from "../components/activities/require-account";
import { LoadMerchant } from "../components/merchants/load-merchant";

export const Route = createFileRoute("/my/merchants/$id")({
  component: MerchantPage,
});

function MerchantPage() {
  const { id } = Route.useParams();
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/my/merchants/$id/payments/$taskId", fuzzy: true }))
    return <Outlet />;
  return (
    <RequireAccount requireLdc>
      {({ userId, csrfToken }) => (
        <LoadMerchant
          key={`${userId}-${id}`}
          id={id}
          userId={userId}
          csrfToken={csrfToken}
        />
      )}
    </RequireAccount>
  );
}
