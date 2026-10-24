import type { PublicActivity } from "@hb/contracts";
import { atom } from "jotai";
import type { ParticipationCache } from "./participation-cache";

/** The 红包 whose changes arrive pushed right now (lib/live.ts). */
export const liveActivityAtom = atom<string | null>(null);

/**
 * How many people have that 红包's page open on its live channel, each
 * counted once (signed-in viewers only: nobody else is on it). Known only
 * while the channel is connected.
 */
export const liveViewersAtom = atom<{ id: string; count: number } | null>(null);

/**
 * 代码判定: how many times that 红包's code has judged, pushed at most once
 * a second. The public read says it too; the page shows the larger.
 */
export const liveJudgedAtom = atom<{ id: string; count: number } | null>(null);

/**
 * Nothing public about this 红包 will change anymore (api: live.ts
 * liveEnded), so its page stops reading it. A 草稿 still may: it opens.
 */
export function publicSettled(activity: PublicActivity | undefined) {
  if (!activity || activity.status === "draft") return false;
  if (activity.draw)
    return (
      activity.draw.state === "completed" || activity.draw.state === "empty"
    );
  return activity.status !== "active";
}

/** Past its deadline by the clock, before a read has said it ended. */
export function pastDeadline(activity: PublicActivity | undefined) {
  return Boolean(
    activity &&
      !activity.draw &&
      activity.status === "active" &&
      activity.deadlineAt &&
      Date.parse(activity.deadlineAt) <= Date.now(),
  );
}

/**
 * A payment on its way. `confirmed` is done; `attention` waits on a person
 * (its claimant sending it again, payments/resend.ts), not on the system.
 */
export const paymentOpen = (payment?: { status: string } | null) =>
  Boolean(
    payment && payment.status !== "confirmed" && payment.status !== "attention",
  );

/** This person's part of a 红包 that can still move: a payment, a draw. */
export function participationOpen(data: ParticipationCache | undefined) {
  const registration = data?.registration;
  return (
    paymentOpen(data?.claim?.payment) ||
    paymentOpen(registration?.claim?.payment) ||
    registration?.status === "registered" ||
    registration?.status === "drawing"
  );
}
