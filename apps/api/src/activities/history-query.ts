import {
  type ActivityRewardFilter,
  type ActivityStatus,
  type ActivityStatusCounts,
  ARCHIVE_DELAY_MS,
} from "@hb/contracts";
import { type SQL, sql } from "drizzle-orm";
import { activities } from "../db/schema";
import { drawSummary } from "./draw-storage";
import type { ActivityRow } from "./storage";

/** Keep query-time lifecycle classification aligned with activityStatus, even before a sweep. */
export function activityStatusSql(now = Date.now()): SQL<ActivityStatus> {
  const end = sql`COALESCE(${activities.endedAt}, CASE WHEN ${activities.deadline} <= ${now} THEN ${activities.deadline} END)`;
  return sql`CASE
    WHEN ${activities.openedAt} IS NULL THEN 'draft'
    WHEN ${activities.archivedAt} IS NOT NULL THEN 'archived'
    WHEN ${end} IS NOT NULL AND ${now} >= ${end} + ${ARCHIVE_DELAY_MS}
      AND COALESCE(${activities.drawState}, '') NOT IN ('waiting', 'settling') THEN 'archived'
    WHEN ${end} IS NOT NULL OR ${activities.claimedCount} >= ${activities.totalCount} THEN 'ended'
    ELSE 'active' END`;
}

/** An open draw stays in the active list until its results are published. */
export function activityListStatusSql(now = Date.now()): SQL<ActivityStatus> {
  return sql`CASE
    WHEN ${activities.openedAt} IS NOT NULL AND ${activities.archivedAt} IS NULL
      AND ${activities.drawState} IN ('waiting', 'settling') THEN 'active'
    ELSE ${activityStatusSql(now)} END`;
}

/** List rows reflect the saved draw state; the countdown never invents settlement. */
export function activityListFields(
  row: ActivityRow,
  status: ActivityStatus,
  exact = true,
) {
  const draw = drawSummary(row, exact);
  return {
    participationMode: row.participationMode,
    status:
      row.openedAt !== null &&
      row.archivedAt === null &&
      (row.drawState === "waiting" || row.drawState === "settling")
        ? ("active" as const)
        : status,
    ...(draw
      ? { draw: { ...draw, state: row.drawState ?? ("waiting" as const) } }
      : {}),
  };
}

export function rewardFilterSql(type: ActivityRewardFilter = "all") {
  if (type === "all") return sql`1 = 1`;
  if (type === "text" || type === "ldc")
    return sql`${activities.rewardType} = ${type}`;
  return sql`${activities.rewardType} = 'ldc' AND json_extract(${activities.config}, '$.money.mode') = ${type}`;
}

export function historyStatusCounts(
  rows: { status: ActivityStatus; count: number }[],
): ActivityStatusCounts {
  const counts: ActivityStatusCounts = {
    all: 0,
    draft: 0,
    active: 0,
    ended: 0,
    archived: 0,
  };
  for (const row of rows) {
    counts[row.status] += Number(row.count);
    counts.all += Number(row.count);
  }
  return counts;
}
