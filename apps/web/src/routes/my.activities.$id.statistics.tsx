import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ListPagination } from "../components/activities/list-pagination";
import { RequireAccount } from "../components/activities/require-account";
import { useActivityStatistics } from "../lib/discovery";

export const Route = createFileRoute("/my/activities/$id/statistics")({
  component: StatisticsPage,
});

function StatisticsPage() {
  const { id } = Route.useParams();
  return (
    <RequireAccount>
      {({ userId }) => (
        <Statistics key={`${id}-${userId}`} id={id} userId={userId} />
      )}
    </RequireAccount>
  );
}

function Statistics({ id, userId }: { id: string; userId: string }) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const query = useActivityStatistics(userId, id, cursors.at(-1) ?? null);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">兑换尝试统计</h1>
        <Link
          to="/my/activities/$id"
          params={{ id }}
          className="text-sm underline underline-offset-4"
        >
          返回活动管理
        </Link>
      </div>
      {query.isPending ? (
        <p role="status">正在读取统计…</p>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              ["总尝试次数", query.data.totalAttempts],
              ["独立尝试人数", query.data.uniqueUsers],
              ["成功领取数", query.data.successfulClaims],
            ].map(([label, value]) => (
              <div key={label} className="activity-panel space-y-2">
                <dt className="text-sm text-neutral-500">{label}</dt>
                <dd className="text-2xl font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
          <section className="activity-panel space-y-4">
            <h2 className="font-semibold">提交内容聚合</h2>
            <p className="text-sm text-neutral-600">
              命中结果按提交当时记录。后来新增有效口令不会改写历史，网络重发不重复计数。
            </p>
            {query.data.items.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-140 border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-neutral-500">
                      <th className="py-3 pr-4 font-medium">提交口令</th>
                      <th className="px-2 font-medium">次数</th>
                      <th className="px-2 font-medium">人数</th>
                      <th className="px-2 font-medium">命中</th>
                      <th className="px-2 font-medium">未命中</th>
                      <th className="px-2 font-medium">成功领取</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.items.map((item) => (
                      <tr
                        key={item.password}
                        className="border-b border-neutral-100"
                      >
                        <td className="max-w-60 break-words py-3 pr-4">
                          {item.password}
                        </td>
                        <td className="px-2">{item.attempts}</td>
                        <td className="px-2">{item.uniqueUsers}</td>
                        <td className="px-2">{item.matchedAttempts}</td>
                        <td className="px-2">{item.unmatchedAttempts}</td>
                        <td className="px-2">{item.successfulClaims}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-neutral-500">暂无兑换尝试。</p>
            )}
            {query.data.nextCursor || cursors.length > 1 ? (
              <ListPagination
                cursors={cursors}
                setCursors={setCursors}
                nextCursor={query.data.nextCursor}
              />
            ) : null}
          </section>
          <section className="activity-panel space-y-4">
            <h2 className="font-semibold">各有效口令的领取数</h2>
            <ul className="divide-y divide-neutral-200 text-sm">
              {query.data.validPasswords.map((item) => (
                <li
                  key={item.password}
                  className="flex flex-wrap justify-between gap-3 py-3"
                >
                  <span className="break-all">{item.password}</span>
                  <span>{item.successfulClaims} 份</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
