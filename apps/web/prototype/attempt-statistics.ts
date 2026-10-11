import type { Identity } from "./types";

export type AttemptStatisticsRow = {
  password: string;
  attempts: number;
  uniqueUsers: number;
  matchedAttempts: number;
  unmatchedAttempts: number;
  successfulClaims: number;
};

export type ActivityAttemptStatistics = {
  totalAttempts: number;
  uniqueUsers: number;
  successfulClaims: number;
  items: AttemptStatisticsRow[];
  validPasswords: { password: string; successfulClaims: number }[];
};

type AttemptEvent = {
  activityId: string;
  identity: Identity;
  password: string;
  matched: boolean;
  successfulClaim: boolean;
};

const attempts = new Map<string, AttemptEvent[]>();

const fixtureRows: Record<string, AttemptEvent[]> = {
  "20000000-0000-4000-8000-000000000001": [
    {
      activityId: "20000000-0000-4000-8000-000000000001",
      identity: "standard",
      password: "作者活动01口令",
      matched: true,
      successfulClaim: true,
    },
    {
      activityId: "20000000-0000-4000-8000-000000000001",
      identity: "standard",
      password: "错误口令2026",
      matched: false,
      successfulClaim: false,
    },
    {
      activityId: "20000000-0000-4000-8000-000000000001",
      identity: "standard",
      password: "错误口令2026",
      matched: false,
      successfulClaim: false,
    },
  ],
};

function eventsFor(identity: Identity, activityId: string) {
  const key = `${identity}:${activityId}`;
  const current = attempts.get(key);
  if (current) return current;
  const seeded = (fixtureRows[activityId] ?? []).map((event) => ({
    ...event,
    identity,
  }));
  attempts.set(key, seeded);
  return seeded;
}

export function recordAttempt(
  identity: Identity,
  activityId: string,
  password: string,
  result: { matched: boolean; successfulClaim: boolean },
) {
  if (identity === "guest" || !password) return;
  const key = `${identity}:${activityId}`;
  const event: AttemptEvent = {
    activityId,
    identity,
    password,
    ...result,
  };
  attempts.set(key, [...eventsFor(identity, activityId), event]);
}

export function markAttemptSuccessful(
  identity: Identity,
  activityId: string,
  password: string,
) {
  const key = `${identity}:${activityId}`;
  const events = [...eventsFor(identity, activityId)];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.password === password &&
      event.matched &&
      !event.successfulClaim
    ) {
      events[index] = { ...event, successfulClaim: true };
      attempts.set(key, events);
      return;
    }
  }
}

export function getAttemptStatistics(
  identity: Identity,
  activityId: string,
): ActivityAttemptStatistics {
  const events = eventsFor(identity, activityId);
  const grouped = new Map<string, AttemptEvent[]>();
  for (const event of events) {
    const current = grouped.get(event.password) ?? [];
    current.push(event);
    grouped.set(event.password, current);
  }
  const items = [...grouped.entries()]
    .map(([password, rows]) => ({
      password,
      attempts: rows.length,
      uniqueUsers: new Set(rows.map((row) => row.identity)).size,
      matchedAttempts: rows.filter((row) => row.matched).length,
      unmatchedAttempts: rows.filter((row) => !row.matched).length,
      successfulClaims: rows.filter((row) => row.successfulClaim).length,
    }))
    .sort(
      (left, right) =>
        right.attempts - left.attempts ||
        left.password.localeCompare(right.password),
    );
  return {
    totalAttempts: events.length,
    uniqueUsers: new Set(events.map((event) => event.identity)).size,
    successfulClaims: events.filter((event) => event.successfulClaim).length,
    items,
    validPasswords: items
      .filter((item) => item.matchedAttempts > 0)
      .map(({ password, successfulClaims }) => ({
        password,
        successfulClaims,
      })),
  };
}

export function resetAttemptStatistics() {
  attempts.clear();
}
