import { type LdcActivityInput, ldcAmounts } from "@hb/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { createDb } from "../db/client";
import { activities, activityPasswords, rewardInventory } from "../db/schema";
import type { ApiBindings } from "../env";
import {
  decryptString,
  digestPassword,
  encryptString,
} from "../security/crypto";
import { activityNotFound, invalidActivity } from "./errors";
import { generateRandomAmounts } from "./random-money";

export type ActivityRow = typeof activities.$inferSelect;
export type PasswordRow = typeof activityPasswords.$inferSelect;
export type InventoryRow = typeof rewardInventory.$inferSelect;

export async function findActivity(env: ApiBindings, id: string) {
  return createDb(env.DB)
    .select()
    .from(activities)
    .where(and(eq(activities.id, id), isNull(activities.deletedAt)))
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
        AND version = ? AND deleted_at IS NULL
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
  const [passwords, inventory] = await db.batch([
    db
      .select()
      .from(activityPasswords)
      .where(eq(activityPasswords.activityId, activityId))
      .orderBy(activityPasswords.position),
    db
      .select()
      .from(rewardInventory)
      .where(eq(rewardInventory.activityId, activityId))
      .orderBy(rewardInventory.position),
  ]);
  return { passwords, inventory };
}

export function passwordAssociatedData(activityId: string, passwordId: string) {
  return `activity:${activityId}:password:${passwordId}`;
}

export function rewardAssociatedData(activityId: string, inventoryId: string) {
  return `activity:${activityId}:reward:${inventoryId}`;
}

export async function readPrivateContent(env: ApiBindings, activityId: string) {
  const { passwords, inventory } = await privateRows(env, activityId);
  return decryptRows(env, activityId, passwords, inventory);
}

export async function privateSnapshot(env: ApiBindings, activityId: string) {
  const db = createDb(env.DB);
  const [rows, passwords, inventory] = await db.batch([
    db
      .select()
      .from(activities)
      .where(and(eq(activities.id, activityId), isNull(activities.deletedAt))),
    db
      .select()
      .from(activityPasswords)
      .where(eq(activityPasswords.activityId, activityId))
      .orderBy(activityPasswords.position),
    db
      .select()
      .from(rewardInventory)
      .where(eq(rewardInventory.activityId, activityId))
      .orderBy(rewardInventory.position),
  ]);
  const row = rows[0];
  if (!row) activityNotFound();
  return {
    row,
    content: await decryptRows(env, activityId, passwords, inventory),
  };
}

async function decryptRows(
  env: ApiBindings,
  activityId: string,
  passwords: PasswordRow[],
  inventory: InventoryRow[],
) {
  const [passwordValues, rewards] = await Promise.all([
    Promise.all(
      passwords.map((row) =>
        decryptString(
          row.ciphertext,
          env,
          passwordAssociatedData(activityId, row.id),
        ),
      ),
    ),
    Promise.all(
      inventory
        .filter((row) => row.kind === "text")
        .map(async (row) => ({
          id: row.id,
          text: await decryptString(
            row.ciphertext ?? "",
            env,
            rewardAssociatedData(activityId, row.id),
          ),
        })),
    ),
  ]);
  return { passwords: passwordValues, rewards };
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

export async function prepareInventory(
  env: ApiBindings,
  activityId: string,
  values: { id: string; text: string }[],
  existing: InventoryRow[],
  now: number,
) {
  const byId = new Map(existing.map((row) => [row.id, row]));
  const ids = new Set<string>();
  return Promise.all(
    values.map(async (value, position): Promise<InventoryRow> => {
      if (ids.has(value.id)) {
        invalidActivity("奖励条目标识无效或重复");
      }
      const id = value.id;
      ids.add(id);
      return {
        id,
        activityId,
        position,
        createdAt: byId.get(id)?.createdAt ?? now,
        kind: "text",
        amountMinor: null,
        ciphertext: await encryptString(
          value.text,
          env,
          rewardAssociatedData(activityId, id),
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
  if (input.money.mode === "timed_draw") return [];
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
