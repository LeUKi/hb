// 私信通知's pages (docs/notification-design.md §4): someone's switches and
// what was sent to them, 开放时提醒我 on a timed 红包, and the 站长's count.

import {
  isNoticeCategory,
  NOTICE_CATEGORIES,
  type NoticeAvailability,
  type NoticeCategory,
  type NoticeRecent,
  type NoticeSettingsView,
  type OpeningWatchView,
  type SquareWatchView,
  updateNoticePaceSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { ActivityError } from "../activities/errors";
import { findActivity } from "../activities/storage";
import { isAdministrator } from "../admin/authorization";
import {
  getOptionalSession,
  requireAdmin,
  requireAdminMutation,
  requireAuth,
  requireProtectedMutation,
} from "../auth/session";
import type { ApiBindings, ApiContext } from "../env";
import { noticeAdminStats, readNoticePace } from "./outbox";

const RECENT_MS = 30 * 86_400_000;

type Reachable = {
  provider: string;
  external_id: string;
  has_email: number;
};

/** Whether a 私信通知 can reach this account at all. */
export function availabilityOf(
  env: ApiBindings,
  user: Reachable | null,
): NoticeAvailability {
  if (!user) return "no_email";
  if (isAdministrator(env, user.provider, user.external_id)) return "owner";
  return user.has_email ? "ok" : "no_email";
}

export async function noticeSettingsOf(
  env: ApiBindings,
  userId: string,
  now = Date.now(),
): Promise<NoticeSettingsView> {
  const [user, settings, recent, groups] = await env.DB.batch([
    env.DB.prepare(
      "SELECT provider, external_id, email_ciphertext IS NOT NULL AS has_email FROM users WHERE id=?",
    ).bind(userId),
    env.DB.prepare(
      "SELECT category, enabled FROM notification_settings WHERE user_id=?",
    ).bind(userId),
    env.DB.prepare(
      `SELECT id, subject, status, created_at, sent_at FROM notifications
       WHERE user_id=? AND created_at>=? AND status IN ('queued','sent','failed')
       ORDER BY created_at DESC LIMIT 50`,
    ).bind(userId, now - RECENT_MS),
    env.DB.prepare(
      `SELECT EXISTS(SELECT 1 FROM judges WHERE author_id=?1) AS judge,
        EXISTS(SELECT 1 FROM points_systems WHERE owner_id=?1) AS points`,
    ).bind(userId),
  ]);
  const switches = Object.fromEntries(
    NOTICE_CATEGORIES.map((category) => [category, true]),
  ) as Record<NoticeCategory, boolean>;
  for (const row of (settings?.results ?? []) as {
    category: string;
    enabled: number;
  }[])
    if (isNoticeCategory(row.category))
      switches[row.category] = row.enabled === 1;
  const seen = groups?.results?.[0] as
    | { judge: number; points: number }
    | undefined;
  return {
    availability: availabilityOf(
      env,
      (user?.results?.[0] as Reachable | undefined) ?? null,
    ),
    switches,
    groups: { judge: Boolean(seen?.judge), points: Boolean(seen?.points) },
    recent: (
      (recent?.results ?? []) as {
        id: string;
        subject: string;
        status: NoticeRecent["status"];
        created_at: number;
        sent_at: number | null;
      }[]
    ).map((row) => ({
      id: row.id,
      subject: row.subject,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      sentAt: row.sent_at === null ? null : new Date(row.sent_at).toISOString(),
    })),
  };
}

/**
 * 开放时提醒我 as a timed 红包's page shows it: only to a signed-in viewer
 * other than its sender whom a notice can reach.
 */
export async function openingWatchOf(
  env: ApiBindings,
  activity: {
    id: string;
    authorId: string;
    openedAt: number | null;
    scheduledOpenAt: number | null;
  },
  viewerId: string | undefined,
) {
  if (
    !viewerId ||
    viewerId === activity.authorId ||
    activity.openedAt !== null ||
    activity.scheduledOpenAt === null
  )
    return undefined;
  const row = await env.DB.prepare(
    `SELECT u.provider, u.external_id, u.email_ciphertext IS NOT NULL AS has_email,
      EXISTS(SELECT 1 FROM opening_watchers w WHERE w.activity_id=? AND w.user_id=u.id) AS watching
     FROM users u WHERE u.id=?`,
  )
    .bind(activity.id, viewerId)
    .first<Reachable & { watching: number }>();
  if (availabilityOf(env, row) !== "ok") return undefined;
  return { watching: Boolean(row?.watching) };
}

/** 下一个红包开放时提醒我 in 红包广场: undefined when no notice can reach them. */
async function squareWatchOf(env: ApiBindings, userId: string) {
  const row = await env.DB.prepare(
    `SELECT u.provider, u.external_id, u.email_ciphertext IS NOT NULL AS has_email,
      EXISTS(SELECT 1 FROM square_watchers w WHERE w.user_id=u.id) AS watching
     FROM users u WHERE u.id=?`,
  )
    .bind(userId)
    .first<Reachable & { watching: number }>();
  if (availabilityOf(env, row) !== "ok") return null;
  return { watching: Boolean(row?.watching) };
}

/** How many wait for 红包广场's next 红包: a number only, never who. */
async function squareWaiting(env: ApiBindings) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS waiting FROM square_watchers",
  ).first<{ waiting: number }>();
  return row?.waiting ?? 0;
}

export const noticeRoutes = new Hono<ApiContext>()
  .get("/me/notifications", async (c) => {
    const session = await requireAuth(c);
    return c.json(await noticeSettingsOf(c.env, session.user.id));
  })
  .put("/me/notifications/:category", async (c) => {
    const session = await requireProtectedMutation(c);
    const category = c.req.param("category");
    const body = (await c.req.json().catch(() => null)) as {
      enabled?: unknown;
    } | null;
    if (!isNoticeCategory(category) || typeof body?.enabled !== "boolean")
      throw new ActivityError(400, "INVALID_NOTICE_SETTING", "设置无效");
    await c.env.DB.prepare(
      `INSERT INTO notification_settings (user_id,category,enabled,updated_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id,category) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`,
    )
      .bind(session.user.id, category, body.enabled ? 1 : 0, Date.now())
      .run();
    return c.json(await noticeSettingsOf(c.env, session.user.id));
  })
  // 开放时提醒我: whether this viewer can, and has.
  .get("/activities/:id/opening-watch", async (c) => {
    const session = await getOptionalSession(c);
    const activity = await findActivity(c.env, c.req.param("id"));
    const watch = activity
      ? await openingWatchOf(c.env, activity, session?.user.id)
      : undefined;
    return c.json({ openingWatch: watch ?? null } satisfies OpeningWatchView);
  })
  // On, or off again.
  .put("/activities/:id/opening-watch", async (c) => {
    const session = await requireProtectedMutation(c);
    const body = (await c.req.json().catch(() => null)) as {
      watching?: unknown;
    } | null;
    if (typeof body?.watching !== "boolean")
      throw new ActivityError(400, "INVALID_OPENING_WATCH", "设置无效");
    const activity = await findActivity(c.env, c.req.param("id"));
    if (!activity)
      throw new ActivityError(404, "ACTIVITY_NOT_FOUND", "红包不存在");
    const current = await openingWatchOf(c.env, activity, session.user.id);
    if (!current)
      throw new ActivityError(
        409,
        "OPENING_WATCH_UNAVAILABLE",
        activity.openedAt !== null
          ? "红包已经开放了。"
          : "这个红包现在不能提醒。",
      );
    await (body.watching
      ? c.env.DB.prepare(
          "INSERT INTO opening_watchers (activity_id,user_id,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING",
        ).bind(activity.id, session.user.id, Date.now())
      : c.env.DB.prepare(
          "DELETE FROM opening_watchers WHERE activity_id=? AND user_id=?",
        ).bind(activity.id, session.user.id)
    ).run();
    return c.json({
      openingWatch: { watching: body.watching },
    } satisfies OpeningWatchView);
  })
  // 红包广场's 下一个红包开放时提醒我: whether this viewer can, and has.
  .get("/square/watch", async (c) => {
    const session = await getOptionalSession(c);
    const [watch, waiting] = await Promise.all([
      session ? squareWatchOf(c.env, session.user.id) : null,
      squareWaiting(c.env),
    ]);
    return c.json({ squareWatch: watch, waiting } satisfies SquareWatchView);
  })
  // On (used up by the next 红包 they may claim), or off again.
  .put("/square/watch", async (c) => {
    const session = await requireProtectedMutation(c);
    const body = (await c.req.json().catch(() => null)) as {
      watching?: unknown;
    } | null;
    if (typeof body?.watching !== "boolean")
      throw new ActivityError(400, "INVALID_SQUARE_WATCH", "设置无效");
    if (!(await squareWatchOf(c.env, session.user.id)))
      throw new ActivityError(
        409,
        "SQUARE_WATCH_UNAVAILABLE",
        "本站还没有你的隐私邮箱，发不了私信提醒。",
      );
    await (body.watching
      ? c.env.DB.prepare(
          "INSERT INTO square_watchers (user_id,created_at) VALUES (?,?) ON CONFLICT DO NOTHING",
        ).bind(session.user.id, Date.now())
      : c.env.DB.prepare("DELETE FROM square_watchers WHERE user_id=?").bind(
          session.user.id,
        )
    ).run();
    return c.json({
      squareWatch: { watching: body.watching },
      waiting: await squareWaiting(c.env),
    } satisfies SquareWatchView);
  })
  .get("/admin/notifications", async (c) => {
    await requireAdmin(c);
    return c.json(await noticeAdminStats(c.env));
  })
  // How far apart mails go (§2.3), changed by the 站长 at any time.
  .get("/admin/notifications/pace", async (c) => {
    await requireAdmin(c);
    return c.json({ pace: await readNoticePace(c.env) });
  })
  .patch("/admin/notifications/pace", async (c) => {
    const session = await requireAdminMutation(c);
    const input = updateNoticePaceSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      throw new ActivityError(
        400,
        "INVALID_NOTICE_PACE",
        "间隔要填 0 到 600 秒、0 到 3600 秒的整数",
      );
    const { expectedVersion, anyGapSeconds, samePersonGapSeconds } = input.data;
    const saved = await c.env.DB.prepare(
      `UPDATE notice_settings SET any_gap_seconds=?,same_person_gap_seconds=?,version=version+1,
        updated_by=?,updated_at=? WHERE id='global' AND version=?`,
    )
      .bind(
        anyGapSeconds,
        samePersonGapSeconds,
        session.user.id,
        Date.now(),
        expectedVersion,
      )
      .run();
    if (saved.meta.changes === 0)
      throw new ActivityError(
        409,
        "NOTICE_PACE_CHANGED",
        "设置刚被改过，刷新后再改。",
      );
    return c.json({ pace: await readNoticePace(c.env) });
  });
