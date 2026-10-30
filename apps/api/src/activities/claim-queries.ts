import {
  type ActivityInput,
  type AuthorClaim,
  type AuthorClaimList,
  type ClaimDetail,
  type ClaimList,
  type ClaimSummary,
  claimSpeedTitle,
  formatAmount,
  formatSignedAmount,
  type JudgeNote,
  type PublicRecipientList,
  type RecipientSpeedTitle,
} from "@hb/contracts";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { createDb } from "../db/client";
import {
  activities,
  activityPasswords,
  claims,
  paymentTasks,
  rewardInventory,
  users,
} from "../db/schema";
import type { ApiBindings } from "../env";
import { quotaHolds } from "../payments/quota";
import {
  heldForRecipient,
  recipientRejections,
  resendDeadline,
} from "../payments/resend-rules";
import { decryptString, encryptString } from "../security/crypto";
import { attemptAssociatedData } from "./claim-service";
import { activityNotFound, invalidActivity } from "./errors";
import { activityStatus, rewardSummary } from "./service";
import {
  type ActivityRow,
  findActivity,
  ownedActivity,
  passwordAssociatedData,
} from "./storage";

export type ClaimRow = typeof claims.$inferSelect;
type ClaimActivityRow = { claim: ClaimRow; activity: ActivityRow };
type Cursor = { time: number; id: string };
type ClaimSpeedTitles = Map<string, RecipientSpeedTitle>;

function parseCursor(value?: string): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(atob(value)) as Cursor;
    if (
      !Number.isSafeInteger(parsed.time) ||
      typeof parsed.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(parsed.id)
    )
      invalidActivity("分页标识无效");
    return parsed;
  } catch {
    invalidActivity("分页标识无效");
  }
}

function encodeCursor(claim: ClaimRow) {
  return btoa(JSON.stringify({ time: claim.claimedAt, id: claim.id }));
}

function beforeCursor(cursor?: Cursor) {
  return cursor
    ? or(
        lt(claims.claimedAt, cursor.time),
        and(eq(claims.claimedAt, cursor.time), lt(claims.id, cursor.id)),
      )
    : undefined;
}

/** The public roster reads oldest first, so its pages go forward. */
function afterCursor(cursor?: Cursor) {
  return cursor
    ? or(
        gt(claims.claimedAt, cursor.time),
        and(eq(claims.claimedAt, cursor.time), gt(claims.id, cursor.id)),
      )
    : undefined;
}

export function projectClaimSummary(
  claim: ClaimRow,
  activity: ActivityRow,
): ClaimSummary {
  return {
    id: claim.id,
    activity: {
      id: activity.id,
      title: activity.title,
      participationMode: activity.participationMode,
      ...(activity.funding === "balance"
        ? { funding: "balance" as const }
        : {}),
      status: activityStatus(activity),
      deadlineAt:
        activity.deadline === null
          ? null
          : new Date(activity.deadline).toISOString(),
      reward: rewardSummary(
        activity,
        (JSON.parse(activity.config) as ActivityInput).quantityVisibility ===
          "exact",
      ),
    },
    rewardType: "ldc",
    claimedAt: new Date(claim.claimedAt).toISOString(),
  };
}

export async function findUserClaim(
  env: ApiBindings,
  activityId: string,
  userId: string,
) {
  const row = await createDb(env.DB)
    .select({ claim: claims })
    .from(claims)
    .innerJoin(activities, eq(activities.id, claims.activityId))
    .where(
      and(
        eq(claims.activityId, activityId),
        eq(claims.userId, userId),
        eq(activities.rewardType, "ldc"),
        isNull(activities.deletedAt),
      ),
    )
    .get();
  return row?.claim;
}

export async function getClaimDetail(
  env: ApiBindings,
  claimId: string,
  userId: string,
): Promise<ClaimDetail> {
  const row = await createDb(env.DB)
    .select({ claim: claims, activity: activities })
    .from(claims)
    .innerJoin(activities, eq(activities.id, claims.activityId))
    .where(
      and(
        eq(claims.id, claimId),
        eq(claims.userId, userId),
        eq(activities.rewardType, "ldc"),
        isNull(activities.deletedAt),
      ),
    )
    .get();
  if (!row) activityNotFound();
  return (
    (await claimDetailsBatch(env, [row])).get(row.claim.id) ??
    activityNotFound()
  );
}

/** Only decrypt the persisted successful password IDs, never the configured first password. */
export async function sourcePasswordsBatch(
  env: ApiBindings,
  entries: { activityId: string; passwordId: string | null }[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      entries
        .map((entry) => entry.passwordId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (!ids.length) return new Map();
  const rows = await createDb(env.DB)
    .select()
    .from(activityPasswords)
    .where(inArray(activityPasswords.id, ids));
  const allowed = new Set(
    entries.map((entry) => `${entry.activityId}:${entry.passwordId}`),
  );
  const values = await Promise.all(
    rows
      .filter((row) => allowed.has(`${row.activityId}:${row.id}`))
      .map(
        async (row) =>
          [
            row.id,
            await decryptString(
              row.ciphertext,
              env,
              passwordAssociatedData(row.activityId, row.id),
            ),
          ] as const,
      ),
  );
  return new Map(values);
}

/** Owed and not out yet: what a merchant's daily limit holds up. */
const queued = (status: string) => status === "pending" || status === "waiting";

export async function claimSummariesBatch(
  env: ApiBindings,
  rows: ClaimActivityRow[],
): Promise<Map<string, ClaimSummary>> {
  if (!rows.length) return new Map();
  const ids = rows.map((row) => row.claim.id);
  // A 🐟额红包's claim has no payment, nor has 自领 (the sender's own,
  // docs/self-claim-design.md): its share is what it was given.
  const unpaid = rows.filter(
    ({ claim, activity }) =>
      activity.funding === "balance" || claim.userId === activity.authorId,
  );
  const unpaidInventory = unpaid.map(({ claim }) => claim.inventoryId);
  const [sources, payments, shares] = await Promise.all([
    sourcePasswordsBatch(
      env,
      rows.map(({ claim }) => claim),
    ),
    ids.length
      ? createDb(env.DB)
          .select()
          .from(paymentTasks)
          .where(inArray(paymentTasks.claimId, ids))
      : Promise.resolve([]),
    unpaidInventory.length
      ? createDb(env.DB)
          .select({
            id: rewardInventory.id,
            amountMinor: rewardInventory.amountMinor,
          })
          .from(rewardInventory)
          // By the whole key, (activity_id, id): by id alone every row of
          // every 红包 is read.
          .where(
            and(
              inArray(rewardInventory.activityId, [
                ...new Set(unpaid.map(({ claim }) => claim.activityId)),
              ]),
              inArray(rewardInventory.id, unpaidInventory),
            ),
          )
      : Promise.resolve([]),
  ]);
  const shareOf = new Map(shares.map((row) => [row.id, row.amountMinor]));
  const byClaim = new Map(
    payments.map((payment) => [payment.claimId, payment]),
  );
  // A merchant stopped by its daily limit holds every payment it owes.
  const held = await quotaHolds(
    env,
    payments
      .filter((payment) => queued(payment.status))
      .map((payment) => payment.merchantId),
  );
  // Payments turned down for want of a Credit account may go again a while.
  const rejections = await recipientRejections(
    env,
    payments.filter(heldForRecipient).map((payment) => payment.id),
  );
  const now = Date.now();
  return new Map(
    rows.map(({ claim, activity }) => {
      const payment = byClaim.get(claim.id);
      const sourcePassword =
        claim.passwordId === null ? undefined : sources.get(claim.passwordId);
      const self = claim.userId === activity.authorId;
      if (activity.funding === "balance" || self) {
        const share = shareOf.get(claim.inventoryId);
        if (share == null) throw new Error("Unpaid claim has no share");
        return [
          claim.id,
          {
            ...projectClaimSummary(claim, activity),
            ...(sourcePassword === undefined ? {} : { sourcePassword }),
            amount: formatAmount(share),
            ...(self ? { self: true as const } : {}),
          },
        ];
      }
      if (!payment) throw new Error("LDC claim has no payment task");
      const resendUntil = resendDeadline(
        payment,
        rejections.get(payment.id),
        now,
      );
      const resumeAt = queued(payment.status)
        ? held.get(payment.merchantId)
        : undefined;
      return [
        claim.id,
        {
          ...projectClaimSummary(claim, activity),
          ...(sourcePassword === undefined ? {} : { sourcePassword }),
          ...(payment
            ? {
                amount: formatAmount(payment.amountMinor),
                payment: {
                  id: payment.id,
                  mode: payment.mode,
                  status: payment.status,
                  reason: resumeAt === undefined ? payment.reason : "quota",
                  confirmedAt:
                    payment.confirmedAt === null
                      ? null
                      : new Date(payment.confirmedAt).toISOString(),
                  ...(resendUntil === null
                    ? {}
                    : { resendUntil: new Date(resendUntil).toISOString() }),
                  ...(resumeAt === undefined
                    ? {}
                    : { quotaResumeAt: new Date(resumeAt).toISOString() }),
                },
              }
            : {}),
        },
      ];
    }),
  );
}

/**
 * 代码判定: what each claimant typed, what the code said to them and, when
 * its number was pulled into range, that number (the sender's roster only).
 */
async function judgmentsBatch(env: ApiBindings, rows: ClaimActivityRow[]) {
  const coded = rows.filter(
    ({ activity }) => activity.participationMode === "code",
  );
  const judgments = new Map<string, NonNullable<AuthorClaim["judge"]>>();
  if (!coded.length) return judgments;
  const found =
    // From attempt_events.claim_id (indexed; set on the paying judgment's
    // row when its claim completes): never a scan of every submission.
    // Protocol 5's claims settle a person, not a judgment: their last
    // judgment says what they typed (code_judge_people, by its key).
    await env.DB.prepare(`SELECT e.claim_id AS claimId, s.activity_id AS activityId, s.id AS rowId,
      j.message, j.note, j.asked_minor AS asked, j.attempt, e.ciphertext
    FROM attempt_events e JOIN redemption_submissions s ON s.id = e.submission_row_id
    JOIN code_judgments j ON j.submission_row_id = s.id
    WHERE e.claim_id IN (SELECT value FROM json_each(?1)) AND s.participation_mode = 'code'
    UNION ALL
    SELECT p.claim_id AS claimId, j.activity_id AS activityId, j.submission_row_id AS rowId,
      j.message, j.note, j.asked_minor AS asked, j.attempt, e.ciphertext
    FROM code_judge_people p
    JOIN code_judgments j ON j.activity_id = p.activity_id AND j.user_id = p.user_id AND j.attempt = p.judged - 1
    JOIN attempt_events e ON e.submission_row_id = j.submission_row_id
    WHERE p.activity_id IN (SELECT value FROM json_each(?2)) AND p.claim_id IN (SELECT value FROM json_each(?1))`)
      .bind(
        JSON.stringify(coded.map(({ claim }) => claim.id)),
        JSON.stringify([...new Set(coded.map(({ activity }) => activity.id))]),
      )
      .all<{
        claimId: string;
        activityId: string;
        rowId: string;
        message: string | null;
        note: JudgeNote | null;
        asked: number | null;
        attempt: number;
        ciphertext: string;
      }>();
  for (const row of found.results)
    judgments.set(row.claimId, {
      input: await decryptString(
        row.ciphertext,
        env,
        attemptAssociatedData(row.activityId, row.rowId),
      ),
      ...(row.message ? { message: row.message } : {}),
      ...(row.note ? { note: row.note } : {}),
      ...(row.note && row.asked !== null
        ? { asked: formatSignedAmount(row.asked) }
        : {}),
      attempt: row.attempt + 1,
    });
  return judgments;
}

/** What the claimant sees of their judgment: not the code's own number. */
function claimantView({
  asked: _asked,
  ...judge
}: NonNullable<AuthorClaim["judge"]>): NonNullable<ClaimDetail["judge"]> {
  return judge;
}

export async function claimDetailsBatch(
  env: ApiBindings,
  rows: ClaimActivityRow[],
  /** The sender's roster: the code's own number too. */
  options: { asked?: boolean } = {},
): Promise<Map<string, ClaimDetail>> {
  const [summaries, judgments] = await Promise.all([
    claimSummariesBatch(env, rows),
    judgmentsBatch(env, rows),
  ]);
  const entries = await Promise.all(
    rows.map(
      async ({ claim, activity }): Promise<readonly [string, ClaimDetail]> => {
        const base = summaries.get(claim.id) ?? activityNotFound();
        const afterClaimInfo = (JSON.parse(activity.config) as ActivityInput)
          .afterClaimInfo;
        if (activity.rewardType !== "ldc") activityNotFound();
        if (
          base.amount === undefined ||
          (!base.payment && activity.funding !== "balance" && !base.self)
        )
          throw new Error("LDC claim has no payment task");
        const found = judgments.get(claim.id);
        return [
          claim.id,
          {
            ...base,
            afterClaimInfo,
            rewardType: "ldc",
            amount: base.amount,
            ...(found
              ? { judge: options.asked ? found : claimantView(found) }
              : {}),
          },
        ];
      },
    ),
  );
  return new Map(entries);
}

export async function getCurrentClaim(
  env: ApiBindings,
  activityId: string,
  userId: string,
) {
  const activity = await findActivity(env, activityId);
  // A draft too (05 §5): nobody has claimed it yet.
  if (!activity) activityNotFound();
  const claim = await findUserClaim(env, activityId, userId);
  return claim ? getClaimDetail(env, claim.id, userId) : null;
}

export async function listUserClaims(
  env: ApiBindings,
  userId: string,
  cursor?: string,
): Promise<ClaimList> {
  const rows = await createDb(env.DB)
    .select({ claim: claims, activity: activities })
    .from(claims)
    .innerJoin(activities, eq(activities.id, claims.activityId))
    .where(
      and(
        eq(claims.userId, userId),
        eq(activities.rewardType, "ldc"),
        isNull(activities.deletedAt),
        beforeCursor(parseCursor(cursor)),
      ),
    )
    .orderBy(desc(claims.claimedAt), desc(claims.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  const summaries = await claimSummariesBatch(env, page);
  return {
    items: page.map(
      ({ claim }) => summaries.get(claim.id) ?? activityNotFound(),
    ),
    nextCursor: rows.length > 20 && last ? encodeCursor(last.claim) : null,
  };
}

export async function listAuthorClaims(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  cursor?: string,
): Promise<AuthorClaimList> {
  const activity = await ownedActivity(env, activityId, authorId);
  const rows = await createDb(env.DB)
    .select({
      claim: claims,
      claimant: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(claims)
    .innerJoin(users, eq(users.id, claims.userId))
    // Oldest first, like the public roster it adds to (redesign 06 §3).
    .where(
      and(eq(claims.activityId, activityId), afterCursor(parseCursor(cursor))),
    )
    .orderBy(asc(claims.claimedAt), asc(claims.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  const details = await claimDetailsBatch(
    env,
    page.map(({ claim }) => ({ claim, activity })),
    { asked: true },
  );
  const speedTitles = await recipientSpeedTitles(env, activity);
  // The same 手气王 / 手气亡 as the public roster, row for row.
  const titles = drawPending(activity)
    ? noTitles()
    : await publicRecipientTitles(env, activity);
  return {
    items: page.map(({ claim, claimant }) => {
      const { afterClaimInfo: _privateNote, ...detail } =
        details.get(claim.id) ?? activityNotFound();
      const speedTitle = speedTitles.get(claim.id);
      return {
        ...detail,
        claimant,
        ...(speedTitle === undefined ? {} : { speedTitle }),
        ...luckTitle(titles, claim.id),
      };
    }),
    nextCursor: rows.length > 20 && last ? encodeCursor(last.claim) : null,
  };
}

export async function listPublicRecipients(
  env: ApiBindings,
  activityId: string,
  cursor?: string,
): Promise<PublicRecipientList> {
  const activity = await findActivity(env, activityId);
  // A draft too (05 §5): its roster is empty.
  if (!activity) activityNotFound();
  // Claims can be allocated while a timed draw settles; publish only its completed results.
  if (drawPending(activity))
    return { items: [], nextCursor: null, titles: noTitles() };
  // The roster is always public (06 §2), oldest first (06 §3).
  const titles = await publicRecipientTitles(env, activity);
  const speedTitles = await recipientSpeedTitles(env, activity);
  let after: Cursor | undefined;
  if (cursor) {
    try {
      after = parseCursor(
        await decryptString(atob(cursor), env, `recipients:${activityId}`),
      );
    } catch {
      invalidActivity("分页标识无效");
    }
  }
  const rows = await createDb(env.DB)
    .select({
      claim: claims,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      // The share each was given: a payment's amount is the same (a
      // trigger holds it), and a 🐟额红包 has no payment.
      amountMinor: rewardInventory.amountMinor,
    })
    .from(claims)
    .innerJoin(users, eq(users.id, claims.userId))
    // Joined by the whole key: by id alone each row read every 红包's
    // inventory (2026-10-25, most of D1's reads).
    .leftJoin(
      rewardInventory,
      and(
        eq(rewardInventory.activityId, claims.activityId),
        eq(rewardInventory.id, claims.inventoryId),
      ),
    )
    .where(and(eq(claims.activityId, activityId), afterCursor(after)))
    .orderBy(asc(claims.claimedAt), asc(claims.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  const attempts = await claimAttempts(
    env,
    activity,
    page.map(({ claim }) => claim.id),
  );
  return {
    titles,
    items: page.map(
      ({ claim, username, displayName, avatarUrl, amountMinor }) => ({
        id: claim.id,
        username,
        displayName,
        avatarUrl,
        ...(activity.rewardType === "ldc" && amountMinor !== null
          ? { amount: formatAmount(amountMinor) }
          : {}),
        claimedAt: new Date(claim.claimedAt).toISOString(),
        ...(speedTitles.has(claim.id)
          ? { speedTitle: speedTitles.get(claim.id) }
          : {}),
        ...luckTitle(titles, claim.id),
        ...(attempts.has(claim.id) ? { attempt: attempts.get(claim.id) } : {}),
        ...(claim.userId === activity.authorId ? { self: true as const } : {}),
      }),
    ),
    nextCursor:
      rows.length > 20 && last
        ? btoa(
            await encryptString(
              encodeCursor(last.claim),
              env,
              `recipients:${activityId}`,
            ),
          )
        : null,
  };
}

/** 代码判定: on which of each claimant's judged submissions they claimed. */
async function claimAttempts(
  env: ApiBindings,
  activity: ActivityRow,
  claimIds: string[],
) {
  if (activity.participationMode !== "code" || claimIds.length === 0)
    return new Map<string, number>();
  // Protocol 5: settled after their last judgment.
  const found = await env.DB.prepare(`SELECT e.claim_id AS claimId, j.attempt
    FROM attempt_events e JOIN code_judgments j ON j.submission_row_id = e.submission_row_id
    WHERE e.claim_id IN (SELECT value FROM json_each(?1))
    UNION ALL
    SELECT p.claim_id AS claimId, p.judged - 1 AS attempt FROM code_judge_people p
    WHERE p.activity_id = ?2 AND p.claim_id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(claimIds), activity.id)
    .all<{ claimId: string; attempt: number }>();
  return new Map(
    found.results.map((row) => [row.claimId, row.attempt + 1] as const),
  );
}

async function recipientSpeedTitles(
  env: ApiBindings,
  activity: ActivityRow,
): Promise<ClaimSpeedTitles> {
  if (
    activity.rewardType !== "ldc" ||
    activity.openedAt === null ||
    activity.drawState
  )
    return new Map();
  // 自领 takes no title but its own (docs/self-claim-design.md).
  const fastest = await env.DB.prepare(
    `SELECT MIN(claimed_at) AS claimedAt FROM claims WHERE activity_id=? AND claimed_at>=? AND user_id!=?`,
  )
    .bind(activity.id, activity.openedAt, activity.authorId)
    .first<{ claimedAt: number | null }>();
  if (fastest?.claimedAt === null || fastest?.claimedAt === undefined)
    return new Map();
  const elapsed = fastest.claimedAt - activity.openedAt;
  if (elapsed < 0) return new Map();
  const title = claimSpeedTitle(elapsed);
  const rows = await env.DB.prepare(
    `SELECT id FROM claims WHERE activity_id=? AND claimed_at=? AND user_id!=? ORDER BY id`,
  )
    .bind(activity.id, fastest.claimedAt, activity.authorId)
    .all<{ id: string }>();
  return new Map(rows.results.map((row) => [String(row.id), title] as const));
}

type LuckTitles = NonNullable<PublicRecipientList["titles"]>;

const noTitles = (): LuckTitles => ({
  highestClaimIds: [],
  lowestClaimIds: [],
});

/** A timed draw still drawing: its claims are not results yet. */
function drawPending(activity: ActivityRow) {
  return Boolean(
    activity.drawState &&
      activity.drawState !== "completed" &&
      activity.drawState !== "empty",
  );
}

/** One claim's 手气王 / 手气亡, from the whole roster's. */
function luckTitle(titles: LuckTitles, claimId: string) {
  return titles.highestClaimIds.includes(claimId)
    ? { title: "highest" as const }
    : titles.lowestClaimIds.includes(claimId)
      ? { title: "lowest" as const }
      : {};
}

async function publicRecipientTitles(
  env: ApiBindings,
  activity: ActivityRow,
): Promise<LuckTitles> {
  const empty = noTitles();
  if (activity.rewardType !== "ldc") return empty;
  // Among the others' claims: 自领 takes no title but its own
  // (docs/self-claim-design.md).
  const bounds =
    await env.DB.prepare(`SELECT COUNT(*) AS count,MIN(r.amount_minor) AS minimum,MAX(r.amount_minor) AS maximum
    FROM claims c JOIN reward_inventory r ON r.activity_id=c.activity_id AND r.id=c.inventory_id WHERE c.activity_id=? AND c.user_id!=?`)
      .bind(activity.id, activity.authorId)
      .first<{
        count: number;
        minimum: number | null;
        maximum: number | null;
      }>();
  if (
    !bounds ||
    bounds.count < 2 ||
    bounds.minimum === null ||
    bounds.maximum === null ||
    bounds.minimum === bounds.maximum
  )
    return empty;
  const [highest, lowest] = await env.DB.batch<{ id: string }>([
    env.DB.prepare(`SELECT c.id FROM claims c JOIN reward_inventory r ON r.activity_id=c.activity_id AND r.id=c.inventory_id
      WHERE c.activity_id=? AND c.user_id!=? AND r.amount_minor=? ORDER BY c.id LIMIT 3`).bind(
      activity.id,
      activity.authorId,
      bounds.maximum,
    ),
    env.DB.prepare(`SELECT c.id FROM claims c JOIN reward_inventory r ON r.activity_id=c.activity_id AND r.id=c.inventory_id
      WHERE c.activity_id=? AND c.user_id!=? AND r.amount_minor=? ORDER BY c.id LIMIT 3`).bind(
      activity.id,
      activity.authorId,
      bounds.minimum,
    ),
  ]);
  if (!highest || !lowest)
    throw new Error("Missing public recipient title query results");
  return {
    highestClaimIds:
      highest.results.length < 3
        ? highest.results.map((row) => String(row.id))
        : [],
    // Of two, the other one only came second: 手气亡 waits for a third
    // person (user's rule).
    lowestClaimIds:
      bounds.count >= 3 && lowest.results.length < 3
        ? lowest.results.map((row) => String(row.id))
        : [],
  };
}
