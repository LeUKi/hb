// 公开数据 and 动态 (docs/judge-page-design.md §2, protocol 4): what a
// 代码判定红包's code last wrote for everyone, and the lines its judgments
// added, each with who was judged. Public, guests too, as the 名单 is;
// never what anyone typed. Lines run 0…N-1 (activity_announcements'
// insert guard, no updates, no deletes), so the last says how many.
import {
  formatSignedAmount,
  type JudgeAnnouncement,
  type JudgeAnnouncementList,
  type JudgeView,
} from "@hb/contracts";
import type { Json } from "../../../../kit/judge";
import { LEDGER_PROTOCOL } from "../../../../kit/runtime/index.mjs";
import { activityNotFound } from "../activities/errors";
import { findActivity } from "../activities/storage";
import type { ApiBindings } from "../env";
import { ledgerPool } from "./ledger";
import type { JudgeRow } from "./storage";

/** On the 红包 page (§11.3); the rest in 动态's dialog. */
export const ANNOUNCEMENTS_ON_PAGE = 5;
/** The dialog's pages, and the most a push carries. */
export const ANNOUNCEMENTS_PAGE = 20;

/** What everyone sees now, once anything was written; neither part when cleared. */
export function viewOf(
  judge: Pick<JudgeRow, "viewAt" | "viewSummary" | "viewData">,
): JudgeView | undefined {
  if (judge.viewAt === null) return undefined;
  return {
    at: new Date(judge.viewAt).toISOString(),
    ...(judge.viewSummary !== null ? { summary: judge.viewSummary } : {}),
    ...(judge.viewData !== null
      ? { data: JSON.parse(judge.viewData) as Json }
      : {}),
  };
}

type LineRow = {
  n: number;
  text: string;
  at: number;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

const LINES = `SELECT a.n, a.text, a.created_at AS at, u.username, u.display_name AS displayName,
    u.avatar_url AS avatarUrl
  FROM activity_announcements a JOIN users u ON u.id = a.user_id`;

const lineOf = (row: LineRow): JudgeAnnouncement => ({
  n: row.n,
  at: new Date(row.at).toISOString(),
  text: row.text,
  user: {
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
  },
});

/** How many lines in all: the last one's number plus one. */
export async function announcementTotal(env: ApiBindings, activityId: string) {
  return (
    (await env.DB.prepare(
      "SELECT COALESCE(MAX(n) + 1, 0) AS count FROM activity_announcements WHERE activity_id = ?",
    )
      .bind(activityId)
      .first<number>("count")) ?? 0
  );
}

/** The latest `limit` lines, newest first, before line `before` if given. */
export async function latestAnnouncements(
  env: ApiBindings,
  activityId: string,
  limit: number,
  before: number | null = null,
) {
  const rows = await env.DB.prepare(
    `${LINES} WHERE a.activity_id = ?1 AND (?2 IS NULL OR a.n < ?2) ORDER BY a.n DESC LIMIT ?3`,
  )
    .bind(activityId, before, limit)
    .all<LineRow>();
  return rows.results.map(lineOf);
}

/** The lines from `from` on, newest first, at most a page: a push's. */
export async function announcementsSince(
  env: ApiBindings,
  activityId: string,
  from: number,
) {
  const rows = await env.DB.prepare(
    `${LINES} WHERE a.activity_id = ? AND a.n >= ? ORDER BY a.n DESC LIMIT ?`,
  )
    .bind(activityId, from, ANNOUNCEMENTS_PAGE)
    .all<LineRow>();
  return rows.results.map(lineOf);
}

/** 动态 · N 条: every line, twenty at a time, before line `before`. */
export async function listAnnouncements(
  env: ApiBindings,
  activityId: string,
  before: number | null,
): Promise<JudgeAnnouncementList> {
  const activity = await findActivity(env, activityId);
  if (
    !activity ||
    activity.openedAt === null ||
    activity.participationMode !== "code"
  )
    activityNotFound();
  const [items, total] = await Promise.all([
    latestAnnouncements(env, activityId, ANNOUNCEMENTS_PAGE + 1, before),
    announcementTotal(env, activityId),
  ]);
  const page = items.slice(0, ANNOUNCEMENTS_PAGE);
  const last = page.at(-1);
  return {
    items: page,
    total,
    nextCursor:
      items.length > ANNOUNCEMENTS_PAGE && last ? String(last.n) : null,
  };
}

/**
 * What a push after judgments says (live.ts, 300 ms at most apart): how
 * many judged, what everyone sees, and the lines since the last sent
 * (`from`; the latest few when unknown, after hibernating). Protocol 5
 * also what the pool has left, and how many are paid and whether it ended
 * (`claims`): when that moves, the whole 红包 goes out (multi-prize §4.3).
 */
export async function judgedNews(
  env: ApiBindings,
  activityId: string,
  from: number,
): Promise<{
  count: number;
  unclaimed?: string;
  claims?: string;
  view?: JudgeView;
  total?: number;
  items?: JudgeAnnouncement[];
}> {
  const [judged, code, activity] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      "SELECT COALESCE(MAX(sequence) + 1, 0) AS count FROM code_judgments WHERE activity_id = ?",
    ).bind(activityId),
    env.DB.prepare(
      "SELECT protocol, view_at AS viewAt, view_summary AS viewSummary, view_data AS viewData FROM activity_code WHERE activity_id = ?",
    ).bind(activityId),
    env.DB.prepare(
      "SELECT claimed_count AS claimed, ended_at AS endedAt FROM activities WHERE id = ?",
    ).bind(activityId),
  ]);
  const count = Number(judged?.results[0]?.count ?? 0);
  const row = code?.results[0] as
    | {
        protocol: number;
        viewAt: number | null;
        viewSummary: string | null;
        viewData: string | null;
      }
    | undefined;
  if (!row || row.protocol < 4) return { count };
  const paid = activity?.results[0] as
    | { claimed: number; endedAt: number | null }
    | undefined;
  const [total, items, pool] = await Promise.all([
    announcementTotal(env, activityId),
    from < 0
      ? latestAnnouncements(env, activityId, ANNOUNCEMENTS_ON_PAGE)
      : announcementsSince(env, activityId, from),
    row.protocol >= LEDGER_PROTOCOL ? ledgerPool(env, activityId) : null,
  ]);
  return {
    count,
    view: viewOf(row),
    total,
    items,
    ...(pool !== null && paid
      ? {
          unclaimed: formatSignedAmount(pool),
          claims: `${paid.claimed}:${paid.endedAt !== null}`,
        }
      : {}),
  };
}
