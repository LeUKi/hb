import type { AdminRuntimeFlag } from "@hb/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import {
  adminKey,
  fetchAdminOverview,
  fmtTime,
  useCurrentAdmin,
} from "../lib/admin";
import { isBlockingQueryError } from "../lib/query-view";
import { CompactIconButton } from "./presentation/compact-icon-button";
import { SkeletonRows } from "./presentation/loading";
import "./admin-overview.css";

const blockerLabels: Record<string, string> = {
  APP_ENV: "当前环境不是生产环境",
  LDC_NETWORK_MODE: "真实付款网络未启用",
  LDC_STOP_NEW_OPENINGS: "新的活动开放已暂停",
  LDC_STOP_NEW_CLAIMS: "新的领取已暂停",
  LDC_STOP_SENDS: "付款发送已暂停",
  PLATFORM_CONTROL: "运行许可未启用",
  LDC_TIMED_DRAW_ENABLED: "限时开奖未启用",
};
const paymentLabels: Record<string, string> = {
  pending: "待发送",
  sending: "发送中",
  reconciling: "核对中",
  waiting: "等待处理",
  confirmed: "已确认",
  attention: "需要关注",
};
const jobs: Record<string, string> = {
  activities: "活动与开奖维护",
  payments: "付款补偿",
  credentials: "凭证检查恢复",
  identity: "会话清理",
};
function RuntimeFlag({
  label,
  value,
}: {
  label: string;
  value: AdminRuntimeFlag;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value.allowed ? "允许" : "不允许"}
        {value.blockers.length > 0 && (
          <ul>
            {value.blockers.map((reason) => (
              <li key={reason}>{blockerLabels[reason] ?? reason}</li>
            ))}
          </ul>
        )}
      </dd>
    </>
  );
}

export function AdminOverviewPanel({ identity }: { identity: string }) {
  const current = useCurrentAdmin(identity);
  const query = useQuery({
    queryKey: adminKey(identity, "overview"),
    queryFn: async ({ signal }) => {
      const result = await fetchAdminOverview(signal);
      if (signal.aborted || !current())
        throw new DOMException("身份已变化", "AbortError");
      return result;
    },
    retry: false,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const data = isBlockingQueryError(query) ? undefined : query.data;
  const refresh = () => {
    void query.refetch({ cancelRefetch: false });
  };
  return (
    <div className="admin-overview">
      <header className="admin-section-heading">
        <h2>概览</h2>
        <CompactIconButton
          aria-label="刷新"
          title="刷新"
          aria-busy={query.isFetching}
          disabled={query.isFetching}
          onClick={refresh}
        >
          <RefreshCw
            size={16}
            className={query.isFetching ? "spin" : undefined}
          />
        </CompactIconButton>
      </header>
      {query.isError && (
        <p role="alert">
          读取失败，请重试。
          <button className="button secondary" type="button" onClick={refresh}>
            重试
          </button>
        </p>
      )}
      {!data ? (
        !query.isError && (
          <div aria-busy="true">
            <SkeletonRows />
          </div>
        )
      ) : (
        <>
          <p className="text-sm text-subtle">
            上次读取：{fmtTime(query.dataUpdatedAt)} · 环境：
            {data.runtime.environment}
          </p>
          <div className="admin-overview-cards">
            <Link
              to="/admin/payments"
              search={{ anomaly: "unknown" }}
              className="activity-panel"
            >
              <span>付款结果未知</span>
              <strong>{data.warnings.unknownPayments}</strong>
            </Link>
            <Link
              to="/admin/payments"
              search={{ anomaly: "attention" }}
              className="activity-panel"
            >
              <span>付款需要关注</span>
              <strong>{data.warnings.attentionPayments}</strong>
            </Link>
            <Link
              to="/admin/payments"
              search={{ anomaly: "overdue" }}
              className="activity-panel"
            >
              <span>付款等待超过一小时</span>
              <strong>{data.warnings.stalePayments}</strong>
            </Link>
            <Link
              to="/admin/activities"
              search={{ drawException: 1 }}
              className="activity-panel"
            >
              <span>开奖等待超过十分钟</span>
              <strong>{data.warnings.drawBacklog}</strong>
            </Link>
            <Link
              to="/admin/payments"
              search={{ anomaly: "undelivered" }}
              className="activity-panel"
            >
              <span>任务未投递超过十分钟</span>
              <strong>
                {data.warnings.undeliveredPaymentTasksOverdue ?? "—"}
              </strong>
            </Link>
            <div className="activity-panel">
              <span>维护失败或超过十五分钟未更新</span>
              <strong>{data.warnings.staleMaintenance}</strong>
            </div>
          </div>
          <section className="activity-panel">
            <h3>用户与活动</h3>
            <dl className="admin-overview-fields">
              <dt>用户</dt>
              <dd>
                <Link to="/admin/users">{data.counts.users}</Link>
              </dd>
              <dt>未删除活动</dt>
              <dd>
                <Link to="/admin/activities">{data.counts.activities}</Link>
              </dd>
              <dt>付款</dt>
              <dd>
                <Link to="/admin/payments">{data.counts.payments.total}</Link>
                （未确认 {data.counts.payments.unconfirmed}）
              </dd>
            </dl>
          </section>
          <section className="activity-panel">
            <h3>运行许可</h3>
            <dl className="admin-overview-fields">
              <RuntimeFlag
                label="真实活动开放"
                value={data.runtime.realActivityOpening}
              />
              {data.runtime.realClaims && (
                <RuntimeFlag label="真实领取" value={data.runtime.realClaims} />
              )}
              <RuntimeFlag label="真实付款" value={data.runtime.realPayments} />
              <RuntimeFlag label="限时开奖" value={data.runtime.timedDraw} />
              <dt>队列实际积压</dt>
              <dd>{data.paymentQueue.backlog}</dd>
              <dt>本站待投递任务</dt>
              <dd>{data.warnings.undeliveredPaymentTasks}</dd>
            </dl>
          </section>
          <section className="activity-panel">
            <h3>付款状态</h3>
            <div className="admin-table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>模式</th>
                    <th>状态</th>
                    <th>数量</th>
                    <th>最长等待</th>
                  </tr>
                </thead>
                <tbody>
                  {data.paymentsByMode.map((row) => (
                    <tr key={`${row.mode}:${row.status}`}>
                      <td>{row.mode === "real" ? "真实" : "模拟"}</td>
                      <td>{paymentLabels[row.status] ?? row.status}</td>
                      <td>{row.count}</td>
                      <td>
                        {row.oldestAgeSeconds === null
                          ? "—"
                          : `${Math.floor(row.oldestAgeSeconds / 60)} 分钟`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.paymentsByMode.length && (
                <p className="text-sm text-subtle">暂无未确认付款。</p>
              )}
            </div>
          </section>
          <section className="activity-panel">
            <h3>维护任务最近状态</h3>
            <div className="admin-table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>最近状态</th>
                    <th>开始</th>
                    <th>完成</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(jobs).map(([job, label]) => {
                    const row = data.maintenance.find(
                      (record) => record.job === job,
                    );
                    return (
                      <tr key={job}>
                        <td>{label}</td>
                        <td>
                          {row
                            ? `${row.status === "failed" ? "失败" : row.status === "running" ? "运行中" : "已完成"}${row.stale ? " · 超过十五分钟未更新" : ""}`
                            : "暂无运行记录"}
                        </td>
                        <td>{fmtTime(row?.startedAt)}</td>
                        <td>{fmtTime(row?.finishedAt)}</td>
                        <td>{row?.reason ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
