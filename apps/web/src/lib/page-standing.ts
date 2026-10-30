import { type PublicActivity, publicScopeAllows } from "@hb/contracts";
import type { ParticipationCache } from "./participation-cache";

// Where a viewer stands with a 红包, as its page can tell without asking
// the server (docs/judge-page-design.md §11.11, §11.12): the reason they
// cannot take part now, or null when they can. hb.fill() and hb.me() both
// read it; the server still decides as they send.

export type PageStanding =
  | "login"
  | "not_open"
  | "ended"
  | "paused"
  | "already_claimed"
  | "not_in_scope";

export function pageStanding(
  activity: PublicActivity,
  account: { username: string; trustLevel: number | null } | null,
  participation: ParticipationCache | undefined,
  now = Date.now(),
): PageStanding | null {
  if (!account) return "login";
  if (activity.status === "draft") return "not_open";
  const deadline = activity.draw?.deadlineAt ?? activity.deadlineAt;
  if (activity.status !== "active" || (deadline && Date.parse(deadline) <= now))
    return "ended";
  if (activity.participationMode === "code" && activity.judge?.paused)
    return "paused";
  if (participation?.claim || participation?.registration)
    return "already_claimed";
  if (
    !publicScopeAllows(activity.scope, {
      username: account.username,
      trustLevel: account.trustLevel,
    })
  )
    return "not_in_scope";
  return null;
}
