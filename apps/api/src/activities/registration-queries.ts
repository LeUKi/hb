import {
  type AccountHistorySummary,
  type ActivityHistoryFilters,
  type ActivityInput,
  type ActivityParticipationResponse,
  type ActivityStatus,
  type AuthorRegistrationList,
  type ClaimDetail,
  formatAmount,
  type ParticipationList,
  type PublicRegistrationList,
  type RegistrationDetail,
} from "@hb/contracts";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { activities, activityRegistrations, claims, users } from "../db/schema";
import type { ApiBindings } from "../env";
import { ownStanding } from "../judge/ledger";
import { decryptString, encryptString } from "../security/crypto";
import {
  claimDetailsBatch,
  claimSummariesBatch,
  findUserClaim,
  sourcePasswordsBatch,
} from "./claim-queries";
import {
  findRegistration,
  type RegistrationRow,
  registrationStatus,
} from "./draw-storage";
import { activityNotFound, invalidActivity } from "./errors";
import {
  activityListFields,
  activityListStatusSql,
  historyStatusCounts,
  historyStatusFilterSql,
  historyStatusTotal,
  rewardFilterSql,
} from "./history-query";
import { activityStatus, rewardSummary } from "./service";
import { type ActivityRow, findActivity, ownedActivity } from "./storage";

type Cursor = { time: number; id: string; scope?: string };
function cursor(value?: string, scope?: string): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(atob(value)) as Cursor;
    if (
      !Number.isSafeInteger(parsed.time) ||
      typeof parsed.id !== "string" ||
      (scope !== undefined &&
        parsed.scope !== undefined &&
        parsed.scope !== scope) ||
      !/^[a-f0-9-]{36}$/i.test(parsed.id)
    )
      invalidActivity("分页标识无效");
    return parsed;
  } catch {
    invalidActivity("分页标识无效");
  }
}

async function detail(
  env: ApiBindings,
  entry: RegistrationRow,
  activity: ActivityRow,
): Promise<RegistrationDetail> {
  return (
    (await registrationDetailsBatch(env, [{ entry, activity }])).get(
      entry.id,
    ) ?? activityNotFound()
  );
}

async function registrationDetailsBatch(
  env: ApiBindings,
  rows: { entry: RegistrationRow; activity: ActivityRow }[],
  knownClaimsByParticipation: Map<string, ClaimDetail | null> = new Map(),
): Promise<Map<string, RegistrationDetail>> {
  if (!rows.length) return new Map();
  const completed = rows.filter(
    ({ entry, activity }) =>
      activity.drawState === "completed" &&
      !knownClaimsByParticipation.has(`${entry.activityId}:${entry.userId}`),
  );
  const [sources, winnings] = await Promise.all([
    sourcePasswordsBatch(
      env,
      rows.map(({ entry }) => entry),
    ),
    completed.length
      ? createDb(env.DB)
          .select({ claim: claims, activity: activities })
          .from(claims)
          .innerJoin(activities, eq(activities.id, claims.activityId))
          .where(
            and(
              isNull(activities.deletedAt),
              eq(activities.rewardType, "ldc"),
              or(
                ...completed.map(({ entry }) =>
                  and(
                    eq(claims.activityId, entry.activityId),
                    eq(claims.userId, entry.userId),
                  ),
                ),
              ),
            ),
          )
      : Promise.resolve([]),
  ]);
  const details = await claimDetailsBatch(env, winnings);
  const byParticipation = new Map<string, ClaimDetail | null | undefined>(
    knownClaimsByParticipation,
  );
  for (const { claim } of winnings) {
    byParticipation.set(
      `${claim.activityId}:${claim.userId}`,
      details.get(claim.id),
    );
  }
  return new Map(
    rows.map(({ entry, activity }) => {
      const participationKey = `${activity.id}:${entry.userId}`;
      const claim = byParticipation.has(participationKey)
        ? (byParticipation.get(participationKey) ?? null)
        : null;
      const sourcePassword =
        entry.passwordId === null ? undefined : sources.get(entry.passwordId);
      return [
        entry.id,
        {
          id: entry.id,
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
              (JSON.parse(activity.config) as ActivityInput)
                .quantityVisibility === "exact",
            ),
          },
          registeredAt: new Date(entry.registeredAt).toISOString(),
          status: registrationStatus(activity, Boolean(claim)),
          drawAt:
            activity.drawClosedAt === null
              ? activity.deadline === null
                ? null
                : new Date(activity.deadline).toISOString()
              : new Date(activity.drawClosedAt).toISOString(),
          claim,
          ...(sourcePassword === undefined ? {} : { sourcePassword }),
        },
      ];
    }),
  );
}

export async function getRegistrationDetail(
  env: ApiBindings,
  id: string,
  userId: string,
): Promise<RegistrationDetail> {
  const row = await createDb(env.DB)
    .select({ entry: activityRegistrations, activity: activities })
    .from(activityRegistrations)
    .innerJoin(activities, eq(activities.id, activityRegistrations.activityId))
    .where(
      and(
        eq(activityRegistrations.id, id),
        eq(activityRegistrations.userId, userId),
        eq(activities.rewardType, "ldc"),
        isNull(activities.deletedAt),
      ),
    )
    .get();
  if (!row) activityNotFound();
  return detail(env, row.entry, row.activity);
}

export async function getCurrentRegistration(
  env: ApiBindings,
  activityId: string,
  userId: string,
) {
  const activity = await findActivity(env, activityId);
  if (!activity || (activity.openedAt === null && activity.authorId !== userId))
    activityNotFound();
  const entry = await findRegistration(env, activityId, userId);
  return entry ? detail(env, entry, activity) : null;
}

export async function getCurrentParticipationForActivity(
  env: ApiBindings,
  activity: ActivityRow,
  userId: string,
): Promise<ActivityParticipationResponse> {
  const [claim, registration, standing] = await Promise.all([
    findUserClaim(env, activity.id, userId),
    findRegistration(env, activity.id, userId),
    // Protocol 5: their own part (docs/multi-prize-design.md §4.1).
    activity.participationMode === "code"
      ? ownStanding(env, activity.id, userId)
      : null,
  ]);
  const claimDetails = claim
    ? await claimDetailsBatch(env, [{ claim, activity }])
    : new Map<string, ClaimDetail>();
  const knownClaimsByParticipation = new Map<string, ClaimDetail | null>();
  const claimDetail = claim
    ? (claimDetails.get(claim.id) ?? activityNotFound())
    : null;
  if (activity.drawState === "completed")
    knownClaimsByParticipation.set(`${activity.id}:${userId}`, claimDetail);
  const registrationDetails = registration
    ? await registrationDetailsBatch(
        env,
        [{ entry: registration, activity }],
        knownClaimsByParticipation,
      )
    : new Map<string, RegistrationDetail>();

  return {
    claim: claimDetail,
    registration: registration
      ? (registrationDetails.get(registration.id) ?? activityNotFound())
      : null,
    ...(standing ? { standing } : {}),
  };
}

export async function getCurrentParticipation(
  env: ApiBindings,
  activityId: string,
  userId: string,
): Promise<ActivityParticipationResponse> {
  const activity = await findActivity(env, activityId);
  if (!activity || (activity.openedAt === null && activity.authorId !== userId))
    activityNotFound();
  return getCurrentParticipationForActivity(env, activity, userId);
}

export async function listAuthorRegistrations(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  cursorValue?: string,
): Promise<AuthorRegistrationList> {
  const activity = await ownedActivity(env, activityId, authorId);
  // Oldest first, like the public roster it adds to (redesign 06 §3).
  const after = cursor(cursorValue);
  const rows = await createDb(env.DB)
    .select({
      entry: activityRegistrations,
      participant: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(activityRegistrations)
    .innerJoin(users, eq(users.id, activityRegistrations.userId))
    .where(
      and(
        eq(activityRegistrations.activityId, activityId),
        after
          ? or(
              gt(activityRegistrations.registeredAt, after.time),
              and(
                eq(activityRegistrations.registeredAt, after.time),
                gt(activityRegistrations.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      asc(activityRegistrations.registeredAt),
      asc(activityRegistrations.id),
    )
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1)?.entry;
  const details = await registrationDetailsBatch(
    env,
    page.map(({ entry }) => ({ entry, activity })),
  );
  return {
    items: page.map(({ entry, participant }) => ({
      ...(details.get(entry.id) ?? activityNotFound()),
      participant,
    })),
    nextCursor:
      rows.length > 20 && last
        ? btoa(JSON.stringify({ time: last.registeredAt, id: last.id }))
        : null,
  };
}

/** A timed winner is listed once as their participation, never as a second history row. */
export async function listParticipations(
  env: ApiBindings,
  userId: string,
  cursorValue?: string,
  filters: ActivityHistoryFilters = {},
): Promise<ParticipationList> {
  const db = createDb(env.DB);
  const state = activityListStatusSql();
  const type = filters.type ?? "all";
  const status = filters.status ?? "all";
  const scope = `participations:${userId}:${type}:${status}`;
  const before = cursor(cursorValue, scope);
  const history = sql`(
    SELECT 'registration' AS kind,r.id,r.activity_id,r.registered_at AS time FROM activity_registrations r WHERE r.user_id=${userId}
    UNION ALL
    SELECT 'claim' AS kind,c.id,c.activity_id,c.claimed_at AS time FROM claims c WHERE c.user_id=${userId}
      AND NOT EXISTS(SELECT 1 FROM activity_registrations r WHERE r.activity_id=c.activity_id AND r.user_id=c.user_id)
    ) h JOIN ${activities} ON ${activities.id}=h.activity_id`;
  const base = and(isNull(activities.deletedAt), rewardFilterSql(type));
  const counts = await db.all<{ status: ActivityStatus; count: number }>(
    sql`SELECT ${state} AS status,COUNT(*) AS count FROM ${history} WHERE ${base} GROUP BY ${state}`,
  );
  const statusCounts = historyStatusCounts(counts);
  const rows = await db.all<{
    kind: "claim" | "registration";
    id: string;
    time: number;
  }>(
    sql`SELECT h.kind,h.id,h.time FROM ${history} WHERE ${and(base, historyStatusFilterSql(state, status), before ? sql`(h.time<${before.time} OR (h.time=${before.time} AND h.id<${before.id}))` : undefined)} ORDER BY h.time DESC,h.id DESC LIMIT 21`,
  );
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  const claimIds = page
    .filter((row) => row.kind === "claim")
    .map((row) => row.id);
  const ordinaryClaims = claimIds.length
    ? await createDb(env.DB)
        .select({ claim: claims, activity: activities })
        .from(claims)
        .innerJoin(activities, eq(activities.id, claims.activityId))
        .where(
          and(
            inArray(claims.id, claimIds),
            eq(claims.userId, userId),
            eq(activities.rewardType, "ldc"),
            isNull(activities.deletedAt),
          ),
        )
    : [];
  const registrationIds = page
    .filter((row) => row.kind === "registration")
    .map((row) => row.id);
  const registrations = registrationIds.length
    ? await db
        .select({ entry: activityRegistrations, activity: activities })
        .from(activityRegistrations)
        .innerJoin(
          activities,
          eq(activities.id, activityRegistrations.activityId),
        )
        .where(
          and(
            inArray(activityRegistrations.id, registrationIds),
            eq(activityRegistrations.userId, userId),
            eq(activities.rewardType, "ldc"),
            isNull(activities.deletedAt),
          ),
        )
    : [];
  const [summaries, registrationDetails] = await Promise.all([
    claimSummariesBatch(env, ordinaryClaims),
    registrationDetailsBatch(env, registrations),
  ]);
  const historyActivities = new Map([
    ...ordinaryClaims.map(
      ({ claim, activity }) => [claim.id, activity] as const,
    ),
    ...registrations.map(
      ({ entry, activity }) => [entry.id, activity] as const,
    ),
  ]);
  const authorIds = [
    ...new Set(
      [...historyActivities.values()].map((activity) => activity.authorId),
    ),
  ];
  const authors = authorIds.length
    ? await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
        })
        .from(users)
        .where(inArray(users.id, authorIds))
    : [];
  const byAuthor = new Map(authors.map((author) => [author.id, author]));
  return {
    total: historyStatusTotal(statusCounts, status),
    statusCounts,
    items: page.map((row) => {
      const activity = historyActivities.get(row.id) ?? activityNotFound();
      const exact =
        (JSON.parse(activity.config) as ActivityInput).quantityVisibility ===
        "exact";
      const activityFields = {
        ...activityListFields(activity, activityStatus(activity), exact),
        createdAt: new Date(activity.createdAt).toISOString(),
        author: byAuthor.get(activity.authorId) ?? activityNotFound(),
      };
      if (row.kind === "registration") {
        const registration =
          registrationDetails.get(row.id) ?? activityNotFound();
        return {
          kind: "registration" as const,
          registration: {
            ...registration,
            activity: {
              ...registration.activity,
              ...activityFields,
            },
          },
        };
      }
      const claim = summaries.get(row.id) ?? activityNotFound();
      return {
        kind: "claim" as const,
        claim: {
          ...claim,
          activity: {
            ...claim.activity,
            ...activityFields,
          },
        },
      };
    }),
    nextCursor:
      rows.length > 20 && last
        ? btoa(JSON.stringify({ time: last.time, id: last.id, scope }))
        : null,
  };
}

/**
 * What a claim was worth, in cents: every claim (a draw's prizes are claims
 * too), whatever the payment's progress (redesign 06 §9). /me and the 排行榜
 * add them up the same way.
 */
export const claimAmount = `COALESCE(p.amount_minor, i.amount_minor, 0)`;
export const claimJoins = `FROM claims c JOIN activities a ON a.id=c.activity_id
      LEFT JOIN payment_tasks p ON p.claim_id=c.id AND p.source='claim'
      LEFT JOIN reward_inventory i ON i.activity_id=c.activity_id AND i.id=c.inventory_id AND i.kind='ldc'`;
/** 自领 (docs/self-claim-design.md) counts in neither sum, nor the 排行榜. */
export const othersOnly = "c.user_id!=a.author_id";

export async function accountHistorySummary(
  env: ApiBindings,
  userId: string,
): Promise<AccountHistorySummary> {
  const result = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM activities WHERE author_id=? AND reward_type='ldc' AND deleted_at IS NULL) AS initiatedCount,
    (SELECT COUNT(*) FROM activities a WHERE a.reward_type='ldc' AND a.deleted_at IS NULL AND (
      EXISTS(SELECT 1 FROM claims c WHERE c.activity_id=a.id AND c.user_id=?)
      OR EXISTS(SELECT 1 FROM activity_registrations r WHERE r.activity_id=a.id AND r.user_id=?)
    )) AS participatedCount,
    (SELECT COALESCE(SUM(${claimAmount}),0) ${claimJoins}
      WHERE a.author_id=? AND a.reward_type='ldc' AND a.deleted_at IS NULL AND ${othersOnly}) AS sentMinor,
    (SELECT COALESCE(SUM(${claimAmount}),0) ${claimJoins}
      WHERE c.user_id=? AND a.reward_type='ldc' AND a.deleted_at IS NULL AND ${othersOnly}) AS receivedMinor`)
    .bind(userId, userId, userId, userId, userId)
    .first<{
      initiatedCount: number;
      participatedCount: number;
      sentMinor: number;
      receivedMinor: number;
    }>();
  return {
    initiatedCount: result?.initiatedCount ?? 0,
    participatedCount: result?.participatedCount ?? 0,
    sentAmount: formatAmount(result?.sentMinor ?? 0),
    receivedAmount: formatAmount(result?.receivedMinor ?? 0),
  };
}

export async function listPublicRegistrations(
  env: ApiBindings,
  activityId: string,
  cursorValue?: string,
): Promise<PublicRegistrationList> {
  const activity = await findActivity(env, activityId);
  // A draft too (05 §5): its roster is empty.
  if (!activity) activityNotFound();
  // The roster is always public (06 §2), oldest first (06 §3).
  let after: Cursor | undefined;
  if (cursorValue) {
    try {
      after = cursor(
        await decryptString(
          atob(cursorValue),
          env,
          `registrations:${activityId}`,
        ),
      );
    } catch {
      invalidActivity("分页标识无效");
    }
  }
  const rows = await createDb(env.DB)
    .select({
      entry: activityRegistrations,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(activityRegistrations)
    .innerJoin(users, eq(users.id, activityRegistrations.userId))
    .where(
      and(
        eq(activityRegistrations.activityId, activityId),
        after
          ? or(
              gt(activityRegistrations.registeredAt, after.time),
              and(
                eq(activityRegistrations.registeredAt, after.time),
                gt(activityRegistrations.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      asc(activityRegistrations.registeredAt),
      asc(activityRegistrations.id),
    )
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1)?.entry;
  return {
    items: page.map(({ entry, username, displayName, avatarUrl }) => ({
      id: entry.id,
      username,
      displayName,
      avatarUrl,
      registeredAt: new Date(entry.registeredAt).toISOString(),
    })),
    nextCursor:
      rows.length > 20 && last
        ? btoa(
            await encryptString(
              btoa(JSON.stringify({ time: last.registeredAt, id: last.id })),
              env,
              `registrations:${activityId}`,
            ),
          )
        : null,
  };
}
