import type {
  ActivityParticipationResponse,
  PublicActivity,
} from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import {
  ActivityRequestError,
  useManagedActivity,
  usePublicActivity,
} from "../../lib/activities";
import { useActivityPasswords } from "../../lib/activity-passwords";
import { useCurrentActivityId } from "../../lib/activity-route";
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

/**
 * A timed draft off the live channel (a guest's) is read this often: it
 * changes when its sender acts, or it opens, which such a page also reads
 * at its time. Hundreds of guests may wait hours on a timed 红包.
 */
const TIMED_POLL_MS = 15_000;
/** Off the live channel, a timed draft is read at its time and this later. */
const OPENING_RECHECK_MS = 3_000;

/** When a timed draft opens (scheduled-opening §4); null otherwise. */
function opensBy(activity: PublicActivity | undefined) {
  return activity?.status === "draft" && activity.scheduledOpenAt
    ? Date.parse(activity.scheduledOpenAt)
    : null;
}

/** When a draw being drawn should have its result: its round, or its deadline. */
function drawDueAt(activity: PublicActivity | undefined) {
  if (activity?.draw?.state !== "settling") return null;
  const proof = activity.drawProof;
  return proof?.kind === "draw"
    ? Date.parse(proof.roundAt)
    : Date.parse(activity.deadlineAt ?? "");
}

/** A draw in its seconds between closing and its result: off the live channel, read every second until 30 s past its round. */
function drawing(activity: PublicActivity | undefined) {
  const at = drawDueAt(activity);
  return at !== null && Date.now() < at + 30_000;
}

/** On the live channel, a draw not yet pushed drawn is read this past its round. */
const DRAW_RECHECK_MS = 3_000;

/** An open 名单弹窗 reads its lists again at most this often. */
export const ROSTER_FOLLOW_MS = 10_000;
/** At the end, the pages that read it again do so within this, not at once. */
const ROSTER_END_SPREAD_MS = 10_000;

/** The 名单弹窗 is open for this 红包 (its page's, or a list row's). */
function useRosterOpen(id: string) {
  const pageId = useCurrentActivityId();
  const panel = useLocation({
    select: (location) =>
      location.state.panel === "roster"
        ? (location.state.panelFor ?? "")
        : null,
  });
  return panel !== null && (panel || pageId) === id;
}

type FollowedList = {
  dataUpdatedAt: number;
  isFetching: boolean;
  refetch: (options?: { cancelRefetch?: boolean }) => Promise<unknown>;
};

/**
 * The 名单 after a change pushed or polled (someone new among the 名单入口's
 * faces, a draw that moved on, the end): stale, read when its 弹窗 opens.
 * Read again at once only for the sender; in an open 弹窗 at most once per
 * ROSTER_FOLLOW_MS; at the end or a draw's result, by a page whose own row
 * it shows (its 手气王 / 手气亡 on 我的结果), within ROSTER_END_SPREAD_MS.
 * Every open page reading it on every claim overloaded D1, and the claims
 * waited behind it (2026-11-04).
 */
function useRosterFollow(
  id: string,
  activity: PublicActivity | undefined,
  {
    claims,
    registrations,
    author,
    open,
    shown,
  }: {
    claims: FollowedList | null;
    registrations: FollowedList | null;
    author: boolean;
    open: boolean;
    shown: boolean;
  },
) {
  const client = useQueryClient();
  const stage = activity
    ? `${activity.status}|${activity.draw?.state ?? ""}`
    : null;
  const signature =
    activity && stage !== null
      ? `${stage}|${(activity.rosterPreview ?? [])
          .map((person) => person.id)
          .join(",")}`
      : null;
  const seen = useRef({ signature, stage });
  // Since when the lists are behind, and (the end) when to read them.
  const [behind, setBehind] = useState<{
    since: number;
    endAt: number | null;
  } | null>(null);
  useEffect(() => {
    if (signature === null) return;
    const before = seen.current;
    seen.current = { signature, stage };
    if (before.signature === null || before.signature === signature) return;
    void client.invalidateQueries({
      queryKey: ["activity-roster", id],
      refetchType: "none",
    });
    const now = Date.now();
    setBehind((current) => ({
      since: now,
      endAt:
        current?.endAt ??
        (before.stage !== stage
          ? now + Math.random() * ROSTER_END_SPREAD_MS
          : null),
    }));
  }, [client, id, signature, stage]);

  const lastRead = Math.max(
    claims?.dataUpdatedAt ?? 0,
    registrations?.dataUpdatedAt ?? 0,
  );
  const fetching = Boolean(claims?.isFetching || registrations?.isFetching);
  const refetchClaims = claims?.refetch;
  const refetchRegistrations = registrations?.refetch;
  useEffect(() => {
    if (!behind || fetching || (!refetchClaims && !refetchRegistrations))
      return;
    // Read since (the 弹窗 opening reads a stale list): nothing to follow.
    if (behind.endAt === null && lastRead > behind.since) {
      setBehind(null);
      return;
    }
    const at = author
      ? 0
      : open
        ? lastRead + ROSTER_FOLLOW_MS
        : behind.endAt !== null && shown
          ? behind.endAt
          : null;
    if (at === null) return;
    const timer = window.setTimeout(
      () => {
        setBehind(null);
        // The page and its 弹窗 ask together: one read.
        void refetchClaims?.({ cancelRefetch: false });
        void refetchRegistrations?.({ cancelRefetch: false });
      },
      Math.max(0, at - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [
    behind,
    fetching,
    lastRead,
    author,
    open,
    shown,
    refetchClaims,
    refetchRegistrations,
  ]);
}

/**
 * One 红包's data for its page and its dialogs (名单, 说明): the public read,
 * the sender's own read, the viewer's claim or sign-up, their 口令 and the
 * roster. Every reader shares the same queries.
 *
 * While the live channel is open (lib/live.ts) nothing here polls: the
 * public read arrives pushed, and the rest is read again when a push says
 * it moved. Without it (guests, or turned away) the running 红包 polls.
 * Once it is over nothing does, but a payment still on its way. The 名单
 * is read only where it shows (useRosterFollow).
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
        : // A timed draft's opening, or its going back to a draft, is pushed
          // (scheduled-opening §4): no polling for it while live.
          opensBy(activity) !== null
          ? live
            ? false
            : TIMED_POLL_MS
          : // Being drawn (开奖证明): each step is pushed (closed, its random
            // number, drawn); off the live channel, read every second.
            !live && drawing(activity)
            ? DRAWING_POLL_MS
            : // Past the deadline the push should say so; until it has, ask.
              live && !pastDeadline(activity)
              ? false
              : POLL_MS,
  );
  const activity = publicQuery.data?.activity;
  const settled = publicSettled(activity);
  // 定时开放 (scheduled-opening §4): a page on the live channel hears it
  // open, or go back to a draft, pushed. One off it (a guest) reads it at
  // its time and OPENING_RECHECK_MS later, should its clock run late; then
  // every TIMED_POLL_MS. Hundreds of pages watch a timed 红包: none of them
  // polls it every second (2026-11-05).
  const opensAt = opensBy(activity);
  const refetchPublic = publicQuery.refetch;
  useEffect(() => {
    if (opensAt === null || live) return;
    const left = opensAt - Date.now();
    if (left <= 0) return;
    const timers = [left + 50, left + OPENING_RECHECK_MS].map((wait) =>
      setTimeout(() => void refetchPublic(), wait),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [opensAt, live, refetchPublic]);
  // A draw on the live channel: its steps come pushed. Should its result
  // not have come by DRAW_RECHECK_MS past its round, it is read once (the
  // user, 2026-11-05: no longer every second, hundreds of pages at once).
  const drawDue = drawDueAt(activity);
  useEffect(() => {
    if (drawDue === null || !live) return;
    const timer = setTimeout(
      () => void refetchPublic(),
      Math.max(0, drawDue + DRAW_RECHECK_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [drawDue, live, refetchPublic]);
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
  // A draft shows no 口令 to others: they are read once it opens.
  const passwordsEnabled = Boolean(
    activity && !author && activity.status !== "draft",
  );
  const passwordsQuery = useActivityPasswords(
    userId,
    id,
    passwordsEnabled,
    activity?.participationMode,
    running && !live ? LIST_POLL_MS : false,
  );
  const draw = activity?.reward?.mode === "timed_draw";
  const viewer = user?.username ?? null;
  // The 名单 is read where it shows: its 弹窗, the sender's own (each
  // payment), and the 手气王 / 手气亡 on 我的结果 of whoever took part.
  // The 名单入口's faces come with the public read.
  const rosterOpen = useRosterOpen(id);
  const tookPart = Boolean(
    participationQuery.data?.claim || participationQuery.data?.registration,
  );
  const claimsEnabled = Boolean(
    (author || rosterOpen || tookPart) &&
      activity &&
      activity.status !== "draft" &&
      (!draw || activity.draw?.state === "completed"),
  );
  const registrationsEnabled = Boolean(
    (author || rosterOpen) && activity && activity.status !== "draft" && draw,
  );
  // Unpushed, the sender's 名单 shows each payment until it is through;
  // an open 弹窗 follows the public read (useRosterFollow).
  const listPoll = (paymentsOpen: boolean) =>
    !live && author && (running || paymentsOpen) ? LIST_POLL_MS : false;
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
  useRosterFollow(id, activity, {
    claims: claimsEnabled ? claims.query : null,
    registrations: registrationsEnabled ? registrations.query : null,
    author,
    open: rosterOpen,
    // Their own row is in what was read: its titles may change at the end.
    shown: claims.rows.some((row) => row.you),
  });
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
              added: managed.addedPasswords,
            }
          : null,
      ),
      mine: mineOf(participationQuery.data, view, roster),
      standing: participationQuery.data?.standing ?? null,
      waiting: participationQuery.data?.waiting ?? null,
      author,
    };
  }
  // What the live channel is for: the 红包 running, or timed to open (its
  // waiters counted, its opening heard: scheduled-opening §6), or after it
  // a payment this person sees (theirs; for the sender, any in the 名单).
  const timed =
    activity?.status === "draft" && activity.scheduledOpenAt !== undefined;
  const liveWant: LiveWant =
    !user || !activity || (activity.status === "draft" && !timed)
      ? null
      : running || timed
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
