import type { PublicActivity } from "@hb/contracts";
import { atom } from "jotai";
import type { ParticipationCache } from "./participation-cache";

/** The 红包 whose changes arrive pushed right now (lib/live.ts). */
export const liveActivityAtom = atom<string | null>(null);

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

/** A payment on its way: only `confirmed` is done. */
export const paymentOpen = (payment?: { status: string } | null) =>
  Boolean(payment && payment.status !== "confirmed");

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
