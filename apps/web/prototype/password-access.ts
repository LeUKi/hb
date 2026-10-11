import type { Activity, ActivityViewState, Identity } from "./types";

/** Mock of the authorized password response; hidden answers never enter rows. */
export function projectPasswordAccess({
  activity,
  viewState,
  identity,
  solved,
  personalPassword,
  expired,
}: {
  activity: Activity;
  viewState: ActivityViewState;
  identity: Identity;
  solved: readonly string[];
  personalPassword?: string;
  expired: boolean;
}) {
  const ended = ["ended", "archived"].includes(viewState.lifecycle);
  const author = identity !== "guest" && activity.username === "linjian";
  const participated =
    identity !== "guest" && viewState.participation !== "none";
  const known = participated
    ? [...new Set(solved)].filter((text) => activity.passwords.includes(text))
    : [];
  const visible =
    ended || author ? [...new Set([...known, ...activity.passwords])] : known;
  const hiddenCount = Math.max(0, activity.passwords.length - visible.length);
  return {
    known: visible.map((text) => ({
      text,
      label:
        participated && text === (personalPassword ?? solved[0])
          ? activity.type === "draw"
            ? "已用此口令报名"
            : "已用此口令兑换"
          : known.includes(text)
            ? "已解出"
            : undefined,
    })),
    hiddenCount,
    canSolve:
      participated &&
      viewState.lifecycle === "active" &&
      !expired &&
      (viewState.drawProgress === null ||
        viewState.drawProgress === "waiting") &&
      hiddenCount > 0,
  };
}
