import { useRouterState } from "@tanstack/react-router";
import { ActivityPageSkeleton } from "./presentation/activity-layout";
import { PageSkeleton } from "./presentation/loading";
import { Button } from "./ui/button";

export function PageLoading() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  if (
    (/^\/activities\/[^/]+$/.test(path) && path !== "/activities/new") ||
    /^\/e\/[^/]+\/?$/.test(path)
  )
    return <ActivityPageSkeleton />;
  const title =
    path === "/my/activities" || path === "/my/claims"
      ? "活动历史"
      : path.endsWith("/statistics")
        ? "兑换尝试统计"
        : path === "/my/payments"
          ? "付款记录"
          : path === "/activities/new"
            ? "发起活动"
            : path === "/account"
              ? "账号"
              : undefined;
  return (
    <div className="route-frame" data-route-pending="true">
      <PageSkeleton
        title={title}
        layout={
          path === "/my/payments"
            ? "payments"
            : path === "/activities/new"
              ? "form"
              : "list"
        }
      />
    </div>
  );
}

export function PageLoadError() {
  return (
    <section role="alert" className="activity-panel space-y-4">
      <p className="text-sm text-danger">页面加载失败，请重新加载页面。</p>
      <Button type="button" onClick={() => window.location.reload()}>
        重新加载页面
      </Button>
    </section>
  );
}
