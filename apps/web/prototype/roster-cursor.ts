import type { RecipientExample } from "./fixtures";

export type RosterRecord = Readonly<RecipientExample> & {
  readonly id: string;
  readonly timestamp: number;
};

export type RosterCursor = Pick<RosterRecord, "id" | "timestamp">;

export type RosterBatch = {
  rows: readonly RosterRecord[];
  nextCursor: RosterCursor | null;
  hasMore: boolean;
};

function compareDescending(left: RosterCursor, right: RosterCursor) {
  if (left.timestamp !== right.timestamp)
    return right.timestamp - left.timestamp;
  return left.id === right.id ? 0 : left.id > right.id ? -1 : 1;
}

/** Local data uses the same timestamp + stable ID order as a cursor list. */
export function rosterRecords(
  rows: readonly Readonly<RecipientExample>[],
  scope: string,
): readonly RosterRecord[] {
  const unique = new Map<string, RosterRecord>();
  for (const row of rows) {
    const timestamp = Date.parse(row.time);
    const record = {
      ...row,
      id: row.id ?? `${scope}:${row.username}:${row.time}`,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    };
    const previous = unique.get(record.id);
    if (!previous || record.timestamp >= previous.timestamp)
      unique.set(record.id, record);
  }
  return [...unique.values()].sort(compareDescending);
}

export function readRosterBatch(
  records: readonly RosterRecord[],
  cursor: RosterCursor | null = null,
  size = 20,
): RosterBatch {
  const limit = Number.isFinite(size) ? Math.max(1, Math.trunc(size)) : 20;
  const remaining = cursor
    ? records.filter((record) => compareDescending(record, cursor) > 0)
    : records;
  const rows = remaining.slice(0, limit);
  const last = rows.at(-1);
  const hasMore = remaining.length > rows.length;
  return {
    rows,
    nextCursor:
      hasMore && last ? { id: last.id, timestamp: last.timestamp } : null,
    hasMore,
  };
}

export function appendRosterRows(
  previous: readonly RosterRecord[],
  next: readonly RosterRecord[],
): readonly RosterRecord[] {
  const rows = new Map(previous.map((row) => [row.id, row]));
  for (const row of next) rows.set(row.id, row);
  return [...rows.values()].sort(compareDescending);
}
