import { amountToMinor, formatAmount } from "@hb/contracts";
import type { HongbaoActivity } from "../../lib/hongbao";
import { endLabels, fuzzyLabels, type PublicView } from "../../lib/hongbao";
import { clockLabel } from "../../lib/roster-time";

/**
 * One cell of 公开数据: a label, a value and one line under it — a note, a
 * bar (share taken, or sign-ups toward the limit), the four fuzzy steps, or
 * (代码判定) how many times its code has judged. The page draws these; the
 * forum image keeps to one line of its own.
 */
export type CoverCell = {
  label: string;
  value: string;
  note?: string;
  /** The end of the note that only wide windows have room for. */
  noteWide?: string;
  bar?: { share: number; label: string };
  steps?: number;
  /** 代码判定: 已判定 N 次, rolling as it moves (05 §4). */
  judged?: number;
  /** A countdown to this moment, ticking on the page. */
  until?: number;
};

/**
 * "平均 3.00 LDC" a share (约 when it does not divide): short enough for the
 * narrowest cell, next to 已领 … 份.
 */
function averageNote(activity: HongbaoActivity) {
  if (!activity.shares || !activity.totalAmount) return undefined;
  const total = amountToMinor(activity.totalAmount);
  const exact = total % activity.shares === 0;
  const each = Math.round(total / activity.shares);
  return `平均${exact ? "" : "约"} ${formatAmount(each)} LDC`;
}

/**
 * The pool and the line under it. The 玩法 itself is the cover's label
 * (cover-head), so the line says something the label does not.
 */
function poolCell(activity: HongbaoActivity, view: PublicView): CoverCell {
  const fuzzy = view.quantity.kind === "fuzzy";
  // 代码判定: the pool and 每份至少 (05 §4); each share is the code's to say.
  // On protocol 5 there are no shares (multi-prize §4.1).
  if (activity.mode === "code")
    return {
      label: "奖池",
      value: `${activity.totalAmount} LDC`,
      note:
        activity.minEach && view.quantity.kind !== "pool"
          ? `每份至少 ${activity.minEach} LDC`
          : undefined,
    };
  if (activity.mode === "fixed")
    return fuzzy
      ? { label: "每份", value: `${activity.unitAmount} LDC` }
      : {
          label: "总额",
          value: `${activity.totalAmount} LDC`,
          note: `每份 ${activity.unitAmount} LDC`,
        };
  const note =
    activity.mode === "custom" && activity.custom
      ? activity.custom.allocation === "random"
        ? "随机发放"
        : "按顺序发放"
      : activity.mode === "timed_draw"
        ? fuzzy
          ? undefined
          : `抽 ${activity.shares} 人`
        : fuzzy
          ? undefined
          : averageNote(activity);
  return { label: "奖池", value: `${activity.totalAmount} LDC`, note };
}

const fuzzySteps = { plenty: 4, limited: 2, low: 1, empty: 0 } as const;

function quantityCell(view: PublicView, judged?: number): CoverCell {
  const { draw, quantity } = view;
  if (draw) {
    if (draw.registered === null)
      return { label: "名额", value: "不公开", note: "限时开奖" };
    if (draw.state === "completed" && draw.winners !== null)
      return {
        label: "中奖",
        value: `${draw.winners} 人`,
        note: `${draw.registered} 人报名`,
      };
    return draw.limit
      ? {
          label: "报名",
          value: `${draw.registered} / ${draw.limit} 人`,
          bar: { share: draw.registered / draw.limit, label: "报名进度" },
        }
      : { label: "报名", value: `${draw.registered} 人`, note: "不限人数" };
  }
  // 代码判定, protocol 5: the pool less what was paid and everyone's
  // pending (multi-prize §4.1), and how often its code judged.
  if (quantity.kind === "pool")
    return {
      label: quantity.share ? `奖池还剩 ${quantity.share}` : "奖池还剩",
      value: `${quantity.left} LDC`,
      ...(judged !== undefined ? { judged } : {}),
    };
  // 代码判定: how often its code judged says more than a bar (05 §4).
  if (quantity.kind === "fuzzy")
    return {
      label: "余量",
      value: fuzzyLabels[quantity.level],
      ...(judged !== undefined
        ? { judged }
        : { steps: fuzzySteps[quantity.level] }),
    };
  return {
    label: "已领",
    value: `${quantity.taken} / ${quantity.total} 份`,
    ...(judged !== undefined
      ? { judged }
      : { bar: { share: quantity.taken / quantity.total, label: "已领份数" } }),
  };
}

/**
 * "截止 18:47", "开奖 明天 20:00", "截止 10月17日 02:02". A date further
 * than a day away keeps its clock for wide windows only: a phone's third
 * of the cover fits "截止 10月17日", and the countdown above has the rest.
 */
function momentNote(word: string, at: number) {
  const label = clockLabel(at);
  const far = label.match(/^(\d+月\d+日)( \d\d:\d\d)$/);
  return far
    ? { note: `${word} ${far[1]}`, noteWide: far[2] }
    : { note: `${word} ${label}` };
}

function timeCell(view: PublicView): CoverCell {
  const draw = Boolean(view.draw);
  if (view.endReason)
    return {
      label: "状态",
      value: endLabels[view.endReason],
      ...(view.endReason === "expired"
        ? momentNote("截止", view.deadlineAt)
        : view.endReason === "settling"
          ? { note: view.draw?.full ? "报名已满" : "报名已截止" }
          : {}),
    };
  return {
    label: draw ? "距开奖" : "剩余",
    value: "",
    until: view.deadlineAt,
    ...momentNote(draw ? "开奖" : "截止", view.deadlineAt),
  };
}

const unitWords = {
  seconds: "秒",
  minutes: "分钟",
  hours: "小时",
  days: "天",
} as const;

/** A 草稿 has no deadline yet: what was set, counted from opening. */
function draftTimeCell(activity: HongbaoActivity): CoverCell {
  const label = activity.mode === "timed_draw" ? "开奖" : "截止";
  const timing = activity.draftTiming;
  if (timing?.kind === "at")
    return {
      label,
      value: clockLabel(new Date(timing.at).getTime()),
      note: "草稿",
    };
  return {
    label,
    value: timing
      ? `开放后 ${timing.value} ${unitWords[timing.unit]}`
      : "开放后计时",
    note: "从开放时算起",
  };
}

/**
 * 金额 · 数量 · 时间, with fuzzy quantity hidden the way production does.
 * `judged`: a 代码判定红包's count, the latest the page has.
 */
export function coverCells(
  activity: HongbaoActivity,
  view: PublicView,
  judged?: number,
): [CoverCell, CoverCell, CoverCell] {
  return [
    poolCell(activity, view),
    quantityCell(
      view,
      activity.judge ? (judged ?? activity.judge.judged) : undefined,
    ),
    activity.draft ? draftTimeCell(activity) : timeCell(view),
  ];
}
