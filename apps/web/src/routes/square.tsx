import { createFileRoute, redirect } from "@tanstack/react-router";
import { navigationVisit } from "../lib/navigation-state";

// Keep old bookmarks usable without retaining a separate gallery page.
export const Route = createFileRoute("/square")({
  beforeLoad: ({ location }) => {
    const status = new URL(location.href, "http://local").searchParams.get(
      "status",
    );
    throw redirect({
      to: "/",
      search: {},
      replace: true,
      state: {
        hbVisit: navigationVisit(location),
        hbOpenPublicActivities:
          status === "active" || status === "ended" ? status : "all",
      },
    });
  },
});
