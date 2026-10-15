import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { api } from "../../api";
import { Page, PageHeader, Panel } from "../page/page";
import { Button } from "../ui/button";

async function fetchHealth() {
  const response = await api.api.health.$get();
  if (!response.ok) throw new Error(`健康检查失败：HTTP ${response.status}`);
  return response.json();
}

/**
 * /status 运行状态: the connection check, in the new shell. No entry
 * anywhere — not a command, not in a menu — so it is opened by address only
 * (06 §5). Checks on arrival and every 15 seconds.
 */
export function StatusView() {
  const query = useQuery({
    queryKey: ["api-health"],
    queryFn: fetchHealth,
    refetchInterval: 15_000,
  });
  const health = query.isError
    ? "failed"
    : query.data?.status === "ok"
      ? "ok"
      : "checking";
  const fetching = query.isFetching;
  const check = () => void query.refetch();

  const title =
    health === "ok" ? "连接正常" : health === "failed" ? "连接失败" : "检查中";
  const detail =
    health === "ok"
      ? "前端已通过同域网关连接到 Hono 后端。"
      : health === "failed"
        ? (query.error?.message ?? "健康检查失败")
        : "正在确认本地 Worker 与 Service Binding。";

  return (
    <Page>
      <PageHeader
        eyebrow="运行状态"
        title="本地服务连接"
        description="用这个页面验证前端深链接、Service Binding 转发和 API 错误反馈。"
      />
      <Panel className="grid gap-3 p-5">
        <p className="text-sm text-ink-3">API 健康检查</p>
        <div className="grid gap-1">
          <h2
            className={`text-lg font-semibold ${
              health === "ok"
                ? "text-success"
                : health === "failed"
                  ? "text-danger"
                  : "text-ink"
            }`}
          >
            {title}
          </h2>
          <p className="text-sm text-ink-2">{detail}</p>
        </div>
        <div>
          <Button
            size="sm"
            // Not disabled: focus stays on the button while it checks.
            aria-disabled={fetching}
            onClick={() => {
              if (!fetching) check();
            }}
          >
            <RotateCw
              className={fetching ? "motion-safe:animate-spin" : undefined}
              aria-hidden="true"
            />
            重新检查
          </Button>
        </div>
      </Panel>
    </Page>
  );
}
