// 密钥 (docs/judge-key-design.md): a 代码判定红包's, as its sender filled
// them, kept encrypted apart from everything else; never given to the code,
// never read back to anyone. The gateway adds each to requests to its own
// address; once the 红包 is over they are deleted.
import type { JudgeDeclarations } from "@hb/contracts";
import {
  keyHeaders,
  keyParams,
  readKeyValue,
} from "../../../../kit/runtime/index.mjs";
import { ActivityError } from "../activities/errors";
import type { ApiBindings } from "../env";
import { decryptString, encryptString } from "../security/crypto";
import { judgeData } from "./storage";

type Values = Record<string, string>;

async function stored(env: ApiBindings, activityId: string) {
  const row = await env.DB.prepare(
    "SELECT ciphertext FROM activity_keys WHERE activity_id = ?",
  )
    .bind(activityId)
    .first<{ ciphertext: string }>();
  return row
    ? (JSON.parse(
        await decryptString(row.ciphertext, env, judgeData(activityId, "keys")),
      ) as Values)
    : {};
}

/** The keys filled (names only): what a read may say of them. */
export async function keyNamesOf(env: ApiBindings, activityId: string) {
  const row = await env.DB.prepare(
    "SELECT names FROM activity_keys WHERE activity_id = ?",
  )
    .bind(activityId)
    .first<{ names: string }>();
  return row ? (JSON.parse(row.names) as string[]) : [];
}

/**
 * The 密钥 typed, over those kept: each a key its version declares, in its
 * own words when it is not. A statement to batch with the rest of the
 * save; null when none was typed.
 */
export async function saveKeysStatement(
  env: ApiBindings,
  activityId: string,
  declarations: JudgeDeclarations | null,
  typed: Readonly<Record<string, string>> | undefined,
  now: number,
) {
  const given = Object.entries(typed ?? {});
  if (given.length === 0) return null;
  const declared = keyParams(declarations?.params ?? []);
  const values = await stored(env, activityId);
  for (const [key, value] of given) {
    const item = declared.find((each) => each.key === key);
    if (!item)
      throw new ActivityError(
        400,
        "JUDGE_KEY_UNKNOWN",
        "这个判定器没有要填的密钥，刷新页面后再试。",
      );
    const read = readKeyValue(item, value);
    if ("problem" in read)
      throw new ActivityError(400, "JUDGE_KEY_INVALID", read.problem);
    values[key] = read.value;
  }
  // Only those it declares: a version changed since drops the rest.
  const kept = Object.fromEntries(
    Object.entries(values).filter(([key]) =>
      declared.some((item) => item.key === key),
    ),
  );
  return env.DB.prepare(
    `INSERT INTO activity_keys (activity_id, names, ciphertext, updated_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(activity_id) DO UPDATE SET names = excluded.names, ciphertext = excluded.ciphertext,
        updated_at = excluded.updated_at`,
  ).bind(
    activityId,
    JSON.stringify(Object.keys(kept)),
    await encryptString(
      JSON.stringify(kept),
      env,
      judgeData(activityId, "keys"),
    ),
    now,
  );
}

/** What the version this code is in its 判定器 declares; null without one. */
export async function versionDeclarations(
  env: ApiBindings,
  judgeId: string | null,
  fingerprint: string,
) {
  if (!judgeId) return null;
  const row = await env.DB.prepare(
    "SELECT declarations FROM judge_versions WHERE judge_id = ? AND fingerprint = ?",
  )
    .bind(judgeId, fingerprint)
    .first<{ declarations: string | null }>();
  return row?.declarations
    ? (JSON.parse(row.declarations) as JudgeDeclarations)
    : null;
}

/** The required 密钥 not filled yet: their labels, for why it cannot open. */
export function missingKeys(
  declarations: JudgeDeclarations | null,
  names: readonly string[],
) {
  return keyParams(declarations?.params ?? [])
    .filter((item) => item.required !== false && !names.includes(item.key))
    .map((item) => item.label);
}

/**
 * What the gateway adds to a request to `address` (judge-key §1): the
 * header of each 密钥 whose own address it is under, read anew each time
 * (a 密钥 changed applies from the next request).
 */
export async function keyHeadersFor(
  env: ApiBindings,
  activityId: string,
  address: string,
) {
  const row = await env.DB.prepare(
    `SELECT v.declarations FROM activity_code c JOIN judge_versions v ON v.judge_id = c.judge_id AND v.n = c.judge_version
      WHERE c.activity_id = ? AND EXISTS(SELECT 1 FROM activity_keys k WHERE k.activity_id = c.activity_id)`,
  )
    .bind(activityId)
    .first<{ declarations: string | null }>();
  if (!row?.declarations) return [];
  const params = (JSON.parse(row.declarations) as JudgeDeclarations).params;
  if (keyParams(params).length === 0) return [];
  return keyHeaders(params, await stored(env, activityId), address);
}

/** Gone once the 红包 is over, or deleted (judge-key §1). */
export const dropKeysStatement = (env: ApiBindings, activityId: string) =>
  env.DB.prepare("DELETE FROM activity_keys WHERE activity_id = ?").bind(
    activityId,
  );

/**
 * Every 红包 over or deleted lets go of its 密钥 (the maintenance task; a
 * read past its end lets go of its own sooner).
 */
export async function sweepKeys(env: ApiBindings, now = Date.now()) {
  await env.DB.prepare(`DELETE FROM activity_keys WHERE activity_id IN (SELECT a.id FROM activities a
      WHERE a.deleted_at IS NOT NULL OR a.ended_at IS NOT NULL OR (a.opened_at IS NOT NULL
        AND (a.claimed_count >= a.total_count OR (a.deadline IS NOT NULL AND a.deadline <= ?1))))`)
    .bind(now)
    .run();
}
