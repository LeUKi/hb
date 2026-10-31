// A 代码判定红包's params from opening on (docs/judge-square-design.md §3):
// held to what the version its code is declares and to its check(), then
// sealed — the params everyone sees published, the secret ones' 参数封存值
// with them, their salt kept encrypted — handed to every judgment, and the
// secret ones and the salt published once it is over.
import type {
  JudgeDeclarations,
  JudgeParam,
  LdcActivityInput,
} from "@hb/contracts";
import { ldcTotalMinor } from "@hb/contracts";
import type { Params } from "../../../../kit/judge";
import {
  defaultCount,
  paramsCommitment,
  paramValues,
  readCheckAnswer,
  splitParams,
} from "../../../../kit/runtime/index.mjs";
import { ActivityError } from "../activities/errors";
import type { ActivityRow } from "../activities/storage";
import type { ApiBindings } from "../env";
import { decryptString, encryptString } from "../security/crypto";
import { checkParamsInJudge } from "./sandbox";
import { type JudgeRow, judgeData, readCode, readParams } from "./storage";
import { usageStatement } from "./usage";

/**
 * What the version this code is declares: its 判定器's (judge_version), or
 * any of its sender's 判定器 with the same code — declarations follow from
 * the code. Null for code from before the third protocol.
 */
export async function declarationsFor(
  env: ApiBindings,
  authorId: string,
  judge: JudgeRow,
): Promise<JudgeDeclarations | null> {
  // Its very version first: another's too (judge-square §15.3).
  const exact =
    judge.judgeId !== null && judge.judgeVersion !== null
      ? await env.DB.prepare(
          "SELECT declarations FROM judge_versions WHERE judge_id = ? AND n = ? AND fingerprint = ? AND declarations IS NOT NULL",
        )
          .bind(judge.judgeId, judge.judgeVersion, judge.fingerprint)
          .first<{ declarations: string }>()
      : null;
  if (exact) return JSON.parse(exact.declarations) as JudgeDeclarations;
  const row = await env.DB.prepare(
    `SELECT v.declarations FROM judge_versions v JOIN judges j ON j.id = v.judge_id
      WHERE v.fingerprint = ?1 AND v.declarations IS NOT NULL AND j.author_id = ?2
      ORDER BY (v.judge_id = ?3 AND v.n = ?4) DESC LIMIT 1`,
  )
    .bind(judge.fingerprint, authorId, judge.judgeId, judge.judgeVersion)
    .first<{ declarations: string }>();
  return row ? (JSON.parse(row.declarations) as JudgeDeclarations) : null;
}

/**
 * The params as the code will get them, its own declared ones only (one
 * left from another version is let go): `{ values }` or `{ problems }`.
 */
export async function openingParams(
  env: ApiBindings,
  authorId: string,
  judge: JudgeRow,
) {
  const declarations = await declarationsFor(env, authorId, judge);
  const params = declarations?.params ?? [];
  const filled = (await readParams(env, judge)) ?? {};
  const read = paramValues(
    params,
    Object.fromEntries(
      Object.entries(filled).filter(([key]) =>
        params.some((item) => item.key === key),
      ),
    ),
  );
  return { declarations, read };
}

/**
 * check(params, hongbao) once more as it opens (or is timed to): its first
 * problem, or the check's own failure, said as the form would; null when it
 * lets them through or has no check. A sandbox use like any (用量).
 */
export async function paramsRejected(
  env: ApiBindings,
  activity: ActivityRow,
  judge: JudgeRow,
  config: LdcActivityInput,
): Promise<string | null> {
  const { declarations, read } = await openingParams(
    env,
    activity.authorId,
    judge,
  );
  if (!declarations?.check || "problems" in read) return null;
  const code = await readCode(env, activity.id);
  const now = Date.now();
  await usageStatement(env, {
    now,
    fingerprint: judge.fingerprint,
    fresh: 0,
    userId: activity.authorId,
    tries: 1,
  }).run();
  const outcome = await checkParamsInJudge(
    env,
    { code, fingerprint: judge.fingerprint, fresh: 0 },
    {
      params: read.values,
      // Protocol 5 has no shares: the compatible n and 0.01 (§3.5).
      hongbao: {
        title: activity.title,
        total: ldcTotalMinor(config),
        count: defaultCount(ldcTotalMinor(config)),
        minEach: 1,
      },
    },
  );
  if ("failure" in outcome) return `判定器检查参数时出错：${outcome.detail}`;
  const answer = readCheckAnswer(outcome.answer, declarations.params);
  if ("invalid" in answer) return `判定器检查参数时出错：${answer.invalid}`;
  return answer.problems[0]?.message ?? null;
}

/** Opening refused for check()'s word on the params (§3 校验). */
export function paramsRejectedError(message: string) {
  return new ActivityError(
    409,
    "JUDGE_PARAMS_REJECTED",
    `参数没通过判定器的检查：${message}，草稿已保存。`,
  );
}

/**
 * Opening (§3 保密参数): the params as the code gets them, kept again; the
 * ones everyone sees published; the secret ones' 封存值, its salt kept
 * encrypted. Only before the seed is sealed, which opening checks for.
 */
export async function sealParamsStatement(
  env: ApiBindings,
  activityId: string,
  list: readonly JudgeParam[],
  values: Params,
) {
  const { shown, secret } = splitParams(list, values);
  const sealed = Object.keys(secret).length > 0;
  const salt = sealed
    ? Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")
    : null;
  return env.DB.prepare(`UPDATE activity_code SET params_ciphertext = ?, params_public = ?,
      params_commitment = ?, params_salt_ciphertext = ? WHERE activity_id = ? AND seed_commitment IS NULL`).bind(
    await encryptString(
      JSON.stringify(values),
      env,
      judgeData(activityId, "params"),
    ),
    JSON.stringify(shown),
    salt ? paramsCommitment(secret, salt) : null,
    salt
      ? await encryptString(salt, env, judgeData(activityId, "params-salt"))
      : null,
    activityId,
  );
}

/** What every judgment of an opened 红包 is given as submission.params. */
export async function judgedParams(env: ApiBindings, judge: JudgeRow) {
  return ((await readParams(env, judge)) ?? {}) as Params;
}

/**
 * Its secret params and salt (§3, §10 结束后): read and checked against the
 * 封存值 published at opening, to be published in turn. Null without any.
 */
export async function revealedParams(
  env: ApiBindings,
  judge: JudgeRow,
  declarations: JudgeDeclarations | null,
) {
  if (!judge.paramsCommitment || !judge.paramsSaltCiphertext) return null;
  const [values, salt] = await Promise.all([
    judgedParams(env, judge),
    decryptString(
      judge.paramsSaltCiphertext,
      env,
      judgeData(judge.activityId, "params-salt"),
    ),
  ]);
  const { secret } = splitParams(declarations?.params ?? [], values);
  if (paramsCommitment(secret, salt) !== judge.paramsCommitment)
    throw new Error(
      "代码判定红包's secret params do not match what it published",
    );
  return { secret, salt };
}
