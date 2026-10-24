import { type LdcActivityInput, ldcAmounts } from "@hb/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { activities, activityPasswords, rewardInventory } from "../db/schema";
import type { ApiBindings } from "../env";
import {
  decryptString,
  digestPassword,
  encryptString,
} from "../security/crypto";
import { activityNotFound } from "./errors";
import { generateRandomAmounts } from "./random-money";

export type ActivityRow = typeof activities.$inferSelect;
export type PasswordRow = typeof activityPasswords.$inferSelect;
export type InventoryRow = typeof rewardInventory.$inferSelect;

export async function findActivity(env: ApiBindings, id: string) {
  return createDb(env.DB)
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.id, id),
        eq(activities.rewardType, "ldc"),
        isNull(activities.deletedAt),
      ),
    )
    .get();
}

/** A failed predicate aborts the batch even when the target row is absent. */
export function activityWriteGuard(
  database: D1Database,
  id: string,
  authorId: string,
  version: number,
) {
  return database
    .prepare(`SELECT json(CASE WHEN EXISTS (
      SELECT 1 FROM activities WHERE id = ? AND author_id = ?
        AND version = ? AND reward_type = 'ldc' AND deleted_at IS NULL
    ) THEN '{}' ELSE '' END) AS activity_write_guard`)
    .bind(id, authorId, version);
}

export async function ownedActivity(
  env: ApiBindings,
  id: string,
  authorId: string,
) {
  const activity = await findActivity(env, id);
  if (!activity || activity.authorId !== authorId) activityNotFound();
  return activity;
}

export async function privateRows(env: ApiBindings, activityId: string) {
  const db = createDb(env.DB);
  const ldcActivity = and(
    eq(activities.id, activityId),
    eq(activities.rewardType, "ldc"),
    isNull(activities.deletedAt),
  );
  const [passwords, inventory] = await db.batch([
    db
      .select()
      .from(activityPasswords)
      .where(
        and(
          eq(activityPasswords.activityId, activityId),
          sql`EXISTS ${db.select({ one: sql`1` }).from(activities).where(ldcActivity)}`,
        ),
      )
      .orderBy(activityPasswords.position),
    db
      .select()
      .from(rewardInventory)
      .where(
        and(
          eq(rewardInventory.activityId, activityId),
          eq(rewardInventory.kind, "ldc"),
          sql`EXISTS ${db.select({ one: sql`1` }).from(activities).where(ldcActivity)}`,
        ),
      )
      .orderBy(rewardInventory.position),
  ]);
  return { passwords, inventory };
}

export function passwordAssociatedData(activityId: string, passwordId: string) {
  return `activity:${activityId}:password:${passwordId}`;
}

export async function readPrivateContent(env: ApiBindings, activityId: string) {
  const { passwords } = await privateRows(env, activityId);
  return decryptRows(env, activityId, passwords);
}

export async function privateSnapshot(env: ApiBindings, activityId: string) {
  const db = createDb(env.DB);
  const row = await db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.id, activityId),
        eq(activities.rewardType, "ldc"),
        isNull(activities.deletedAt),
      ),
    )
    .get();
  if (!row) activityNotFound();
  const { passwords } = await privateRows(env, activityId);
  return {
    row,
    content: await decryptRows(env, activityId, passwords),
  };
}

async function decryptRows(
  env: ApiBindings,
  activityId: string,
  passwords: PasswordRow[],
) {
  const passwordValues = await Promise.all(
    passwords.map((row) =>
      decryptString(
        row.ciphertext,
        env,
        passwordAssociatedData(activityId, row.id),
      ),
    ),
  );
  return { passwords: passwordValues };
}

export async function preparePasswords(
  env: ApiBindings,
  activityId: string,
  values: string[],
  existing: PasswordRow[],
  now: number,
) {
  const byDigest = new Map(existing.map((row) => [row.digest, row]));
  return Promise.all(
    values.map(async (value, position): Promise<PasswordRow> => {
      const digest = await digestPassword(value, env.PASSWORD_DIGEST_KEY);
      const old = byDigest.get(digest);
      if (old) return { ...old, position };
      const id = crypto.randomUUID();
      return {
        id,
        activityId,
        position,
        digest,
        createdAt: now,
        ciphertext: await encryptString(
          value,
          env,
          passwordAssociatedData(activityId, id),
        ),
      };
    }),
  );
}

export function prepareLdcInventory(
  activityId: string,
  input: LdcActivityInput,
  existing: InventoryRow[],
  now: number,
): InventoryRow[] {
  // A draw's prizes come with its plan, a 代码判定's shares as judged.
  if (input.money.mode === "timed_draw" || input.money.mode === "code")
    return [];
  const amounts =
    input.money.mode === "random"
      ? generateRandomAmounts(input.money)
      : ldcAmounts(input);
  return amounts.map((amountMinor, position) => ({
    id: existing[position]?.id ?? crypto.randomUUID(),
    activityId,
    position,
    amountMinor,
    kind: "ldc",
    ciphertext: null,
    createdAt: existing[position]?.createdAt ?? now,
  }));
}

// JSON parameters keep 1,000 inventory entries below D1's bound-parameter limit.
export function insertPasswordRows(db: D1Database, rows: PasswordRow[]) {
  return db
    .prepare(`INSERT INTO activity_passwords (id, activity_id, digest, ciphertext, position, created_at)
    SELECT json_extract(value, '$.id'), json_extract(value, '$.activityId'), json_extract(value, '$.digest'),
      json_extract(value, '$.ciphertext'), json_extract(value, '$.position'), json_extract(value, '$.createdAt')
    FROM json_each(?)`)
    .bind(JSON.stringify(rows));
}

export function insertInventoryRows(db: D1Database, rows: InventoryRow[]) {
  return db
    .prepare(`INSERT INTO reward_inventory (id, activity_id, position, kind, ciphertext, amount_minor, created_at)
    SELECT json_extract(value, '$.id'), json_extract(value, '$.activityId'), json_extract(value, '$.position'), json_extract(value, '$.kind'),
      json_extract(value, '$.ciphertext'), json_extract(value, '$.amountMinor'), json_extract(value, '$.createdAt')
    FROM json_each(?)`)
    .bind(JSON.stringify(rows));
}
