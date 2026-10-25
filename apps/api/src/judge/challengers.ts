// 参与名单 · 挑战 (docs/redesign/05-hongbao.md §7): everyone a 代码判定红包's
// code has judged, the latest judged first, with how many times, when last
// and whether they took a share. Public like the 名单; never what anyone
// typed or what the code said to them (its replies may give hints away).
import type { JudgeChallengerList } from "@hb/contracts";
import { activityNotFound } from "../activities/errors";
import { findActivity } from "../activities/storage";
import type { ApiBindings } from "../env";

export const CHALLENGERS_PAGE = 20;

/** Past this one: its latest judgment's time, then its user id. */
export type ChallengerCursor = { at: number; userId: string };

export function readChallengerCursor(value: string): ChallengerCursor | null {
  const match = /^(\d{1,15}):([0-9a-f-]{36})$/.exec(value);
  return match?.[1] && match[2]
    ? { at: Number(match[1]), userId: match[2] }
    : null;
}

export async function listChallengers(
  env: ApiBindings,
  activityId: string,
  after: ChallengerCursor | null,
): Promise<JudgeChallengerList> {
  const activity = await findActivity(env, activityId);
  if (
    !activity ||
    activity.openedAt === null ||
    activity.participationMode !== "code"
  )
    activityNotFound();
  const [found, total] = await Promise.all([
    env.DB.prepare(`SELECT j.user_id AS userId, COUNT(*) AS judged, MAX(j.judged_at) AS lastAt,
        MAX(j.ok) AS claimed, u.username, u.display_name AS displayName, u.avatar_url AS avatarUrl
      FROM code_judgments j JOIN users u ON u.id = j.user_id
      WHERE j.activity_id = ?1
      GROUP BY j.user_id
      HAVING ?2 IS NULL OR MAX(j.judged_at) < ?2 OR (MAX(j.judged_at) = ?2 AND j.user_id < ?3)
      ORDER BY lastAt DESC, j.user_id DESC
      LIMIT ?4`)
      .bind(
        activityId,
        after?.at ?? null,
        after?.userId ?? null,
        CHALLENGERS_PAGE + 1,
      )
      .all<{
        userId: string;
        judged: number;
        lastAt: number;
        claimed: number;
        username: string;
        displayName: string;
        avatarUrl: string | null;
      }>(),
    env.DB.prepare(
      "SELECT COUNT(DISTINCT user_id) AS count FROM code_judgments WHERE activity_id = ?",
    )
      .bind(activityId)
      .first<number>("count"),
  ]);
  const rows = found.results.slice(0, CHALLENGERS_PAGE);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => ({
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      judged: row.judged,
      lastAt: new Date(row.lastAt).toISOString(),
      claimed: row.claimed === 1,
    })),
    total: total ?? 0,
    nextCursor:
      found.results.length > CHALLENGERS_PAGE && last
        ? `${last.lastAt}:${last.userId}`
        : null,
  };
}
