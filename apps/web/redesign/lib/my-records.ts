import type { PaymentState } from "@hb/contracts";
import { useAtomValue } from "jotai";
import { activities, type FixtureActivity } from "../fixtures/activities";
import {
  isArchived,
  type Mine,
  mineOf,
  type PublicView,
  paymentOf,
  publicOf,
  rosterOf,
  type ViewerContext,
} from "../fixtures/hongbao";
import { claimsAtom, drawSimAtom, paymentSimAtom, sessionAtom } from "./store";
import { toCents } from "./titles";

// The signed-in account's own records, shared by 红包记录, 账号资料 and the
// 红包广场's "you took part" tags. Mirrors production's /api/me/activities
// and /api/me/participations.

export type Participation = {
  activity: FixtureActivity;
  mine: Mine;
  view: PublicView;
  /** The payment of a claimed or won share; null for a sign-up. */
  payment: PaymentState | null;
};

export type SentRecord = {
  activity: FixtureActivity;
  view: PublicView;
  archived: boolean;
  /** What it gave out so far, in cents (see givenOf). */
  given: number;
};

/** Every 红包 this account claimed or signed up for, newest first. */
export function useParticipations(): Participation[] {
  const user = useAtomValue(sessionAtom);
  const claims = useAtomValue(claimsAtom);
  const drawSim = useAtomValue(drawSimAtom);
  const paymentSim = useAtomValue(paymentSimAtom);
  if (!user) return [];
  const now = Date.now();
  return activities
    .flatMap((activity) => {
      const record = claims[activity.id];
      if (!record) return [];
      const context = { record, solved: [], drawSim, now };
      const view = publicOf(activity, context);
      const mine = mineOf(
        activity,
        context,
        rosterOf(activity, context, user.displayName),
      );
      if (!mine) return [];
      const won = mine.kind === "claimed" || mine.outcome === "won";
      return [
        {
          activity,
          mine,
          view,
          payment: won ? paymentOf(mine.at, paymentSim, now) : null,
        },
      ];
    })
    .sort((a, b) => b.mine.at - a.mine.at);
}

/**
 * What an opened 红包 gave out so far, in cents, as its roster shows it:
 * every claimed share, or a timed draw's prizes once it is drawn. Payment
 * progress does not count here (付款记录 has it), as for 领到.
 */
function givenOf(activity: FixtureActivity, context: ViewerContext) {
  if (activity.draft) return 0;
  const roster = rosterOf(activity, context, null);
  const rows =
    roster.kind === "claims"
      ? roster.rows
      : roster.kind === "draw"
        ? roster.winners
        : [];
  return rows.reduce(
    (sum, row) => sum + (row.amount ? toCents(row.amount) : 0),
    0,
  );
}

/** Every 红包 this account sent, drafts included, newest first. */
export function useSentRecords(): SentRecord[] {
  const user = useAtomValue(sessionAtom);
  const drawSim = useAtomValue(drawSimAtom);
  if (!user) return [];
  const now = Date.now();
  return activities
    .filter((activity) => activity.author.username === user.username)
    .map((activity) => {
      const context = { solved: [], drawSim, now };
      const view = publicOf(activity, context);
      return {
        activity,
        view,
        archived: isArchived(activity, view, now),
        given: givenOf(activity, context),
      };
    })
    .sort((a, b) => b.view.openedAt - a.view.openedAt);
}

/** 发出的金额: what everyone got from this account's 红包, in cents. */
export function sentTotal(sent: SentRecord[]) {
  return sent.reduce((sum, record) => sum + record.given, 0);
}

/** 领到: claims and prizes, in cents. */
export function receivedTotal(joined: Participation[]) {
  return joined.reduce(
    (sum, item) => sum + toCents(outcomeOf(item.mine).amount ?? "0"),
    0,
  );
}

/** Cents as an amount ("11.00"). */
export function amountText(cents: number) {
  return (cents / 100).toFixed(2);
}

/** What the viewer got: the amount, or how a sign-up went. */
export function outcomeOf(mine: Mine) {
  if (mine.kind === "claimed")
    return { label: "已领取", amount: mine.amount, tone: "success" as const };
  if (mine.outcome === "won")
    return { label: "已中奖", amount: mine.amount, tone: "success" as const };
  if (mine.outcome === "lost")
    return { label: "未中奖", amount: undefined, tone: "neutral" as const };
  if (mine.outcome === "settling")
    return { label: "开奖中", amount: undefined, tone: "warning" as const };
  return { label: "已报名", amount: undefined, tone: "gold" as const };
}

/** The tone of a payment state, as 我的结果 colours it. */
export function paymentTone(state: PaymentState) {
  return state === "confirmed"
    ? ("success" as const)
    : state === "attention"
      ? ("danger" as const)
      : ("warning" as const);
}
