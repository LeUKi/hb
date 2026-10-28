// A claim on a 代码判定红包 (docs/programmable-hongbao-design.md §2–§4): the
// usual checks first, then the sender's code judges what was typed, and
// what it pays (pulled into the share's range) is made into the share and
// claimed. The 红包's Durable Object runs these one at a time, so the pool,
// the claims and the code's state it was given are the ones it changes. A
// 联网 红包's judgment goes out through the gateway, and what it asked and
// got is kept with it (§9).
import {
  type ClaimActivityInput,
  type ClaimResult,
  type LdcActivityInput,
  ldcTotalMinor,
} from "@hb/contracts";
import type { Submission } from "../../../../kit/judge";
import {
  readVerdict,
  shareRange,
  submissionSeed,
  userSeed,
} from "../../../../kit/runtime/index.mjs";
import {
  admitClaim,
  attemptAssociatedData,
  claimGuardStatement,
  completeClaimSubmission,
  findSubmission,
  resultOfSubmission,
  resumePendingActivityClaims,
} from "../activities/claim-service";
import { ActivityError } from "../activities/errors";
import type { ActivityExecutionPolicy } from "../activities/execution-policy";
import { requireHumanCheck } from "../activities/human-check";
import { databaseNow } from "../activities/lifecycle";
import { participationRequest } from "../activities/participation";
import type { ActivityRow } from "../activities/storage";
import type { ApiBindings } from "../env";
import { attemptWriteStatements } from "../runtime/attempt-cooldown";
import {
  decryptString,
  digestPassword,
  encryptString,
} from "../security/crypto";
import { judgedParams } from "./params";
import {
  JUDGE_WAIT_MS,
  NETWORK_WAIT_MS,
  runJudge,
  type SandboxFailure,
} from "./sandbox";
import type { FetchRecord, JudgeHooks } from "./session";
import { findJudgeRow, type JudgeRow, judgeData, readSeed } from "./storage";
import { usageStatement } from "./usage";

type CodeClaim = Extract<ClaimActivityInput, { participationMode: "code" }>;

/** Failures in a row that pause claims (§3). */
export const FAILURES_TO_PAUSE = 5;
/** Submissions a 红包 takes a second (§3, 暂定); more wait, unjudged. */
const PER_SECOND = 20;
/** A 联网 红包's claims waiting at once, the one judged too (§9.3). */
const NETWORK_WAITING = 5;
const SANDBOXES = 4;

/** A 红包's addresses (activity_code.network), or null without network. */
export const networkOf = (row: JudgeRow) =>
  row.network === null ? null : (JSON.parse(row.network) as string[]);

const recent = new Map<string, number[]>();

function busy(activityId: string, now = Date.now()) {
  const times = (recent.get(activityId) ?? []).filter(
    (time) => time > now - 1000,
  );
  if (times.length >= PER_SECOND) return true;
  times.push(now);
  recent.set(activityId, times);
  return false;
}

/** Decrypted once per isolate: claimed inputs never change. */
const claimedInputs = new Map<string, string>();
const codes = new Map<string, string>();

async function codeOf(env: ApiBindings, row: JudgeRow) {
  const cached = codes.get(row.activityId);
  if (cached !== undefined) return cached;
  const code = await decryptString(
    row.codeCiphertext,
    env,
    judgeData(row.activityId, "code"),
  );
  codes.set(row.activityId, code);
  return code;
}

async function stateOf(env: ApiBindings, row: JudgeRow) {
  if (row.stateCiphertext === null) return null;
  return JSON.parse(
    await decryptString(
      row.stateCiphertext,
      env,
      judgeData(row.activityId, "state"),
    ),
  ) as Submission["state"];
}

/**
 * The claims so far, in order, with what each typed (§4.1), each person as
 * the code was given them when judged: so a replay sees the same.
 */
async function claimsOf(env: ApiBindings, activityId: string) {
  const rows =
    await env.DB.prepare(`SELECT c.id, c.claimed_at AS at, j.paid_minor AS amount,
      u.external_id AS externalId, j.username, e.ciphertext, s.id AS rowId
    FROM code_judgments j JOIN redemption_submissions s ON s.id = j.submission_row_id
    JOIN claims c ON c.id = s.claim_id JOIN users u ON u.id = j.user_id
    JOIN attempt_events e ON e.submission_row_id = s.id
    WHERE j.activity_id = ? AND j.ok = 1 AND s.outcome = 'claimed' ORDER BY j.sequence`)
      .bind(activityId)
      .all<{
        id: string;
        at: number;
        amount: number;
        externalId: string;
        username: string;
        ciphertext: string;
        rowId: string;
      }>();
  return Promise.all(
    rows.results.map(async (row) => {
      let input = claimedInputs.get(row.id);
      if (input === undefined) {
        input = await decryptString(
          row.ciphertext,
          env,
          attemptAssociatedData(activityId, row.rowId),
        );
        claimedInputs.set(row.id, input);
      }
      return {
        user: { id: Number(row.externalId), username: row.username },
        amount: row.amount,
        input,
        at: row.at,
      };
    }),
  );
}

const failureKind = (
  failure: Exclude<SandboxFailure, "unavailable" | "load">,
): "threw" | "timeout" | "invalid" | "memory" =>
  failure === "no-judge" ? "invalid" : failure;

/**
 * The code failed this judgment: noted for its sender, and the fifth in a
 * row pauses claims. A timeout moves to the next sandbox, past one that
 * may still be stuck, unless the runtime cut it short (`hung`): then
 * nothing holds it. The sandbox was used all the same (用量记录).
 */
async function recordFailure(
  env: ApiBindings,
  row: JudgeRow,
  sender: string,
  userId: string,
  kind: "threw" | "timeout" | "invalid" | "memory",
  detail: string,
  /** When the judgment began: its 份's day. */
  now: number,
  hung = false,
  /** 联网: the requests it sent out. */
  fetches = 0,
) {
  const timeout = Number(kind === "timeout");
  const moves = Number(kind === "timeout" && !hung);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO code_failures (id, activity_id, user_id, kind, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ${databaseNow})`).bind(
      crypto.randomUUID(),
      row.activityId,
      userId,
      kind,
      detail.slice(0, 500),
    ),
    env.DB.prepare(`UPDATE activity_code SET failures_in_row = MIN(failures_in_row + 1, ?),
      paused_at = CASE WHEN paused_at IS NULL AND failures_in_row + 1 >= ? THEN ${databaseNow} ELSE paused_at END,
      sandbox = CASE WHEN ? THEN (sandbox + 1) % ? ELSE sandbox END, updated_at = ${databaseNow}
      WHERE activity_id = ?`).bind(
      FAILURES_TO_PAUSE,
      FAILURES_TO_PAUSE,
      moves,
      SANDBOXES,
      row.activityId,
    ),
    usageStatement(env, {
      now,
      fingerprint: row.fingerprint,
      fresh: row.sandbox,
      protocol: row.protocol,
      networked: row.network !== null,
      userId: sender,
      activityId: row.activityId,
      timeouts: timeout,
      switches: moves,
      fetches,
    }),
  ]);
  return row.failuresInRow + 1 >= FAILURES_TO_PAUSE;
}

const failed = () =>
  new ActivityError(503, "JUDGE_FAILED", "红包的代码出错了，请稍后再试。");
const paused = () =>
  new ActivityError(409, "CODE_PAUSED", "红包的代码连续出错，暂停领取。");

/**
 * What is left of its pool (§2): the 🐟额 still locked, or for 商户直发,
 * which locks nothing, the total less the shares made (as the database's
 * guard counts it, migration 0047).
 */
async function remainingOf(env: ApiBindings, activity: ActivityRow) {
  if (activity.funding === "balance")
    return env.DB.prepare(
      "SELECT remaining_minor AS remaining FROM balance_locks WHERE activity_id = ? AND purpose = 'activity' AND status = 'active'",
    )
      .bind(activity.id)
      .first<number>("remaining");
  const made = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_minor), 0) AS made FROM reward_inventory WHERE activity_id = ?",
  )
    .bind(activity.id)
    .first<number>("made");
  return made === null
    ? null
    : ldcTotalMinor(JSON.parse(activity.config) as LdcActivityInput) - made;
}

export async function claimByCode(
  env: ApiBindings,
  activityId: string,
  userId: string,
  input: CodeClaim,
  executionPolicy?: ActivityExecutionPolicy,
  humanVerified = false,
  hooks: JudgeHooks = {},
): Promise<ClaimResult> {
  const { fingerprint } = await participationRequest(
    env,
    activityId,
    input,
    "claim",
  );
  // Judged and not yet claimed (an interrupted write): finished first, so
  // the pool this judgment sees has it out.
  await resumePendingActivityClaims(env, activityId);
  const admission = await admitClaim(
    env,
    activityId,
    userId,
    input.submissionId,
    fingerprint,
    "code",
    undefined,
    executionPolicy,
  );
  if ("row" in admission)
    return admission.row.outcome === "pending"
      ? completeClaimSubmission(env, admission.row, executionPolicy)
      : resultOfSubmission(env, admission.row);
  const { activity } = admission;
  const row = await findJudgeRow(env, activityId);
  if (!row?.seedCiphertext) throw new Error("代码判定红包 has no sealed code");
  if (row.pausedAt !== null || row.stoppedAt !== null) throw paused();
  // Every submission, before the code runs (§3).
  requireHumanCheck(env, activity, humanVerified);
  const network = networkOf(row);
  // A 联网 judgment goes out through the gateway, which only the 红包's
  // Durable Object has.
  const online = network ? hooks.network : undefined;
  if (network && !online)
    throw new ActivityError(
      503,
      "JUDGE_UNAVAILABLE",
      "暂时领不了，请稍后再试。",
    );
  if (busy(activityId) || (online && online.waiting() > NETWORK_WAITING))
    throw new ActivityError(
      429,
      "CODE_BUSY",
      "这个红包同时提交的人太多，请稍后再试。",
    );

  const [user, attempts, sequence, lock, claims, state, code, secret] =
    await Promise.all([
      env.DB.prepare(
        "SELECT external_id AS externalId, username, trust_level AS level FROM users WHERE id = ?",
      )
        .bind(userId)
        .first<{
          externalId: string;
          username: string;
          level: number | null;
        }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM code_judgments WHERE activity_id = ? AND user_id = ?",
      )
        .bind(activityId, userId)
        .first<number>("count"),
      // Sequences run 0…N-1: the next is the last plus one (public.ts).
      env.DB.prepare(
        "SELECT COALESCE(MAX(sequence) + 1, 0) AS count FROM code_judgments WHERE activity_id = ?",
      )
        .bind(activityId)
        .first<number>("count"),
      remainingOf(env, activity),
      claimsOf(env, activityId),
      stateOf(env, row),
      codeOf(env, row),
      readSeed(env, row),
    ]);
  if (!user || attempts === null || sequence === null || lock === null)
    throw new Error("代码判定红包 claim is missing its parts");
  const config = JSON.parse(activity.config) as LdcActivityInput;
  const hongbao = {
    title: activity.title,
    total: ldcTotalMinor(config),
    count: activity.totalCount,
    minEach: row.minEachMinor,
    remaining: lock,
    remainingCount: activity.totalCount - activity.claimedCount,
    openedAt: activity.openedAt ?? 0,
    endsAt: activity.deadline ?? 0,
  };
  const share = shareRange(hongbao);
  const linuxDoId = Number(user.externalId);
  // An earlier protocol's code is given what it was given then: no params.
  const submission = {
    input: input.input,
    now: Date.now(),
    user: {
      id: linuxDoId,
      username: user.username,
      level: (user.level ?? null) as Submission["user"]["level"],
      attempts,
    },
    hongbao,
    share,
    claims,
    state,
    ...(row.protocol >= 3 ? { params: await judgedParams(env, row) } : {}),
  } as Submission;
  // 联网: the requests this judgment sends are kept as the gateway saw
  // them; one the gateway failed on makes it count for nothing.
  const session = online?.start();
  let fetches: FetchRecord[] = [];
  let outcome: Awaited<ReturnType<typeof runJudge>>;
  try {
    outcome = await runJudge(env, {
      code,
      fingerprint: row.fingerprint,
      submission,
      seeds: {
        submission: submissionSeed(activityId, secret, linuxDoId, attempts),
        user: userSeed(activityId, secret, linuxDoId),
      },
      fresh: row.sandbox,
      protocol: row.protocol,
      ...(network && online && session
        ? {
            network: {
              mode: "live" as const,
              list: network,
              activityId,
              outbound: online.outbound(activityId, network),
            },
            // Waiting on its requests buys no time to compute: the clock
            // stops while one is out, 5 s in all (§9.3).
            timer: session.deadline(JUDGE_WAIT_MS, NETWORK_WAIT_MS),
          }
        : {}),
    });
    if (session) {
      fetches = await session.close();
      if (session.broken)
        throw new ActivityError(
          503,
          "JUDGE_UNAVAILABLE",
          "暂时领不了，请稍后再试。",
        );
    }
  } finally {
    online?.end();
  }
  let reading: ReturnType<typeof readVerdict>;
  if ("failure" in outcome) {
    // Not the code's fault: nothing counts, nothing is noted.
    if (outcome.failure === "unavailable")
      throw new ActivityError(
        503,
        "JUDGE_UNAVAILABLE",
        "暂时领不了，请稍后再试。",
      );
    const kind = failureKind(
      outcome.failure === "load" ? "threw" : outcome.failure,
    );
    if (
      await recordFailure(
        env,
        row,
        activity.authorId,
        userId,
        kind,
        outcome.detail,
        submission.now,
        outcome.hung,
        fetches.length,
      )
    )
      hooks.paused?.();
    throw failed();
  }
  reading = readVerdict(outcome.verdict, share);
  if ("error" in reading) {
    if (
      await recordFailure(
        env,
        row,
        activity.authorId,
        userId,
        "invalid",
        reading.error.detail,
        submission.now,
        false,
        fetches.length,
      )
    )
      hooks.paused?.();
    throw failed();
  }

  // A judgment: the submission, its input for the sender's 尝试统计, the
  // answer, and the state it leaves, all at once.
  const rowId = crypto.randomUUID();
  const outcomeName = reading.ok ? "pending" : "incorrect";
  const stateText = reading.state.keep
    ? null
    : JSON.stringify(reading.state.value);
  const [
    inputCiphertext,
    digest,
    stateCiphertext,
    judgmentState,
    fetchesCiphertext,
  ] = await Promise.all([
    encryptString(input.input, env, attemptAssociatedData(activityId, rowId)),
    digestPassword(input.input, env.PASSWORD_DIGEST_KEY),
    stateText === null
      ? null
      : encryptString(stateText, env, judgeData(activityId, "state")),
    stateText === null
      ? null
      : encryptString(
          stateText,
          env,
          `${judgeData(activityId, "state")}:${rowId}`,
        ),
    fetches.length === 0
      ? null
      : encryptString(
          JSON.stringify(fetches),
          env,
          `${judgeData(activityId, "fetches")}:${rowId}`,
        ),
  ]);
  const statements = [
    ...attemptWriteStatements(env, userId, "activity", rowId),
    claimGuardStatement(env, activity, "code", userId, admission),
    env.DB.prepare(`INSERT INTO redemption_submissions
      (id, activity_id, user_id, submission_id, fingerprint, purpose, participation_mode, outcome, matched_password_id, created_at, validated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, 'claim', 'code', ?, NULL, ${databaseNow}, ${databaseNow}, CASE WHEN ? = 'incorrect' THEN ${databaseNow} ELSE NULL END)`).bind(
      rowId,
      activityId,
      userId,
      input.submissionId,
      fingerprint,
      outcomeName,
      outcomeName,
    ),
    env.DB.prepare(`INSERT INTO attempt_events
      (id, submission_row_id, activity_id, user_id, ciphertext, digest, matched, matched_password_id, validated_at)
      SELECT ?, id, activity_id, user_id, ?, ?, ?, NULL, validated_at FROM redemption_submissions WHERE id = ?`).bind(
      crypto.randomUUID(),
      inputCiphertext,
      digest,
      Number(reading.ok),
      rowId,
    ),
    env.DB.prepare(`INSERT INTO code_judgments
      (submission_row_id, activity_id, user_id, sequence, attempt, title, username, level, ok, asked_minor, paid_minor, note, message, state_ciphertext, fetches_ciphertext, judged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      rowId,
      activityId,
      userId,
      sequence,
      attempts,
      submission.hongbao.title,
      submission.user.username,
      submission.user.level,
      Number(reading.ok),
      reading.ok ? reading.asked : null,
      reading.ok ? reading.paid : null,
      reading.ok ? reading.note : null,
      reading.message ?? null,
      judgmentState,
      fetchesCiphertext,
      submission.now,
    ),
    env.DB.prepare(`UPDATE activity_code SET failures_in_row = 0,
      state_ciphertext = CASE WHEN ? THEN state_ciphertext ELSE ? END, updated_at = ${databaseNow}
      WHERE activity_id = ?`).bind(
      Number(stateText === null),
      stateCiphertext,
      activityId,
    ),
    // 用量记录 (§7): the 判定器 it ran in, on its sender's row.
    usageStatement(env, {
      now: submission.now,
      fingerprint: row.fingerprint,
      fresh: row.sandbox,
      protocol: row.protocol,
      networked: network !== null,
      userId: activity.authorId,
      activityId,
      claims: 1,
      fetches: fetches.length,
    }),
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const winner = await findSubmission(env, userId, input.submissionId);
    if (winner)
      return winner.outcome === "pending"
        ? completeClaimSubmission(env, winner, executionPolicy)
        : resultOfSubmission(env, winner);
    const current = await findJudgeRow(env, activityId);
    if (current && (current.pausedAt !== null || current.stoppedAt !== null))
      throw paused();
    throw error;
  }
  const saved = await findSubmission(env, userId, input.submissionId);
  if (!saved) throw new Error("Judgment was not persisted");
  if (!reading.ok) return resultOfSubmission(env, saved);
  return completeClaimSubmission(env, saved, executionPolicy);
}
