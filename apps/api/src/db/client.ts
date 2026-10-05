import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

export const createDb = (database: D1Database) => drizzle(database);

export async function checkD1(database: D1Database) {
  const result = await createDb(database).get<{ ok: number }>(
    sql`SELECT 1 AS ok`,
  );

  return result?.ok === 1;
}
