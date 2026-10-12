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

function lifecycleColumn(alias: string, name: string) {
  return `${alias}."${name}"`;
}

/** Keep query-time lifecycle classification aligned with activityStatus, even before a sweep. */
export function activityStatusCaseSql(
  now = Date.now(),
  alias = '"activities"',
) {
  const openedAt = lifecycleColumn(alias, "opened_at");
  const archivedAt = lifecycleColumn(alias, "archived_at");
  const endedAt = lifecycleColumn(alias, "ended_at");
  const deadline = lifecycleColumn(alias, "deadline");
  const drawState = lifecycleColumn(alias, "draw_state");
  const claimedCount = lifecycleColumn(alias, "claimed_count");
  const totalCount = lifecycleColumn(alias, "total_count");
  const end = `COALESCE(${endedAt}, CASE WHEN ${deadline} <= ${now} THEN ${deadline} END)`;
  return `CASE
    WHEN ${openedAt} IS NULL THEN 'draft'
    WHEN ${archivedAt} IS NOT NULL THEN 'archived'
    WHEN ${end} IS NOT NULL AND ${now} >= ${end} + ${ARCHIVE_DELAY_MS}
      AND COALESCE(${drawState}, '') NOT IN ('waiting', 'settling') THEN 'archived'
    WHEN ${end} IS NOT NULL OR ${claimedCount} >= ${totalCount} THEN 'ended'
    ELSE 'active' END`;
}

export function activityStatusSql(now = Date.now()): SQL<ActivityStatus> {
  return sql.raw(activityStatusCaseSql(now)) as SQL<ActivityStatus>;
}

/** An open draw stays in the active list until its results are published. */
export function activityListStatusCaseSql(
  now = Date.now(),
  alias = '"activities"',
) {
  const openedAt = lifecycleColumn(alias, "opened_at");
  const archivedAt = lifecycleColumn(alias, "archived_at");
  const drawState = lifecycleColumn(alias, "draw_state");
  return `CASE
    WHEN ${openedAt} IS NOT NULL AND ${archivedAt} IS NULL
      AND ${drawState} IN ('waiting', 'settling') THEN 'active'
    ELSE ${activityStatusCaseSql(now, alias)} END`;
}

export function activityListStatusSql(now = Date.now()): SQL<ActivityStatus> {
  return sql.raw(activityListStatusCaseSql(now)) as SQL<ActivityStatus>;
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
