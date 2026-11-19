import type {
  ActivityViewersDetail,
  ViewerCurve,
  ViewerStats,
} from "@hb/contracts";
import type { ApiBindings } from "../env";

// 在看人数 (docs/viewer-stats-design.md §3). A 红包's ActivityDO keeps, in
// its own SQLite, who was ever on its live channel, the most at once, and a
// row a minute while people come and go; it writes them to D1 when the last
// viewer leaves and when it sees the 红包 over, so the read after the end
// never wakes it. Nothing here sets a timer or an alarm: it all happens in
// a connect or a close the object is awake for anyway.

/** At most this many points on a curve; longer ones take several minutes a point. */
export const VIEWER_CURVE_POINTS = 240;

const MINUTE_MS = 60_000;

/** One minute with comings or goings: the most then, and how many at its end. */
export type ViewerMinute = { minute: number; top: number; last: number };

/** The object's numbers so far. */
export type ViewerTally = {
  peak: number;
  peakAt: number;
  total: number;
};

/** The minute a time falls in, as the object keys its rows. */
export const viewerMinute = (at: number) => Math.floor(at / MINUTE_MS);

/**
 * The curve from the object's minutes (in order): a minute without a row
 * stays at the count the last one ended with, and a minute's most is never
 * below the count it began with (people were there until the first change).
 * Past VIEWER_CURVE_POINTS minutes, each point is the most of several.
 * Over, it says when the object saw the end.
 */
export function viewerCurve(
  rows: ViewerMinute[],
  endedAt: number | null = null,
): ViewerCurve | null {
  const first = rows[0];
  const final = rows.at(-1);
  if (!first || !final) return null;
  const span = final.minute - first.minute + 1;
  const step = Math.max(1, Math.ceil(span / VIEWER_CURVE_POINTS));
  const values: number[] = [];
  let index = 0;
  let carry = 0;
  for (let start = first.minute; start <= final.minute; start += step) {
    let most = carry;
    for (
      let row = rows[index];
      row !== undefined && row.minute < start + step;
      row = rows[++index]
    ) {
      most = Math.max(most, row.top);
      carry = row.last;
    }
    values.push(most);
  }
  return {
    start: new Date(first.minute * MINUTE_MS).toISOString(),
    stepSeconds: step * 60,
    values,
    last: carry,
    ...(endedAt !== null ? { end: new Date(endedAt).toISOString() } : {}),
  };
}

export const publicViewerStats = (tally: ViewerTally): ViewerStats => ({
  peak: tally.peak,
  peakAt: new Date(tally.peakAt).toISOString(),
  total: tally.total,
});

/** The object's numbers and curve, into D1 (one row per 红包). */
export async function writeViewerStats(
  env: ApiBindings,
  activityId: string,
  tally: ViewerTally,
  curve: ViewerCurve | null,
) {
  await env.DB.prepare(
    `INSERT INTO activity_viewer_stats (activity_id, peak, peak_at, total, curve, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET peak = excluded.peak, peak_at = excluded.peak_at,
        total = excluded.total, curve = excluded.curve, updated_at = excluded.updated_at`,
  )
    .bind(
      activityId,
      tally.peak,
      tally.peakAt,
      tally.total,
      curve ? JSON.stringify(curve) : null,
      Date.now(),
    )
    .run();
}

type StoredRow = {
  peak: number;
  peakAt: number;
  total: number;
  curve: string | null;
};

async function storedRow(env: ApiBindings, activityId: string) {
  return env.DB.prepare(
    `SELECT peak, peak_at AS peakAt, total, curve FROM activity_viewer_stats
      WHERE activity_id = ?`,
  )
    .bind(activityId)
    .first<StoredRow>();
}

/** For the public read once the 红包 is over: the numbers alone. */
export async function storedViewerStats(
  env: ApiBindings,
  activityId: string,
): Promise<ViewerStats | null> {
  const row = await storedRow(env, activityId);
  return row && row.total > 0 ? publicViewerStats(row) : null;
}

/** What D1 has: the numbers and the curve as last written. */
export async function storedViewers(
  env: ApiBindings,
  activityId: string,
): Promise<ActivityViewersDetail> {
  const row = await storedRow(env, activityId);
  if (!row || row.total === 0) return { viewers: null, curve: null };
  let curve: ViewerCurve | null = null;
  try {
    curve = row.curve ? (JSON.parse(row.curve) as ViewerCurve) : null;
  } catch {
    // Written by the object only; unreadable means none.
  }
  return { viewers: publicViewerStats(row), curve };
}
