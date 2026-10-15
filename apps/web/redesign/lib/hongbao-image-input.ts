import type { PaymentState } from "@hb/contracts";
import { encodeActivityEmoji } from "@/lib/ecoji-v2";
import { type FixtureActivity, openedAtOf } from "../fixtures/activities";
import {
  type DrawSim,
  endHint,
  fuzzyLabels,
  isEnded,
  mineOf,
  type PaymentSim,
  type PublicView,
  paymentOf,
  publicOf,
  rosterOf,
  type ViewerContext,
} from "../fixtures/hongbao";
import { demoViewerName } from "../fixtures/session";
import type { HongbaoImageInput, ImageTone } from "./hongbao-image";

// What the 内嵌图 shows to whom (docs/redesign/05 §6). Production tells the
// viewer by the image cookie: none (or blocked as a third-party cookie, or
// the sender themself) draws the guest image; signed in, their own record.
// Never drawn: avatars, who took part, 口令, notes, amounts other than the
// viewer's own, deadlines, titles.

/**
 * Who is looking. The prototype's dev server has no session, so ?viewer=
 * picks one; `participant` takes part the way that 红包 most naturally
 * allows (claimed, or signed up with the draw's outcome). `won` and `lost`
 * settle a running draw, like the dev toolbar's draw switch.
 */
export type ImageViewer =
  | "guest"
  | "member"
  | "participant"
  | "claimed"
  | "registered"
  | "won"
  | "lost";

export const imageViewers: readonly ImageViewer[] = [
  "guest",
  "member",
  "participant",
  "claimed",
  "registered",
  "won",
  "lost",
];

export function isImageViewer(value: unknown): value is ImageViewer {
  return imageViewers.includes(value as ImageViewer);
}

/** A signed-in viewer and their record, or nobody. */
export type ImageAudience =
  | { signedIn: false }
  | { signedIn: true; name: string; record?: ViewerContext["record"] };

export type ImageSims = {
  drawSim: DrawSim;
  paymentSim: PaymentSim;
  now: number;
};

/** A plausible amount without touching the fixtures' running cycles. */
function sampleAmount(activity: FixtureActivity) {
  return (
    activity.mine?.amount ??
    activity.unitAmount ??
    activity.custom?.lines[activity.entries.length] ??
    activity.entries.find((entry) => entry.amount)?.amount ??
    "1.00"
  );
}

/**
 * The record a participant would have: the demo viewer's own, or a fresh
 * one. An ended 红包 the demo viewer never joined stays that way.
 */
function naturalRecord(
  activity: FixtureActivity,
  now: number,
): ViewerContext["record"] {
  const opened = openedAtOf(activity);
  if (activity.mine)
    return {
      kind: activity.mine.kind,
      amount: activity.mine.amount,
      password: activity.mine.password,
      at: opened + activity.mine.at * 1000,
    };
  if (isEnded(activity, "waiting", now)) return undefined;
  const draw = activity.mode === "timed_draw";
  return {
    kind: draw ? "registered" : "claimed",
    amount: draw ? undefined : sampleAmount(activity),
    password: null,
    at: Math.max(opened, now - 2 * 60_000),
  };
}

/** The audience and draw switch a ?viewer= value stands for. */
export function audienceFor(
  activity: FixtureActivity,
  viewer: ImageViewer,
  sims: ImageSims,
): { audience: ImageAudience; drawSim: DrawSim } {
  if (viewer === "guest")
    return { audience: { signedIn: false }, drawSim: sims.drawSim };
  if (viewer === "member")
    return {
      audience: { signedIn: true, name: demoViewerName },
      drawSim: sims.drawSim,
    };
  const drawSim: DrawSim =
    viewer === "won"
      ? "won"
      : viewer === "lost"
        ? "lost"
        : viewer === "registered"
          ? "waiting"
          : sims.drawSim;
  return {
    audience: {
      signedIn: true,
      name: demoViewerName,
      record: naturalRecord(activity, sims.now),
    },
    drawSim,
  };
}

/** Production's four payment words for the image. */
function paymentWords(state: PaymentState): {
  text: string;
  tone: ImageTone;
} {
  switch (state) {
    case "confirmed":
      return { text: "已发放", tone: "success" };
    case "pending":
    case "sending":
      return { text: "付款处理中", tone: "warning" };
    case "reconciling":
    case "waiting":
      return { text: "正在核对原订单", tone: "warning" };
    default:
      return { text: "需要关注", tone: "danger" };
  }
}

/** The one public line: how much is left, as the quantity setting allows. */
function remainingLine(view: PublicView) {
  if (view.draw)
    return view.draw.registered === null
      ? "限时开奖"
      : `已报名 ${view.draw.registered} 人`;
  if (view.quantity.kind === "fuzzy")
    return view.quantity.level === "empty"
      ? "已领完"
      : `余量${fuzzyLabels[view.quantity.level]}`;
  return `剩余 ${view.quantity.total - view.quantity.taken} 份`;
}

/** Everything the renderer needs, by the same projection as the page. */
export function imageInputFor(
  activity: FixtureActivity,
  audience: ImageAudience,
  options: ImageSims & { age?: number },
): HongbaoImageInput {
  const { drawSim, paymentSim, now } = options;
  const record = audience.signedIn ? audience.record : undefined;
  const context: ViewerContext = { record, solved: [], drawSim, now };
  const view = publicOf(activity, context);
  const roster = rosterOf(
    activity,
    context,
    audience.signedIn ? audience.name : null,
  );
  const mine = record ? mineOf(activity, context, roster) : null;
  const isDraw = activity.mode === "timed_draw";
  const base = {
    sender: activity.author.displayName,
    title: activity.title,
    code: encodeActivityEmoji(activity.id),
    renderedAt: now,
    age: options.age,
  };

  // Took part and got something: the opened 红包.
  if (mine && (mine.kind === "claimed" || mine.outcome === "won")) {
    // A winner's share is taken when the draw runs.
    const at =
      mine.kind === "claimed" ? mine.at : Math.min(now, view.deadlineAt);
    const payment = paymentOf(at, paymentSim, now);
    return {
      ...base,
      muted: false,
      seal: null,
      body: {
        kind: "opened",
        label: mine.kind === "claimed" ? "你已领取" : "你中奖了",
        amount: mine.amount ?? "0.00",
        status: paymentWords(payment),
        at,
        opens: isDraw ? "报" : "开",
      },
      // The payment may still move on; once sent, nothing will change.
      live: payment !== "confirmed",
    };
  }
  if (mine?.kind === "registered") {
    if (mine.outcome === "lost")
      return {
        ...base,
        muted: true,
        seal: "未中",
        body: { kind: "line", text: "本次未中奖" },
        live: false,
      };
    const settling = mine.outcome === "settling";
    return {
      ...base,
      muted: false,
      seal: settling ? "开奖中" : "已报名",
      body: { kind: "line", text: settling ? "正在开奖" : "已报名，等待开奖" },
      live: true,
    };
  }

  // Not taken part (or nobody we know): the public image.
  if (view.endReason === "settling")
    return {
      ...base,
      muted: false,
      seal: "开奖中",
      body: { kind: "line", text: "正在开奖" },
      live: true,
    };
  if (view.ended)
    return {
      ...base,
      muted: true,
      seal: "完",
      body: { kind: "line", text: endHint(view) },
      live: false,
    };
  return {
    ...base,
    muted: false,
    // A guest may have taken part already: the seal only offers a look.
    seal: audience.signedIn ? (isDraw ? "报" : "开") : "查看",
    body: { kind: "line", text: remainingLine(view) },
    live: true,
  };
}

/** For the gallery's captions: what the image ended up drawing. */
export function imageSummary(input: HongbaoImageInput) {
  return input.body.kind === "opened"
    ? `${input.body.label} · ${input.body.status.text}`
    : `${input.seal ?? ""}｜${input.body.text}`;
}
