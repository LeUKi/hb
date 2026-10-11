import { Link } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { Trash2 } from "lucide-react";
import { useAttemptHistory } from "../../lib/attempt-history";
import { useViewState } from "../../lib/navigation-state";
import { redemptionIntentAtom } from "../../lib/redemption-intent";
import { ActionMenu } from "../presentation/action-menu";
import { CompactIconButton } from "../presentation/compact-icon-button";

export function AttemptHistory({
  userId,
  onFill,
}: {
  userId: string;
  onFill: (password: string) => void;
}) {
  const history = useAttemptHistory(userId);
  const [limit, setLimit] = useViewState("attempt-history-limit", 10);
  const setIntent = useSetAtom(redemptionIntentAtom);
  const entries = history.entries.slice(0, limit);
  if (!entries.length) return null;
  return (
    <section
      className="attempt-history"
      aria-labelledby="attempt-history-title"
    >
      <div className="section-heading">
        <h2 id="attempt-history-title" className="attempt-history-title">
          尝试历史
        </h2>
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            if (window.confirm("清空当前账号在此浏览器中的全部尝试历史？"))
              void history.clear();
          }}
        >
          清空
        </button>
      </div>
      {history.status === "unavailable" && (
        <p className="form-message" role="status">
          浏览器本地存储不可用，尝试历史暂时只在本次会话中保留。
        </p>
      )}
      <ul className="attempt-history-list">
        {entries.map((entry) => (
          <li key={entry.id} className="attempt-history-row">
            <button
              type="button"
              className="attempt-history-password"
              onClick={() => onFill(entry.password)}
              aria-label={`填入口令 ${entry.password}`}
            >
              {entry.password}
            </button>
            <div className="attempt-history-meta">
              <span
                className={`attempt-history-result${entry.matched === true ? " is-matched" : ""}`}
              >
                {entry.matched === true
                  ? "已匹配"
                  : entry.matched === false
                    ? "未匹配"
                    : "未确认"}
              </span>
              <time dateTime={new Date(entry.lastAttemptAt).toISOString()}>
                {new Date(entry.lastAttemptAt).toLocaleString("zh-CN", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
            <div className="attempt-history-actions">
              {entry.activityIds.length === 1 && (
                <Link
                  className="button secondary small"
                  to="/activities/$id"
                  params={{ id: entry.activityIds[0] ?? "" }}
                  onClick={() => setIntent(null)}
                >
                  查看活动
                </Link>
              )}
              {entry.activityIds.length > 1 && (
                <ActionMenu
                  label="查看活动"
                  items={entry.activityIds.map((id, index) => ({
                    label: `活动${index + 1}`,
                    href: `/activities/${encodeURIComponent(id)}`,
                    onSelect: () => setIntent(null),
                  }))}
                />
              )}
              <CompactIconButton
                aria-label={`删除口令 ${entry.password} 的记录`}
                onClick={() => {
                  void history.remove(entry.id);
                }}
              >
                <Trash2 size={15} aria-hidden="true" />
              </CompactIconButton>
            </div>
          </li>
        ))}
      </ul>
      {history.entries.length > limit && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => setLimit((value) => value + 10)}
        >
          显示更多
        </button>
      )}
      <p className="attempt-history-description">仅保存在当前浏览器</p>
    </section>
  );
}
