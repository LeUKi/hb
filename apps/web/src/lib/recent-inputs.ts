import { useCallback, useMemo } from "react";
import { activityToolsEnabled } from "./activity-tools-release";
import { useAttemptHistory } from "./attempt-history";

/** One 口令 in 最近输入, as the start page and the 指令框 list it. */
export type RecentEntry = {
  password: string;
  /** 匹配到 / 未匹配 / 待确认 (the answer was lost). */
  status: "matched" | "unmatched" | "unconfirmed";
  activityIds: string[];
  at: number;
};

/**
 * 最近输入: this account's 口令 attempts in this browser (IndexedDB, never
 * sent anywhere), newest first.
 */
export function useRecentInputs(userId: string | null) {
  const history = useAttemptHistory(activityToolsEnabled ? userId : null);
  const { entries: rows, remove: removeRow, clear: clearRows } = history;
  const entries = useMemo<RecentEntry[]>(
    () =>
      rows.map((row) => ({
        password: row.password,
        status:
          row.matched === null
            ? "unconfirmed"
            : row.matched
              ? "matched"
              : "unmatched",
        activityIds: row.activityIds,
        at: row.lastAttemptAt,
      })),
    [rows],
  );
  const remove = useCallback(
    (password: string) => {
      const row = rows.find((entry) => entry.password === password);
      if (row) void removeRow(row.id);
    },
    [removeRow, rows],
  );
  const clear = useCallback(() => void clearRows(), [clearRows]);
  return { entries, remove, clear };
}
