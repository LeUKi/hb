// 用量记录 and 每月上限 (docs/programmable-hongbao-design.md §7): a 判定器
// counts once a UTC day, the first time it is used, as Cloudflare bills a
// Dynamic Worker. A run writes each row before its first use of that
// 判定器 and adds what it went through at its end; each claim writes inside
// the batch it writes anyway. The 站长 reads them on 网站管理 · 判定器.
import {
  type AdminJudgeUsage,
  type AdminJudgeUsageCounts,
  type AdminLifecycle,
  JUDGE_PROTOCOL,
  type JudgeSettings,
} from "@hb/contracts";
import { activityListStatusCaseSql } from "../activities/history-query";
import type { ApiBindings } from "../env";
import { sandboxId } from "./sandbox";

/** Dynamic Workers' allowance a month, and each past it (USD, 2026-06). */
export const FREE_ROWS = 1000;
export const PRICE_PER_ROW = 0.002;
/** Rows are kept this many days. */
export const KEEP_DAYS = 90;
const DAY_MS = 86_400_000;

/** The UTC day of a time: 2026-10-25. */
export const usageDay = (now = Date.now()) =>
  new Date(now).toISOString().slice(0, 10);
/** The first UTC day of its month: 2026-10-01. */
const monthStart = (now: number) => `${usageDay(now).slice(0, 8)}01`;
const monthStartMs = (now: number) => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

export type UsageUse = {
  now: number;
  /**
   * When the sandbox was first used in it, if before `now`: that day is its
   * 份's, as Cloudflare bills it.
   */
  firstAt?: number;
  fingerprint: string;
  /** Its sandbox: 0, or n after timeouts moved on (sandboxId's ":n"). */
  fresh: number;
  /** The protocol its runtime is: the 红包's, or JUDGE_PROTOCOL for a run. */
  protocol?: number;
  /** A 联网 红包's own 判定器 (§9.7): its sandboxId names `activityId`. */
  networked?: boolean;
  /** The deployer, or for a claim the 红包's sender. */
  userId: string;
  activityId?: string | null;
  /** A run's judge_checks row: its kind says deploy or rerun. */
  checkId?: string;
  deploys?: number;
  reruns?: number;
  claims?: number;
  timeouts?: number;
  switches?: number;
  /** 联网: requests sent out. */
  fetches?: number;
  /** check() and 试一试 runs (docs/judge-square-design.md §3, §6). */
  tries?: number;
};

/**
 * This use of a 判定器: its day's row, made by the first use and added to
 * by the rest. Who and which 红包 stay those of the first use, but a 红包
 * comes in when the first had none (a deploy, then claims on the same day).
 */
export function usageStatement(env: ApiBindings, use: UsageUse) {
  const firstAt = Math.min(use.firstAt ?? use.now, use.now);
  const protocol = use.protocol ?? JUDGE_PROTOCOL;
  const networked = use.networked === true && Boolean(use.activityId);
  // A run counts as the row written with it says, in the same batch: the
  // database's word on deploy or rerun, as judge_checks.kind is.
  return env.DB.prepare(`INSERT INTO judge_usage
    (day, sandbox_id, fingerprint, fresh, user_id, activity_id, deploys, reruns, claims, timeouts, switches, first_at, last_at,
      protocol, networked, fetches, tries)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6,
      COALESCE((SELECT kind = 'deploy' FROM judge_checks WHERE id = ?14), ?7),
      COALESCE((SELECT kind = 'rerun' FROM judge_checks WHERE id = ?14), ?8), ?9, ?10, ?11, ?12, ?13, ?15, ?16, ?17, ?18)
    ON CONFLICT(day, sandbox_id) DO UPDATE SET
      activity_id = COALESCE(judge_usage.activity_id, excluded.activity_id),
      deploys = judge_usage.deploys + excluded.deploys, reruns = judge_usage.reruns + excluded.reruns,
      claims = judge_usage.claims + excluded.claims, timeouts = judge_usage.timeouts + excluded.timeouts,
      switches = judge_usage.switches + excluded.switches, fetches = judge_usage.fetches + excluded.fetches,
      tries = judge_usage.tries + excluded.tries,
      last_at = MAX(judge_usage.last_at, excluded.last_at)`).bind(
    usageDay(firstAt),
    sandboxId(
      use.fingerprint,
      use.fresh,
      protocol,
      networked ? (use.activityId ?? undefined) : undefined,
    ),
    use.fingerprint,
    use.fresh,
    use.userId,
    use.activityId ?? null,
    use.deploys ?? 0,
    use.reruns ?? 0,
    use.claims ?? 0,
    use.timeouts ?? 0,
    use.switches ?? 0,
    firstAt,
    use.now,
    use.checkId ?? null,
    protocol,
    Number(networked),
    use.fetches ?? 0,
    use.tries ?? 0,
  );
}

/**
 * 每月上限: this month's 份 have reached the limit and this code's own
 * 判定器 has none today, so running it would make another. Claims are
 * never held to it.
 */
export async function overMonthlyLimit(
  env: ApiBindings,
  settings: JudgeSettings,
  fingerprint: string,
  now = Date.now(),
) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM judge_usage WHERE day >= ?) AS month,
      EXISTS(SELECT 1 FROM judge_usage WHERE day = ? AND sandbox_id = ?) AS today`,
  )
    .bind(monthStart(now), usageDay(now), sandboxId(fingerprint))
    .first<{ month: number; today: number }>();
  return (row?.month ?? 0) >= settings.monthlyLimit && row?.today !== 1;
}

/** The scheduled maintenance: rows past 90 days go. */
export async function pruneJudgeUsage(env: ApiBindings, now = Date.now()) {
  await env.DB.prepare("DELETE FROM judge_usage WHERE day < ?")
    .bind(usageDay(now - KEEP_DAYS * DAY_MS))
    .run();
}

// Deploys and reruns are the runs themselves (judge_checks since ?1), as
// 谁在用 counts them: one whose code never ran (an import, empty tests) is
// a deploy all the same, with no 份. The rest are the rows' (since ?2).
const COUNTS = `COUNT(*) AS shares,
  (SELECT COUNT(*) FROM judge_checks WHERE kind = 'deploy' AND created_at >= ?1) AS deploys,
  (SELECT COUNT(*) FROM judge_checks WHERE kind = 'rerun' AND created_at >= ?1) AS reruns,
  COALESCE(SUM(claims), 0) AS claims, COALESCE(SUM(timeouts), 0) AS timeouts, COALESCE(SUM(switches), 0) AS switches,
  COALESCE(SUM(fetches), 0) AS fetches`;

const countsOf = (row: Record<string, unknown> | undefined) =>
  ({
    rows: Number(row?.shares ?? 0),
    deploys: Number(row?.deploys ?? 0),
    reruns: Number(row?.reruns ?? 0),
    claims: Number(row?.claims ?? 0),
    timeouts: Number(row?.timeouts ?? 0),
    switches: Number(row?.switches ?? 0),
    fetches: Number(row?.fetches ?? 0),
  }) satisfies AdminJudgeUsageCounts;

const authorOf = (row: Record<string, unknown>) => ({
  id: String(row.userId),
  username: String(row.username ?? ""),
  displayName: String(row.displayName ?? ""),
  avatarUrl: row.avatarUrl == null ? null : String(row.avatarUrl),
});

/** 网站管理 · 判定器's 用量 (redesign/07 §10). */
export async function judgeUsageReport(
  env: ApiBindings,
  settings: JudgeSettings,
  now = Date.now(),
): Promise<AdminJudgeUsage> {
  const day = usageDay(now);
  const month = monthStart(now);
  const firstDay = usageDay(now - 29 * DAY_MS);
  const [today, thisMonth, days, people, hongbao] = await env.DB.batch<
    Record<string, unknown>
  >([
    env.DB.prepare(`SELECT ${COUNTS} FROM judge_usage WHERE day = ?2`).bind(
      Date.parse(`${day}T00:00:00Z`),
      day,
    ),
    env.DB.prepare(`SELECT ${COUNTS} FROM judge_usage WHERE day >= ?2`).bind(
      monthStartMs(now),
      month,
    ),
    env.DB.prepare(
      "SELECT day, COUNT(*) AS shares FROM judge_usage WHERE day >= ? GROUP BY day",
    ).bind(firstDay),
    // New versions from the deploys themselves: a 判定器 two people used
    // on one day is the first one's row. Only people who deployed this
    // month: claims on an older version show under its 红包.
    env.DB.prepare(`SELECT u.id AS userId, u.username, u.display_name AS displayName, u.avatar_url AS avatarUrl,
        p.deploys, p.shares
      FROM (SELECT user_id, SUM(deploys) AS deploys, SUM(shares) AS shares FROM (
          SELECT user_id, COUNT(*) AS deploys, 0 AS shares FROM judge_checks
          WHERE kind = 'deploy' AND created_at >= ? GROUP BY user_id
          UNION ALL
          SELECT user_id, 0, COUNT(*) FROM judge_usage WHERE day >= ? GROUP BY user_id)
        GROUP BY user_id HAVING SUM(deploys) > 0) p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.deploys DESC, p.shares DESC, u.id LIMIT 10`).bind(
      monthStartMs(now),
      month,
    ),
    env.DB.prepare(`SELECT a.id, a.title, a.author_id AS userId, u.username, u.display_name AS displayName,
        u.avatar_url AS avatarUrl, ${activityListStatusCaseSql(now, "a")} AS status, c.stopped_at AS stoppedAt,
        h.shares, (SELECT COUNT(*) FROM code_judgments j WHERE j.activity_id = a.id AND j.judged_at >= ?) AS judgments
      FROM (SELECT activity_id, COUNT(*) AS shares FROM judge_usage
          WHERE day >= ? AND activity_id IS NOT NULL GROUP BY activity_id) h
      JOIN activities a ON a.id = h.activity_id JOIN users u ON u.id = a.author_id
      LEFT JOIN activity_code c ON c.activity_id = a.id
      ORDER BY h.shares DESC, judgments DESC, a.id LIMIT 10`).bind(
      monthStartMs(now),
      month,
    ),
  ]);
  const rowsOn = new Map(
    (days?.results ?? []).map((row) => [String(row.day), Number(row.shares)]),
  );
  const counts = countsOf(thisMonth?.results[0]);
  return {
    readAt: now,
    day,
    month: day.slice(0, 7),
    today: countsOf(today?.results[0]),
    thisMonth: counts,
    freeRows: FREE_ROWS,
    pricePerRow: PRICE_PER_ROW,
    // Whole thousandths of a dollar: each 份 past the allowance is two.
    estimatedCost:
      Math.round(Math.max(0, counts.rows - FREE_ROWS) * PRICE_PER_ROW * 1000) /
      1000,
    monthlyLimit: settings.monthlyLimit,
    days: Array.from({ length: 30 }, (_, index) => {
      const date = usageDay(now - (29 - index) * DAY_MS);
      return { day: date, rows: rowsOn.get(date) ?? 0 };
    }),
    people: (people?.results ?? []).map((row) => ({
      user: authorOf(row),
      deploys: Number(row.deploys),
      rows: Number(row.shares),
    })),
    hongbao: (hongbao?.results ?? []).map((row) => ({
      activity: {
        id: String(row.id),
        title: String(row.title),
        author: authorOf(row),
        status: row.status as AdminLifecycle,
        ...(row.stoppedAt != null ? { stopped: true as const } : {}),
      },
      rows: Number(row.shares),
      judgments: Number(row.judgments),
    })),
  };
}
