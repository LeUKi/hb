import type { ActivityLiveMessage, PublicActivity } from "@hb/contracts";

// A running 红包's live channel: its ActivityDO (one per 红包) holds the
// viewers' WebSockets, hibernating between changes, and pushes the public
// read after each one. Signed-in viewers only; everyone else polls.

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
/** What the browser sends to keep the line open; answered without waking. */
export const LIVE_PING = "ping";
export const LIVE_PONG = "pong";

/** Nothing more will change for anyone watching: the result is out. */
export function liveEnded(activity: PublicActivity) {
  if (activity.draw)
    return (
      activity.draw.state === "completed" || activity.draw.state === "empty"
    );
  return activity.status !== "active";
}

export function liveMessage(activity: PublicActivity) {
  return JSON.stringify({
    type: "activity",
    activity,
  } satisfies ActivityLiveMessage);
}
