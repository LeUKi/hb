// Protocol 5 (docs/multi-prize-design.md): each person a 代码判定红包
// judged has pending, their own state and view, and is settled once — by
// the code, or by the site as the 红包 ends. A judgment's money moves as
// kit/runtime/ledger.mjs moves it, in one batch with the judgment, the
// people it moved and whoever it settled; a judgment that ends it (end, or
// the pool taken) ends it in that batch. Then 结算中: everyone not settled
// is, a page at a time (settleEnded), and only then the rest goes back.
import {
  type ClaimActivityInput,
  type ClaimResult,
  formatSignedAmount,
  type LdcActivityInput,
  ldcTotalMinor,
  type PublicQuantity,
} from "@hb/contracts";
import type { Json, Submission } from "../../../../kit/judge";
import {
  defaultCount,
  type LedgerReading,
  moveMoney,
} from "../../../../kit/runtime/index.mjs";
import { getClaimDetail } from "../activities/claim-queries";
import {
  type Admitted,
  attemptAssociatedData,
  claimGuardStatement,
  shareStatements,
} from "../activities/claim-service";
import { databaseNow } from "../activities/lifecycle";
import { type ActivityRow, findActivity } from "../activities/storage";
import { refundStatement } from "../balance/hongbao";
import type { ApiBindings } from "../env";
import { attemptWriteStatements } from "../runtime/attempt-cooldown";
import { allowsRealClaim, readPlatformControls } from "../runtime/controls";
import {
  decryptString,
  digestPassword,
  encryptString,
} from "../security/crypto";
import type { FetchRecord } from "./session";
import { type JudgeRow, judgeData } from "./storage";
import { usageStatement } from "./usage";

/** Where a person's own state and view are sealed: theirs alone. */
export const ownData = (
  activityId: string,
  userId: string,
  part: "state" | "view",
) => `${judgeData(activityId, "player")}:${userId}:${part}`;

type PartRow = {
  userId: string;
  externalId: string;
  pending: number;
  settledAt: number | null;
  ownState: string | null;
  ownView: string | null;
};

/** This person's part (protocol 5), as the code is given it; null before their first judgment. */
export async function ownPart(
  env: ApiBindings,
  activityId: string,
  userId: string,
) {
  const row = await env.DB.prepare(
    `SELECT pending_minor AS pending, settled_at AS settledAt, own_state_ciphertext AS ownState,
      own_view_ciphertext AS ownView FROM code_judge_people WHERE activity_id = ? AND user_id = ?`,
  )
    .bind(activityId, userId)
    .first<Omit<PartRow, "userId" | "externalId">>();
  if (!row) return { settled: false, pending: 0, state: null, view: null };
  const read = async (cipher: string | null, part: "state" | "view") =>
    cipher === null
      ? null
      : JSON.parse(
          await decryptString(cipher, env, ownData(activityId, userId, part)),
        );
  return {
    settled: row.settledAt !== null,
    pending: row.pending,
    state: (await read(row.ownState, "state")) as Json,
    view: (await read(row.ownView, "view")) as Submission["player"]["view"],
  };
}

/**
 * Their own part as they see it (§3.4, §4.1): pending, settled, their view
 * — never the code's own state. Null before their first judgment, or on a
 * 红包 before protocol 5.
 */
export async function ownStanding(
  env: ApiBindings,
  activityId: string,
  userId: string,
) {
  const row = await env.DB.prepare(
    `SELECT p.pending_minor AS pending, p.settled_at AS settledAt, p.own_view_ciphertext AS ownView
      FROM code_judge_people p JOIN activity_code c ON c.activity_id = p.activity_id AND c.protocol >= 5
      WHERE p.activity_id = ? AND p.user_id = ?`,
  )
    .bind(activityId, userId)
    .first<{
      pending: number;
      settledAt: number | null;
      ownView: string | null;
    }>();
  if (!row) return null;
  return {
    pending: formatSignedAmount(row.pending),
    settled: row.settledAt !== null,
    view:
      row.ownView === null
        ? null
        : (JSON.parse(
            await decryptString(
              row.ownView,
              env,
              ownData(activityId, userId, "view"),
            ),
          ) as { summary?: string; data?: unknown }),
  };
}

/** Decrypted once per isolate: a settled person's input never changes. */
const settledInputs = new Map<string, string>();

/**
 * The claims the code is given (protocol 5): everyone settled with money,
 * in the order settled (their share's place), each with the input of
 * their last judgment, their name then, and when they were settled — as a
 * replay works them out (kit/runtime/scenario.mjs).
 */
export async function ledgerClaimsOf(env: ApiBindings, activityId: string) {
  const rows =
    await env.DB.prepare(`SELECT p.claim_id AS claimId, p.settled_minor AS amount, p.settled_at AS at,
      u.external_id AS externalId, j.username, j.submission_row_id AS rowId, e.ciphertext
    FROM code_judge_people p JOIN users u ON u.id = p.user_id
    JOIN claims c ON c.id = p.claim_id
    JOIN reward_inventory r ON r.activity_id = c.activity_id AND r.id = c.inventory_id
    JOIN code_judgments j ON j.activity_id = p.activity_id AND j.user_id = p.user_id AND j.attempt = p.judged - 1
    JOIN attempt_events e ON e.submission_row_id = j.submission_row_id
    WHERE p.activity_id = ? AND p.claim_id IS NOT NULL ORDER BY r.position`)
      .bind(activityId)
      .all<{
        claimId: string;
        amount: number;
        at: number;
        externalId: string;
        username: string;
        rowId: string;
        ciphertext: string;
      }>();
  return Promise.all(
    rows.results.map(async (row) => {
      let input = settledInputs.get(row.claimId);
      if (input === undefined) {
        input = await decryptString(
          row.ciphertext,
          env,
          attemptAssociatedData(activityId, row.rowId),
        );
        settledInputs.set(row.claimId, input);
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

/**
 * What is left of its pool (§2): the 🐟额 still locked, or for 商户直发,
 * which locks nothing, the total less the shares made (as the database's
 * guard counts it, migration 0047).
 */
export async function poolLeft(env: ApiBindings, activity: ActivityRow) {
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

/**
 * 奖池还剩 (§4.1, §4.5) of these 红包, in 分, in one read: for a protocol
 * 5 红包 that has opened, the pool less what was paid and everyone's
 * pending; for a 代码判定 draft (it opens on protocol 5), its whole pool.
 * Others are not in it: they have shares.
 */
export async function ledgerPools(
  env: ApiBindings,
  activityIds: string[],
): Promise<Map<string, number>> {
  if (activityIds.length === 0) return new Map();
  const total = `CAST(ROUND(CAST(json_extract(a.config, '$.money.totalAmount') AS REAL) * 100) AS INTEGER)`;
  const found = await env.DB.prepare(`SELECT a.id, MAX(0, CASE
        WHEN a.opened_at IS NULL THEN ${total}
        WHEN a.funding = 'balance'
          THEN COALESCE((SELECT remaining_minor FROM balance_locks WHERE activity_id = a.id AND purpose = 'activity' AND status = 'active'), 0)
            - c.pending_minor
        ELSE ${total} - COALESCE((SELECT SUM(amount_minor) FROM reward_inventory WHERE activity_id = a.id), 0)
          - c.pending_minor END) AS left
    FROM activities a LEFT JOIN activity_code c ON c.activity_id = a.id
    WHERE a.id IN (SELECT value FROM json_each(?)) AND a.participation_mode = 'code'
      AND (a.opened_at IS NULL OR c.protocol >= 5)`)
    .bind(JSON.stringify(activityIds))
    .all<{ id: string; left: number | null }>();
  return new Map(
    found.results.flatMap((row) =>
      row.left === null ? [] : [[row.id, row.left] as const],
    ),
  );
}

/** Only 代码判定 may have a pool: a list without one reads nothing more. */
const codeIds = (items: { id: string; participationMode?: string }[]) =>
  items.flatMap((item) => (item.participationMode === "code" ? [item.id] : []));

/**
 * Public reads of a list (广场, a topic's): 奖池还剩 for quantity where
 * one has it, never shares it has not.
 */
export async function withPoolQuantities<
  T extends {
    id: string;
    participationMode?: string;
    quantity: PublicQuantity;
  },
>(env: ApiBindings, items: T[]): Promise<T[]> {
  const pools = await ledgerPools(env, codeIds(items));
  return items.map((item) => {
    const left = pools.get(item.id);
    return left === undefined
      ? item
      : { ...item, quantity: { mode: "pool", left: formatSignedAmount(left) } };
  });
}

/** Summaries (one's own lists, payments, the 站长's): 奖池还剩 beside them. */
export async function withPoolLeft<
  T extends { id: string; participationMode?: string },
>(env: ApiBindings, items: T[]): Promise<(T & { poolLeft?: string })[]> {
  const pools = await ledgerPools(env, codeIds(items));
  return items.map((item) => {
    const left = pools.get(item.id);
    return left === undefined
      ? item
      : { ...item, poolLeft: formatSignedAmount(left) };
  });
}

/** One 红包's 奖池还剩 (ledgerPools); null when it has shares instead. */
export async function ledgerPool(env: ApiBindings, activityId: string) {
  return (await ledgerPools(env, [activityId])).get(activityId) ?? null;
}

/** Everyone's pending together (protocol 5). */
export async function pendingTotal(env: ApiBindings, activityId: string) {
  return (
    (await env.DB.prepare(
      "SELECT pending_minor FROM activity_code WHERE activity_id = ?",
    )
      .bind(activityId)
      .first<number>("pending_minor")) ?? 0
  );
}

/**
 * Protocol 5's submission (§3.1, §3.5): the old numbers as n shares would
 * have them, n about 1 LDC each, with `unclaimed`; `player`, this
 * person's own. As kit/runtime/scenario.mjs gives it.
 */
export function ledgerHongbao(
  activity: ActivityRow,
  remaining: number,
  pending: number,
  claims: number,
) {
  const total = ldcTotalMinor(JSON.parse(activity.config) as LdcActivityInput);
  const count = defaultCount(total);
  const unclaimed = remaining - pending;
  return {
    hongbao: {
      title: activity.title,
      total,
      count,
      minEach: 1,
      remaining,
      remainingCount: Math.max(1, count - claims),
      unclaimed,
      openedAt: activity.openedAt ?? 0,
      endsAt: activity.deadline ?? 0,
    },
    share: { min: 1, max: unclaimed, last: false },
  };
}

/**
 * Settles one person (§2), in a batch: their pending is what they get, a
 * claim when it is not 0 — its share next in line, the way it reaches them
 * (🐟额 or a payment, shareStatements) — and their part marked settled at
 * `at`. `claimId` is the claim made, or null for 0.
 */
export async function settlementStatements(
  env: ApiBindings,
  activity: ActivityRow,
  person: { userId: string; amount: number; at: number },
) {
  const settle = (claimId: string | null) =>
    env.DB.prepare(`UPDATE code_judge_people SET settled_at = ?, settled_minor = pending_minor, claim_id = ?,
      claimed = pending_minor > 0, paid_minor = NULLIF(pending_minor, 0), pending_minor = 0
      WHERE activity_id = ? AND user_id = ? AND settled_at IS NULL AND pending_minor = ?`).bind(
      person.at,
      claimId,
      activity.id,
      person.userId,
      person.amount,
    );
  if (person.amount === 0)
    return { claimId: null, statements: [settle(null)], merchantVersion: null };
  const claimId = crypto.randomUUID();
  const inventoryId = crypto.randomUUID();
  const way = await shareStatements(env, activity, {
    claimId,
    taskId: crypto.randomUUID(),
    userId: person.userId,
    inventoryId,
    amountMinor: person.amount,
  });
  return {
    claimId,
    merchantVersion: way.merchantVersion,
    statements: [
      env.DB.prepare(`INSERT INTO reward_inventory (id, activity_id, position, kind, ciphertext, amount_minor, created_at)
        SELECT ?, id, claimed_count, 'ldc', NULL, ?, ${databaseNow} FROM activities WHERE id = ?`).bind(
        inventoryId,
        person.amount,
        activity.id,
      ),
      env.DB.prepare(
        `INSERT INTO claims (id, activity_id, user_id, inventory_id, password_id, claimed_at) VALUES (?, ?, ?, ?, NULL, ${databaseNow})`,
      ).bind(claimId, activity.id, person.userId, inventoryId),
      env.DB.prepare(
        `UPDATE activities SET claimed_count = claimed_count + 1, updated_at = ${databaseNow} WHERE id = ?`,
      ).bind(activity.id),
      ...way.statements,
      settle(claimId),
    ],
  };
}

/** A protocol 5 红包 ended and not everyone settled yet: 结算中. */
export async function isSettling(env: ApiBindings, activityId: string) {
  return Boolean(
    await env.DB.prepare(`SELECT 1 FROM activity_code c JOIN activities a ON a.id = c.activity_id
      WHERE c.activity_id = ? AND c.protocol >= 5 AND c.settled_at IS NULL AND a.ended_at IS NOT NULL`)
      .bind(activityId)
      .first(),
  );
}

/** People settled a batch at a time as it ends, and batches a call. */
const SETTLE_PAGE = 20;
const SETTLE_ROUNDS = 10;

/**
 * 结算中 (§2 红包结束时的统一结算): everyone a protocol 5 红包 that has
 * ended has not settled is, with their pending, a page at a time, first
 * judged first; once nobody is left it is marked settled and what nobody
 * took goes back. Each person settles only while still unsettled, so a
 * page cut off or done twice pays nobody twice. A real-money 红包 waits
 * while new claims are paused. True once it is done (or has nothing to
 * do), false when there is more for the next call.
 */
export async function settleEnded(env: ApiBindings, activityId: string) {
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    if (!(await isSettling(env, activityId))) return true;
    const activity = await findActivity(env, activityId);
    if (!activity) return true;
    const page =
      await env.DB.prepare(`SELECT user_id AS userId, pending_minor AS pending FROM code_judge_people
      WHERE activity_id = ? AND settled_at IS NULL ORDER BY first_at, user_id LIMIT ?`)
        .bind(activityId, SETTLE_PAGE)
        .all<{ userId: string; pending: number }>();
    if (page.results.length === 0) {
      await env.DB.batch([
        env.DB.prepare(`UPDATE activity_code SET settled_at = ${databaseNow}, updated_at = ${databaseNow}
          WHERE activity_id = ? AND settled_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM code_judge_people WHERE activity_id = ? AND settled_at IS NULL)`).bind(
          activityId,
          activityId,
        ),
        refundStatement(env, activityId),
      ]);
      return true;
    }
    if (
      activity.paymentMode === "real" &&
      page.results.some((person) => person.pending > 0) &&
      !allowsRealClaim(env, await readPlatformControls(env))
    )
      return false;
    const at = Date.now();
    const statements = [];
    for (const person of page.results)
      statements.push(
        ...(
          await settlementStatements(env, activity, {
            userId: person.userId,
            amount: person.pending,
            at,
          })
        ).statements,
      );
    await env.DB.batch(statements);
  }
  return !(await isSettling(env, activityId));
}

/** A protocol 5 judgment's own part of ClaimResult: what moved, what it settled. */
export async function judgedResult(
  env: ApiBindings,
  submissionRowId: string,
  userId: string,
): Promise<Extract<ClaimResult, { result: "judged" }>> {
  const row =
    await env.DB.prepare(`SELECT j.message, m.add_minor AS added, m.before_minor AS before, m.after_minor AS after,
      m.settles, p.settled_at AS settledAt, p.claim_id AS claimId, p.settled_minor AS settled,
      (SELECT MAX(sequence) FROM code_judgments WHERE activity_id = j.activity_id AND user_id = j.user_id) = j.sequence AS latest
    FROM code_judgments j JOIN code_judgment_moves m ON m.submission_row_id = j.submission_row_id AND m.position = 0
    JOIN code_judge_people p ON p.activity_id = j.activity_id AND p.user_id = j.user_id
    WHERE j.submission_row_id = ?`)
      .bind(submissionRowId)
      .first<{
        message: string | null;
        added: number;
        before: number;
        after: number;
        settles: number;
        settledAt: number | null;
        claimId: string | null;
        settled: number | null;
        latest: number;
      }>();
  if (!row) throw new Error("A protocol 5 judgment has no move");
  // Settled by this judgment: its own, or the 红包 ending with it.
  const settledHere = row.settledAt !== null && row.latest === 1;
  return {
    result: "judged",
    ...(row.message ? { message: row.message } : {}),
    moved: {
      added: formatSignedAmount(row.after - row.before),
      pending: formatSignedAmount(row.after),
    },
    ...(settledHere
      ? {
          settled: {
            claim:
              row.claimId === null
                ? null
                : await getClaimDetail(env, row.claimId, userId),
          },
        }
      : {}),
  };
}

/** What a protocol 5 judgment needs written, as claims.ts gathered it. */
export type LedgerJudgment = {
  activity: ActivityRow;
  row: JudgeRow;
  admission: Pick<Admitted, "testPermission" | "realActivityPermitted">;
  userId: string;
  input: Extract<ClaimActivityInput, { participationMode: "code" }>;
  fingerprint: string;
  submission: Submission;
  reading: LedgerReading;
  /** The people its others name, in order (othersOf). */
  people: Omit<PartRow, "ownState" | "ownView">[];
  sequence: number;
  fetches: FetchRecord[];
  networked: boolean;
};

const sealed = (env: ApiBindings, value: Json, data: string) =>
  encryptString(JSON.stringify(value), env, data);

/**
 * A protocol 5 judgment's batch (§2, §3.2), not yet written: the submission
 * and its input, the judgment with what it wrote (ledger_ciphertext), each
 * person it moved (code_judgment_moves, written before their pending
 * moves), the one judged's part and the others' (pending as ledger.mjs
 * moves it, own state and view as written), the shared state and view,
 * its line in 动态, 用量, then whoever it settles, the one judged first;
 * and when it ends the 红包 (end, or the pool taken), the end, last.
 * Several of one 红包 go in one batch (batch.ts), each as it would on its
 * own. What moved and settled comes back, for the answer, for telling the
 * others, and for the next one judged after it.
 */
export async function ledgerJudgmentStatements(
  env: ApiBindings,
  judgment: LedgerJudgment,
) {
  const { activity, row, submission, reading, userId, people } = judgment;
  const activityId = activity.id;
  const unclaimed = submission.hongbao.unclaimed;
  const writes = [
    {
      userId,
      pending: submission.player.pending,
      add: reading.add,
      settle: reading.settle,
      state: reading.player.state,
      view: reading.player.view,
      message: undefined as string | undefined,
    },
    ...reading.others.map((other, index) => {
      const person = people[index];
      if (!person) throw new Error("A named other has no part");
      return {
        userId: person.userId,
        pending: person.pending,
        add: other.add,
        settle: other.settle,
        state: other.state,
        view: other.view,
        message: other.message,
      };
    }),
  ];
  const moved = moveMoney(
    unclaimed,
    writes.map((write, index) => ({
      id: index,
      pending: write.pending,
      add: write.add,
    })),
  );
  const ended = reading.end ? "judge" : moved.unclaimed === 0 ? "empty" : null;
  const now = submission.now;
  const rowId = crypto.randomUUID();
  const stateText = reading.state.keep
    ? null
    : JSON.stringify(reading.state.value);
  const view = reading.view.keep ? null : reading.view;
  // What it wrote besides the shared state and view, for the records.
  const ledgerText = {
    add: reading.add,
    settle: reading.settle,
    shorthand: reading.shorthand,
    player: {
      ...(reading.player.state.keep
        ? {}
        : { state: reading.player.state.value }),
      ...(reading.player.view.keep ? {} : { view: reading.player.view.value }),
    },
    others: reading.others.map((other) => ({
      id: other.id,
      add: other.add,
      settle: other.settle,
      ...(other.state.keep ? {} : { state: other.state.value }),
      ...(other.view.keep ? {} : { view: other.view.value }),
      ...(other.message !== undefined ? { message: other.message } : {}),
    })),
  };
  const [
    inputCiphertext,
    digest,
    stateCiphertext,
    judgmentState,
    fetchesCiphertext,
    ledgerCiphertext,
    owns,
  ] = await Promise.all([
    encryptString(
      judgment.input.input,
      env,
      attemptAssociatedData(activityId, rowId),
    ),
    digestPassword(judgment.input.input, env.PASSWORD_DIGEST_KEY),
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
    judgment.fetches.length === 0
      ? null
      : encryptString(
          JSON.stringify(judgment.fetches),
          env,
          `${judgeData(activityId, "fetches")}:${rowId}`,
        ),
    sealed(
      env,
      ledgerText as Json,
      `${judgeData(activityId, "ledger")}:${rowId}`,
    ),
    Promise.all(
      writes.map(async (write) => ({
        state: write.state.keep
          ? undefined
          : await sealed(
              env,
              write.state.value,
              ownData(activityId, write.userId, "state"),
            ),
        view: write.view.keep
          ? undefined
          : write.view.value === null
            ? null
            : await sealed(
                env,
                write.view.value as Json,
                ownData(activityId, write.userId, "view"),
              ),
      })),
    ),
  ]);
  // Whoever it settles, the one judged first, with what they then have.
  const settling: Awaited<ReturnType<typeof settlementStatements>>[] = [];
  for (const [index, write] of writes.entries()) {
    if (!write.settle) continue;
    const after = moved.moves[index]?.after ?? 0;
    settling.push(
      await settlementStatements(env, activity, {
        userId: write.userId,
        amount: after,
        at: now,
      }),
    );
  }
  // The one judged settled with money now: this attempt won it, as a
  // claim's attempt does (尝试统计, 第 N 次领到, the roster).
  const selfClaim =
    writes[0]?.settle && (moved.moves[0]?.after ?? 0) > 0
      ? (settling[0]?.claimId ?? null)
      : null;
  const ownState = (index: number) => owns[index]?.state;
  const ownView = (index: number) => owns[index]?.view;
  const self = owns[0];
  const statements = [
    ...attemptWriteStatements(env, userId, "activity", rowId),
    claimGuardStatement(env, activity, "code", userId, judgment.admission),
    env.DB.prepare(`INSERT INTO redemption_submissions
      (id, activity_id, user_id, submission_id, fingerprint, purpose, participation_mode, outcome, matched_password_id, created_at, validated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, 'claim', 'code', 'incorrect', NULL, ${databaseNow}, ${databaseNow}, ${databaseNow})`).bind(
      rowId,
      activityId,
      userId,
      judgment.input.submissionId,
      judgment.fingerprint,
    ),
    env.DB.prepare(`INSERT INTO attempt_events
      (id, submission_row_id, activity_id, user_id, ciphertext, digest, matched, matched_password_id, validated_at)
      SELECT ?, id, activity_id, user_id, ?, ?, ?, NULL, validated_at FROM redemption_submissions WHERE id = ?`).bind(
      crypto.randomUUID(),
      inputCiphertext,
      digest,
      Number(selfClaim !== null),
      rowId,
    ),
    env.DB.prepare(`INSERT INTO code_judgments
      (submission_row_id, activity_id, user_id, sequence, attempt, title, username, level, ok, asked_minor, paid_minor, note, message, state_ciphertext, fetches_ciphertext, judged_at, view, ends, ledger_ciphertext)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`).bind(
      rowId,
      activityId,
      userId,
      judgment.sequence,
      submission.user.attempts,
      submission.hongbao.title,
      submission.user.username,
      submission.user.level,
      reading.message ?? null,
      judgmentState,
      fetchesCiphertext,
      now,
      view ? JSON.stringify(view.value) : null,
      Number(reading.end),
      ledgerCiphertext,
    ),
    // Each one moved, before their pending moves (the guard reads it).
    ...writes.map((write, index) =>
      env.DB.prepare(`INSERT INTO code_judgment_moves
        (submission_row_id, position, activity_id, user_id, add_minor, before_minor, after_minor, settles, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        rowId,
        index,
        activityId,
        write.userId,
        write.add,
        moved.moves[index]?.before ?? 0,
        moved.moves[index]?.after ?? 0,
        Number(write.settle),
        index > 0 ? (write.message ?? null) : null,
        now,
      ),
    ),
    // The one judged: counted, their pending and own state and view.
    env.DB.prepare(`INSERT INTO code_judge_people
      (activity_id, user_id, judged, claimed, paid_minor, first_at, last_at, pending_minor, own_state_ciphertext, own_view_ciphertext)
      VALUES (?1, ?2, 1, 0, NULL, ?3, ?3, ?4, ?6, ?8)
      ON CONFLICT (activity_id, user_id) DO UPDATE SET judged = judged + 1,
        last_at = MAX(last_at, excluded.last_at), pending_minor = ?4,
        own_state_ciphertext = CASE WHEN ?5 THEN own_state_ciphertext ELSE ?6 END,
        own_view_ciphertext = CASE WHEN ?7 THEN own_view_ciphertext ELSE ?8 END`).bind(
      activityId,
      userId,
      now,
      moved.moves[0]?.after ?? 0,
      Number(self?.state === undefined),
      self?.state ?? null,
      Number(self?.view === undefined),
      self?.view ?? null,
    ),
    // Those its others named: their pending and own state and view.
    ...writes.slice(1).map((write, offset) => {
      const index = offset + 1;
      return env.DB.prepare(`UPDATE code_judge_people SET pending_minor = ?,
          own_state_ciphertext = CASE WHEN ? THEN own_state_ciphertext ELSE ? END,
          own_view_ciphertext = CASE WHEN ? THEN own_view_ciphertext ELSE ? END
        WHERE activity_id = ? AND user_id = ? AND settled_at IS NULL AND pending_minor = ?`).bind(
        moved.moves[index]?.after ?? 0,
        Number(ownState(index) === undefined),
        ownState(index) ?? null,
        Number(ownView(index) === undefined),
        ownView(index) ?? null,
        activityId,
        write.userId,
        write.pending,
      );
    }),
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
      now,
      activityId,
    ),
    ...(reading.announce !== undefined
      ? [
          env.DB.prepare(`INSERT INTO activity_announcements
            (activity_id, n, user_id, submission_row_id, text, created_at)
            VALUES (?1, (SELECT COUNT(*) FROM activity_announcements WHERE activity_id = ?1), ?2, ?3, ?4, ?5)`).bind(
            activityId,
            userId,
            rowId,
            reading.announce,
            now,
          ),
        ]
      : []),
    usageStatement(env, {
      now,
      fingerprint: row.fingerprint,
      fresh: row.sandbox,
      protocol: row.protocol,
      networked: judgment.networked,
      userId: activity.authorId,
      activityId,
      claims: 1,
      fetches: judgment.fetches.length,
    }),
    ...settling.flatMap((settlement) => settlement.statements),
    ...(selfClaim
      ? [
          env.DB.prepare(
            "UPDATE attempt_events SET claim_id = ? WHERE submission_row_id = ? AND matched = 1",
          ).bind(selfClaim, rowId),
        ]
      : []),
    // It ended the 红包: the end, last; everyone else settles as 结算中.
    ...(ended
      ? [
          env.DB.prepare(`UPDATE activities SET ended_at = ${databaseNow}, end_reason = ?, version = version + 1,
            updated_at = ${databaseNow} WHERE id = ? AND ended_at IS NULL`).bind(
            ended === "judge" ? "judge" : "exhausted",
            activityId,
          ),
        ]
      : []),
  ];
  return {
    statements,
    rowId,
    ended,
    /** Those it moved besides the one judged, to tell. */
    others: writes.slice(1).map((write) => write.userId),
    /** Each one moved, the one judged first: pending before and after. */
    moves: writes.map((write, index) => ({
      userId: write.userId,
      before: moved.moves[index]?.before ?? 0,
      after: moved.moves[index]?.after ?? 0,
      settles: write.settle,
      state: write.state,
      view: write.view,
    })),
    /** Whoever it settled, with what, and the claim when it paid. */
    settled: writes.flatMap((write, index) =>
      write.settle
        ? [
            {
              userId: write.userId,
              amount: moved.moves[index]?.after ?? 0,
              claimId:
                settling[writes.slice(0, index).filter((w) => w.settle).length]
                  ?.claimId ?? null,
            },
          ]
        : [],
    ),
  };
}
