import {
  amountToMinor,
  formatAmount,
  type LdcActivityInput,
  ldcTotalMinor,
  moneySchema,
  type TimedDrawMoney,
} from "@hb/contracts";

export type { TimedDrawMoney };
export type WebLdcMoney = LdcActivityInput["money"];

export function isTimedDrawMoney(money: unknown): money is TimedDrawMoney {
  return (
    typeof money === "object" &&
    money !== null &&
    "mode" in money &&
    (money as { mode?: unknown }).mode === "timed_draw"
  );
}

export function timedDrawCount(money: TimedDrawMoney) {
  return Number.isSafeInteger(money.count) && money.count > 0 ? money.count : 0;
}

export function timedDrawTotalMinor(money: TimedDrawMoney) {
  return moneySchema.safeParse(money.totalAmount).success
    ? amountToMinor(money.totalAmount)
    : null;
}

export function webLdcRewardCount(activity: { money: WebLdcMoney }) {
  return isTimedDrawMoney(activity.money)
    ? timedDrawCount(activity.money)
    : activity.money.mode === "custom"
      ? activity.money.amounts.length
      : activity.money.count;
}

export function webLdcTotalMinor(activity: { money: WebLdcMoney }) {
  if (isTimedDrawMoney(activity.money))
    return timedDrawTotalMinor(activity.money);
  if (activity.money.mode === "custom") {
    if (
      !activity.money.amounts.every(
        (amount) => moneySchema.safeParse(amount).success,
      )
    )
      return null;
  } else if (!moneySchema.safeParse(activity.money.totalAmount).success) {
    return null;
  }
  return ldcTotalMinor(activity as LdcActivityInput);
}

export function timedDrawSummary(money: TimedDrawMoney) {
  const total = timedDrawTotalMinor(money);
  const parts = [
    `最多 ${money.count || 0} 人获奖`,
    total === null ? "总奖池待填写" : `总奖池 ${formatAmount(total)} LDC`,
    money.participantLimit === null
      ? "不限报名人数，仅到时开奖"
      : `最多 ${money.participantLimit} 人报名，满员提前开奖`,
    `最晚在开放后 ${formatCountdownSeconds(money.countdownSeconds)} 开奖`,
    money.algorithm === "bounded_mean_v1" ? "均值上下 50%" : "二倍均值法",
    money.distributeFullPool
      ? "人数不足时发完奖池"
      : "人数不足时按原名额生成金额池，随机发出实到份数，剩余不发",
  ];
  return parts.join(" · ");
}

export function formatCountdownSeconds(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "待设置";
  if (value % 86_400 === 0) return `${value / 86_400} 天`;
  if (value % 3_600 === 0) return `${value / 3_600} 小时`;
  if (value % 60 === 0) return `${value / 60} 分钟`;
  return `${value} 秒`;
}
