// 一批一起写 (docs/programmable-hongbao-design.md §3): a protocol 5 红包's
// submissions waiting in its Durable Object, judged together. What they
// need is read once — the 红包, its code, the shared state, the pool,
// everyone's pending, those settled, each one's own part — then each is
// judged in turn in memory, as one at a time would be: the state, the pool
// and each pending carried on from one to the next. All of it goes into one
// batch, the database's guards checking each as it would on its own. One
// that cannot go along (the 红包 ended in it, a write refused) is judged on
// its own after (claims.ts).
import {
  type ClaimActivityInput,
  type ClaimResult,
  formatSignedAmount,
} from "@hb/contracts";
import type { Json, Submission } from "../../../../kit/judge";
import {
  LEDGER_PROTOCOL,
  othersProblem,
  readVerdict,
  submissionSeed,
  userSeed,
} from "../../../../kit/runtime/index.mjs";
import { getClaimDetail } from "../activities/claim-queries";
import {
  type Admitted,
  resumePendingActivityClaims,
} from "../activities/claim-service";
import { ActivityError, activityNotFound } from "../activities/errors";
import { requireHumanCheck } from "../activities/human-check";
import { refreshActivityLifecycle } from "../activities/lifecycle";
import { activityStatus } from "../activities/service";
import { findActivity } from "../activities/storage";
import type { ApiBindings } from "../env";
import { assertAttemptAllowed } from "../runtime/attempt-cooldown";
import {
  FAILURES_TO_PAUSE,
  failed,
  failureKind,
  networkOf,
  paused,
  recordFailure,
  SANDBOXES,
  stateOf,
} from "./claims";
import {
  judgedResult,
  ledgerClaimsOf,
  ledgerHongbao,
  ledgerJudgmentStatements,
  ownPart,
  pendingTotal,
} from "./ledger";
import { judgedParams } from "./params";
import { JUDGE_WAIT_MS, NETWORK_WAIT_MS, runJudge } from "./sandbox";
import type { FetchRecord, JudgeHooks } from "./session";
import { codeOf, findJudgeRow, readSeed } from "./storage";

type CodeClaim = Extract<ClaimActivityInput, { participationMode: "code" }>;

/** At most this many judged in one batch (each one person). */
export const JUDGE_BATCH = 10;

/** A submission let in (claims.ts admitCodeClaim), waiting its turn. */
export type QueuedJudgment = {
  userId: string;
  input: CodeClaim;
  fingerprint: string;
  admission: Pick<Admitted, "testPermission" | "realActivityPermitted">;
  humanVerified: boolean;
  /** When it reached the 红包 (JudgeHooks.arrivedAt). */
  arrivedAt: number;
};

export type BatchOutcome =
  | { result: Extract<ClaimResult, { result: "judged" }> }
  | { error: unknown }
  /** Not judged here: to be judged on its own (claims.ts claimByCode). */
  | { alone: true };

type Person = {
  externalId: string;
  pending: number;
  settled: boolean;
};

type Own = {
  pending: number;
  settled: boolean;
  state: Json;
  view: Submission["player"]["view"];
};

const unavailable = () =>
  new ActivityError(503, "JUDGE_UNAVAILABLE", "暂时领不了，请稍后再试。");

const settledAlready = () =>
  new ActivityError(
    409,
    "CODE_SETTLED",
    "你在这个红包里已经结算了，不能再提交。",
  );

/**
 * Judges `items` of one protocol 5 红包, one person each, in order. `single`
 * (one submission on its own): a refused write is its error, not a turn to
 * be judged alone again.
 */
export async function judgeBatch(
  env: ApiBindings,
  activityId: string,
  items: QueuedJudgment[],
  hooks: JudgeHooks = {},
  options: { single?: boolean } = {},
): Promise<BatchOutcome[]> {
  const outcomes: (BatchOutcome | undefined)[] = items.map(() => undefined);
  const rest = (outcome: BatchOutcome) =>
    outcomes.map((given) => given ?? outcome);
  const users = items.map((item) => item.userId);
  const [
    resumed,
    activity,
    row,
    ends,
    left,
    sequence,
    pending,
    claims,
    people,
    accounts,
    attempts,
    owns,
    cooldowns,
  ] = await Promise.all([
    // An earlier protocol's interrupted claim: finished first, as on its own.
    resumePendingActivityClaims(env, activityId),
    findActivity(env, activityId),
    findJudgeRow(env, activityId),
    env.DB.prepare(
      "SELECT 1 FROM code_judgments WHERE activity_id = ? AND ends = 1 LIMIT 1",
    )
      .bind(activityId)
      .first(),
    // What the pool holds (ledger.ts poolLeft), read without the 红包 first.
    env.DB.prepare(`SELECT CASE WHEN a.funding = 'balance'
        THEN (SELECT remaining_minor FROM balance_locks WHERE activity_id = a.id AND purpose = 'activity' AND status = 'active')
        ELSE CAST(ROUND(CAST(json_extract(a.config, '$.money.totalAmount') AS REAL) * 100) AS INTEGER)
          - COALESCE((SELECT SUM(amount_minor) FROM reward_inventory WHERE activity_id = a.id), 0) END AS remaining
      FROM activities a WHERE a.id = ?`)
      .bind(activityId)
      .first<number | null>("remaining"),
    env.DB.prepare(
      "SELECT COALESCE(MAX(sequence) + 1, 0) AS count FROM code_judgments WHERE activity_id = ?",
    )
      .bind(activityId)
      .first<number>("count"),
    pendingTotal(env, activityId),
    ledgerClaimsOf(env, activityId),
    // Everyone judged here: whom others may name, and their pending.
    env.DB.prepare(`SELECT p.user_id AS userId, u.external_id AS externalId, p.pending_minor AS pending,
        p.settled_at IS NOT NULL AS settled FROM code_judge_people p JOIN users u ON u.id = p.user_id
        WHERE p.activity_id = ?`)
      .bind(activityId)
      .all<{
        userId: string;
        externalId: string;
        pending: number;
        settled: number;
      }>(),
    env.DB.prepare(`SELECT id, external_id AS externalId, username, trust_level AS level FROM users
        WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(users))
      .all<{
        id: string;
        externalId: string;
        username: string;
        level: number | null;
      }>(),
    env.DB.prepare(`SELECT user_id AS userId, COUNT(*) AS count FROM code_judgments
        WHERE activity_id = ? AND user_id IN (SELECT value FROM json_each(?)) GROUP BY user_id`)
      .bind(activityId, JSON.stringify(users))
      .all<{ userId: string; count: number }>(),
    Promise.all(users.map((userId) => ownPart(env, activityId, userId))),
    // Since they were let in, one may have submitted somewhere else.
    Promise.all(
      users.map((userId) =>
        assertAttemptAllowed(env, userId, "activity").then(
          () => null,
          (error: unknown) => error,
        ),
      ),
    ),
  ]);
  if (!activity) activityNotFound();
  if (!row?.seedCiphertext) throw new Error("代码判定红包 has no sealed code");
  // Ended, ending, or not one for here: each answered on its own.
  if (
    resumed > 0 ||
    ends ||
    activityStatus(activity) !== "active" ||
    row.protocol < LEDGER_PROTOCOL ||
    left === null ||
    sequence === null
  )
    return rest({ alone: true });
  if (row.pausedAt !== null || row.stoppedAt !== null)
    return rest({ error: paused() });
  const network = networkOf(row);
  const [shared, code, secret, params] = await Promise.all([
    stateOf(env, row),
    codeOf(env, row),
    readSeed(env, row),
    judgedParams(env, row),
  ]);

  // What each judgment leaves for the next.
  let judge = { ...row };
  let state = shared as Json;
  let next = sequence;
  let unclaimedLeft = left;
  let pendingAll = pending;
  let settledClaims = claims;
  const byUser = new Map<string, Person>(
    people.results.map((person) => [
      person.userId,
      {
        externalId: person.externalId,
        pending: person.pending,
        settled: person.settled === 1,
      },
    ]),
  );
  const userOf = new Map(
    [...byUser].map(([userId, person]) => [Number(person.externalId), userId]),
  );
  const accountOf = new Map(
    accounts.results.map((account) => [account.id, account]),
  );
  const attemptsOf = new Map(
    attempts.results.map((row) => [row.userId, Number(row.count)]),
  );
  const ownOf = new Map<string, Own>(
    users.map((userId, index) => [
      userId,
      owns[index] ?? { pending: 0, settled: false, state: null, view: null },
    ]),
  );
  const told = new Set<string>();
  let ended = false;

  // Judged and not yet written, and written.
  let statements: D1PreparedStatement[] = [];
  let unwritten: {
    index: number;
    userId: string;
    message?: string;
    parts: Awaited<ReturnType<typeof ledgerJudgmentStatements>>;
  }[] = [];
  const written: typeof unwritten = [];
  /** Writes what is judged; false when the database refused it all. */
  const flush = async () => {
    if (statements.length === 0) return true;
    try {
      await env.DB.batch(statements);
    } catch (error) {
      for (const judged of unwritten)
        outcomes[judged.index] = options.single ? { error } : { alone: true };
      statements = [];
      unwritten = [];
      return false;
    }
    written.push(...unwritten);
    statements = [];
    unwritten = [];
    return true;
  };

  /** Paused by the one at `index`: those after it are turned away. */
  const pauseAfter = (index: number) => {
    for (let after = index + 1; after < items.length; after += 1)
      outcomes[after] = { error: paused() };
  };

  /** The code failed this one (or named whom it may not): as on its own. */
  const failing = async (
    index: number,
    item: QueuedJudgment,
    kind: "threw" | "timeout" | "invalid" | "memory",
    detail: string,
    now: number,
    hung: boolean,
    fetches: number,
  ) => {
    if (!(await flush())) return "stop" as const;
    const pausedNow = await recordFailure(
      env,
      judge,
      activity.authorId,
      item.userId,
      kind,
      detail,
      now,
      hung,
      fetches,
    );
    const moves = kind === "timeout" && !hung;
    judge = {
      ...judge,
      failuresInRow: Math.min(judge.failuresInRow + 1, FAILURES_TO_PAUSE),
      sandbox: moves ? (judge.sandbox + 1) % SANDBOXES : judge.sandbox,
    };
    outcomes[index] = { error: failed() };
    if (pausedNow) {
      hooks.paused?.();
      return "paused" as const;
    }
    return "next" as const;
  };

  for (const [index, item] of items.entries()) {
    if (ended) break;
    const cooldown = cooldowns[index];
    if (cooldown) {
      outcomes[index] = { error: cooldown };
      continue;
    }
    const own = ownOf.get(item.userId);
    const account = accountOf.get(item.userId);
    if (!own || !account) {
      outcomes[index] = { error: new Error("A judged person has no account") };
      continue;
    }
    if (own.settled) {
      outcomes[index] = { error: settledAlready() };
      continue;
    }
    try {
      requireHumanCheck(env, activity, item.humanVerified);
    } catch (error) {
      outcomes[index] = { error };
      continue;
    }
    const online = network ? hooks.network : undefined;
    if (network && !online) {
      outcomes[index] = { error: unavailable() };
      continue;
    }
    const { hongbao, share } = ledgerHongbao(
      activity,
      unclaimedLeft,
      pendingAll,
      settledClaims.length,
    );
    const linuxDoId = Number(account.externalId);
    const attempt = attemptsOf.get(item.userId) ?? 0;
    const submission = {
      input: item.input.input,
      now: Date.now(),
      user: {
        id: linuxDoId,
        username: account.username,
        level: (account.level ?? null) as Submission["user"]["level"],
        attempts: attempt,
      },
      hongbao,
      share,
      claims: settledClaims,
      state,
      params,
      player: { pending: own.pending, state: own.state, view: own.view },
    } as Submission;
    // 联网 (only ever one on its own): its requests kept as the gateway
    // saw them; one the gateway failed on makes it count for nothing.
    const session = online?.start();
    let fetches: FetchRecord[] = [];
    let outcome: Awaited<ReturnType<typeof runJudge>>;
    try {
      outcome = await runJudge(env, {
        code,
        fingerprint: judge.fingerprint,
        submission,
        seeds: {
          submission: submissionSeed(activityId, secret, linuxDoId, attempt),
          user: userSeed(activityId, secret, linuxDoId),
        },
        fresh: judge.sandbox,
        protocol: judge.protocol,
        ...(network && online && session
          ? {
              network: {
                mode: "live" as const,
                list: network,
                activityId,
                outbound: online.outbound(activityId, network),
              },
              timer: session.deadline(JUDGE_WAIT_MS, NETWORK_WAIT_MS),
            }
          : {}),
      });
      if (session) {
        fetches = await session.close();
        if (session.broken) throw unavailable();
      }
    } catch (error) {
      outcomes[index] = { error };
      continue;
    } finally {
      online?.end();
    }
    if ("failure" in outcome) {
      // Not the code's fault: nothing counts, nothing is noted.
      if (outcome.failure === "unavailable") {
        outcomes[index] = { error: unavailable() };
        continue;
      }
      const after = await failing(
        index,
        item,
        failureKind(outcome.failure === "load" ? "threw" : outcome.failure),
        outcome.detail,
        submission.now,
        outcome.hung ?? false,
        fetches.length,
      );
      if (after === "stop") break;
      if (after === "paused") {
        pauseAfter(index);
        break;
      }
      continue;
    }
    const read = readVerdict(outcome.verdict, share, judge.protocol);
    let invalid: string | null = null;
    let named: { userId: string; externalId: string; pending: number }[] = [];
    if ("error" in read) invalid = read.error.detail;
    else if (!("add" in read)) invalid = "判定结果不是第 5 版的写法";
    else {
      // Whom its others name: judged here and not settled (ledger.mjs othersProblem).
      const problem = othersProblem(read.others, linuxDoId, (id) => {
        const userId = userOf.get(id);
        const person = userId ? byUser.get(userId) : undefined;
        if (!person) return "unknown";
        return person.settled ? "settled" : null;
      });
      if (problem) invalid = problem;
      else
        named = read.others.map((other) => {
          const userId = userOf.get(other.id) ?? "";
          const person = byUser.get(userId);
          if (!person) throw new Error("A named other has no part");
          return {
            userId,
            externalId: person.externalId,
            pending: person.pending,
          };
        });
    }
    if (invalid !== null || !("add" in read)) {
      const after = await failing(
        index,
        item,
        "invalid",
        invalid ?? "",
        submission.now,
        false,
        fetches.length,
      );
      if (after === "stop") break;
      if (after === "paused") {
        pauseAfter(index);
        break;
      }
      continue;
    }
    const parts = await ledgerJudgmentStatements(env, {
      activity,
      row: judge,
      admission: item.admission,
      userId: item.userId,
      input: item.input,
      fingerprint: item.fingerprint,
      arrivedAt: item.arrivedAt,
      submission,
      reading: read,
      people: named.map((person) => ({ ...person, settledAt: null })),
      sequence: next,
      fetches,
      networked: network !== null,
    });
    statements.push(...parts.statements);
    unwritten.push({
      index,
      userId: item.userId,
      ...(read.message ? { message: read.message } : {}),
      parts,
    });

    // What it leaves for the next one judged.
    next += 1;
    attemptsOf.set(item.userId, attempt + 1);
    judge = { ...judge, failuresInRow: 0 };
    if (!read.state.keep) state = read.state.value as Json;
    if (!byUser.has(item.userId)) {
      byUser.set(item.userId, {
        externalId: account.externalId,
        pending: 0,
        settled: false,
      });
      userOf.set(linuxDoId, item.userId);
    }
    for (const move of parts.moves) {
      pendingAll += move.after - move.before;
      const person = byUser.get(move.userId);
      if (person) person.pending = move.after;
      const theirs = ownOf.get(move.userId);
      if (theirs) {
        theirs.pending = move.after;
        if (!move.state.keep) theirs.state = move.state.value as Json;
        if (!move.view.keep)
          theirs.view = move.view.value as Submission["player"]["view"];
      }
    }
    let othersPaid = false;
    for (const settled of parts.settled) {
      pendingAll -= settled.amount;
      unclaimedLeft -= settled.amount;
      const person = byUser.get(settled.userId);
      if (person) {
        person.pending = 0;
        person.settled = true;
      }
      const theirs = ownOf.get(settled.userId);
      if (theirs) {
        theirs.pending = 0;
        theirs.settled = true;
      }
      if (settled.amount === 0) continue;
      if (settled.userId === item.userId)
        settledClaims = [
          ...settledClaims,
          {
            user: { id: linuxDoId, username: account.username },
            amount: settled.amount,
            input: item.input.input,
            at: submission.now,
          },
        ];
      else othersPaid = true;
    }
    for (const userId of parts.others) told.add(userId);
    if (parts.ended) ended = true;
    // Someone else paid: their last input is theirs to read, as claims go.
    else if (othersPaid) {
      if (!(await flush())) break;
      settledClaims = await ledgerClaimsOf(env, activityId);
    }
  }
  await flush();

  // It ended the 红包: everyone not settled now is, as 结算中 (§2).
  const ender = written.find((judged) => judged.parts.ended);
  if (ender) {
    await refreshActivityLifecycle(env, activityId);
    hooks.ended?.();
  }
  if (told.size > 0) hooks.moved?.([...told]);
  await Promise.all(
    written.map(async (judged) => {
      // The one that ended it may have been settled by the end itself.
      if (judged === ender) {
        outcomes[judged.index] = {
          result: await judgedResult(env, judged.parts.rowId, judged.userId),
        };
        return;
      }
      const self = judged.parts.moves[0];
      const settled = judged.parts.settled.find(
        (person) => person.userId === judged.userId,
      );
      outcomes[judged.index] = {
        result: {
          result: "judged",
          ...(judged.message ? { message: judged.message } : {}),
          moved: {
            added: formatSignedAmount((self?.after ?? 0) - (self?.before ?? 0)),
            pending: formatSignedAmount(self?.after ?? 0),
          },
          ...(settled
            ? {
                settled: {
                  claim:
                    settled.claimId === null
                      ? null
                      : await getClaimDetail(
                          env,
                          settled.claimId,
                          judged.userId,
                        ),
                },
              }
            : {}),
        },
      };
    }),
  );
  return rest({ alone: true });
}
