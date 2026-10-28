import type {
  ActivityParticipationResponse,
  PublicActivity,
} from "@hb/contracts";
import { useAtomValue } from "jotai";
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
import type { LiveWant } from "../../lib/live";
import {
  liveActivityAtom,
  participationOpen,
  pastDeadline,
  paymentOpen,
  publicSettled,
} from "../../lib/live-state";
import { useRosterList } from "../../lib/roster";
import { useIdentity } from "../../lib/session";
import { useBefore } from "../../lib/use-before";
import { queriesLoad } from "../page/page-state";
import type { HongbaoData } from "./use-hongbao";

/** Unpushed, a running 红包 is read again this often; its lists slower. */
const POLL_MS = 5_000;
const LIST_POLL_MS = 15_000;
const DRAWING_POLL_MS = 1_000;

/** Past its time, a timed draft is asked this often until it opens. */
const DUE_POLL_MS = 1_000;

/** When a timed draft opens (scheduled-opening §4); null otherwise. */
function opensBy(activity: PublicActivity | undefined) {
  return activity?.status === "draft" && activity.scheduledOpenAt
    ? Date.parse(activity.scheduledOpenAt)
    : null;
}

/** A draw in its seconds between closing and its result: read every second until 30 s past its round. */
function drawing(activity: PublicActivity | undefined) {
  if (activity?.draw?.state !== "settling") return false;
  const proof = activity.drawProof;
  const at =
    proof?.kind === "draw"
      ? Date.parse(proof.roundAt)
      : Date.parse(activity.deadlineAt ?? "");
  return Date.now() < at + 30_000;
}

/**
 * One 红包's data for its page and its dialogs (名单, 说明): the public read,
 * the sender's own read, the viewer's claim or sign-up, their 口令 and the
 * roster. Every reader shares the same queries.
 *
 * While the live channel is open (lib/live.ts) nothing here polls: the
 * public read arrives pushed, and the rest is read again when a push says
 * it moved. Without it (guests, or turned away) the running 红包 polls.
 * Once it is over nothing does, but a payment still on its way.
 */
/** 自领: the 口令 the sender took their own share (or place) with. */
function usedBySender(
  participation: Partial<ActivityParticipationResponse> | undefined,
) {
  const registration = participation?.registration;
  if (registration?.sourcePassword)
    return { text: registration.sourcePassword, label: "registered" as const };
  const claim = participation?.claim;
  return claim?.sourcePassword
    ? { text: claim.sourcePassword, label: "claimed" as const }
    : null;
}

export function useHongbaoPageData(id: string) {
  const identity = useIdentity();
  const user = identity.user;
  const userId = user?.id ?? null;
  const live = useAtomValue(liveActivityAtom) === id;
  const publicQuery = usePublicActivity(
    id,
    userId,
    identity.ready,
    (activity) =>
      publicSettled(activity)
        ? false
        : // 定时开放 past its time: every second until it has opened.
          (opensBy(activity) ?? Number.POSITIVE_INFINITY) <= Date.now()
          ? DUE_POLL_MS
          : // Being drawn (开奖证明): each step as it comes, pushed or not.
            drawing(activity)
            ? DRAWING_POLL_MS
            : // Past the deadline the push should say so; until it has, ask.
              live && !pastDeadline(activity)
              ? false
              : POLL_MS,
  );
  const activity = publicQuery.data?.activity;
  const settled = publicSettled(activity);
  // 定时开放 (scheduled-opening §4): read again right at its time, so all
  // watching turn together; then the poll above asks every second.
  const opensAt = opensBy(activity);
  const refetchPublic = publicQuery.refetch;
  useEffect(() => {
    if (opensAt === null) return;
    const left = opensAt - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => void refetchPublic(), left + 50);
    return () => clearTimeout(timer);
  }, [opensAt, refetchPublic]);
  // Only the clock ends a 红包 at its deadline: the page turns over then.
  useBefore(
    activity && !activity.draw && activity.deadlineAt && !settled
      ? Date.parse(activity.deadlineAt)
      : 0,
  );
  const running = Boolean(activity) && !settled;
  const author = Boolean(activity && user && activity.author.id === user.id);
  const managedQuery = useManagedActivity(
    userId ?? "",
    id,
    author,
    // A 草稿 waits on its merchant to open; the rest changes by its sender.
    activity?.status === "draft" ? LIST_POLL_MS : false,
  );
  // The sender's too: they may take a share of their own (自领,
  // docs/self-claim-design.md).
  const participationQuery = useCurrentParticipation(
    userId ?? "",
    id,
    Boolean(activity && userId),
    activity?.draw?.state,
    live,
  );
  const passwordsEnabled = Boolean(activity && !author);
  const passwordsQuery = useActivityPasswords(
    userId,
    id,
    passwordsEnabled,
    activity?.participationMode,
    running && !live ? LIST_POLL_MS : false,
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
  const listPoll = (paymentsOpen: boolean) =>
    live
      ? false
      : // The sender's 名单 shows each payment until it is through.
        running || (author && paymentsOpen)
        ? LIST_POLL_MS
        : false;
  const claims = useRosterList(id, "claims", {
    enabled: claimsEnabled,
    viewer,
    author: author ? userId : null,
    poll: listPoll,
  });
  const registrations = useRosterList(id, "registrations", {
    enabled: registrationsEnabled,
    viewer,
    author: author ? userId : null,
    poll: listPoll,
  });
  // The lists follow the numbers above them: a read that shows someone new
  // (the 名单入口's faces changed), a draw that moved on or the end (the
  // 手气王 / 手气亡) reads them again at once.
  const rosterSignature = activity
    ? `${activity.status}|${activity.draw?.state ?? ""}|${(
        activity.rosterPreview ?? []
      )
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
  // At the end every 口令 shows: read them once more.
  const seenSettled = useRef(settled);
  const refetchPasswords = passwordsQuery.refetch;
  useEffect(() => {
    const before = seenSettled.current;
    seenSettled.current = settled;
    if (!before && settled && passwordsEnabled) void refetchPasswords();
  }, [settled, passwordsEnabled, refetchPasswords]);

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
        author && managed
          ? {
              passwords: managed.config.passwords,
              used: usedBySender(participationQuery.data),
            }
          : null,
      ),
      mine: mineOf(participationQuery.data, view, roster),
      author,
    };
  }
  // What the live channel is for: the 红包 running, or after it a payment
  // this person sees (theirs; for the sender, any in the 名单).
  const liveWant: LiveWant =
    !user || !activity || activity.status === "draft"
      ? null
      : running
        ? "running"
        : (
              author
                ? claims.rows.some((row) => paymentOpen(row.payment))
                : participationOpen(participationQuery.data)
            )
          ? "waiting"
          : null;
  return {
    data,
    missing,
    identity,
    liveWant,
    /** The page waits for the public read (and the sender's own). */
    load: author
      ? queriesLoad(publicQuery, managedQuery)
      : queriesLoad(publicQuery),
    rosterLists: { claims, registrations },
  };
}

export type HongbaoPageData = ReturnType<typeof useHongbaoPageData>;
