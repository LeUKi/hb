// A 代码判定红包's code as kept (activity_code): judge.js, tests.json and
// the draft's deployed versions encrypted like 口令, the prompt and 每份至少
// beside them; from opening its sealed seed and the code's state
// (docs/programmable-hongbao-design.md).
import {
  amountToMinor,
  type JudgeInput,
  type JudgeVersions,
  type LdcMoney,
} from "@hb/contracts";
import { eq } from "drizzle-orm";
import { ActivityError } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import { createDb } from "../db/client";
import { activityCode } from "../db/schema";
import type { ApiBindings } from "../env";
import { decryptString, encryptString, sha256Hex } from "../security/crypto";
import { JUDGE_PROTOCOL } from "./sandbox";
import type { FetchRecord } from "./session";

export type JudgeRow = typeof activityCode.$inferSelect;

/** What each encrypted part is bound to. */
export const judgeData = (
  activityId: string,
  part: "code" | "tests" | "seed" | "state" | "versions" | "fetches",
) => `judge:${activityId}:${part}`;

/** The fingerprint (judge.js) and the tests' digest: SHA-256 of the text. */
export const textDigest = sha256Hex;

export function findJudgeRow(env: ApiBindings, activityId: string) {
  return createDb(env.DB)
    .select()
    .from(activityCode)
    .where(eq(activityCode.activityId, activityId))
    .get();
}

/** The code, the tests and the prompt as the sender pasted them. */
export async function readJudgeInput(
  env: ApiBindings,
  row: JudgeRow,
): Promise<JudgeInput> {
  const [code, tests, versions] = await Promise.all([
    decryptString(row.codeCiphertext, env, judgeData(row.activityId, "code")),
    decryptString(row.testsCiphertext, env, judgeData(row.activityId, "tests")),
    row.versionsCiphertext === null
      ? null
      : decryptString(
          row.versionsCiphertext,
          env,
          judgeData(row.activityId, "versions"),
        ),
  ]);
  return {
    prompt: row.prompt,
    code,
    tests,
    ...(versions === null
      ? {}
      : { versions: JSON.parse(versions) as JudgeVersions }),
  };
}

/**
 * 换回 (§5): the code kept to go back to is the very version it names. The
 * numbers are the form's; only this can be checked here.
 */
async function encryptVersions(
  env: ApiBindings,
  activityId: string,
  versions: JudgeVersions | undefined,
) {
  if (!versions) return null;
  const { restore } = versions;
  if (
    restore &&
    versions.versions.find((version) => version.n === restore.n)
      ?.fingerprint !== (await textDigest(restore.code))
  )
    throw new ActivityError(
      400,
      "INVALID_ACTIVITY",
      `换回的代码和第 ${restore.n} 版不一样`,
    );
  return encryptString(
    JSON.stringify(versions),
    env,
    judgeData(activityId, "versions"),
  );
}

/**
 * A draft's code and its versions, saved with the rest of it: written over
 * each time, as its 口令 are. Opening fixes it (activity_code_update_guard).
 */
export async function saveJudgeStatement(
  env: ApiBindings,
  activityId: string,
  judge: JudgeInput,
  money: Extract<LdcMoney, { mode: "code" }>,
  now: number,
) {
  const [
    fingerprint,
    testsDigest,
    codeCiphertext,
    testsCiphertext,
    versionsCiphertext,
  ] = await Promise.all([
    textDigest(judge.code),
    textDigest(judge.tests),
    encryptString(judge.code, env, judgeData(activityId, "code")),
    encryptString(judge.tests, env, judgeData(activityId, "tests")),
    encryptVersions(env, activityId, judge.versions),
  ]);
  return env.DB.prepare(`INSERT INTO activity_code
    (activity_id, protocol, prompt, fingerprint, code_ciphertext, tests_ciphertext, tests_digest, min_each_minor, versions_ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET protocol = excluded.protocol, prompt = excluded.prompt,
      fingerprint = excluded.fingerprint, code_ciphertext = excluded.code_ciphertext,
      tests_ciphertext = excluded.tests_ciphertext, tests_digest = excluded.tests_digest,
      min_each_minor = excluded.min_each_minor, versions_ciphertext = excluded.versions_ciphertext,
      updated_at = excluded.updated_at`).bind(
    activityId,
    JUDGE_PROTOCOL,
    judge.prompt.trim(),
    fingerprint,
    codeCiphertext,
    testsCiphertext,
    testsDigest,
    amountToMinor(money.minEach),
    versionsCiphertext,
    now,
    now,
  );
}

/** A draft that is no longer 代码判定 drops its code. */
export function dropJudgeStatement(env: ApiBindings, activityId: string) {
  return env.DB.prepare("DELETE FROM activity_code WHERE activity_id = ?").bind(
    activityId,
  );
}

/** Whether a saved draft holds this code, these tests and this prompt. */
export async function sameJudge(row: JudgeRow, judge: JudgeInput) {
  return (
    row.prompt === judge.prompt.trim() &&
    row.fingerprint === (await textDigest(judge.code)) &&
    row.testsDigest === (await textDigest(judge.tests))
  );
}

/**
 * Opening: the secret seed, sealed; its 封存值 is public from now on. The
 * 红包 takes the current protocol, and the addresses its code exports as
 * the run of this code and these tests that passed found them (§9.2).
 */
export async function sealSeedStatement(
  env: ApiBindings,
  activityId: string,
  commitment: (secret: string) => string,
) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return env.DB.prepare(`UPDATE activity_code SET seed_commitment = ?1, seed_ciphertext = ?2,
      protocol = ?4, network = (SELECT k.network FROM judge_checks k JOIN activities a ON a.id = activity_code.activity_id
        WHERE k.user_id = a.author_id AND k.protocol = ?4 AND k.fingerprint = activity_code.fingerprint
          AND k.tests_digest = activity_code.tests_digest AND k.passed = 1
        ORDER BY k.created_at DESC LIMIT 1),
      updated_at = ${databaseNow}
    WHERE activity_id = ?3 AND seed_commitment IS NULL`).bind(
    commitment(secret),
    await encryptString(secret, env, judgeData(activityId, "seed")),
    activityId,
    JUDGE_PROTOCOL,
  );
}

/** A judgment's requests and answers (联网, §9.4), as the gateway kept them. */
export async function fetchesOf(
  env: ApiBindings,
  activityId: string,
  rowId: string,
  ciphertext: string | null,
): Promise<FetchRecord[]> {
  if (ciphertext === null) return [];
  return JSON.parse(
    await decryptString(
      ciphertext,
      env,
      `${judgeData(activityId, "fetches")}:${rowId}`,
    ),
  ) as FetchRecord[];
}

export async function readSeed(env: ApiBindings, row: JudgeRow) {
  if (!row.seedCiphertext) throw new Error("The code's seed is not sealed");
  return decryptString(
    row.seedCiphertext,
    env,
    judgeData(row.activityId, "seed"),
  );
}
