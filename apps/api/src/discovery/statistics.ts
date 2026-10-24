import type { ActivityStatistics } from "@hb/contracts";
import { attemptAssociatedData } from "../activities/claim-service";
import { ActivityError } from "../activities/errors";
import { ownedActivity, passwordAssociatedData } from "../activities/storage";
import type { ApiBindings } from "../env";
import { decryptString } from "../security/crypto";

type Aggregate = {
  digest: string;
  ciphertext: string;
  submissionRowId: string;
  attempts: number;
  uniqueUsers: number;
  matchedAttempts: number;
  matchedUsers: number;
  unmatchedAttempts: number;
  successfulClaims: number;
};

function parseCursor(cursor: string | undefined, activityId: string) {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(atob(cursor)) as {
      activityId: string;
      digest: string;
      attempts: number;
    };
    if (
      parsed.activityId !== activityId ||
      typeof parsed.digest !== "string" ||
      !Number.isSafeInteger(parsed.attempts) ||
      parsed.attempts < 1 ||
      !/^v1:[A-Za-z0-9_-]{43}$/.test(parsed.digest)
    )
      throw new Error("Invalid cursor");
    return parsed;
  } catch {
    throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
  }
}

export async function getStatistics(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  cursor?: string,
): Promise<ActivityStatistics> {
  const activity = await ownedActivity(env, activityId, authorId);
  // Every opened 口令红包 has them (07 §7), and every 代码判定红包.
  if (activity.participationMode === "direct" || activity.openedAt === null)
    throw new ActivityError(
      404,
      "STATISTICS_UNAVAILABLE",
      activity.participationMode === "direct"
        ? "无需口令的红包没有口令尝试"
        : "红包开放之后才有人提交口令",
    );
  const after = parseCursor(cursor, activityId);
  const [totals, groups, passwords] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS totalAttempts, COUNT(DISTINCT user_id) AS uniqueUsers,
      COALESCE(SUM(CASE WHEN matched = 1 THEN 1 ELSE 0 END), 0) AS matchedAttempts,
      COUNT(claim_id) AS successfulClaims FROM attempt_events WHERE activity_id = ?`).bind(
      activityId,
    ),
    env.DB.prepare(`WITH grouped AS (
        SELECT digest, MIN(id) AS representative, COUNT(*) AS attempts, COUNT(DISTINCT user_id) AS uniqueUsers,
          SUM(CASE WHEN matched = 1 THEN 1 ELSE 0 END) AS matchedAttempts,
          COUNT(DISTINCT CASE WHEN matched = 1 THEN user_id END) AS matchedUsers,
          SUM(CASE WHEN matched = 0 THEN 1 ELSE 0 END) AS unmatchedAttempts,
          COUNT(claim_id) AS successfulClaims
        FROM attempt_events WHERE activity_id = ? GROUP BY digest
      ) SELECT s.digest, e.ciphertext, e.submission_row_id AS submissionRowId,
      s.attempts, s.uniqueUsers, s.matchedAttempts, s.matchedUsers, s.unmatchedAttempts, s.successfulClaims
      FROM (
        SELECT * FROM grouped
        WHERE ? IS NULL OR attempts < ? OR (attempts = ? AND digest > ?)
        ORDER BY attempts DESC,digest LIMIT 21
      ) s JOIN attempt_events e ON e.id = s.representative ORDER BY s.attempts DESC,s.digest`).bind(
      activityId,
      after?.attempts ?? null,
      after?.attempts ?? null,
      after?.attempts ?? null,
      after?.digest ?? "",
    ),
    env.DB.prepare(`SELECT p.id, p.ciphertext,
      (SELECT COUNT(*) FROM claims c WHERE c.password_id = p.id) AS successfulClaims,
      (SELECT COUNT(*) FROM activity_registrations r WHERE r.password_id = p.id) AS registrations
      FROM activity_passwords p WHERE p.activity_id = ? ORDER BY p.position`).bind(
      activityId,
    ),
  ]);
  if (!totals || !groups || !passwords)
    throw new Error("Statistics snapshot is incomplete");
  const page = (groups.results as Aggregate[]).slice(0, 20);
  const last = page.at(-1);
  const summary = totals.results[0] as Pick<
    ActivityStatistics,
    "totalAttempts" | "uniqueUsers" | "matchedAttempts" | "successfulClaims"
  >;
  return {
    ...summary,
    ...(activity.drawState
      ? { registeredParticipants: activity.registeredCount }
      : {}),
    items: await Promise.all(
      page.map(
        async ({
          ciphertext,
          submissionRowId,
          digest: _digest,
          ...counts
        }) => ({
          password: await decryptString(
            ciphertext,
            env,
            attemptAssociatedData(activityId, submissionRowId),
          ),
          ...counts,
        }),
      ),
    ),
    validPasswords: await Promise.all(
      (
        passwords.results as {
          id: string;
          ciphertext: string;
          successfulClaims: number;
          registrations: number;
        }[]
      ).map(async (row) => ({
        password: await decryptString(
          row.ciphertext,
          env,
          passwordAssociatedData(activityId, row.id),
        ),
        successfulClaims: row.successfulClaims,
        registrations: row.registrations,
      })),
    ),
    nextCursor:
      groups.results.length > 20 && last
        ? btoa(
            JSON.stringify({
              activityId,
              attempts: last.attempts,
              digest: last.digest,
            }),
          )
        : null,
  };
}
