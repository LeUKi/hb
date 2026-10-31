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
import { eq, getTableColumns } from "drizzle-orm";
import { ActivityError } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import { createDb } from "../db/client";
import { activityCode } from "../db/schema";
import type { ApiBindings } from "../env";
import { decryptString, encryptString, sha256Hex } from "../security/crypto";
import { draftVersionsOf, ownJudge, renameStatement } from "./judges";
import { JUDGE_PROTOCOL } from "./sandbox";
import type { FetchRecord } from "./session";
import { borrowedVersion } from "./square";

/**
 * Its row without the code, the tests and the versions kept: those are
 * large (judge.js up to 256 KB, tests.json often more) and read where they
 * are used (judgeTexts), not with every claim and public read
 * (docs/programmable-hongbao-design.md §3, 热点).
 */
const {
  codeCiphertext: _code,
  testsCiphertext: _tests,
  versionsCiphertext: _versions,
  ...lightColumns
} = getTableColumns(activityCode);

export type JudgeRow = Omit<
  typeof activityCode.$inferSelect,
  "codeCiphertext" | "testsCiphertext" | "versionsCiphertext"
>;

/** What each encrypted part is bound to. */
export const judgeData = (
  activityId: string,
  part:
    | "code"
    | "tests"
    | "seed"
    | "state"
    | "versions"
    | "fetches"
    | "params"
    | "params-salt"
    | "setup"
    | "ledger"
    | "player",
) => `judge:${activityId}:${part}`;

/** The fingerprint (judge.js) and the tests' digest: SHA-256 of the text. */
export const textDigest = sha256Hex;

export function findJudgeRow(
  env: ApiBindings,
  activityId: string,
): Promise<JudgeRow | undefined> {
  return createDb(env.DB)
    .select(lightColumns)
    .from(activityCode)
    .where(eq(activityCode.activityId, activityId))
    .get();
}

const codes = new Map<string, string>();

/**
 * An opened 红包's judge.js: read and decrypted once per isolate, as it
 * never changes once open.
 */
export async function codeOf(env: ApiBindings, row: JudgeRow) {
  const cached = codes.get(row.activityId);
  if (cached !== undefined) return cached;
  const code = await readCode(env, row.activityId);
  codes.set(row.activityId, code);
  return code;
}

/** judge.js as kept, decrypted: read on its own (a draft's may change). */
export async function readCode(env: ApiBindings, activityId: string) {
  const row = await env.DB.prepare(
    "SELECT code_ciphertext AS code FROM activity_code WHERE activity_id = ?",
  )
    .bind(activityId)
    .first<{ code: string }>();
  if (!row) throw new Error("JUDGE_ROW_MISSING");
  return decryptString(row.code, env, judgeData(activityId, "code"));
}

/** The params its sender filled (docs/judge-square-design.md §3), or none. */
export async function readParams(env: ApiBindings, row: JudgeRow) {
  if (row.paramsCiphertext === null) return undefined;
  return JSON.parse(
    await decryptString(
      row.paramsCiphertext,
      env,
      judgeData(row.activityId, "params"),
    ),
  ) as Record<string, unknown>;
}

/**
 * The code, the tests and the prompt as the sender pasted them; the
 * 判定器 they are in (docs/judge-square-design.md §1) with its name and
 * versions, and the params filled. One from before 判定器 still shows the
 * versions it kept (until it is moved over, judges.ts).
 */
export async function readJudgeInput(
  env: ApiBindings,
  row: JudgeRow,
): Promise<JudgeInput> {
  const texts = await env.DB.prepare(
    `SELECT code_ciphertext AS code, tests_ciphertext AS tests,
      versions_ciphertext AS versions FROM activity_code WHERE activity_id = ?`,
  )
    .bind(row.activityId)
    .first<{ code: string; tests: string; versions: string | null }>();
  if (!texts) throw new Error("JUDGE_ROW_MISSING");
  const [code, tests, versions, params, judge] = await Promise.all([
    decryptString(texts.code, env, judgeData(row.activityId, "code")),
    decryptString(texts.tests, env, judgeData(row.activityId, "tests")),
    row.judgeId !== null
      ? draftVersionsOf(env, row.judgeId)
      : texts.versions === null
        ? null
        : decryptString(
            texts.versions,
            env,
            judgeData(row.activityId, "versions"),
          ).then((text) => JSON.parse(text) as JudgeVersions),
    readParams(env, row),
    row.judgeId === null
      ? null
      : env.DB.prepare(
          `SELECT j.name, j.description, j.author_id = a.author_id AS own
            FROM judges j JOIN activities a ON a.id = ?2 WHERE j.id = ?1`,
        )
          .bind(row.judgeId, row.activityId)
          .first<{ name: string; description: string; own: number }>(),
  ]);
  // Another's (§15.3): its version, never its tests nor its other versions.
  if (judge && judge.own !== 1 && row.judgeId !== null)
    return {
      prompt: row.prompt,
      code,
      tests: "",
      judgeId: row.judgeId,
      name: judge.name,
      description: judge.description,
      ...(row.judgeVersion !== null ? { version: row.judgeVersion } : {}),
      ...(row.networkAck !== null
        ? { networkAck: JSON.parse(row.networkAck) as string[] }
        : {}),
      ...(params === undefined ? {} : { params }),
    };
  return {
    prompt: row.prompt,
    code,
    tests,
    ...(versions === null ? {} : { versions }),
    ...(row.judgeId !== null && judge
      ? {
          judgeId: row.judgeId,
          name: judge.name,
          description: judge.description,
        }
      : {}),
    ...(params === undefined ? {} : { params }),
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
 * A draft's code, saved with the rest of it: written over each time, as its
 * 口令 are. Opening fixes it (activity_code_update_guard). It names its
 * 判定器 (docs/judge-square-design.md §1) — the sender's own, whose name
 * and line are saved onto it as typed — and the version its code is there;
 * a draft from a page before 判定器 still keeps its versions itself.
 */
export async function saveJudgeStatements(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  judge: JudgeInput,
  money: Extract<LdcMoney, { mode: "code" }>,
  now: number,
) {
  // Another's (§15.3): its version's code and tests, whatever was sent.
  const borrowed = judge.judgeId
    ? await borrowedVersion(
        env,
        activityId,
        authorId,
        judge.judgeId,
        judge.version,
      )
    : null;
  if (judge.judgeId && !borrowed) await ownJudge(env, judge.judgeId, authorId);
  const code = borrowed?.code ?? judge.code;
  const tests = borrowed?.tests ?? judge.tests;
  const [
    fingerprint,
    testsDigest,
    codeCiphertext,
    testsCiphertext,
    versionsCiphertext,
    paramsCiphertext,
  ] = await Promise.all([
    textDigest(code),
    textDigest(tests),
    encryptString(code, env, judgeData(activityId, "code")),
    encryptString(tests, env, judgeData(activityId, "tests")),
    judge.judgeId ? null : encryptVersions(env, activityId, judge.versions),
    judge.params === undefined
      ? null
      : encryptString(
          JSON.stringify(judge.params),
          env,
          judgeData(activityId, "params"),
        ),
  ]);
  return [
    ...(judge.judgeId && !borrowed && judge.name !== undefined
      ? [
          renameStatement(
            env,
            judge.judgeId,
            authorId,
            judge.name,
            judge.description ?? "",
          ),
        ]
      : []),
    env.DB.prepare(`INSERT INTO activity_code
    (activity_id, protocol, prompt, fingerprint, code_ciphertext, tests_ciphertext, tests_digest, min_each_minor,
      versions_ciphertext, judge_id, judge_version, params_ciphertext, network_ack, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
      (SELECT n FROM judge_versions WHERE judge_id = ?10 AND fingerprint = ?4), ?11, ?13, ?12, ?12)
    ON CONFLICT(activity_id) DO UPDATE SET protocol = excluded.protocol, prompt = excluded.prompt,
      fingerprint = excluded.fingerprint, code_ciphertext = excluded.code_ciphertext,
      tests_ciphertext = excluded.tests_ciphertext, tests_digest = excluded.tests_digest,
      min_each_minor = excluded.min_each_minor, versions_ciphertext = excluded.versions_ciphertext,
      judge_id = excluded.judge_id, judge_version = excluded.judge_version,
      params_ciphertext = excluded.params_ciphertext, network_ack = excluded.network_ack,
      updated_at = excluded.updated_at`).bind(
      activityId,
      JUDGE_PROTOCOL,
      judge.prompt.trim(),
      fingerprint,
      codeCiphertext,
      testsCiphertext,
      testsDigest,
      // Protocol 5 has no 每份至少: 0.01 (a draft from before keeps its own).
      money.minEach ? amountToMinor(money.minEach) : 1,
      versionsCiphertext,
      judge.judgeId ?? null,
      paramsCiphertext,
      now,
      borrowed && judge.networkAck ? JSON.stringify(judge.networkAck) : null,
    ),
  ];
}

/** A draft that is no longer 代码判定 drops its code. */
export function dropJudgeStatement(env: ApiBindings, activityId: string) {
  return env.DB.prepare("DELETE FROM activity_code WHERE activity_id = ?").bind(
    activityId,
  );
}

/**
 * Whether a saved draft holds this code, these tests and this prompt, and
 * (from 判定器 on) the same params.
 */
export async function sameJudge(
  env: ApiBindings,
  row: JudgeRow,
  judge: JudgeInput,
) {
  // Another's (§15.3) is held by its version: its tests are never sent.
  const sameCode =
    judge.version !== undefined
      ? row.judgeId === judge.judgeId && row.judgeVersion === judge.version
      : row.fingerprint === (await textDigest(judge.code)) &&
        row.testsDigest === (await textDigest(judge.tests));
  return (
    row.prompt === judge.prompt.trim() &&
    sameCode &&
    sameJson((await readParams(env, row)) ?? null, judge.params ?? null)
  );
}

/** JSON alike whatever order its keys were written in. */
function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every(
        (key) =>
          Object.hasOwn(right, key) &&
          sameJson(
            (left as Record<string, unknown>)[key],
            (right as Record<string, unknown>)[key],
          ),
      )
    );
  }
  return left === right;
}

/** A 红包's secret seed (64 hex digits), made as it opens. */
export function newSeed() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Opening: the secret seed, sealed; its 封存值 is public from now on. The
 * 红包 takes the protocol it opens on (opening.ts codeOpeningRun), and the
 * addresses its code exports as the run of this code and these tests on
 * it that passed found them (§9.2) — its 判定器 author's run, for
 * another's (judge-square §15.3).
 */
export async function sealSeedStatement(
  env: ApiBindings,
  activityId: string,
  secret: string,
  commitment: string,
  protocol: number,
) {
  return env.DB.prepare(`UPDATE activity_code SET seed_commitment = ?1, seed_ciphertext = ?2,
      protocol = ?4, network = (SELECT k.network FROM judge_checks k JOIN activities a ON a.id = activity_code.activity_id
        WHERE k.user_id = COALESCE((SELECT author_id FROM judges WHERE id = activity_code.judge_id), a.author_id)
          AND k.protocol = ?4 AND k.fingerprint = activity_code.fingerprint
          AND k.tests_digest = activity_code.tests_digest AND k.passed = 1
        ORDER BY k.created_at DESC LIMIT 1),
      updated_at = ${databaseNow}
    WHERE activity_id = ?3 AND seed_commitment IS NULL`).bind(
    commitment,
    await encryptString(secret, env, judgeData(activityId, "seed")),
    activityId,
    protocol,
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
