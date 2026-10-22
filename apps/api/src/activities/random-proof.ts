import {
  type ActivityProofData,
  bytesToHex,
  DRAND_QUICKNET,
  type DrawProof,
  drandRoundAfter,
  drandRoundAt,
  drandRoundMatches,
  drawSeed,
  hasQueue,
  type LdcActivityInput,
  type LdcMoney,
  queueAmountsV2,
  queueCommitment,
  queueSeed,
  rosterHash,
} from "@hb/contracts";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { activityRandomProofs } from "../db/schema";
import type { ApiBindings } from "../env";
import { decryptString, encryptString } from "../security/crypto";
import type { DrawPlan } from "./draw-service";
import { timedDrawMoney } from "./draw-storage";
import { activityNotFound } from "./errors";
import { databaseNow } from "./lifecycle";
import {
  type ActivityRow,
  findActivity,
  type InventoryRow,
  insertInventoryRows,
} from "./storage";

// 开奖证明 v2 (docs/draw-proof-design.md): a 限时开奖 drawn from the drand
// round right after closing and its frozen roster; a 拼手气 (or 自定义 in
// random order) handing out a queue sealed when it opened.

export const RANDOM_VERSION = 2;

type ProofRow = typeof activityRandomProofs.$inferSelect;

/** The random version a 红包 opens with: v2 when anything of it is random. */
export function openingRandomVersion(input: LdcActivityInput) {
  return input.money.mode === "timed_draw" ||
    hasQueue(input.money, input.allocation)
    ? RANDOM_VERSION
    : null;
}

export function findRandomProof(env: ApiBindings, activityId: string) {
  return createDb(env.DB)
    .select()
    .from(activityRandomProofs)
    .where(eq(activityRandomProofs.activityId, activityId))
    .get();
}

const secretData = (activityId: string) => `random-proof:${activityId}`;

/**
 * Opening a queue: a fresh secret makes the whole queue, which replaces the
 * draft's amounts; the 封存值 is public from now on, the secret kept
 * encrypted until the end. `before` runs ahead of the opening write (the
 * inventory is fixed once opened), `after` behind it.
 */
export async function sealQueue(
  env: ApiBindings,
  activityId: string,
  money: LdcMoney,
  existing: InventoryRow[],
  now: number,
) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = bytesToHex(bytes);
  const amounts = queueAmountsV2({
    seed: queueSeed(activityId, secret),
    money,
  });
  const inventory: InventoryRow[] = amounts.map((amountMinor, position) => ({
    id: existing[position]?.id ?? crypto.randomUUID(),
    activityId,
    position,
    kind: "ldc",
    ciphertext: null,
    amountMinor,
    createdAt: existing[position]?.createdAt ?? now,
  }));
  return {
    inventory,
    before: [
      env.DB.prepare("DELETE FROM reward_inventory WHERE activity_id = ?").bind(
        activityId,
      ),
      insertInventoryRows(env.DB, inventory),
    ],
    after:
      env.DB.prepare(`INSERT INTO activity_random_proofs (activity_id, kind, version, commitment, secret_ciphertext, created_at)
      VALUES (?, 'queue', ?, ?, ?, ${databaseNow})`).bind(
        activityId,
        RANDOM_VERSION,
        queueCommitment(activityId, secret),
        await encryptString(secret, env, secretData(activityId)),
      ),
  };
}

/** At closing: the round right after it, and the frozen roster's hash. */
async function ensureDrawProof(env: ApiBindings, activityId: string) {
  const existing = await findRandomProof(env, activityId);
  if (existing) return existing;
  const activity = await findActivity(env, activityId);
  if (
    activity?.randomVersion !== RANDOM_VERSION ||
    activity.drawState !== "settling" ||
    activity.drawClosedAt === null
  )
    return null;
  const roster = await env.DB.prepare(
    "SELECT id, ordinal FROM activity_registrations WHERE activity_id = ? ORDER BY ordinal",
  )
    .bind(activityId)
    .all<{ id: string; ordinal: number }>();
  if (roster.results.length !== activity.registeredCount)
    throw new Error("Drawing roster is inconsistent");
  const round = drandRoundAfter(activity.drawClosedAt);
  await env.DB.prepare(`INSERT OR IGNORE INTO activity_random_proofs (activity_id, kind, version, round, round_at, roster_hash, roster_count, created_at)
    VALUES (?, 'draw', ?, ?, ?, ?, ?, ${databaseNow})`)
    .bind(
      activityId,
      RANDOM_VERSION,
      round,
      drandRoundAt(round),
      rosterHash(
        roster.results.map((entry) => ({
          ordinal: entry.ordinal,
          registrationId: entry.id,
        })),
      ),
      activity.registeredCount,
    )
    .run();
  return findRandomProof(env, activityId);
}

/** The time a draw checks its round's against: tests move it on rather than wait for a real round. */
export const drandTime = { now: () => Date.now() };

/** A node serves a round a few hundred ms after its time; asking earlier gets a 404 it keeps. */
const ROUND_SERVED_AFTER_MS = 500;
const ROUND_RETRY_MS = 1_000;
const lastRoundAttempt = new Map<string, number>();

function drandNodes(env: ApiBindings) {
  return (
    env.DRAND_URLS?.split(",")
      .map((url) => url.trim())
      .filter(Boolean) ?? [
      "https://drand.cloudflare.com",
      "https://api.drand.sh",
    ]
  );
}

async function fetchRound(base: string, round: number) {
  try {
    const response = await fetch(
      `${base}/${DRAND_QUICKNET.chainHash}/public/${round}`,
      {
        cache: "no-store",
        headers: { "User-Agent": "hb.lafi.sh 开奖证明" },
        signal: AbortSignal.timeout(2_500),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      round?: unknown;
      randomness?: unknown;
      signature?: unknown;
    };
    if (
      body.round !== round ||
      typeof body.randomness !== "string" ||
      typeof body.signature !== "string"
    )
      return null;
    const value = { randomness: body.randomness, signature: body.signature };
    return drandRoundMatches(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The draw's seed, once its round is out: fetched from a drand node (the
 * same round whatever happens, never another one), checked, stored once.
 */
export async function drawRandomness(env: ApiBindings, activityId: string) {
  const proof = await ensureDrawProof(env, activityId);
  if (!proof || proof.seed) return proof?.seed ?? null;
  const { round, roundAt, rosterHash: hash } = proof;
  if (round === null || roundAt === null || hash === null)
    throw new Error("Drawing proof is incomplete");
  const now = drandTime.now();
  if (
    now < roundAt + ROUND_SERVED_AFTER_MS ||
    now < (lastRoundAttempt.get(activityId) ?? 0) + ROUND_RETRY_MS
  )
    return null;
  lastRoundAttempt.set(activityId, now);
  for (const base of drandNodes(env)) {
    const value = await fetchRound(base, round);
    if (!value) continue;
    try {
      await env.DB.prepare(`UPDATE activity_random_proofs SET randomness = ?, signature = ?, seed = ?, fetched_at = ${databaseNow}
        WHERE activity_id = ? AND kind = 'draw' AND randomness IS NULL`)
        .bind(
          value.randomness,
          value.signature,
          drawSeed({
            activityId,
            rosterHash: hash,
            round,
            randomness: value.randomness,
          }),
          activityId,
        )
        .run();
    } catch (error) {
      console.error("drand_round_not_saved", { activityId, round });
      throw error;
    }
    lastRoundAttempt.delete(activityId);
    return (await findRandomProof(env, activityId))?.seed ?? null;
  }
  console.error("drand_round_unavailable", { activityId, round });
  return null;
}

/** When a draw waiting for its round tries again (null: nothing to wait for). */
export async function drawRetryAt(env: ApiBindings, row: ActivityRow) {
  if (row.randomVersion !== RANDOM_VERSION || row.drawState !== "settling")
    return null;
  const proof = await findRandomProof(env, row.id);
  if (!proof || proof.seed || proof.roundAt === null) return null;
  const ahead = drandTime.now() - Date.now();
  return (
    Math.max(
      proof.roundAt + ROUND_SERVED_AFTER_MS,
      (lastRoundAttempt.get(row.id) ?? 0) + ROUND_RETRY_MS,
    ) - ahead
  );
}

/** What the roster dialog says: on a v2 红包's public read. */
export async function publicDrawProof(
  env: ApiBindings,
  row: ActivityRow,
): Promise<DrawProof | undefined> {
  if (row.randomVersion !== RANDOM_VERSION || row.openedAt === null)
    return undefined;
  const proof = await findRandomProof(env, row.id);
  if (proof?.kind === "queue" && proof.commitment)
    return { kind: "queue", commitment: proof.commitment };
  if (!timedDrawMoney(row)) return undefined;
  if (proof?.round && proof.roundAt && proof.rosterHash)
    return {
      kind: "draw",
      round: proof.round,
      roundAt: new Date(proof.roundAt).toISOString(),
      rosterHash: proof.rosterHash,
      ...(proof.randomness ? { randomness: proof.randomness } : {}),
    };
  const closing = row.drawClosedAt ?? row.deadline;
  if (closing === null) return undefined;
  const round = drandRoundAfter(closing);
  return {
    kind: "draw",
    round,
    roundAt: new Date(drandRoundAt(round)).toISOString(),
  };
}

function isOver(row: ActivityRow) {
  return (
    row.endedAt !== null ||
    row.claimedCount >= row.totalCount ||
    (row.deadline !== null && row.deadline <= Date.now())
  );
}

/** The queue's secret, once its 红包 is over: shown from then on, never changed. */
async function revealedSecret(
  env: ApiBindings,
  row: ActivityRow,
  proof: ProofRow,
) {
  if (proof.secret) return proof.secret;
  if (!isOver(row) || !proof.secretCiphertext || !proof.commitment) return null;
  const secret = await decryptString(
    proof.secretCiphertext,
    env,
    secretData(row.id),
  );
  if (queueCommitment(row.id, secret) !== proof.commitment)
    throw new Error("Sealed queue does not match its commitment");
  try {
    await env.DB.prepare(`UPDATE activity_random_proofs SET secret = ?, revealed_at = ${databaseNow}
      WHERE activity_id = ? AND kind = 'queue' AND secret IS NULL`)
      .bind(secret, row.id)
      .run();
  } catch {
    // D1's clock a moment behind the deadline: shown on the next read.
    return null;
  }
  return (await findRandomProof(env, row.id))?.secret ?? null;
}

type ProfileRow = {
  username: string;
  display_name: string;
  avatar_url: string | null;
};
const profile = (row: ProfileRow) => ({
  username: row.username,
  displayName: row.display_name,
  avatarUrl: row.avatar_url,
});

/**
 * A draw's result, public as soon as its plan is saved: the ordinals as
 * picked, the pool by position and each winner's prize; once published,
 * what each winner was actually given.
 */
async function drawResult(
  env: ApiBindings,
  activityId: string,
  published: boolean,
): Promise<NonNullable<
  Extract<ActivityProofData, { kind: "draw" }>["result"]
> | null> {
  const saved = await env.DB.prepare(
    "SELECT payload FROM activity_draw_plans WHERE activity_id = ?",
  )
    .bind(activityId)
    .first<{ payload: string }>();
  if (!saved) return null;
  const plan = JSON.parse(saved.payload) as DrawPlan;
  const positions = new Map(
    plan.inventory.map((item) => [item.id, item.position]),
  );
  const picked = plan.picked ?? [];
  if (!published)
    return {
      picked,
      amounts: plan.inventory.map((item) => item.amountMinor ?? 0),
      winners: plan.winners
        .map((winner) => ({
          ordinal: winner.ordinal,
          position: positions.get(winner.inventoryId) ?? -1,
          amountMinor: winner.amountMinor,
        }))
        .sort((left, right) => left.ordinal - right.ordinal),
    };
  const [amounts, winners] = await env.DB.batch([
    env.DB.prepare(
      "SELECT amount_minor FROM reward_inventory WHERE activity_id = ? ORDER BY position",
    ).bind(activityId),
    env.DB.prepare(`SELECT r.ordinal, i.position, i.amount_minor FROM claims c
      JOIN activity_registrations r ON r.activity_id = c.activity_id AND r.user_id = c.user_id
      JOIN reward_inventory i ON i.activity_id = c.activity_id AND i.id = c.inventory_id
      WHERE c.activity_id = ? ORDER BY r.ordinal`).bind(activityId),
  ]);
  return {
    picked,
    amounts: ((amounts?.results ?? []) as { amount_minor: number }[]).map(
      (item) => item.amount_minor,
    ),
    winners: (
      (winners?.results ?? []) as {
        ordinal: number;
        position: number;
        amount_minor: number;
      }[]
    ).map((winner) => ({
      ordinal: winner.ordinal,
      position: winner.position,
      amountMinor: winner.amount_minor,
    })),
  };
}

/** GET /api/activities/:id/proof: the same for everyone, signed in or not. */
export async function activityProofData(
  env: ApiBindings,
  activityId: string,
): Promise<ActivityProofData> {
  const row = await findActivity(env, activityId);
  if (!row || row.openedAt === null) activityNotFound();
  if (row.randomVersion !== RANDOM_VERSION) return { kind: "none" };
  const proof = await findRandomProof(env, row.id);
  const author = await env.DB.prepare(
    "SELECT username, display_name, avatar_url FROM users WHERE id = ?",
  )
    .bind(row.authorId)
    .first<ProfileRow>();
  if (!author) activityNotFound();
  const money = (JSON.parse(row.config) as LdcActivityInput).money;
  if (money.mode === "timed_draw") {
    const roster =
      await env.DB.prepare(`SELECT r.id, r.ordinal, r.registered_at, u.username, u.display_name, u.avatar_url
      FROM activity_registrations r JOIN users u ON u.id = r.user_id WHERE r.activity_id = ? ORDER BY r.ordinal`)
        .bind(row.id)
        .all<
          ProfileRow & { id: string; ordinal: number; registered_at: number }
        >();
    const frozen = proof?.kind === "draw" ? proof : null;
    const drawn = row.drawState === "completed" || row.drawState === "empty";
    // While the roster is open, the round its deadline would take.
    const round =
      frozen?.round ?? drandRoundAfter(row.drawClosedAt ?? row.deadline ?? 0);
    const result = frozen?.seed ? await drawResult(env, row.id, drawn) : null;
    return {
      kind: "draw",
      version: RANDOM_VERSION,
      stage:
        row.drawState === "waiting"
          ? "registering"
          : !frozen?.seed
            ? "waiting"
            : drawn
              ? "drawn"
              : "drawing",
      activity: {
        id: row.id,
        title: row.title,
        author: profile(author),
        deadlineAt: new Date(row.deadline ?? 0).toISOString(),
        closedAt:
          row.drawClosedAt === null
            ? null
            : new Date(row.drawClosedAt).toISOString(),
        money,
      },
      drand: {
        chainHash: DRAND_QUICKNET.chainHash,
        round,
        roundAt: new Date(frozen?.roundAt ?? drandRoundAt(round)).toISOString(),
        randomness: frozen?.randomness ?? null,
        signature: frozen?.signature ?? null,
      },
      roster: {
        hash: frozen?.rosterHash ?? null,
        entries: roster.results.map((entry) => ({
          ordinal: entry.ordinal,
          registrationId: entry.id,
          registeredAt: new Date(entry.registered_at).toISOString(),
          user: profile(entry),
        })),
      },
      seed: frozen?.seed ?? null,
      result,
    };
  }
  if (
    proof?.kind !== "queue" ||
    !proof.commitment ||
    (money.mode !== "random" && money.mode !== "custom")
  )
    return { kind: "none" };
  const secret = await revealedSecret(env, row, proof);
  const ended =
    row.endedAt ??
    (row.deadline !== null && row.deadline <= Date.now() ? row.deadline : null);
  // The shares claimed so far are public already (the 名单 shows them);
  // the rest only once it is over.
  const queue =
    await env.DB.prepare(`SELECT i.position, i.amount_minor, c.claimed_at, u.username, u.display_name, u.avatar_url
      FROM reward_inventory i LEFT JOIN claims c ON c.activity_id = i.activity_id AND c.inventory_id = i.id
      LEFT JOIN users u ON u.id = c.user_id WHERE i.activity_id = ? AND (? = 1 OR c.id IS NOT NULL) ORDER BY i.position`)
      .bind(row.id, secret ? 1 : 0)
      .all<
        {
          position: number;
          amount_minor: number;
          claimed_at: number | null;
        } & (ProfileRow | { [key in keyof ProfileRow]: null })
      >();
  return {
    kind: "queue",
    version: RANDOM_VERSION,
    stage: secret ? "ended" : "running",
    activity: {
      id: row.id,
      title: row.title,
      author: profile(author),
      openedAt: new Date(row.openedAt).toISOString(),
      endedAt: ended === null ? null : new Date(ended).toISOString(),
      money,
    },
    commitment: proof.commitment,
    secret,
    queue: queue.results.map((item) => ({
      position: item.position,
      amountMinor: item.amount_minor,
      claim:
        item.claimed_at !== null && item.username !== null
          ? {
              user: profile(item as ProfileRow),
              claimedAt: new Date(item.claimed_at).toISOString(),
            }
          : null,
    })),
  };
}
