import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { api } from "../api";
import { Button } from "./ui/button";

async function fetchHealth() {
  const response = await api.api.health.$get();

  if (!response.ok) {
    throw new Error(`健康检查失败：HTTP ${response.status}`);
  }

  return response.json();
}

export function HealthStatus() {
  const prefersReducedMotion = useReducedMotion();
  const health = useQuery({
    queryKey: ["api-health"],
    queryFn: fetchHealth,
    refetchInterval: 15_000,
  });

  const connected = !health.isError && health.data?.status === "ok";
  const statusText = connected
    ? "连接正常"
    : health.isError
      ? "连接失败"
      : "检查中";

  return (
    <motion.section
      className="w-full max-w-3xl rounded-md border border-separator bg-surface p-5 shadow-sm"
      initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
      animate={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-subtle">API 健康检查</p>
          <h2
            className="mt-1 text-2xl font-semibold tracking-normal text-ink"
            data-testid="health-status"
          >
            {statusText}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {connected
              ? "前端已通过同域网关连接到 Hono 后端。"
              : health.isError
                ? health.error.message
                : "正在确认本地 Worker 与 Service Binding。"}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => health.refetch()}
          disabled={health.isFetching}
        >
          <RefreshCw
            className={health.isFetching ? "size-4 animate-spin" : "size-4"}
          />
          重新检查
        </Button>
      </div>
    </motion.section>
  );
}
