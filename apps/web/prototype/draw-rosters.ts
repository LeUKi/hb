import { useSyncExternalStore } from "react";
import { prototypeStartedAt } from "./activity-metadata";
import {
  drawOtherWinnerExamples,
  drawWinnerExamples,
  getSampleRecipients,
  getSampleResult,
  type RecipientExample,
  recipientExamples,
} from "./fixtures";
import type { Activity, DrawProgress, Participation, Scenario } from "./types";
import { effectiveDrawProgress } from "./view-state";

export type DrawRegistrationProfile = Pick<
  RecipientExample,
  "name" | "username" | "color"
>;
export type DrawRoster = {
  readonly progress: DrawProgress | null;
  readonly registrations: readonly Readonly<RecipientExample>[];
  readonly winners: readonly Readonly<RecipientExample>[];
};
export type DrawScenario = DrawProgress | Scenario;
export type DrawParticipation = {
  participation: Participation;
  participatedAt?: string;
  rewardAmount?: string;
};

const emptyRoster: DrawRoster = Object.freeze({
  progress: null,
  registrations: Object.freeze([]),
  winners: Object.freeze([]),
});
const ownProfile: DrawRegistrationProfile = {
  name: "林间",
  username: "linjian",
  color: "sage",
};

function freezeRows(rows: readonly RecipientExample[], scope: string) {
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({ ...row, id: `${scope}:${row.username}` }),
    ),
  );
}

function snapshot(
  activityId: string,
  progress: DrawProgress,
  registrations: readonly RecipientExample[],
  winners: readonly RecipientExample[],
): DrawRoster {
  return Object.freeze({
    progress,
    registrations: freezeRows(
      progress === "empty" ? [] : registrations,
      `${activityId}:registration`,
    ),
    winners: freezeRows(
      progress === "completed" ? winners : [],
      `${activityId}:winner`,
    ),
  });
}

function registrationTime(activity: Activity, offset = 0) {
  const deadline = Date.parse(activity.deadlineAt ?? "");
  return new Date(
    Math.min(
      prototypeStartedAt - 60_000,
      Number.isFinite(deadline) ? deadline - 60_000 : Infinity,
    ) -
      offset * 90_000,
  ).toISOString();
}

function publicationTime(activity: Activity) {
  const deadline = Date.parse(activity.deadlineAt ?? "");
  return new Date(
    Number.isFinite(deadline) && deadline <= prototypeStartedAt
      ? deadline + 1_000
      : prototypeStartedAt,
  ).toISOString();
}

function poolCents(activity: Activity) {
  const value = activity.poolAmount ?? activity.amount;
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value)) return 2_000;
  const [whole = "0", fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : 2_000;
}

/** Stable integer-cent allocation for the selected virtual result only. */
function allocateWinners(
  activity: Activity,
  profiles: readonly RecipientExample[],
) {
  const total = poolCents(activity);
  const selected = profiles.slice(
    0,
    Math.max(1, Math.min(Math.trunc(activity.count), profiles.length, total)),
  );
  const weights = selected.map((profile) =>
    Math.round(Number(profile.amount ?? "1.00") * 100),
  );
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let remaining = total;
  return selected.map((profile, index) => {
    const cents =
      index === selected.length - 1
        ? remaining
        : Math.max(
            1,
            Math.min(
              remaining - (selected.length - index - 1),
              Math.floor((total * (weights[index] ?? 1)) / weightTotal),
            ),
          );
    remaining -= cents;
    return {
      ...profile,
      amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
      time: publicationTime(activity),
    };
  });
}

type StoredDraw = {
  snapshot: DrawRoster;
  registrations: RecipientExample[];
  candidates: RecipientExample[];
};
export type DrawRostersSnapshot = {
  revision: number;
  draws: [string, StoredDraw][];
};

/** Activity facts survive viewer changes; reload is the only automatic reset. */
export function createDrawRosterStore() {
  const draws = new Map<string, StoredDraw>();
  const listeners = new Set<() => void>();
  let revision = 0;

  function ensure(activity: Activity): StoredDraw | null {
    if (activity.type !== "draw") return null;
    const previous = draws.get(activity.id);
    if (previous) return previous;
    const result = getSampleResult(activity.id);
    const published = getSampleRecipients(activity.id);
    const registrationCount =
      activity.registrationCount === undefined
        ? recipientExamples.length
        : Math.max(0, Math.trunc(activity.registrationCount));
    const registrations = recipientExamples
      .slice(0, registrationCount)
      .map((profile, index) => ({
        name: profile.name,
        username: profile.username,
        color: profile.color,
        time: registrationTime(activity, index),
      }));
    if (result)
      registrations.unshift({
        ...ownProfile,
        time: result.participatedAt,
      });
    const candidates = allocateWinners(
      activity,
      published?.length
        ? published
        : activity.username === ownProfile.username
          ? drawOtherWinnerExamples
          : drawWinnerExamples,
    );
    const progress = activity.drawProgress ?? "waiting";
    if (progress === "completed")
      addWinnerRegistrations(activity, registrations, candidates);
    const created: StoredDraw = {
      registrations,
      candidates,
      snapshot: snapshot(activity.id, progress, registrations, candidates),
    };
    draws.set(activity.id, created);
    return created;
  }

  function addWinnerRegistrations(
    activity: Activity,
    registrations: RecipientExample[],
    winners: readonly RecipientExample[],
  ) {
    for (const winner of winners) {
      if (registrations.some((row) => row.username === winner.username))
        continue;
      registrations.unshift({
        name: winner.name,
        username: winner.username,
        color: winner.color,
        time: registrationTime(activity),
      });
    }
  }

  function emit() {
    revision++;
    for (const listener of listeners) listener();
  }

  function exportSnapshot(): DrawRostersSnapshot {
    return structuredClone({ revision, draws: [...draws.entries()] });
  }

  function importSnapshot(snapshot: DrawRostersSnapshot | undefined) {
    if (!snapshot) return;
    draws.clear();
    for (const [activityId, draw] of structuredClone(snapshot.draws))
      draws.set(activityId, draw);
    revision = snapshot.revision;
    emit();
  }

  function getDrawRoster(activity: Activity): DrawRoster {
    return ensure(activity)?.snapshot ?? emptyRoster;
  }

  function recordDrawRegistration(
    activity: Activity,
    profile: DrawRegistrationProfile,
    time = new Date().toISOString(),
  ) {
    const draw = ensure(activity);
    if (
      !draw ||
      activity.lifecycle === "draft" ||
      !profile.username ||
      !profile.name ||
      !Number.isFinite(Date.parse(time)) ||
      effectiveDrawProgress(activity, {
        lifecycle: activity.lifecycle ?? (activity.ended ? "ended" : "active"),
        drawProgress: draw.snapshot.progress,
      }) !== "waiting" ||
      draw.registrations.some((row) => row.username === profile.username)
    )
      return false;
    draw.registrations.unshift({
      name: profile.name,
      username: profile.username,
      color: profile.color,
      time: new Date(time).toISOString(),
    });
    draw.snapshot = snapshot(activity.id, "waiting", draw.registrations, []);
    emit();
    return true;
  }

  function setDrawScenario(activity: Activity, scenario: DrawScenario) {
    const draw = ensure(activity);
    if (!draw) return emptyRoster;
    const progress: DrawProgress =
      scenario === "drawing" || scenario === "settling"
        ? "settling"
        : scenario === "completed" ||
            scenario === "won" ||
            scenario === "not-won" ||
            scenario === "draw-no-winners"
          ? "completed"
          : scenario === "draw-empty" || scenario === "empty"
            ? "empty"
            : "waiting";
    const winners =
      scenario === "draw-no-winners"
        ? []
        : scenario === "won"
          ? allocateWinners(activity, drawWinnerExamples)
          : scenario === "not-won"
            ? allocateWinners(activity, drawOtherWinnerExamples)
            : draw.candidates;
    if (
      ["registered", "drawing", "won", "not-won", "draw-no-winners"].includes(
        scenario,
      )
    )
      addWinnerRegistrations(activity, draw.registrations, [
        { ...ownProfile, time: registrationTime(activity) },
      ]);
    if (progress === "completed")
      addWinnerRegistrations(activity, draw.registrations, winners);
    draw.snapshot = snapshot(
      activity.id,
      progress,
      draw.registrations,
      winners,
    );
    emit();
    return draw.snapshot;
  }

  function resolveDrawParticipation(
    activity: Activity,
    username: string,
  ): DrawParticipation {
    const roster = getDrawRoster(activity);
    const registration = roster.registrations.find(
      (row) => row.username === username,
    );
    if (!registration) return { participation: "none" };
    const progress = effectiveDrawProgress(activity, {
      lifecycle: activity.lifecycle ?? (activity.ended ? "ended" : "active"),
      drawProgress: roster.progress,
    });
    const winner = roster.winners.find((row) => row.username === username);
    return {
      participation:
        progress === "completed"
          ? winner
            ? "won"
            : "not-won"
          : progress === "settling"
            ? "drawing"
            : "registered",
      participatedAt: registration.time,
      ...(winner?.amount ? { rewardAmount: winner.amount } : {}),
    };
  }

  return {
    getDrawRoster,
    recordDrawRegistration,
    resolveDrawParticipation,
    setDrawScenario,
    exportSnapshot,
    importSnapshot,
    getRevision: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const store = createDrawRosterStore();
export const {
  getDrawRoster,
  recordDrawRegistration,
  resolveDrawParticipation,
  setDrawScenario,
  exportSnapshot: exportDrawRostersSnapshot,
  importSnapshot: importDrawRostersSnapshot,
} = store;

export function useDrawRoster(activity: Activity) {
  return useSyncExternalStore(
    store.subscribe,
    () => getDrawRoster(activity),
    () => getDrawRoster(activity),
  );
}

/** A management list subscribes once rather than once for every row. */
export function useDrawRosterRevision() {
  return useSyncExternalStore(
    store.subscribe,
    store.getRevision,
    store.getRevision,
  );
}
