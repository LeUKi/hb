import {
  type ActivityInput,
  type AuthorClaimList,
  type ClaimDetail,
  type ClaimList,
  type ClaimSummary,
  claimSpeedTitle,
  formatAmount,
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
  const [sources, payments] = await Promise.all([
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
  ]);
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
      if (!payment) throw new Error("LDC claim has no payment task");
      const resendUntil = resendDeadline(
        payment,
        rejections.get(payment.id),
        now,
      );
      const resumeAt = queued(payment.status)
        ? held.get(payment.merchantId)
        : undefined;
      const sourcePassword =
        claim.passwordId === null ? undefined : sources.get(claim.passwordId);
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

export async function claimDetailsBatch(
  env: ApiBindings,
  rows: ClaimActivityRow[],
): Promise<Map<string, ClaimDetail>> {
  const summaries = await claimSummariesBatch(env, rows);
  const entries = await Promise.all(
    rows.map(
      async ({ claim, activity }): Promise<readonly [string, ClaimDetail]> => {
        const base = summaries.get(claim.id) ?? activityNotFound();
        const afterClaimInfo = (JSON.parse(activity.config) as ActivityInput)
          .afterClaimInfo;
        if (activity.rewardType !== "ldc") activityNotFound();
        if (!base.payment || base.amount === undefined)
          throw new Error("LDC claim has no payment task");
        return [
          claim.id,
          {
            ...base,
            afterClaimInfo,
            rewardType: "ldc",
            amount: base.amount,
            payment: base.payment,
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
  if (!activity || (activity.openedAt === null && activity.authorId !== userId))
    activityNotFound();
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
  viewerId?: string,
  cursor?: string,
): Promise<PublicRecipientList> {
  const activity = await findActivity(env, activityId);
  if (
    !activity ||
    (activity.openedAt === null && activity.authorId !== viewerId)
  )
    activityNotFound();
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
      amountMinor: paymentTasks.amountMinor,
    })
    .from(claims)
    .innerJoin(users, eq(users.id, claims.userId))
    .leftJoin(paymentTasks, eq(paymentTasks.claimId, claims.id))
    .where(and(eq(claims.activityId, activityId), afterCursor(after)))
    .orderBy(asc(claims.claimedAt), asc(claims.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
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
  const fastest = await env.DB.prepare(
    `SELECT MIN(claimed_at) AS claimedAt FROM claims WHERE activity_id=? AND claimed_at>=?`,
  )
    .bind(activity.id, activity.openedAt)
    .first<{ claimedAt: number | null }>();
  if (fastest?.claimedAt === null || fastest?.claimedAt === undefined)
    return new Map();
  const elapsed = fastest.claimedAt - activity.openedAt;
  if (elapsed < 0) return new Map();
  const title = claimSpeedTitle(elapsed);
  const rows = await env.DB.prepare(
    `SELECT id FROM claims WHERE activity_id=? AND claimed_at=? ORDER BY id`,
  )
    .bind(activity.id, fastest.claimedAt)
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
  const bounds =
    await env.DB.prepare(`SELECT COUNT(*) AS count,MIN(p.amount_minor) AS minimum,MAX(p.amount_minor) AS maximum
    FROM claims c JOIN payment_tasks p ON p.claim_id=c.id AND p.source='claim' WHERE c.activity_id=?`)
      .bind(activity.id)
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
    env.DB.prepare(`SELECT c.id FROM claims c JOIN payment_tasks p ON p.claim_id=c.id AND p.source='claim'
      WHERE c.activity_id=? AND p.amount_minor=? ORDER BY c.id LIMIT 3`).bind(
      activity.id,
      bounds.maximum,
    ),
    env.DB.prepare(`SELECT c.id FROM claims c JOIN payment_tasks p ON p.claim_id=c.id AND p.source='claim'
      WHERE c.activity_id=? AND p.amount_minor=? ORDER BY c.id LIMIT 3`).bind(
      activity.id,
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
