import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { activityKeys, type PublicActivityDetail } from "./activities";
import { useCachedQueryData } from "./cached-query";
import { useSessionUser } from "./session";

/** What the shell says about a 红包 it names (scope chip, address, hints). */
export type ActivityFacts = {
  id: string;
  title: string;
  /** 限时开奖: one signs up instead of claiming. */
  timedDraw: boolean;
  /** A 口令红包: what is typed here is summed up for its sender (07 §7). */
  password: boolean;
  /** 🐟额红包: nothing is paid out, so it has no 付款记录. */
  fish: boolean;
  authorUsername: string;
  /** 代码判定红包: what its sender wrote above the box (02 §4). */
  code?: { prompt: string };
};

/**
 * The 红包 page's own public read, from the cache: the shell never fetches
 * it, it shows what the page on screen already has (or nothing yet).
 */
export function useActivityFacts(id: string | null): ActivityFacts | null {
  const user = useSessionUser();
  const detail = useCachedQueryData<PublicActivityDetail>(
    id ? activityKeys.public(id, user?.id ?? null) : null,
  );
  const activity = detail?.activity;
  if (!activity) return null;
  return {
    id: activity.id,
    title: activity.title,
    timedDraw: activity.reward?.mode === "timed_draw",
    password: activity.participationMode === "password",
    fish: activity.funding === "balance",
    authorUsername: activity.author.username,
    ...(activity.judge ? { code: { prompt: activity.judge.prompt } } : {}),
  };
}

type Look = { code: boolean; ended: boolean };

/**
 * One read's word on a 红包: a summary, a card, or the 红包 of a claim or
 * a sign-up (我参与的). Ended as its page draws it: over, and not taken
 * part in (a draft is not over).
 */
function lookOf(value: unknown, id: string, joined = false): Look | null {
  if (!value || typeof value !== "object") return null;
  const item = value as {
    id?: unknown;
    participationMode?: unknown;
    status?: unknown;
    myClaim?: unknown;
    myRegistration?: unknown;
    activity?: unknown;
    claim?: unknown;
    registration?: unknown;
  };
  if (item.id === id && typeof item.participationMode === "string")
    return {
      code: item.participationMode === "code",
      ended:
        (item.status === "ended" || item.status === "archived") &&
        !joined &&
        !item.myClaim &&
        !item.myRegistration,
    };
  if (item.activity) return lookOf(item.activity, id, joined);
  // A claim or sign-up of the viewer's: its 红包 was taken part in.
  const mine = item.claim ?? item.registration;
  return mine ? lookOf(mine, id, true) : null;
}

/** In a list read (items, or pages of items), the 红包 with this id. */
function lookIn(data: unknown, id: string): Look | null {
  if (!data || typeof data !== "object") return null;
  const read = data as { items?: unknown; pages?: unknown };
  const lists = Array.isArray(read.pages)
    ? (read.pages as { items?: unknown }[]).map((page) => page?.items)
    : [read.items];
  for (const items of lists)
    if (Array.isArray(items))
      for (const item of items) {
        const look = lookOf(item, id);
        if (look) return look;
      }
  return null;
}

function coverLook(
  client: QueryClient,
  id: string,
  userId: string | null,
): Look | null {
  const own = client.getQueryData<PublicActivityDetail>(
    activityKeys.public(id, userId),
  )?.activity;
  if (own) return lookOf(own, id);
  for (const query of client.getQueryCache().getAll()) {
    const look = lookIn(query.state.data, id);
    if (look) return look;
  }
  return null;
}

/**
 * Before its page's own read: what a list already read says about this
 * 红包's cover, so the skeleton is drawn in its colours (a 代码判定红包's
 * lacquer, 05 §14). Null when nothing on hand names it.
 */
export function useCoverLook(id: string): Look | null {
  const client = useQueryClient();
  const user = useSessionUser();
  return coverLook(client, id, user?.id ?? null);
}
