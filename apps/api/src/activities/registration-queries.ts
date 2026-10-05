import type {
  AuthorRegistrationList,
  ParticipationList,
  RegistrationDetail,
} from "@hb/contracts";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { createDb } from "../db/client";
import { activities, activityRegistrations, claims, users } from "../db/schema";
import type { ApiBindings } from "../env";
import {
  findUserClaim,
  getClaimDetail,
  projectClaimSummary,
} from "./claim-queries";
import {
  findRegistration,
  type RegistrationRow,
  registrationStatus,
} from "./draw-storage";
import { activityNotFound, invalidActivity } from "./errors";
import { activityStatus } from "./service";
import { type ActivityRow, findActivity, ownedActivity } from "./storage";

type Cursor = { time: number; id: string };
function cursor(value?: string): Cursor | undefined {
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

async function detail(
  env: ApiBindings,
  entry: RegistrationRow,
  activity: ActivityRow,
): Promise<RegistrationDetail> {
  const claim =
    activity.drawState === "completed"
      ? await findUserClaim(env, activity.id, entry.userId)
      : undefined;
  return {
    id: entry.id,
    activity: {
      id: activity.id,
      title: activity.title,
      status: activityStatus(activity),
    },
    registeredAt: new Date(entry.registeredAt).toISOString(),
    status: registrationStatus(activity, Boolean(claim)),
    drawAt:
      activity.drawClosedAt === null
        ? activity.deadline === null
          ? null
          : new Date(activity.deadline).toISOString()
        : new Date(activity.drawClosedAt).toISOString(),
    claim: claim ? await getClaimDetail(env, claim.id, entry.userId) : null,
  };
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
      ),
    )
    .get();
  if (!row || row.activity.deletedAt !== null) activityNotFound();
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

export async function listAuthorRegistrations(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  cursorValue?: string,
): Promise<AuthorRegistrationList> {
  const activity = await ownedActivity(env, activityId, authorId);
  const before = cursor(cursorValue);
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
        before
          ? or(
              lt(activityRegistrations.registeredAt, before.time),
              and(
                eq(activityRegistrations.registeredAt, before.time),
                lt(activityRegistrations.id, before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(activityRegistrations.registeredAt),
      desc(activityRegistrations.id),
    )
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1)?.entry;
  return {
    items: await Promise.all(
      page.map(async ({ entry, participant }) => ({
        ...(await detail(env, entry, activity)),
        participant,
      })),
    ),
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
): Promise<ParticipationList> {
  const before = cursor(cursorValue);
  const rows = await env.DB.prepare(`SELECT kind,id,time FROM (
    SELECT 'registration' AS kind,r.id,r.registered_at AS time FROM activity_registrations r JOIN activities a ON a.id=r.activity_id WHERE r.user_id=? AND a.deleted_at IS NULL
    UNION ALL
    SELECT 'claim' AS kind,c.id,c.claimed_at AS time FROM claims c JOIN activities a ON a.id=c.activity_id WHERE c.user_id=? AND a.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM activity_registrations r WHERE r.activity_id=c.activity_id AND r.user_id=c.user_id)
    ) WHERE ? IS NULL OR time<? OR (time=? AND id<?) ORDER BY time DESC,id DESC LIMIT 21`)
    .bind(
      userId,
      userId,
      before?.time ?? null,
      before?.time ?? null,
      before?.time ?? null,
      before?.id ?? "",
    )
    .all<{ kind: "claim" | "registration"; id: string; time: number }>();
  const page = rows.results.slice(0, 20);
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
            isNull(activities.deletedAt),
          ),
        )
    : [];
  const summaries = new Map(
    ordinaryClaims.map(({ claim, activity }) => [
      claim.id,
      projectClaimSummary(claim, activity),
    ]),
  );
  return {
    items: await Promise.all(
      page.map(async (row) =>
        row.kind === "registration"
          ? {
              kind: "registration" as const,
              registration: await getRegistrationDetail(env, row.id, userId),
            }
          : {
              kind: "claim" as const,
              claim: summaries.get(row.id) ?? activityNotFound(),
            },
      ),
    ),
    nextCursor:
      rows.results.length > 20 && last
        ? btoa(JSON.stringify({ time: last.time, id: last.id }))
        : null,
  };
}
