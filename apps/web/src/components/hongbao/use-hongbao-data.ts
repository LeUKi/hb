import { useEffect, useRef } from "react";
import {
  ActivityRequestError,
  useManagedActivity,
  usePublicActivity,
} from "../../lib/activities";
import { useActivityPasswords } from "../../lib/activity-passwords";
import { useCurrentParticipation } from "../../lib/claims";
import {
  hongbaoOf,
  mineOf,
  passwordViewOf,
  publicViewOf,
  rosterOf,
} from "../../lib/hongbao";
import { useRosterList } from "../../lib/roster";
import { useIdentity } from "../../lib/session";
import { queriesLoad } from "../page/page-state";
import type { HongbaoData } from "./use-hongbao";

/**
 * One 红包's data for its page and its dialogs (名单, 说明): the public read,
 * the sender's own read, the viewer's claim or sign-up, their 口令 and the
 * roster. Every reader shares the same queries.
 */
export function useHongbaoPageData(id: string) {
  const identity = useIdentity();
  const user = identity.user;
  const userId = user?.id ?? null;
  const publicQuery = usePublicActivity(id, userId, identity.ready);
  const activity = publicQuery.data?.activity;
  const author = Boolean(activity && user && activity.author.id === user.id);
  const managedQuery = useManagedActivity(userId ?? "", id, author);
  const participationQuery = useCurrentParticipation(
    userId ?? "",
    id,
    Boolean(activity && userId && !author),
    activity?.draw?.state,
  );
  const passwordsQuery = useActivityPasswords(
    userId,
    id,
    Boolean(activity && !author),
    activity?.participationMode,
  );
  const draw = activity?.reward?.mode === "timed_draw";
  const viewer = user?.username ?? null;
  const claimsEnabled = Boolean(
    activity &&
      activity.status !== "draft" &&
      (!draw || activity.draw?.state === "completed"),
  );
  const registrationsEnabled = Boolean(
    activity && activity.status !== "draft" && draw,
  );
  const claims = useRosterList(id, "claims", {
    enabled: claimsEnabled,
    viewer,
    author: author ? userId : null,
  });
  const registrations = useRosterList(id, "registrations", {
    enabled: registrationsEnabled,
    viewer,
    author: author ? userId : null,
  });
  // The lists follow the numbers above them: a read that shows someone new
  // (the 名单入口's faces changed) or a draw that moved on reads them again
  // at once, instead of a polling round later.
  const rosterSignature = activity
    ? `${activity.draw?.state ?? ""}|${(activity.rosterPreview ?? [])
        .map((person) => person.id)
        .join(",")}`
    : null;
  const seenSignature = useRef(rosterSignature);
  const refetchClaims = claims.query.refetch;
  const refetchRegistrations = registrations.query.refetch;
  useEffect(() => {
    if (rosterSignature === null) return;
    const before = seenSignature.current;
    seenSignature.current = rosterSignature;
    if (before === null || before === rosterSignature) return;
    if (claimsEnabled) void refetchClaims();
    if (registrationsEnabled) void refetchRegistrations();
  }, [
    rosterSignature,
    claimsEnabled,
    registrationsEnabled,
    refetchClaims,
    refetchRegistrations,
  ]);

  const missing =
    publicQuery.error instanceof ActivityRequestError &&
    (publicQuery.error.status === 404 || publicQuery.error.status === 403);
  const managed = managedQuery.data?.activity ?? null;
  const ready = Boolean(activity) && (!author || managed !== null);
  let data: HongbaoData | null = null;
  if (activity && ready) {
    const view = publicViewOf(activity);
    const roster = rosterOf(view, claims.rows, registrations.rows);
    data = {
      activity: hongbaoOf(activity, managed),
      view,
      roster,
      passwords: passwordViewOf(
        passwordsQuery.data,
        author && managed ? { passwords: managed.config.passwords } : null,
      ),
      mine: author ? null : mineOf(participationQuery.data, view, roster),
      author,
    };
  }
  return {
    data,
    missing,
    identity,
    /** The page waits for the public read (and the sender's own). */
    load: author
      ? queriesLoad(publicQuery, managedQuery)
      : queriesLoad(publicQuery),
    rosterLists: { claims, registrations },
  };
}

export type HongbaoPageData = ReturnType<typeof useHongbaoPageData>;
