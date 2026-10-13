import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/my/merchants/$id")({
  beforeLoad: ({ params, location }) => {
    if (location.pathname.endsWith(`/merchants/${params.id}`))
      throw redirect({
        to: "/my/merchants",
        search: { merchantId: params.id, dialog: "payments" },
        replace: true,
      });
  },
});
