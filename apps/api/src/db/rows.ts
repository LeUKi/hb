import { getTableColumns, type Table } from "drizzle-orm";

/**
 * A row read with plain SQL (`SELECT *`, `RETURNING *`) as drizzle's own
 * select gives it: keyed by the columns' names in code, each value mapped
 * as its column says (booleans, timestamps). For reads and writes made in
 * one D1 batch, which drizzle's batch cannot mix with plain statements.
 */
export function tableRow<T extends Table>(
  table: T,
  raw: Record<string, unknown> | null | undefined,
): T["$inferSelect"] | undefined {
  if (!raw) return undefined;
  const row: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    const value = raw[column.name];
    row[key] =
      value === null || value === undefined
        ? null
        : column.mapFromDriverValue(value);
  }
  return row as T["$inferSelect"];
}
