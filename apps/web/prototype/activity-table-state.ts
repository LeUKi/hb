import { publicActivityStatus } from "./public-activity-status";
import type { Activity, ActivityViewState } from "./types";
import { effectiveDrawProgress } from "./view-state";

/** A list projection only: passing a deadline never generates draw results. */
export function projectActivityTableState(
  activity: Activity,
  state: ActivityViewState,
  now = Date.now(),
): ActivityViewState {
  if (state.lifecycle === "draft" || state.lifecycle === "archived")
    return state;
  const drawProgress = effectiveDrawProgress(activity, state, now);
  return {
    ...state,
    lifecycle: publicActivityStatus(activity, state, now),
    drawProgress,
    participation:
      state.participation === "registered" && drawProgress === "settling"
        ? "drawing"
        : state.participation,
  };
}
