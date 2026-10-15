import { useAtomValue } from "jotai";
import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { pageLoadSimAtom } from "../../lib/store";
import { Page, PageHeader, Panel } from "../page/page";
import { Button } from "../ui/button";

type Health = "checking" | "ok" | "failed";

const checkMs = 600;
const intervalMs = 15_000;

/**
 * /status 运行状态: production's connection check (health-status.tsx), in
 * the new shell. No entry anywhere — not a command, not in a menu — so it is
 * opened by address only, as in production. The prototype has no API: the
 * check is simulated, and the toolbar's 页面数据 → 读取失败 makes it fail.
 */
export function StatusView() {
  const sim = useAtomValue(pageLoadSimAtom);
  const failing = sim === "error";
  const [health, setHealth] = useState<Health>("checking");
  const [fetching, setFetching] = useState(true);
  const timer = useRef(0);

  const check = useCallback(() => {
    window.clearTimeout(timer.current);
    setFetching(true);
    timer.current = window.setTimeout(() => {
      setHealth(failing ? "failed" : "ok");
      setFetching(false);
    }, checkMs);
  }, [failing]);

  // Checks on arrival, again every 15 seconds, and when the simulation
  // changes (production polls at the same interval).
  useEffect(() => {
    check();
    const interval = window.setInterval(check, intervalMs);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timer.current);
    };
  }, [check]);

  const title =
    health === "ok" ? "连接正常" : health === "failed" ? "连接失败" : "检查中";
  const detail =
    health === "ok"
      ? "前端已通过同域网关连接到 Hono 后端。"
      : health === "failed"
        ? "健康检查失败：HTTP 503"
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
