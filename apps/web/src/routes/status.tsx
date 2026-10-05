import { createFileRoute } from "@tanstack/react-router";
import { HealthStatus } from "../components/health-status";

export const Route = createFileRoute("/status")({
  component: StatusPage,
});

function StatusPage() {
  return (
    <>
      <section className="max-w-3xl">
        <p className="text-sm font-medium text-neutral-500">运行状态</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-normal text-neutral-950">
          本地服务连接
        </h1>
        <p className="mt-3 text-base leading-7 text-neutral-600">
          用这个页面验证前端深链接、Service Binding 转发和 API 错误反馈。
        </p>
      </section>
      <HealthStatus />
    </>
  );
}
