// A claim on a 代码判定红包 (docs/programmable-hongbao-design.md §2–§4): the
// usual checks first, then the sender's code judges what was typed, and
// what it pays (pulled into the share's range) is made into the share and
// claimed. The 红包's Durable Object runs these one at a time, so the pool,
// the claims and the code's state it was given are the ones it changes. A
// 联网 红包's judgment goes out through the gateway, and what it asked and
// got is kept with it (§9). From protocol 4 a judgment may also change what
// everyone sees, add a line to 动态 and end the 红包 (docs/judge-page-
// design.md §2): the view and the line go in with it, the end once its own
// share is in (lifecycle.ts). From protocol 5 (docs/multi-prize-design.md)
// there are no shares: each person's pending moves and settles (ledger.ts).
import {
  type ClaimActivityInput,
  type ClaimResult,
  type LdcActivityInput,
  ldcTotalMinor,
} from "@hb/contracts";
import type { Submission } from "../../../../kit/judge";
import {
  LEDGER_PROTOCOL,
  readVerdict,
  shareRange,
  submissionSeed,
  userSeed,
  type VerdictReading,
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
import { databaseNow, refreshActivityLifecycle } from "../activities/lifecycle";
import { participationRequest } from "../activities/participation";
import type { ApiBindings } from "../env";
import { attemptWriteStatements } from "../runtime/attempt-cooldown";
import {
  decryptString,
  digestPassword,
  encryptString,
} from "../security/crypto";
import {
  judgedResult,
  ledgerClaimsOf,
  ledgerHongbao,
  othersOf,
  ownPart,
  pendingTotal,
  poolLeft,
  writeLedgerJudgment,
} from "./ledger";
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
const NETWORK_WAITING = 3;
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
  new ActivityError(
    503,
    "JUDGE_FAILED",
    "判定器出错了，这次没有判定，可以再提交一次。",
  );
const paused = () =>
  new ActivityError(409, "CODE_PAUSED", "判定器连续出错，暂停领取。");

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
  // the pool this judgment sees has it out; then a judgment that ended it
  // and was cut off before the end ends it now.
  await resumePendingActivityClaims(env, activityId);
  if (
    await env.DB.prepare(
      "SELECT 1 FROM code_judgments WHERE activity_id = ? AND ends = 1 LIMIT 1",
    )
      .bind(activityId)
      .first()
  )
    await refreshActivityLifecycle(env, activityId);
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

  // Protocol 5: each person's own part, and everyone's pending.
  const ledgered = row.protocol >= LEDGER_PROTOCOL;
  const [
    user,
    attempts,
    sequence,
    lock,
    claims,
    state,
    code,
    secret,
    own,
    pending,
  ] = await Promise.all([
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
    poolLeft(env, activity),
    ledgered ? ledgerClaimsOf(env, activityId) : claimsOf(env, activityId),
    stateOf(env, row),
    codeOf(env, row),
    readSeed(env, row),
    ledgered ? ownPart(env, activityId, userId) : null,
    ledgered ? pendingTotal(env, activityId) : 0,
  ]);
  if (!user || attempts === null || sequence === null || lock === null)
    throw new Error("代码判定红包 claim is missing its parts");
  // Settled once (protocol 5), with or without a claim: no more turns.
  if (own?.settled)
    throw new ActivityError(
      409,
      "CODE_SETTLED",
      "你在这个红包里已经结算了，不能再提交。",
    );
  const config = JSON.parse(activity.config) as LdcActivityInput;
  const { hongbao, share } = ledgered
    ? ledgerHongbao(activity, lock, pending, claims.length)
    : (() => {
        const numbers = {
          title: activity.title,
          total: ldcTotalMinor(config),
          count: activity.totalCount,
          minEach: row.minEachMinor,
          remaining: lock,
          remainingCount: activity.totalCount - activity.claimedCount,
          openedAt: activity.openedAt ?? 0,
          endsAt: activity.deadline ?? 0,
        };
        return { hongbao: numbers, share: shareRange(numbers) };
      })();
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
    ...(own
      ? { player: { pending: own.pending, state: own.state, view: own.view } }
      : {}),
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
  // An earlier protocol's code is read as it was then: no view or end.
  const read = readVerdict(outcome.verdict, share, row.protocol);
  // Protocol 5: naming someone who may not be named is the code's error.
  const named =
    "add" in read ? await othersOf(env, activityId, read, linuxDoId) : null;
  let invalid: string | null = null;
  if ("error" in read) invalid = read.error.detail;
  else if (named && "problem" in named) invalid = named.problem;
  if (invalid !== null) {
    if (
      await recordFailure(
        env,
        row,
        activity.authorId,
        userId,
        "invalid",
        invalid,
        submission.now,
        false,
        fetches.length,
      )
    )
      hooks.paused?.();
    throw failed();
  }
  if ("add" in read && named && "people" in named) {
    let written: Awaited<ReturnType<typeof writeLedgerJudgment>>;
    try {
      written = await writeLedgerJudgment(env, {
        activity,
        row,
        admission,
        userId,
        input,
        fingerprint,
        submission,
        reading: read,
        people: named.people,
        sequence,
        fetches,
        networked: network !== null,
      });
    } catch (error) {
      const winner = await findSubmission(env, userId, input.submissionId);
      if (winner) return resultOfSubmission(env, winner);
      const current = await findJudgeRow(env, activityId);
      if (current && (current.pausedAt !== null || current.stoppedAt !== null))
        throw paused();
      throw error;
    }
    // Those its others moved see their part again on their pages (§4.3).
    if (written.others.length > 0) hooks.moved?.(written.others);
    // It ended the 红包: everyone not settled now is, as 结算中 (§2).
    if (written.ended) {
      await refreshActivityLifecycle(env, activityId);
      hooks.ended?.();
    }
    return judgedResult(env, written.rowId, userId);
  }
  if ("error" in read || "add" in read)
    throw new Error("A judgment was read as neither protocol");
  const reading: VerdictReading = read;

  // A judgment: the submission, its input for the sender's 尝试统计, the
  // answer, and the state it leaves, all at once.
  const rowId = crypto.randomUUID();
  const outcomeName = reading.ok ? "pending" : "incorrect";
  const stateText = reading.state.keep
    ? null
    : JSON.stringify(reading.state.value);
  // Protocol 4: what everyone sees, when it changed it (null clears it).
  const view = reading.view && !reading.view.keep ? reading.view : null;
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
      (submission_row_id, activity_id, user_id, sequence, attempt, title, username, level, ok, asked_minor, paid_minor, note, message, state_ciphertext, fetches_ciphertext, judged_at, view, ends)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
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
      view ? JSON.stringify(view.value) : null,
      Number(reading.end === true),
    ),
    // 判定记录 · 按人 (docs/judge-records-design.md §4): this person's count.
    env.DB.prepare(`INSERT INTO code_judge_people
      (activity_id, user_id, judged, claimed, paid_minor, first_at, last_at)
      VALUES (?1, ?2, 1, ?3, ?4, ?5, ?5)
      ON CONFLICT (activity_id, user_id) DO UPDATE SET judged = judged + 1,
        claimed = MAX(claimed, excluded.claimed),
        paid_minor = COALESCE(paid_minor, excluded.paid_minor),
        last_at = MAX(last_at, excluded.last_at)`).bind(
      activityId,
      userId,
      Number(reading.ok),
      reading.ok ? reading.paid : null,
      submission.now,
    ),
    env.DB.prepare(`UPDATE activity_code SET failures_in_row = 0,
      state_ciphertext = CASE WHEN ?1 THEN state_ciphertext ELSE ?2 END,
      view_summary = CASE WHEN ?3 THEN view_summary ELSE ?4 END,
      view_data = CASE WHEN ?3 THEN view_data ELSE ?5 END,
      view_at = CASE WHEN ?3 THEN view_at ELSE ?6 END, updated_at = ${databaseNow}
      WHERE activity_id = ?7`).bind(
      Number(stateText === null),
      stateCiphertext,
      Number(view === null),
      view?.value?.summary ?? null,
      view?.value?.data === undefined ? null : JSON.stringify(view.value.data),
      submission.now,
      activityId,
    ),
    // 动态: its line, after the ones before (numbered from 0).
    ...(reading.announce !== undefined
      ? [
          env.DB.prepare(`INSERT INTO activity_announcements
            (activity_id, n, user_id, submission_row_id, text, created_at)
            VALUES (?1, (SELECT COUNT(*) FROM activity_announcements WHERE activity_id = ?1), ?2, ?3, ?4, ?5)`).bind(
            activityId,
            userId,
            rowId,
            reading.announce,
            submission.now,
          ),
        ]
      : []),
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
  const result = reading.ok
    ? await completeClaimSubmission(env, saved, executionPolicy)
    : await resultOfSubmission(env, saved);
  // It ended the 红包: its own share is in, the rest goes back (§2 end).
  if (reading.end) {
    await refreshActivityLifecycle(env, activityId);
    hooks.ended?.();
  }
  return result;
}
