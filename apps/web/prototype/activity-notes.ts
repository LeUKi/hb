import type { Activity, ActivityViewState, Identity } from "./types";

export type VisibleActivityNotes = {
  before?: string;
  after?: string;
  ended?: string;
};

function nonempty(value: string | undefined) {
  return value?.trim() ? value : undefined;
}

/** Local authorization projection. Production must return only authorized text. */
export function projectActivityNotes(
  activity: Activity,
  state: ActivityViewState,
  identity: Identity,
): VisibleActivityNotes {
  const eligible = identity === "standard";
  const hasReward =
    state.participation === "claimed" || state.participation === "won";
  const ended = state.lifecycle === "ended" || state.lifecycle === "archived";
  return {
    before: nonempty(activity.beforeInfo),
    after:
      eligible && hasReward ? nonempty(activity.afterClaimInfo) : undefined,
    ended: ended ? nonempty(activity.afterEndInfo) : undefined,
  };
}
