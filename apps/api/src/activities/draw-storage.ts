import type {
  DrawSummary,
  LdcActivityInput,
  RegistrationStatus,
  TimedDrawMoney,
} from "@hb/contracts";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { activityRegistrations } from "../db/schema";
import type { ApiBindings } from "../env";
import type { ActivityRow } from "./storage";

export type RegistrationRow = typeof activityRegistrations.$inferSelect;

export function timedDrawMoney(row: ActivityRow): TimedDrawMoney | null {
  if (row.rewardType !== "ldc") return null;
  const money = (JSON.parse(row.config) as LdcActivityInput).money;
  return money.mode === "timed_draw" ? money : null;
}

export function drawSummary(
  row: ActivityRow,
  exact = true,
): DrawSummary | undefined {
  const money = timedDrawMoney(row);
  if (!money) return undefined;
  const state = row.drawState ?? "waiting";
  return {
    state:
      state === "waiting" && row.deadline !== null && row.deadline <= Date.now()
        ? "settling"
        : state,
    deadlineAt:
      row.deadline === null ? null : new Date(row.deadline).toISOString(),
    closedAt:
      row.drawClosedAt === null
        ? null
        : new Date(row.drawClosedAt).toISOString(),
    reason: row.drawReason,
    registeredCount: exact ? row.registeredCount : null,
    winnerCount:
      exact && (state === "completed" || state === "empty")
        ? row.claimedCount
        : null,
    ...(exact ? { participantLimit: money.participantLimit } : {}),
  };
}

export async function findRegistration(
  env: ApiBindings,
  activityId: string,
  userId: string,
) {
  return createDb(env.DB)
    .select()
    .from(activityRegistrations)
    .where(
      and(
        eq(activityRegistrations.activityId, activityId),
        eq(activityRegistrations.userId, userId),
      ),
    )
    .get();
}

export function registrationStatus(
  row: ActivityRow,
  hasClaim: boolean,
): RegistrationStatus {
  if (row.drawState === "completed" || row.drawState === "empty")
    return hasClaim ? "won" : "not_won";
  return row.drawState === "settling" ||
    (row.deadline !== null && row.deadline <= Date.now())
    ? "drawing"
    : "registered";
}
