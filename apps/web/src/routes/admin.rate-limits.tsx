import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/rate-limits")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/settings", replace: true });
  },
});
