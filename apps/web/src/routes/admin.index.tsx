import { createFileRoute } from "@tanstack/react-router";
import { AdminOverviewPanel } from "../components/admin-overview";
import { AdminGuard, AdminShell } from "../lib/admin";

export const Route = createFileRoute("/admin/")({
  component: AdminOverviewPage,
});

function AdminOverviewPage() {
  return (
    <AdminGuard>
      {({ identity }) => (
        <AdminShell active="/admin">
          <AdminOverviewPanel identity={identity} />
        </AdminShell>
      )}
    </AdminGuard>
  );
}
