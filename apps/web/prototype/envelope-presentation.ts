import type { EnvelopeReward } from "./components/envelope";
import type { Activity, ActivityViewState, Identity } from "./types";

/** UI projection only. Open paper never creates a participation or reward. */
export function envelopePresentation({
  activity,
  state,
  identity,
  amount,
}: {
  activity: Activity;
  state: ActivityViewState;
  identity: Identity;
  amount?: string;
}): EnvelopeReward | undefined {
  if (state.participation === "claimed" || state.participation === "won")
    return { kind: "ldc", amount: amount ?? "—" };
  if (
    activity.type === "draw" &&
    state.drawProgress !== "completed" &&
    state.drawProgress !== "empty"
  )
    return undefined;
  if (state.participation === "not-won") return { kind: "not-won" };
  if (state.lifecycle !== "ended" && state.lifecycle !== "archived")
    return undefined;
  return {
    kind:
      identity === "guest" || activity.username === "linjian"
        ? "ended"
        : "missed",
  };
}
