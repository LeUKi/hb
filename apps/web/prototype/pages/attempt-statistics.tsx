import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { getAttemptStatistics } from "../attempt-statistics";
import { ListPanel, Pagination } from "../components/list-controls";
import type { Identity, Page } from "../types";
import { findWorkbenchActivity } from "./workbench-store";
import { PageTitle } from "./workbench-ui";
import "./attempt-statistics.css";

export function AttemptStatisticsPage({
  identity,
  activityId,
  navigate,
}: {
  identity: Identity;
  activityId?: string;
  navigate: (page: Page, options?: { activityId?: string }) => void;
}) {
  const activity = activityId
    ? findWorkbenchActivity(identity, activityId)
    : undefined;
  if (
    identity === "guest" ||
    !activity ||
    activity.status === "draft" ||
    !activity.config.dedicated
  ) {
    return (
      <div className="work-page attempt-statistics-page">
        <PageTitle title="兑换尝试统计" />
        <div className="work-notice" role="status">
          <strong>暂时无法查看</strong>
          <p>只有作者本人开启“仅在活动页兑换”的已保存活动才提供尝试统计。</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => navigate("manage")}
          >
            <ArrowLeft size={16} />
            返回我的活动
          </button>
        </div>
      </div>
    );
  }

  return (
    <AttemptStatisticsContent
      activityId={activity.id}
      title={activity.title}
      identity={identity}
      navigate={navigate}
    />
  );
}

function AttemptStatisticsContent({
  activityId,
  title,
  identity,
  navigate,
}: {
  activityId: string;
  title: string;
  identity: Identity;
  navigate: (page: Page, options?: { activityId?: string }) => void;
}) {
  const [page, setPage] = useState(1);
  const stats = getAttemptStatistics(identity, activityId);
  const pageSize = 20;
  const pageItems = stats.items.slice((page - 1) * pageSize, page * pageSize);
  const hasNext = page * pageSize < stats.items.length;

  return (
    <div className="work-page attempt-statistics-page">
      <div className="attempt-statistics-heading">
        <PageTitle title="兑换尝试统计" />
        <button
          className="button secondary"
          type="button"
          onClick={() => navigate("manage", { activityId })}
        >
          <ArrowLeft size={16} />
          返回我的活动
        </button>
      </div>
      <p className="muted attempt-statistics-activity">
        {title || "未命名活动"}
      </p>
      <dl className="attempt-statistics-summary">
        <div>
          <dt>总尝试次数</dt>
          <dd>{stats.totalAttempts}</dd>
        </div>
        <div>
          <dt>独立尝试人数</dt>
          <dd>{stats.uniqueUsers}</dd>
        </div>
        <div>
          <dt>成功领取数</dt>
          <dd>{stats.successfulClaims}</dd>
        </div>
      </dl>
      <section className="work-panel attempt-statistics-panel">
        <h2>提交内容聚合</h2>
        <p className="muted">
          只展示提交内容的汇总，不展示个人失败记录；命中结果按提交当时的活动配置计算。
        </p>
        <ListPanel
          state={pageItems.length ? "ready" : "empty"}
          emptyText="暂无兑换尝试。"
          footer={null}
        >
          {pageItems.length ? (
            <div className="attempt-statistics-table-wrap">
              <table className="attempt-statistics-table">
                <thead>
                  <tr>
                    <th>提交口令</th>
                    <th>次数</th>
                    <th>人数</th>
                    <th>命中</th>
                    <th>未命中</th>
                    <th>成功领取</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((item) => (
                    <tr key={item.password}>
                      <td>{item.password}</td>
                      <td>{item.attempts}</td>
                      <td>{item.uniqueUsers}</td>
                      <td>{item.matchedAttempts}</td>
                      <td>{item.unmatchedAttempts}</td>
                      <td>{item.successfulClaims}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <Pagination
            label="兑换尝试统计分页"
            page={page}
            hasNext={hasNext}
            onPageChange={setPage}
          />
        </ListPanel>
      </section>
      <section className="work-panel attempt-statistics-panel">
        <h2>各有效口令的领取数</h2>
        {stats.validPasswords.length ? (
          <ul className="attempt-statistics-valid-passwords">
            {stats.validPasswords.map((item) => (
              <li key={item.password}>
                <span>{item.password}</span>
                <strong>{item.successfulClaims} 份</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">暂无成功领取。</p>
        )}
      </section>
    </div>
  );
}
