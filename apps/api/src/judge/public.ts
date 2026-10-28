// A 代码判定红包's public side (docs/programmable-hongbao-design.md §6): the
// prompt, the code's fingerprint and the seed's 封存值 from opening; once it
// is over, the code and the seed, written out once and checked against
// both. Nobody's input and none of the code's state are ever here.
import type { JudgeDeclarations, PublicJudge } from "@hb/contracts";
import { seedCommitment } from "../../../../kit/runtime/index.mjs";
import { databaseNow } from "../activities/lifecycle";
import { activityStatus } from "../activities/service";
import type { ActivityRow } from "../activities/storage";
import type { ApiBindings } from "../env";
import { decryptString } from "../security/crypto";
import { declarationsFor, revealedParams } from "./params";
import {
  findJudgeRow,
  type JudgeRow,
  judgeData,
  readSeed,
  textDigest,
} from "./storage";

/** Over: ended, every share claimed, or its deadline passed. */
export function isOver(row: ActivityRow) {
  return (
    row.endedAt !== null ||
    row.claimedCount >= row.totalCount ||
    (row.deadline !== null && row.deadline <= Date.now())
  );
}

/**
 * Once it is over: the code, the seed and its secret params with their
 * salt (judge-square §3), each checked against what opening published,
 * written out once.
 */
async function revealed(
  env: ApiBindings,
  row: ActivityRow,
  judge: JudgeRow,
  declarations: JudgeDeclarations | null,
) {
  if (judge.code !== null && judge.seed !== null)
    return {
      code: judge.code,
      seed: judge.seed,
      ...(judge.paramsSecret !== null && judge.paramsSalt !== null
        ? {
            secret: JSON.parse(judge.paramsSecret) as Record<string, unknown>,
            salt: judge.paramsSalt,
          }
        : {}),
    };
  if (row.openedAt === null || !isOver(row) || !judge.seedCommitment)
    return null;
  const [code, seed, params] = await Promise.all([
    decryptString(judge.codeCiphertext, env, judgeData(row.id, "code")),
    readSeed(env, judge),
    revealedParams(env, judge, declarations),
  ]);
  if (
    (await textDigest(code)) !== judge.fingerprint ||
    seedCommitment(row.id, seed) !== judge.seedCommitment
  )
    throw new Error(
      "代码判定红包's code or seed does not match what it published",
    );
  try {
    await env.DB.prepare(`UPDATE activity_code SET code = ?, seed = ?, params_secret = ?, params_salt = ?,
      revealed_at = ${databaseNow}, updated_at = ${databaseNow}
      WHERE activity_id = ? AND revealed_at IS NULL`)
      .bind(
        code,
        seed,
        params ? JSON.stringify(params.secret) : null,
        params?.salt ?? null,
        row.id,
      )
      .run();
  } catch {
    // D1's clock a moment behind the deadline: shown on the next read.
    return null;
  }
  return { code, seed, ...(params ?? {}) };
}

/** Its 判定器 (judge-square §10): name, version and whose. */
async function judgeOf(env: ApiBindings, judge: JudgeRow) {
  if (!judge.judgeId) return undefined;
  const row = await env.DB.prepare(
    `SELECT j.name, u.username, u.display_name AS displayName FROM judges j
      JOIN users u ON u.id = j.author_id WHERE j.id = ?`,
  )
    .bind(judge.judgeId)
    .first<{ name: string; username: string; displayName: string }>();
  return row
    ? {
        name: row.name,
        version: judge.judgeVersion,
        author: { username: row.username, displayName: row.displayName },
      }
    : undefined;
}

/**
 * 已判定 N 次 (05 §4): every verdict, paid or not; failures never count.
 * Sequences run 0…N-1 (the insert guard, no updates, no deletes), so the
 * last one says it in one index seek, not a count of them all.
 */
export async function judgedCount(env: ApiBindings, activityId: string) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(sequence) + 1, 0) AS count FROM code_judgments WHERE activity_id = ?",
  )
    .bind(activityId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function publicJudge(
  env: ApiBindings,
  row: ActivityRow,
): Promise<PublicJudge | undefined> {
  if (row.participationMode !== "code") return undefined;
  const judge = await findJudgeRow(env, row.id);
  if (!judge) return undefined;
  // Its params' names and kinds, once it has opened with some.
  const declarations =
    judge.paramsPublic !== null
      ? await declarationsFor(env, row.authorId, judge)
      : null;
  const [out, judged, by] = await Promise.all([
    revealed(env, row, judge, declarations),
    judgedCount(env, row.id),
    judgeOf(env, judge),
  ]);
  const shown =
    judge.paramsPublic !== null
      ? (JSON.parse(judge.paramsPublic) as Record<string, unknown>)
      : null;
  const secrets = (declarations?.params ?? []).filter((item) => item.secret);
  const params = shown
    ? (declarations?.params ?? []).flatMap((param) => {
        const from = param.secret ? out?.secret : shown;
        return from && Object.hasOwn(from, param.key)
          ? [{ param, value: from[param.key] }]
          : [];
      })
    : [];
  return {
    protocol: judge.protocol,
    prompt: judge.prompt,
    fingerprint: judge.fingerprint,
    // 联网 (§9.5): public from opening, as the code it belongs to is.
    ...(judge.network !== null
      ? { network: JSON.parse(judge.network) as string[] }
      : {}),
    seedCommitment: judge.seedCommitment,
    judged,
    ...(judge.pausedAt !== null && activityStatus(row) === "active"
      ? { paused: true as const }
      : {}),
    ...(judge.stoppedAt !== null ? { stopped: true as const } : {}),
    ...(out ? { code: out.code, seed: out.seed } : {}),
    ...(by ? { judge: by } : {}),
    ...(params.length > 0 ? { params } : {}),
    ...(judge.paramsCommitment
      ? {
          sealedParams: {
            count: secrets.length,
            commitment: judge.paramsCommitment,
            ...(out?.salt ? { salt: out.salt } : {}),
          },
        }
      : {}),
  };
}
