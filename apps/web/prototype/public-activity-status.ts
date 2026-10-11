import { isActivityDeadlineReached } from "./activity-metadata";
import type { Activity, ActivityViewState } from "./types";
import { effectiveDrawProgress } from "./view-state";

export type PublicActivityStatus = "active" | "ended";

/** Public browsing status does not change admission or publish draw results. */
export function publicActivityStatus(
  activity: Activity,
  state: ActivityViewState,
  now = Date.now(),
): PublicActivityStatus {
  if (activity.type === "draw") {
    const progress = effectiveDrawProgress(activity, state, now);
    return progress === "completed" || progress === "empty"
      ? "ended"
      : "active";
  }
  return state.lifecycle === "ended" ||
    state.lifecycle === "archived" ||
    isActivityDeadlineReached(activity, now)
    ? "ended"
    : "active";
}
