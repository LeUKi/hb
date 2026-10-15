import type { PaymentState } from "@hb/contracts";
import { activities, type FixtureActivity, openedAtOf } from "./activities";
import { merchantOfActivity } from "./merchants";
import { demoViewerName } from "./session";

// Payments out of the demo account's merchants: one per claim (or per
// winner) of the 红包 it sent. Mostly 已发放, with one of each unfinished
// state so every screen has something to show. Fake numbers throughout.

export type PaymentStep = {
  at: number;
  title: string;
  detail?: string;
  /** done: happened; now: where it stands; warn / stop: went wrong. */
  tone: "done" | "now" | "warn" | "stop";
};

export type PaymentAttempt = {
  at: number;
  action: "分发请求" | "订单查询";
  result: string;
  note: string;
};

export type FixturePayment = {
  id: string;
  activityId: string;
  merchantId: string;
  recipient: { displayName: string; username: string };
  amount: string;
  source: "claim" | "draw";
  createdAt: number;
  state: PaymentState;
  /** One sentence on why it is not 已发放 yet. */
  reason: string | null;
  businessNo: string;
  externalOrderId: string | null;
  confirmedAt: number | null;
  /** When the next send or check is due, for 等待恢复 / 核对中. */
  nextRunAt: number | null;
  /**
   * The Client ID the order went out with, when the merchant has since
   * moved to another app. With `repairable`, that app's 密钥 was rejected
   * and the sender can supply the current one (更新原订单密钥).
   */
  originalClientId?: string;
  repairable?: boolean;
  steps: PaymentStep[];
  attempts: PaymentAttempt[];
};

export const usernames: Record<string, string> = {
  林间: "linjian",
  阿青: "aqing",
  小鹿: "xiaolu",
  南风: "nanfeng",
  橘子汽水: "orange_soda",
  老周: "laozhou",
  Kiki: "kiki",
  晴天: "qingtian",
  阿北: "abei",
  七七: "qiqi",
  山茶: "shancha",
  林间月: "linjianyue",
  一只猫: "yizhimao",
  白开水: "baikaishui",
  秋刀鱼: "qiudaoyu",
  阿土: "atu",
  莫莫: "momo",
  拾光: "shiguang",
  大橙子: "dachengzi",
  星河: "xinghe",
  半夏: "banxia",
};

/** Deterministic hex, so ids and numbers stay put across reloads. */
export function hex(seed: string, length: number) {
  let hash = 2166136261;
  let out = "";
  for (let round = 0; out.length < length; round++) {
    for (const char of `${seed}:${round}`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

export function uuidOf(seed: string) {
  const h = hex(seed, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function orderNo(at: number, seed: string) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const digits = BigInt(`0x${hex(seed, 8)}`)
    .toString()
    .padStart(6, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${digits.slice(-6)}`;
}

type Unfinished =
  | Exclude<PaymentState, "confirmed" | "pending" | "sending">
  /** 等待恢复 because the original app's 密钥 went bad: the sender can fix it. */
  | "repair";

/** The unfinished payments, by 红包 and claim index. */
const unfinished: Record<string, Record<number, Unfinished>> = {
  "c2b7f1a4-5d3e-4f6a-9b8c-1d2e3f4a5b6c": { 1: "repair", 2: "reconciling" },
  "c9e1f3b5-2a4d-4c6e-8a0b-3c4d5e6f7a8b": { 5: "waiting", 6: "attention" },
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function paymentFor(
  activity: FixtureActivity,
  entry: FixtureActivity["entries"][number],
  index: number,
  now: number,
): FixturePayment {
  const seed = `${activity.id}:${index}`;
  const createdAt = openedAtOf(activity) + entry.at * SECOND;
  const amount = entry.amount ?? "0.00";
  const state = unfinished[activity.id]?.[index] ?? "confirmed";
  const base = {
    id: uuidOf(`payment:${seed}`),
    activityId: activity.id,
    merchantId:
      merchantOfActivity[activity.id] ??
      uuidOf(`merchant:${activity.author.username}`),
    recipient: {
      displayName: entry.name,
      username: usernames[entry.name] ?? "user",
    },
    amount,
    source:
      activity.mode === "timed_draw" ? ("draw" as const) : ("claim" as const),
    createdAt,
    businessNo: `hb_${hex(`claim:${seed}`, 32)}`,
  };
  const created: PaymentStep = {
    at: createdAt,
    title:
      activity.mode === "timed_draw" ? "中奖，创建付款" : "领取成功，创建付款",
    detail: `${amount} LDC 付给 ${entry.name}`,
    tone: "done",
  };
  const sentAt = createdAt + 1.4 * SECOND;

  if (state === "confirmed") {
    const confirmedAt = createdAt + 4.2 * SECOND;
    const order = orderNo(sentAt, seed);
    return {
      ...base,
      state,
      reason: null,
      externalOrderId: order,
      confirmedAt,
      nextRunAt: null,
      steps: [
        created,
        { at: sentAt, title: "发给 LDC", detail: "LDC 已建单", tone: "done" },
        {
          at: confirmedAt,
          title: "已发放",
          detail: "查单确认到账",
          tone: "done",
        },
      ],
      attempts: [
        {
          at: sentAt,
          action: "分发请求",
          result: "已收到有效响应",
          note: `上游交易号 ${order}`,
        },
        {
          at: confirmedAt,
          action: "订单查询",
          result: "已收到有效响应",
          note: "订单已完成",
        },
      ],
    };
  }

  if (state === "reconciling") {
    const nextRunAt = now + 2 * MINUTE;
    return {
      ...base,
      state,
      reason: "付款结果尚未明确，正在核对原订单。",
      externalOrderId: null,
      confirmedAt: null,
      nextRunAt,
      steps: [
        created,
        {
          at: sentAt,
          title: "发给 LDC",
          detail: "请求超时，没有收到结果",
          tone: "warn",
        },
        {
          at: now - 3 * MINUTE,
          title: "核对原订单",
          detail: "查清之前不会重新发送，不会重复付款",
          tone: "now",
        },
      ],
      attempts: [
        {
          at: sentAt,
          action: "分发请求",
          result: "结果尚未明确",
          note: "请求超时，将继续核对原订单。",
        },
        {
          at: now - 3 * MINUTE,
          action: "订单查询",
          result: "结果尚未明确",
          note: "暂未查到原订单，系统会继续安全核对。",
        },
      ],
    };
  }

  if (state === "repair") {
    return {
      ...base,
      state: "waiting",
      reason: "原应用的密钥失效，等待更新原订单密钥。",
      externalOrderId: null,
      confirmedAt: null,
      nextRunAt: null,
      originalClientId: "7b3e90c1d4f2a856",
      repairable: true,
      steps: [
        created,
        {
          at: sentAt,
          title: "发给 LDC",
          detail: "LDC 拒绝：原应用的密钥已失效，没有建单",
          tone: "warn",
        },
        {
          at: sentAt + 2 * SECOND,
          title: "等待更新原订单密钥",
          detail: "这笔付款用的是更换前的应用，更新它现在的密钥后继续",
          tone: "now",
        },
      ],
      attempts: [
        {
          at: sentAt,
          action: "分发请求",
          result: "请求未通过",
          note: "原应用的密钥失效，等待更新原订单密钥。",
        },
      ],
    };
  }

  if (state === "waiting") {
    const nextRunAt = now + 26 * MINUTE;
    return {
      ...base,
      state,
      reason: "商户资金不足，等待补足后恢复。",
      externalOrderId: null,
      confirmedAt: null,
      nextRunAt,
      steps: [
        created,
        {
          at: sentAt,
          title: "发给 LDC",
          detail: "LDC 拒绝：商户资金不足，没有建单",
          tone: "warn",
        },
        {
          at: sentAt + 2 * SECOND,
          title: "等待恢复",
          detail: "在 LDC 补足资金后自动继续",
          tone: "now",
        },
      ],
      attempts: [
        {
          at: sentAt,
          action: "分发请求",
          result: "请求未通过",
          note: "商户资金不足，等待补足后恢复。",
        },
      ],
    };
  }

  // attention
  return {
    ...base,
    state: "attention",
    reason: "上游未找到指定收款人，发送已暂停。",
    externalOrderId: null,
    confirmedAt: null,
    nextRunAt: null,
    steps: [
      created,
      {
        at: sentAt,
        title: "发给 LDC",
        detail: "LDC 未找到这个收款人，没有建单",
        tone: "stop",
      },
      {
        at: sentAt + 2 * SECOND,
        title: "发送已暂停",
        detail: "这笔付款不会自动重发",
        tone: "stop",
      },
    ],
    attempts: [
      {
        at: sentAt,
        action: "分发请求",
        result: "请求未通过",
        note: "上游未找到指定收款人，发送已暂停。",
      },
    ],
  };
}

let cache: FixturePayment[] | null = null;

/** Every payment of the demo account's merchants, newest first. */
export function demoPayments(): FixturePayment[] {
  if (cache) return cache;
  const now = Date.now();
  cache = activities
    .filter((activity) => activity.id in merchantOfActivity && !activity.draft)
    .flatMap((activity) =>
      activity.entries.map((entry, index) =>
        paymentFor(activity, entry, index, now),
      ),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return cache;
}

let site: FixturePayment[] | null = null;

/**
 * Every payment on the site (网站管理 · 付款): the demo account's, plus one
 * per paid claim on everyone else's 红包, all 已发放.
 */
export function sitePayments(): FixturePayment[] {
  if (site) return site;
  const now = Date.now();
  const own = demoPayments();
  const others = activities
    .filter(
      (activity) =>
        !(activity.id in merchantOfActivity) &&
        !activity.draft &&
        activity.mode !== "timed_draw",
    )
    .flatMap((activity) => {
      const paid = activity.entries.flatMap((entry, index) =>
        entry.amount ? [paymentFor(activity, entry, index, now)] : [],
      );
      // The demo account's own earlier claim is paid like any other.
      const mine = activity.mine;
      if (mine?.kind === "claimed" && mine.amount)
        paid.push(
          paymentFor(
            activity,
            { name: demoViewerName, at: mine.at, amount: mine.amount },
            activity.entries.length,
            now,
          ),
        );
      return paid;
    });
  site = [...own, ...others].sort((a, b) => b.createdAt - a.createdAt);
  return site;
}

export function findPayment(id: string) {
  return sitePayments().find((payment) => payment.id === id) ?? null;
}

/** The payment for one claim (the roster's entry `index`), if paid out. */
export function entryPayment(activityId: string, index: number) {
  return findPayment(uuidOf(`payment:${activityId}:${index}`));
}

/** Days and hours since, for "最长等待". */
export function waitedMinutes(payment: FixturePayment, now = Date.now()) {
  return Math.max(0, Math.round((now - payment.createdAt) / 60_000));
}

/** Not 已发放 yet: 待发放, 发送中, 核对中, 等待恢复 or 异常待处理. */
export function isOpenPayment(payment: FixturePayment) {
  return payment.state !== "confirmed";
}

/** Sum of LDC amounts, as a two-decimal string. */
export function sumAmounts(payments: FixturePayment[]) {
  const cents = payments.reduce(
    (sum, payment) => sum + Math.round(Number(payment.amount) * 100),
    0,
  );
  return (cents / 100).toFixed(2);
}
