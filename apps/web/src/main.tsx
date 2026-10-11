import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { Provider as JotaiProvider } from "jotai";
import { MotionConfig } from "motion/react";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { PageLoadError, PageLoading } from "./components/page-loading";
import { navigationVisit } from "./lib/navigation-state";
import { createAppQueryClient } from "./lib/query-cache";
import { routeTree } from "./routeTree.gen";
import "./styles.css";
import "./prototype-ui/index.css";

const queryClient = createAppQueryClient();

const router = createRouter({
  routeTree,
  scrollRestoration: true,
  getScrollRestorationKey: navigationVisit,
  scrollToTopSelectors: [
    "#main",
    ".list-panel__scroll",
    ".work-payment-targets .list-panel__scroll",
    ".work-payment-detail-body",
    ".recipient-list",
    ".attempt-statistics-dialog__body",
  ],
  defaultPreload: "intent",
  defaultPendingComponent: PageLoading,
  defaultErrorComponent: PageLoadError,
  defaultPendingMs: 200,
  defaultPendingMinMs: 0,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <JotaiProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>
    </MotionConfig>
  </StrictMode>,
);
