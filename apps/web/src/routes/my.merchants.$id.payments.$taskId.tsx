import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/my/merchants/$id/payments/$taskId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/my/merchants",
      search: {
        merchantId: params.id,
        dialog: "payment",
        taskId: params.taskId,
      },
      replace: true,
    });
  },
});
