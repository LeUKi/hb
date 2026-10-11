import {
  getSampleRecipients,
  type RandomRosterCase,
  type RecipientExample,
  recipientExamples,
} from "./fixtures";
import type { Activity } from "./types";

const newClaims = new Map<string, RecipientExample[]>();
export type ClaimRosterSnapshot = [string, RecipientExample[]][];

export function exportClaimRosterSnapshot(): ClaimRosterSnapshot {
  return structuredClone([...newClaims.entries()]);
}

export function importClaimRosterSnapshot(
  snapshot: ClaimRosterSnapshot | undefined,
) {
  if (!snapshot) return;
  newClaims.clear();
  for (const [activityId, claims] of structuredClone(snapshot))
    newClaims.set(activityId, claims);
}

/** Public local facts survive viewer changes, just like the draw registry. */
export function publicClaimRoster(
  activity: Activity,
  rosterCase?: RandomRosterCase,
): RecipientExample[] {
  const published = getSampleRecipients(activity.id, rosterCase);
  const seeded = published
    ? published.filter(
        (row) => activity.id !== "random" || row.username !== "linjian",
      )
    : recipientExamples
        .slice(0, Math.max(0, activity.count - activity.remaining))
        .map((row, index) => ({
          ...row,
          amount:
            activity.type === "text"
              ? undefined
              : (activity.publishedRecipientAmounts?.[index] ??
                (activity.rewardMode === "instant_random" ||
                activity.rewardMode === "custom"
                  ? undefined
                  : activity.amount)),
        }));
  const rows = new Map(
    seeded.map((row) => [
      row.username,
      { ...row, id: `${activity.id}:claim:${row.username}` },
    ]),
  );
  for (const claim of newClaims.get(activity.id) ?? [])
    rows.set(claim.username, {
      ...claim,
      // Selecting a fixture changes its fixed distribution, not its record time.
      amount:
        (activity.id === "random" || activity.id === "random-ended") &&
        rosterCase
          ? (published?.find((row) => row.username === claim.username)
              ?.amount ?? claim.amount)
          : claim.amount,
      id: `${activity.id}:claim:${claim.username}`,
    });
  return [...rows.values()];
}

export function recordInstantClaim(
  activity: Activity,
  amount?: string,
  rosterCase?: RandomRosterCase,
) {
  const previous = publicClaimRoster(activity, rosterCase).find(
    (row) => row.username === "linjian",
  );
  if (previous) return previous;
  const row: RecipientExample = {
    id: `${activity.id}:claim:linjian`,
    name: "林间",
    username: "linjian",
    color: "sand",
    time: new Date().toISOString(),
    amount,
  };
  newClaims.set(activity.id, [...(newClaims.get(activity.id) ?? []), row]);
  return row;
}
