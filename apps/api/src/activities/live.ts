import type {
  ActivityLiveMessage,
  JudgeAnnouncement,
  JudgeView,
  PublicActivity,
} from "@hb/contracts";
import type { ApiBindings } from "../env";
import { activityObject } from "../runtime/objects";
import type { ActivityRow } from "./storage";

// A 红包's live channel: its ActivityDO (one per 红包) holds the viewers'
// WebSockets, hibernating between changes. It pushes the public read after
// each change, tells a person when only their own part moved (a payment),
// and tells everyone how many people are watching (and, for 代码判定, how
// many times its code has judged, and from protocol 4 what everyone sees
// and the new lines in 动态). Signed-in viewers only;
// everyone else polls. The channel lasts while the 红包 runs, and after
// that for whoever still waits on a payment.

/** Every live socket of a 红包's DO. */
export const LIVE_TAG = "live";
/** One person's sockets (tabs, devices) in that DO. */
export const liveUserTag = (userId: string) => `u:${userId}`;
/** The HTTP route's word for who connected; never a client's. */
export const LIVE_USER_HEADER = "X-HB-Live-User";
/** Enough tabs and devices for one person: a new one replaces the oldest. */
export const MAX_LIVE_PER_USER = 4;
/** Past this the page polls instead, and the DO stays responsive. */
export const MAX_LIVE_SOCKETS = 5_000;
/** At most one push per window: a rush of claims goes out together. */
export const LIVE_COALESCE_MS = 300;
/**
 * 代码判定's 已判定 N 次, its view and 动态: as a claim's, at most one push
 * per window (docs/multi-prize-design.md §4.3; once a second before).
 */
export const LIVE_JUDGED_MS = LIVE_COALESCE_MS;
/** Past the deadline by this much, the DO's clock and D1's agree it is. */
export const LIVE_DEADLINE_MARGIN_MS = 250;
/** What the browser sends to keep the line open; answered without waking. */
export const LIVE_PING = "ping";
export const LIVE_PONG = "pong";

/**
 * Nothing more will change for anyone watching: the result is out. A draft
 * is not on the channel, unless it is timed to open: people wait for it
 * (N 人在看) and hear it open (scheduled-opening §6).
 */
export function liveEnded(activity: PublicActivity) {
  if (activity.status === "draft")
    return activity.scheduledOpenAt === undefined;
  if (activity.draw)
    return (
      activity.draw.state === "completed" || activity.draw.state === "empty"
    );
  return activity.status !== "active";
}

// Everything sent to everyone carries the channel's number (`seq`, one
// up each time, kept by the 红包's object): a page that sees one skipped
// reads the 红包 whole again. What goes to one person carries none.

export function liveMessage(activity: PublicActivity, seq: number) {
  return JSON.stringify({
    type: "activity",
    activity,
    seq,
  } satisfies ActivityLiveMessage);
}

export const liveMine = () =>
  JSON.stringify({ type: "mine" } satisfies ActivityLiveMessage);

export const liveQueued = (ahead: number) =>
  JSON.stringify({ type: "queued", ahead } satisfies ActivityLiveMessage);

export const liveViewers = (count: number, seq: number) =>
  JSON.stringify({ type: "viewers", count, seq } satisfies ActivityLiveMessage);

export const liveJudged = (
  count: number,
  seq: number,
  unclaimed: string | undefined,
) =>
  JSON.stringify({
    type: "judged",
    count,
    ...(unclaimed !== undefined ? { unclaimed } : {}),
    seq,
  } satisfies ActivityLiveMessage);

export const liveView = (view: JudgeView, seq: number) =>
  JSON.stringify({ type: "view", view, seq } satisfies ActivityLiveMessage);

export const liveAnnounce = (
  items: JudgeAnnouncement[],
  total: number,
  seq: number,
) =>
  JSON.stringify({
    type: "announce",
    items,
    total,
    seq,
  } satisfies ActivityLiveMessage);

/** What a refresh may have moved: pushed only when something did. */
export function liveFingerprint(row: ActivityRow | null | undefined) {
  return row
    ? [
        row.version,
        row.drawState,
        row.deadline,
        row.endedAt,
        row.archivedAt,
        row.claimedCount,
        row.registeredCount,
      ].join("|")
    : "";
}

/**
 * Who still waits on this 红包 once it is over: each person whose payment
 * is on its way, and the sender while any is. One stopped in attention
 * waits on nobody: only its claimant moves it again (payments/resend.ts).
 */
export async function liveWaiting(
  env: ApiBindings,
  activityId: string,
  authorId: string,
) {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT c.user_id AS userId FROM payment_tasks p
      JOIN claims c ON c.id = p.claim_id
      WHERE c.activity_id = ? AND p.source = 'claim'
        AND p.status IN ('pending','sending','reconciling','waiting')`,
  )
    .bind(activityId)
    .all<{ userId: string }>();
  const waiting = new Set(rows.results.map((row) => row.userId));
  if (waiting.size > 0) waiting.add(authorId);
  return waiting;
}

/**
 * A claim's payment moved (the merchant cycle): its claimant and the
 * sender hear of it, if they have the 红包's page open.
 */
export async function tellPaymentWatchers(env: ApiBindings, taskId: string) {
  const row = await env.DB.prepare(
    `SELECT c.activity_id AS activityId, c.user_id AS userId, a.author_id AS authorId
      FROM payment_tasks p JOIN claims c ON c.id = p.claim_id
      JOIN activities a ON a.id = c.activity_id
      WHERE p.id = ? AND p.source = 'claim'`,
  )
    .bind(taskId)
    .first<{ activityId: string; userId: string; authorId: string }>();
  if (!row) return;
  const stub = activityObject(env, row.activityId);
  const response = await stub.fetch(
    `https://activity.internal/internal/activities/${encodeURIComponent(row.activityId)}/live/mine`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds: [row.userId, row.authorId] }),
    },
  );
  await response.arrayBuffer();
}
