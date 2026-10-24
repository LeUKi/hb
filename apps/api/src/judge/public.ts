// A 代码判定红包's public side (docs/programmable-hongbao-design.md §6): the
// prompt, the code's fingerprint and the seed's 封存值 from opening; once it
// is over, the code and the seed, written out once and checked against
// both. Nobody's input and none of the code's state are ever here.
import type { PublicJudge } from "@hb/contracts";
import { seedCommitment } from "../../../../kit/runtime/index.mjs";
import { databaseNow } from "../activities/lifecycle";
import { activityStatus } from "../activities/service";
import type { ActivityRow } from "../activities/storage";
import type { ApiBindings } from "../env";
import { decryptString } from "../security/crypto";
import {
  findJudgeRow,
  type JudgeRow,
  judgeData,
  readSeed,
  textDigest,
} from "./storage";

function isOver(row: ActivityRow) {
  return (
    row.endedAt !== null ||
    row.claimedCount >= row.totalCount ||
    (row.deadline !== null && row.deadline <= Date.now())
  );
}

async function revealed(env: ApiBindings, row: ActivityRow, judge: JudgeRow) {
  if (judge.code !== null && judge.seed !== null)
    return { code: judge.code, seed: judge.seed };
  if (row.openedAt === null || !isOver(row) || !judge.seedCommitment)
    return null;
  const [code, seed] = await Promise.all([
    decryptString(judge.codeCiphertext, env, judgeData(row.id, "code")),
    readSeed(env, judge),
  ]);
  if (
    (await textDigest(code)) !== judge.fingerprint ||
    seedCommitment(row.id, seed) !== judge.seedCommitment
  )
    throw new Error(
      "代码判定红包's code or seed does not match what it published",
    );
  try {
    await env.DB.prepare(`UPDATE activity_code SET code = ?, seed = ?, revealed_at = ${databaseNow}, updated_at = ${databaseNow}
      WHERE activity_id = ? AND revealed_at IS NULL`)
      .bind(code, seed, row.id)
      .run();
  } catch {
    // D1's clock a moment behind the deadline: shown on the next read.
    return null;
  }
  return { code, seed };
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
  const [out, judged] = await Promise.all([
    revealed(env, row, judge),
    judgedCount(env, row.id),
  ]);
  return {
    protocol: judge.protocol,
    prompt: judge.prompt,
    fingerprint: judge.fingerprint,
    seedCommitment: judge.seedCommitment,
    judged,
    ...(judge.pausedAt !== null && activityStatus(row) === "active"
      ? { paused: true as const }
      : {}),
    ...(judge.stoppedAt !== null ? { stopped: true as const } : {}),
    ...(out ?? {}),
  };
}
