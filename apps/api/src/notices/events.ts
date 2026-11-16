// Where 私信通知 come from (docs/notification-design.md §3): each function
// reads what its notice needs and hands it to the outbox. They never throw;
// the places that call them go on as before.

import {
  type AmountUnit,
  FISH_UNIT,
  formatAmountWithUnit,
  LDC_UNIT,
  PAYOUT_FUNDS_WAIT_MS,
  readClaimScope,
  type StoredClaimScope,
  scopeAllows,
} from "@hb/contracts";
import type { ScopeViewer } from "../activities/claim-scope";
import type { ApiBindings } from "../env";
import { notify } from "./outbox";
import * as notice from "./templates";

type ActivityLike = {
  id: string;
  title: string;
  authorId: string;
  funding: string;
  config: string;
};

function quietly(name: string, work: () => Promise<void>) {
  return work().catch((error) =>
    console.error("notice.event_failed", { name, error: String(error) }),
  );
}

/** LDC, 🐟, or the 三方积分 the 红包 was sent in. */
function unitOfActivity(activity: ActivityLike): AmountUnit {
  if (activity.funding === "balance") return FISH_UNIT;
  if (activity.funding === "points") {
    try {
      const points = (
        JSON.parse(activity.config) as {
          points?: { unit?: string; step?: number };
        }
      ).points;
      if (points?.unit && points.step)
        return { unit: points.unit, step: points.step };
    } catch {}
  }
  return LDC_UNIT;
}

function pointsNameOf(activity: ActivityLike) {
  try {
    return (
      (JSON.parse(activity.config) as { points?: { name?: string } }).points
        ?.name ?? "三方积分"
    );
  } catch {
    return "三方积分";
  }
}

const fundingOf = (activity: ActivityLike) =>
  activity.funding === "balance"
    ? "balance"
    : activity.funding === "points"
      ? "points"
      : "merchant";

/** 限时开奖中了: every winner but the sender (自领 is not paid). */
export function noticeDrawWon(
  env: ApiBindings,
  activity: ActivityLike,
  winners: { userId: string; amountMinor: number }[],
) {
  return quietly("draw_won", async () => {
    const unit = unitOfActivity(activity);
    await notify(
      env,
      winners
        .filter((winner) => winner.userId !== activity.authorId)
        .map((winner) => ({
          userId: winner.userId,
          kind: "draw_won" as const,
          key: `draw_won:${activity.id}:${winner.userId}`,
          ...notice.drawWon(env, {
            activityId: activity.id,
            title: activity.title,
            amount: formatAmountWithUnit(winner.amountMinor, unit),
            funding: fundingOf(activity),
          }),
        })),
    );
  });
}

/**
 * 奖励发放暂停 for the day's limit: a claim's payment on the sender's own
 * 商户 stopped by it. Once a 红包. Want of funds is told once a wait, by
 * the payments job (noticePayoutWaiting).
 */
export function noticePayoutStuck(env: ApiBindings, taskId: string) {
  return quietly("payout_stuck", async () => {
    const row = await env.DB.prepare(
      `SELECT a.id AS activity_id, a.title, a.author_id,
        (SELECT COUNT(*) FROM payment_tasks q JOIN claims d ON d.id=q.claim_id
          WHERE d.activity_id=a.id AND q.source='claim' AND q.status IN ('pending','sending','reconciling','waiting')) AS waiting
       FROM payment_tasks p JOIN claims c ON c.id=p.claim_id
       JOIN activities a ON a.id=c.activity_id
       JOIN merchants m ON m.id=p.merchant_id
       WHERE p.id=? AND p.source='claim' AND p.status='waiting' AND p.reason='quota'
         AND m.kind='author' AND m.author_id=a.author_id`,
    )
      .bind(taskId)
      .first<{
        activity_id: string;
        title: string;
        author_id: string;
        waiting: number;
      }>();
    if (!row) return;
    await notify(env, {
      userId: row.author_id,
      kind: "payout_stuck",
      key: `payout_stuck:${row.activity_id}`,
      ...notice.payoutStuck(env, {
        activityId: row.activity_id,
        title: row.title,
        waiting: Math.max(1, row.waiting),
      }),
    });
  });
}

/**
 * 奖励发放暂停 for want of funds (docs/payout-stop-design.md §4): once a
 * wait, to the merchant's owner, with what waits and until when.
 */
export function noticePayoutWaiting(
  env: ApiBindings,
  merchantId: string,
  since: number,
) {
  return quietly("payout_waiting", async () => {
    const row = await env.DB.prepare(
      `SELECT m.author_id, COUNT(t.id) AS payments, COALESCE(SUM(t.amount_minor),0) AS minor
        FROM merchants m JOIN payment_tasks t ON t.merchant_id=m.id
        WHERE m.id=? AND m.kind='author' AND t.source='claim'
          AND t.status IN ('pending','sending','reconciling','waiting')
        GROUP BY m.author_id`,
    )
      .bind(merchantId)
      .first<{ author_id: string; payments: number; minor: number }>();
    if (!row || row.payments === 0) return;
    await notify(env, {
      userId: row.author_id,
      kind: "payout_stuck",
      key: `payout_waiting:${merchantId}:${since}`,
      ...notice.payoutWaiting(env, {
        payments: row.payments,
        amount: formatAmountWithUnit(row.minor, LDC_UNIT),
        stopAt: since + PAYOUT_FUNDS_WAIT_MS,
      }),
    });
  });
}

/**
 * 奖励发放已终止 (payout-stop §4, §6 point 2): the sender once, over every
 * 红包 it touched; each claimant once a 红包, with what they were to get.
 */
export function noticePayoutStopped(
  env: ApiBindings,
  merchantId: string,
  since: number,
  taskIds: string[],
) {
  return quietly("payout_stopped", async () => {
    if (!taskIds.length) return;
    const rows = await env.DB.prepare(
      `SELECT a.id AS activityId, a.title, a.author_id AS authorId, c.user_id AS userId,
          SUM(t.amount_minor) AS minor, COUNT(*) AS payments
        FROM payment_tasks t JOIN claims c ON c.id=t.claim_id
        JOIN activities a ON a.id=c.activity_id
        WHERE t.id IN (SELECT value FROM json_each(?)) AND t.status='failed'
        GROUP BY a.id, c.user_id`,
    )
      .bind(JSON.stringify(taskIds))
      .all<{
        activityId: string;
        title: string;
        authorId: string;
        userId: string;
        minor: number;
        payments: number;
      }>();
    const list = rows.results;
    const first = list[0];
    if (!first) return;
    const byActivity = new Map<string, { title: string; payments: number }>();
    for (const row of list) {
      const seen = byActivity.get(row.activityId);
      byActivity.set(row.activityId, {
        title: row.title,
        payments: (seen?.payments ?? 0) + row.payments,
      });
    }
    const most = [...byActivity.values()].sort(
      (a, b) => b.payments - a.payments,
    )[0];
    await notify(env, [
      {
        userId: first.authorId,
        kind: "payout_stopped",
        key: `payout_stopped:${merchantId}:${since}`,
        ...notice.payoutStopped(env, {
          firstTitle: most?.title ?? first.title,
          activities: byActivity.size,
          payments: list.reduce((sum, row) => sum + row.payments, 0),
          amount: formatAmountWithUnit(
            list.reduce((sum, row) => sum + row.minor, 0),
            LDC_UNIT,
          ),
        }),
      },
      ...list
        .filter((row) => row.userId !== row.authorId)
        .map((row) => ({
          userId: row.userId,
          kind: "payout_failed" as const,
          key: `payout_failed:${row.activityId}:${row.userId}`,
          ...notice.payoutFailed(env, {
            activityId: row.activityId,
            title: row.title,
            amount: formatAmountWithUnit(row.minor, LDC_UNIT),
          }),
        })),
    ]);
  });
}

/** 定时开放没开成, with the 红包 page's reason. */
export function noticeScheduleFailed(
  env: ApiBindings,
  activity: ActivityLike & { scheduledOpenAt: number | null },
  reason: string,
) {
  return quietly("schedule_failed", () =>
    notify(env, {
      userId: activity.authorId,
      kind: "schedule_failed",
      key: `schedule_failed:${activity.id}:${activity.scheduledOpenAt ?? 0}`,
      ...notice.scheduleFailed(env, {
        activityId: activity.id,
        title: activity.title,
        reason,
      }),
    }),
  );
}

/** 等的红包开放了: everyone who asked, once; then they are let go. */
export function noticeOpened(env: ApiBindings, activityId: string) {
  return quietly("opening_watch", async () => {
    // Most openings have nobody waiting: one small read, then nothing.
    const watchers = await env.DB.prepare(
      "SELECT user_id FROM opening_watchers WHERE activity_id=? LIMIT 5000",
    )
      .bind(activityId)
      .all<{ user_id: string }>();
    const users = watchers.results;
    if (!users.length) return;
    const row = await env.DB.prepare(
      `SELECT a.title, a.deadline, a.opened_at, u.username FROM activities a JOIN users u ON u.id=a.author_id WHERE a.id=?`,
    )
      .bind(activityId)
      .first<{
        title: string;
        deadline: number | null;
        opened_at: number | null;
        username: string;
      }>();
    if (!users.length || !row || row.opened_at === null) return;
    const said = notice.openingWatch(env, {
      activityId,
      title: row.title,
      author: row.username,
      deadline: row.deadline,
    });
    await notify(
      env,
      users.map((user) => ({
        userId: user.user_id,
        kind: "opening_watch" as const,
        key: `opening_watch:${activityId}:${user.user_id}`,
        ...said,
      })),
    );
    await env.DB.prepare("DELETE FROM opening_watchers WHERE activity_id=?")
      .bind(activityId)
      .run();
  });
}

/** 红包被站长停用. */
export function noticeStopped(env: ApiBindings, activity: ActivityLike) {
  return quietly("hongbao_stopped", () =>
    notify(env, {
      userId: activity.authorId,
      kind: "hongbao_stopped",
      key: `hongbao_stopped:${activity.id}`,
      ...notice.hongbaoStopped(env, {
        activityId: activity.id,
        title: activity.title,
        refunds: activity.funding === "balance",
      }),
    }),
  );
}

/** 三方积分红包提前结束 (not when the sender removed the key just now). */
export function noticePointsEnded(
  env: ApiBindings,
  activityIds: string[],
  stop: notice.PointsStop,
  beforeDraw = false,
) {
  return quietly("points_hongbao_ended", async () => {
    if (!activityIds.length) return;
    const rows = await env.DB.prepare(
      `SELECT id,title,author_id AS authorId,funding,config FROM activities WHERE id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(activityIds))
      .all<ActivityLike>();
    await notify(
      env,
      rows.results.map((activity) => ({
        userId: activity.authorId,
        kind: "points_hongbao_ended" as const,
        key: `points_hongbao_ended:${activity.id}`,
        ...notice.pointsHongbaoEnded(env, {
          activityId: activity.id,
          title: activity.title,
          system: pointsNameOf(activity),
          stop,
          beforeDraw,
        }),
      })),
    );
  });
}

/** 收到打赏: a tip that just became done. */
export function noticeTip(
  env: ApiBindings,
  tip: {
    id: string;
    ownerId: string;
    tipperId: string | null;
    amountMinor: number;
    method: string;
    message: string | null;
  },
) {
  return quietly("tip_received", async () => {
    if (tip.tipperId === tip.ownerId) return;
    const tipper = tip.tipperId
      ? await env.DB.prepare("SELECT username FROM users WHERE id=?")
          .bind(tip.tipperId)
          .first<{ username: string }>()
      : null;
    await notify(env, {
      userId: tip.ownerId,
      kind: "tip_received",
      key: `tip_received:${tip.id}`,
      ...notice.tipReceived(env, {
        tipper: tipper?.username ?? null,
        amount: formatAmountWithUnit(
          tip.amountMinor,
          tip.method === "balance" ? FISH_UNIT : LDC_UNIT,
        ),
        message: tip.message,
      }),
    });
  });
}

/** 收到转账: a 🐟额 转账 to someone's 🐟额. */
export function noticeTransfer(
  env: ApiBindings,
  transfer: {
    id: string;
    senderId: string;
    recipientId: string;
    amountMinor: number;
    remark: string | null;
  },
) {
  return quietly("transfer_received", async () => {
    if (transfer.senderId === transfer.recipientId) return;
    const sender = await env.DB.prepare("SELECT username FROM users WHERE id=?")
      .bind(transfer.senderId)
      .first<{ username: string }>();
    if (!sender) return;
    await notify(env, {
      userId: transfer.recipientId,
      kind: "transfer_received",
      key: `transfer_received:${transfer.id}`,
      ...notice.transferReceived(env, {
        sender: sender.username,
        amount: formatAmountWithUnit(transfer.amountMinor, FISH_UNIT),
        remark: transfer.remark,
      }),
    });
  });
}

/** 判定器被撤下, with the 站长's reason. */
export function noticeJudgeWithdrawn(
  env: ApiBindings,
  judge: { id: string; authorId: string; name: string },
  reason: string,
  at: number,
) {
  return quietly("judge_withdrawn", () =>
    notify(env, {
      userId: judge.authorId,
      kind: "judge_withdrawn",
      key: `judge_withdrawn:${judge.id}:${at}`,
      ...notice.judgeWithdrawn(env, {
        judgeId: judge.id,
        name: judge.name,
        reason,
      }),
    }),
  );
}

type SystemLike = { id: string; owner_id: string; name: string };

/** 三方积分 审核: through or sent back. */
export function noticePointsReviewed(
  env: ApiBindings,
  system: SystemLike,
  approved: boolean,
  note: string | null,
  at: number,
) {
  return quietly("points_review", () =>
    notify(env, {
      userId: system.owner_id,
      kind: "points_review",
      key: `points_review:${system.id}:${at}`,
      ...notice.pointsReviewed(env, {
        systemId: system.id,
        name: system.name,
        approved,
        note,
      }),
    }),
  );
}

/** 三方积分 paused, resumed or 下架 by the 站长. */
export function noticePointsStatus(
  env: ApiBindings,
  system: SystemLike,
  action: "pause" | "resume" | "retire",
  at: number,
  /** 暂停's reason, as the 站长 wrote it (third-party-points §17). */
  reason = "",
) {
  return quietly("points_status", () =>
    notify(env, {
      userId: system.owner_id,
      kind: "points_status",
      key: `points_status:${system.id}:${action}:${at}`,
      ...notice.pointsStatus(env, {
        systemId: system.id,
        name: system.name,
        action,
        reason,
      }),
    }),
  );
}

/** 三方积分's interface stopped answering: the first trip of an outage. */
export function noticePointsBreaker(
  env: ApiBindings,
  systemId: string,
  at: number,
) {
  return quietly("points_breaker", async () => {
    const system = await env.DB.prepare(
      "SELECT id,owner_id,name FROM points_systems WHERE id=?",
    )
      .bind(systemId)
      .first<SystemLike>();
    if (!system) return;
    await notify(env, {
      userId: system.owner_id,
      kind: "points_breaker",
      key: `points_breaker:${system.id}:${at}`,
      ...notice.pointsBreaker(env, { systemId: system.id, name: system.name }),
    });
  });
}

/**
 * 红包广场's 下一个红包开放时提醒我: a 红包 in the 广场 just opened. Those
 * waiting who may claim it are let go first (so two openings at once tell
 * them once), then told; the rest wait for the next. Its sender's own
 * opening never uses theirs up.
 */
export function noticeSquareOpened(env: ApiBindings, activityId: string) {
  return quietly("square_watch", async () => {
    const activity = await env.DB.prepare(
      `SELECT a.id, a.title, a.deadline, a.opened_at, a.join_square, a.author_id, a.config, u.username
       FROM activities a JOIN users u ON u.id=a.author_id WHERE a.id=?`,
    )
      .bind(activityId)
      .first<{
        id: string;
        title: string;
        deadline: number | null;
        opened_at: number | null;
        join_square: number;
        author_id: string;
        config: string;
        username: string;
      }>();
    if (!activity || activity.opened_at === null || !activity.join_square)
      return;
    const watchers = await env.DB.prepare(
      `SELECT w.user_id, u.external_id, u.username, u.trust_level, u.profile_seen_at
       FROM square_watchers w JOIN users u ON u.id=w.user_id
       WHERE w.user_id<>? LIMIT 5000`,
    )
      .bind(activity.author_id)
      .all<ScopeViewer & { user_id: string }>();
    if (!watchers.results.length) return;
    // 领取范围, as a claim checks it (activities/claim-scope.ts).
    const scope = readClaimScope(
      (JSON.parse(activity.config) as { scope?: StoredClaimScope }).scope,
    );
    const inScope = scope
      ? watchers.results.filter((viewer) =>
          scopeAllows(scope, {
            linuxDoId: viewer.external_id,
            username: viewer.profile_seen_at === null ? "" : viewer.username,
            trustLevel: viewer.trust_level,
          }),
        )
      : watchers.results;
    if (!inScope.length) return;
    const taken = await env.DB.prepare(
      "DELETE FROM square_watchers WHERE user_id IN (SELECT value FROM json_each(?)) RETURNING user_id",
    )
      .bind(JSON.stringify(inScope.map((viewer) => viewer.user_id)))
      .all<{ user_id: string }>();
    const said = notice.squareOpened(env, {
      activityId: activity.id,
      title: activity.title,
      author: activity.username,
      deadline: activity.deadline,
    });
    await notify(
      env,
      taken.results.map((row) => ({
        userId: row.user_id,
        kind: "square_watch" as const,
        key: `square_watch:${activity.id}:${row.user_id}`,
        ...said,
      })),
    );
  });
}
