import { useQuery } from "@tanstack/react-query";
import { activityKeys, type PublicActivityDetail } from "./activities";
import { useSessionUser } from "./session";

/** What the shell says about a 红包 it names (scope chip, address, hints). */
export type ActivityFacts = {
  id: string;
  title: string;
  /** 限时开奖: one signs up instead of claiming. */
  timedDraw: boolean;
  /** 口令尝试统计: attempts here are summed up for its sender. */
  statistics: boolean;
  authorUsername: string;
};

/**
 * The 红包 page's own public read, from the cache: the shell never fetches
 * it, it shows what the page on screen already has (or nothing yet).
 */
export function useActivityFacts(id: string | null): ActivityFacts | null {
  const user = useSessionUser();
  const query = useQuery<PublicActivityDetail>({
    queryKey: activityKeys.public(id ?? "", user?.id ?? null),
    queryFn: () => Promise.reject(new Error("read by the 红包 page")),
    enabled: false,
  });
  const activity = id ? query.data?.activity : undefined;
  if (!activity) return null;
  return {
    id: activity.id,
    title: activity.title,
    timedDraw: activity.reward?.mode === "timed_draw",
    statistics: activity.forceDedicated,
    authorUsername: activity.author.username,
  };
}
