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
    password: activity.participationMode !== "direct",
    fish: activity.funding === "balance",
    authorUsername: activity.author.username,
  };
}
