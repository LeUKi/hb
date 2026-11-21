// The 站长's 三方积分 panel (docs/third-party-points-design.md §7): each
// system's state and today's calls, what waits for review, payouts with no
// known result or a broken answer, failures by reason, words changed (a red
// dot until seen), self-tests. Read on demand; nothing refreshes by itself.
import { ActivityError } from "../activities/errors";
import type { ApiBindings } from "../env";
import { startOfBeijingDay } from "../runtime/day";
import { pointsEventIfChanged } from "./events";
import { wakePointsPayment } from "./payments";
import { listSelfTests } from "./self-test";
import {
  ownerView,
  type PointsSystemRow,
  readPointsSettings,
  requireSystem,
} from "./systems";

const DAY_MS = 86_400_000;

type CallStats = {
  system_id: string;
  kind: string;
  calls: number;
  answered: number;
  ms: number;
};

export async function adminOverview(env: ApiBindings) {
  // “今天” on the panel starts at midnight in Beijing.
  const since = startOfBeijingDay();
  const [settings, systems, calls, open, unseen, attention] = await Promise.all(
    [
      readPointsSettings(env),
      env.DB.prepare(
        `SELECT s.*,u.username AS owner_username FROM points_systems s
          JOIN users u ON u.id=s.owner_id
          ORDER BY CASE s.status WHEN 'reviewing' THEN 0 WHEN 'online' THEN 1
            WHEN 'paused' THEN 2 WHEN 'draft' THEN 3 ELSE 4 END, s.updated_at DESC`,
      ).all<PointsSystemRow & { owner_username: string }>(),
      env.DB.prepare(
        `SELECT system_id,kind,COUNT(*) AS calls,
          SUM(CASE WHEN result LIKE 'missed:%' THEN 0 ELSE 1 END) AS answered,
          CAST(AVG(ms) AS INTEGER) AS ms
         FROM points_calls WHERE at>=? GROUP BY system_id,kind`,
      )
        .bind(since)
        .all<CallStats>(),
      env.DB.prepare(
        `SELECT points_system_id AS id,COUNT(*) AS count FROM activities
          WHERE funding='points' AND opened_at IS NOT NULL AND ended_at IS NULL
            AND deleted_at IS NULL GROUP BY points_system_id`,
      ).all<{ id: string; count: number }>(),
      env.DB.prepare(
        `SELECT system_id AS id,COUNT(*) AS count FROM points_copy_changes
          WHERE seen_at IS NULL GROUP BY system_id`,
      ).all<{ id: string; count: number }>(),
      env.DB.prepare(
        `SELECT system_id AS id,COUNT(*) AS count FROM points_payments
          WHERE status='unknown' OR (status='failed' AND reason IN ('bad_request','conflict')
            AND done_at>=?) GROUP BY system_id`,
      )
        .bind(Date.now() - 7 * DAY_MS)
        .all<{ id: string; count: number }>(),
    ],
  );
  const quality = await payoutQuality(
    env,
    systems.results.map((row) => row.id),
  );
  const openOf = new Map(open.results.map((row) => [row.id, row.count]));
  const unseenOf = new Map(unseen.results.map((row) => [row.id, row.count]));
  const attentionOf = new Map(
    attention.results.map((row) => [row.id, row.count]),
  );
  return {
    settings,
    systems: systems.results.map((row) => {
      const stats = calls.results.filter((call) => call.system_id === row.id);
      const total = stats.reduce((sum, call) => sum + call.calls, 0);
      const answered = stats.reduce((sum, call) => sum + call.answered, 0);
      return {
        ...ownerView(row),
        ownerUsername: row.owner_username,
        missedInRow: row.missed_in_row,
        today: {
          calls: Object.fromEntries(
            stats.map((call) => [call.kind, call.calls]),
          ) as Partial<Record<"balance" | "transfer" | "query", number>>,
          total,
          answeredRate: total ? answered / total : null,
          averageMs: total
            ? Math.round(
                stats.reduce((sum, call) => sum + call.ms * call.calls, 0) /
                  total,
              )
            : null,
        },
        openHongbao: openOf.get(row.id) ?? 0,
        unseenChanges: unseenOf.get(row.id) ?? 0,
        attention: attentionOf.get(row.id) ?? 0,
        ...(quality.get(row.id) ?? emptyQuality()),
      };
    }),
  };
}

/** Payouts by how they ended: through, and the failures by reason. */
export type PayoutQuality = {
  confirmed: number;
  noRecipient: number;
  notAllowed: number;
  otherFailed: number;
  waiting: number;
};

/** 失败率高 (§17): enough payouts in a day, most refused for the recipient. */
export const FAILING_MIN_PAYOUTS = 20;

export function failingDay(day: PayoutQuality) {
  const ended =
    day.confirmed + day.noRecipient + day.notAllowed + day.otherFailed;
  return (
    ended >= FAILING_MIN_PAYOUTS &&
    (day.noRecipient + day.notAllowed) * 2 > ended
  );
}

function emptyQuality() {
  const none = {
    confirmed: 0,
    noRecipient: 0,
    notAllowed: 0,
    otherFailed: 0,
    waiting: 0,
  };
  return { week: { ...none }, day: { ...none }, failing: false };
}

/**
 * 发放质量 (docs/third-party-points-design.md §17), for every system at
 * once: the last 7 days and the last 24 hours, by the payouts' index
 * (system_id, status, updated_at).
 */
async function payoutQuality(env: ApiBindings, systemIds: string[]) {
  const map = new Map<string, ReturnType<typeof emptyQuality>>();
  if (!systemIds.length) return map;
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT system_id,
        SUM(status='confirmed') AS confirmed,
        SUM(status='failed' AND reason='no_recipient') AS no_recipient,
        SUM(status='failed' AND reason='not_allowed') AS not_allowed,
        SUM(status='failed' AND COALESCE(reason,'') NOT IN ('no_recipient','not_allowed')) AS other_failed,
        SUM(status IN ('pending','sending','held','unknown')) AS waiting,
        SUM(updated_at>=?3 AND status='confirmed') AS day_confirmed,
        SUM(updated_at>=?3 AND status='failed' AND reason='no_recipient') AS day_no_recipient,
        SUM(updated_at>=?3 AND status='failed' AND reason='not_allowed') AS day_not_allowed,
        SUM(updated_at>=?3 AND status='failed' AND COALESCE(reason,'') NOT IN ('no_recipient','not_allowed')) AS day_other_failed,
        SUM(updated_at>=?3 AND status IN ('pending','sending','held','unknown')) AS day_waiting
      FROM points_payments
      WHERE system_id IN (SELECT value FROM json_each(?1))
        AND status IN ('pending','sending','held','unknown','confirmed','failed')
        AND updated_at>=?2
      GROUP BY system_id`,
  )
    .bind(JSON.stringify(systemIds), now - 7 * DAY_MS, now - DAY_MS)
    .all<Record<string, number> & { system_id: string }>();
  for (const row of rows.results) {
    const week = {
      confirmed: row.confirmed ?? 0,
      noRecipient: row.no_recipient ?? 0,
      notAllowed: row.not_allowed ?? 0,
      otherFailed: row.other_failed ?? 0,
      waiting: row.waiting ?? 0,
    };
    const day = {
      confirmed: row.day_confirmed ?? 0,
      noRecipient: row.day_no_recipient ?? 0,
      notAllowed: row.day_not_allowed ?? 0,
      otherFailed: row.day_other_failed ?? 0,
      waiting: row.day_waiting ?? 0,
    };
    map.set(row.system_id, { week, day, failing: failingDay(day) });
  }
  return map;
}

/** For the 站长's red dot: what waits for them (session, admin only). */
export async function pointsAttentionCount(env: ApiBindings) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM points_systems WHERE status='reviewing')
      + (SELECT COUNT(*) FROM points_copy_changes WHERE seen_at IS NULL)
      + (SELECT COUNT(*) FROM points_payments WHERE status='unknown') AS count`,
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

type PayoutRow = {
  id: string;
  activity_id: string;
  title: string;
  recipient_username: string;
  amount_minor: number;
  out_trade_no: string;
  status: string;
  reason: string | null;
  attempts: number;
  misses: number;
  created_at: number;
  updated_at: number;
};

function payoutOf(row: PayoutRow) {
  return {
    id: row.id,
    activityId: row.activity_id,
    title: row.title,
    recipientUsername: row.recipient_username,
    amountMinor: row.amount_minor,
    outTradeNo: row.out_trade_no,
    status: row.status,
    reason: row.reason,
    attempts: row.attempts,
    misses: row.misses,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function adminSystemDetail(env: ApiBindings, id: string) {
  const row = await requireSystem(env, id);
  const since = Date.now() - 7 * DAY_MS;
  const select = `SELECT p.id,p.activity_id,a.title,p.recipient_username,p.amount_minor,
    p.out_trade_no,p.status,p.reason,p.attempts,p.misses,p.created_at,p.updated_at
    FROM points_payments p JOIN activities a ON a.id=p.activity_id`;
  const [owner, tests, changes, attention, failures, recent] =
    await Promise.all([
      env.DB.prepare("SELECT username FROM users WHERE id=?")
        .bind(row.owner_id)
        .first<{ username: string }>(),
      listSelfTests(env, id),
      env.DB.prepare(
        `SELECT c.id,c.field,c.before,c.after,c.created_at,c.seen_at,u.username
          FROM points_copy_changes c JOIN users u ON u.id=c.actor_id
          WHERE c.system_id=? ORDER BY c.created_at DESC LIMIT 100`,
      )
        .bind(id)
        .all<{
          id: string;
          field: string;
          before: string;
          after: string;
          created_at: number;
          seen_at: number | null;
          username: string;
        }>(),
      env.DB.prepare(
        `${select} WHERE p.system_id=? AND (p.status='unknown'
          OR (p.status='failed' AND p.reason IN ('bad_request','conflict') AND p.done_at>=?))
          ORDER BY p.updated_at DESC LIMIT 100`,
      )
        .bind(id, since)
        .all<PayoutRow>(),
      env.DB.prepare(
        `SELECT reason,COUNT(*) AS count FROM points_payments
          WHERE system_id=? AND status='failed' AND done_at>=? GROUP BY reason
          ORDER BY count DESC`,
      )
        .bind(id, since)
        .all<{ reason: string | null; count: number }>(),
      env.DB.prepare(
        `${select} WHERE p.system_id=? AND p.status='failed' AND p.done_at>=?
          ORDER BY p.done_at DESC LIMIT 30`,
      )
        .bind(id, since)
        .all<PayoutRow>(),
    ]);
  return {
    system: { ...ownerView(row), ownerUsername: owner?.username ?? "" },
    tests,
    changes: changes.results.map((change) => ({
      id: change.id,
      field: change.field,
      before: change.before,
      after: change.after,
      createdAt: change.created_at,
      seenAt: change.seen_at,
      username: change.username,
    })),
    attention: attention.results.map(payoutOf),
    failures: failures.results.map((item) => ({
      reason: item.reason ?? "",
      count: item.count,
    })),
    recentFailures: recent.results.map(payoutOf),
  };
}

export async function markChangesSeen(env: ApiBindings, systemId: string) {
  await env.DB.prepare(
    "UPDATE points_copy_changes SET seen_at=? WHERE system_id=? AND seen_at IS NULL",
  )
    .bind(Date.now(), systemId)
    .run();
}

/** The payout, for its system and 单号 in the 操作记录. */
async function payoutIdentity(env: ApiBindings, id: string) {
  return env.DB.prepare(
    "SELECT system_id,out_trade_no FROM points_payments WHERE id=?",
  )
    .bind(id)
    .first<{ system_id: string; out_trade_no: string }>();
}

/** 再查一次: a payout with no known result asks the issuer once more. */
export async function requeryPayout(
  env: ApiBindings,
  id: string,
  adminId: string,
) {
  const now = Date.now();
  const payout = await payoutIdentity(env, id);
  const [result] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE points_payments SET status='pending',reason='final_query',query_first=1,
        next_run_at=?1,updated_at=?1 WHERE id=?2 AND status='unknown'`,
    ).bind(now, id),
    ...(payout
      ? [
          pointsEventIfChanged(env, {
            systemId: payout.system_id,
            actor: "admin",
            actorId: adminId,
            action: "payout_requery",
            note: `单号 ${payout.out_trade_no}`,
            at: now,
          }),
        ]
      : []),
  ]);
  if (!result?.meta.changes)
    throw new ActivityError(
      409,
      "POINTS_PAYOUT_MOVED",
      // A sentence that says what to do (07 §1; sweep 2026-11-21 ADM-1).
      "这笔发放的状态刚刚变了，刷新后再看。",
    );
  await wakePointsPayment(env, id);
}

/** 标为发放失败: the 站长 settles a payout with no known result as not paid. */
export async function failPayout(
  env: ApiBindings,
  id: string,
  adminId: string,
) {
  const now = Date.now();
  const payout = await payoutIdentity(env, id);
  const [result] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE points_payments SET status='failed',reason='admin',next_run_at=NULL,
        done_at=?1,updated_at=?1 WHERE id=?2 AND status='unknown'`,
    ).bind(now, id),
    ...(payout
      ? [
          pointsEventIfChanged(env, {
            systemId: payout.system_id,
            actor: "admin",
            actorId: adminId,
            action: "payout_failed",
            note: `单号 ${payout.out_trade_no}`,
            at: now,
          }),
        ]
      : []),
  ]);
  if (!result?.meta.changes)
    throw new ActivityError(
      409,
      "POINTS_PAYOUT_MOVED",
      // A sentence that says what to do (07 §1; sweep 2026-11-21 ADM-1).
      "这笔发放的状态刚刚变了，刷新后再看。",
    );
}
