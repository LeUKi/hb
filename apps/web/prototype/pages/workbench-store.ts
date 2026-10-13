import { ACTIVITY_LIMITS } from "@hb/contracts";
import { useCallback, useSyncExternalStore } from "react";
import {
  fixedPoolAmount,
  prototypeDeadlineAt,
  prototypeStartedAt,
} from "../activity-metadata";
import { recipientExamples } from "../fixtures";
import { normalizePrototypeTopicLink } from "../topic-link";
import type { Activity, ActivityLifecycle, Identity } from "../types";

export type RewardPlan = "fixed" | "random" | "custom" | "draw";
export type Algorithm = "double" | "balanced";
export type DurationUnit = "minutes" | "hours" | "days";
export type ActivityConfig = {
  title: string;
  rewardKind: "ldc";
  plan: RewardPlan;
  fixed: { amount: string; count: string };
  random: { amount: string; count: string; algorithm: Algorithm };
  custom: { amounts: string; order: string };
  draw: {
    amount: string;
    winners: string;
    limit: string;
    seconds: string;
    algorithm: Algorithm;
    fullPool: boolean;
  };
  passwords: { id: number; value: string }[];
  topic: string;
  listed: boolean;
  dedicated: boolean;
  quantity: string;
  showRecipients: boolean;
  hours: string;
  durationUnit?: DurationUnit;
  notes: { description: string; before: string; after: string; ended: string };
};

export type ManagedActivity = {
  id: string;
  fixtureId: string;
  title: string;
  kind: string;
  status: ActivityLifecycle;
  amount: string;
  count: number;
  claimed: number;
  rewardAmountInventory?: string[];
  registrations: number;
  createdAt: string;
  date: string;
  deadlineAt: string | null;
  config: ActivityConfig;
};

export type PaymentExample = {
  id: string;
  activityId: string | null;
  title: string;
  amount: string;
  state: string;
  status: "pending" | "confirmed" | "waiting";
  date: string;
  detail: string;
  businessId: string;
  upstreamId: string | null;
  recipient: { name: string; username: string; color?: string };
  sentUsername: string;
  source: string;
  createdAt: string;
  confirmedAt: string | null;
  firstSendAt?: string | null;
  sendAcknowledgedAt?: string | null;
  orderObservedAt?: string | null;
  orderEvidence?: "send" | "query";
  canRepairCredentials?: boolean;
  attempts?: Array<{
    id: string;
    operation: "send" | "query";
    outcome: string;
    startedAt: string;
    finishedAt: string | null;
    note: string | null;
  }>;
  issue: string | null;
  recovery: string;
};

const planNames: Record<RewardPlan, string> = {
  fixed: "固定均分",
  random: "即时随机",
  custom: "自定义金额",
  draw: "限时开奖",
};

function fixtureDate(offsetMs: number) {
  return new Date(prototypeStartedAt + offsetMs).toISOString();
}

function amountCents(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? cents : null;
}

function characters(value: string) {
  return Array.from(value).length;
}

function inspectPasswordValue(value: string) {
  const length = characters(value);
  return (
    length >= 6 && length <= 18 && /^[\p{Script=Han}A-Za-z0-9]+$/u.test(value)
  );
}

function durationSeconds(config: ActivityConfig) {
  const value = Number(config.hours);
  if (
    !/^\d+$/u.test(config.hours) ||
    !Number.isSafeInteger(value) ||
    value <= 0
  )
    return null;
  const unit = config.durationUnit ?? "hours";
  const multiplier =
    unit === "minutes" ? 60 : unit === "days" ? 24 * 3600 : 3600;
  const seconds = value * multiplier;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

function formatAmount(cents: bigint) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function createAmountInventory(config: ActivityConfig): string[] | undefined {
  if (config.plan === "custom") {
    const amounts = config.custom.amounts
      .split(/\r?\n/u)
      .map((amount) => amount.trim())
      .filter(Boolean)
      .map(amountCents);
    if (amounts.some((amount) => amount === null)) return undefined;
    return amounts.map((amount) => formatAmount(amount ?? 0n));
  }
  if (config.plan !== "random") return undefined;
  const total = amountCents(config.random.amount);
  const count = Number(config.random.count);
  if (
    total === null ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 1000 ||
    total < BigInt(count)
  )
    return undefined;
  const shares = BigInt(count);
  const lower = total / (2n * shares) > 1n ? total / (2n * shares) : 1n;
  const upper = (3n * total + 2n * shares - 1n) / (2n * shares);
  const amounts: string[] = [];
  let remaining = total;
  for (let pending = shares; pending > 0n; pending--) {
    let minimum: bigint;
    let maximum: bigint;
    if (config.random.algorithm === "double") {
      minimum = pending === 1n ? remaining : 1n;
      const reserved = remaining - pending + 1n;
      const twiceMean = (2n * remaining) / pending;
      maximum =
        pending === 1n
          ? remaining
          : reserved < twiceMean
            ? reserved
            : twiceMean;
    } else {
      const reservedMaximum = remaining - (pending - 1n) * upper;
      const reservedMinimum = remaining - (pending - 1n) * lower;
      minimum = lower > reservedMaximum ? lower : reservedMaximum;
      maximum = upper < reservedMinimum ? upper : reservedMinimum;
    }
    // Virtual inventory is deterministic, while retaining the real algorithm's bounds.
    const fraction = amounts.length % 2 === 0 ? 1n : 3n;
    const amount = minimum + ((maximum - minimum) * fraction) / 4n;
    amounts.push(formatAmount(amount));
    remaining -= amount;
  }
  return amounts;
}

function sameAmountInventory(left: ActivityConfig, right: ActivityConfig) {
  if (left.plan === "random")
    return (
      left.random.amount === right.random.amount &&
      left.random.count === right.random.count &&
      left.random.algorithm === right.random.algorithm
    );
  if (left.plan === "custom")
    return (
      left.custom.amounts === right.custom.amounts &&
      left.custom.order === right.custom.order
    );
  return true;
}

function customPool(config: ActivityConfig) {
  const total = config.custom.amounts
    .split(/\r?\n/u)
    .filter(Boolean)
    .reduce((sum, value) => {
      const [whole = "0", fraction = ""] = value.trim().split(".");
      return sum + Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    }, 0);
  return (total / 100).toFixed(2);
}

function rewardSummary(config: ActivityConfig) {
  if (config.plan === "fixed") return `${config.fixed.amount} LDC / 份`;
  const pool =
    config.plan === "draw"
      ? config.draw.amount
      : config.plan === "custom"
        ? customPool(config)
        : config.random.amount;
  return `${pool} LDC 奖池`;
}

function deadlineForConfig(config: ActivityConfig, openedAt: number) {
  const seconds =
    config.plan === "draw"
      ? Number(config.draw.seconds)
      : durationSeconds(config);
  if (seconds === null) return null;
  const deadlineMs = openedAt + seconds * 1000;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    !Number.isFinite(deadlineMs) ||
    Math.abs(deadlineMs) > 8640000000000000
  )
    return null;
  return new Date(deadlineMs).toISOString();
}

export function defaultActivityConfig(identity: Identity): ActivityConfig {
  void identity;
  return {
    title: "",
    rewardKind: "ldc",
    plan: "fixed",
    fixed: { amount: "", count: "" },
    random: { amount: "", count: "", algorithm: "double" },
    custom: { amounts: "", order: "sequential" },
    draw: {
      amount: "",
      winners: "",
      limit: "",
      seconds: "600",
      algorithm: "double",
      fullPool: true,
    },
    passwords: [{ id: 1, value: "" }],
    topic: "",
    listed: false,
    dedicated: false,
    quantity: "exact",
    showRecipients: true,
    hours: "24",
    durationUnit: "hours",
    notes: { description: "", before: "", after: "", ended: "" },
  };
}

export function fixtureActivityConfig(identity: Identity): ActivityConfig {
  const config = defaultActivityConfig(identity);
  return {
    ...config,
    title: "周末红包",
    fixed: { amount: "0.88", count: "20" },
    random: { amount: "20.00", count: "20", algorithm: "double" },
    custom: { amounts: "0.50\n0.88\n1.20", order: "sequential" },
    draw: {
      amount: "20.00",
      winners: "10",
      limit: "",
      seconds: "600",
      algorithm: "double",
      fullPool: true,
    },
    passwords: [{ id: 1, value: "公共口令2026" }],
  };
}

export type ActivityValidation = {
  ok: boolean;
  errors: Record<string, string>;
  canonicalTopic: string;
};

function addError(
  errors: Record<string, string>,
  key: string,
  message: string,
) {
  if (!errors[key]) errors[key] = message;
}

export function validateActivityConfig(
  config: ActivityConfig,
): ActivityValidation {
  const errors: Record<string, string> = {};
  const title = config.title.trim();
  if (!title) addError(errors, "title", "请填写活动名称。");
  else if (characters(title) > ACTIVITY_LIMITS.titleCharacters)
    addError(errors, "title", "活动名称不能超过 100 个字符。");

  const passwordValues = config.passwords.map((password) => password.value);
  if (passwordValues.length < 1)
    addError(errors, "passwords", "至少填写一个兑换口令。");
  if (passwordValues.length > ACTIVITY_LIMITS.passwords)
    addError(errors, "passwords", "最多填写 5 条兑换口令。");
  const seen = new Map<string, number>();
  passwordValues.forEach((value, index) => {
    const key = `password:${config.passwords[index]?.id ?? index}`;
    if (!inspectPasswordValue(value))
      addError(errors, key, "口令须为 6–18 个字符，仅限汉字、英文字母和数字。");
    const previous = seen.get(value);
    if (value && previous !== undefined) {
      addError(errors, key, "口令重复，请移除重复项。");
      const previousId = config.passwords[previous]?.id;
      if (previousId !== undefined)
        addError(errors, `password:${previousId}`, "口令重复，请移除重复项。");
    } else if (value) seen.set(value, index);
  });

  if (config.topic.trim() && normalizePrototypeTopicLink(config.topic) === null)
    addError(errors, "topic", "请填写有效的 Linux DO 帖子或回复链接。");
  const canonicalTopic =
    normalizePrototypeTopicLink(config.topic)?.topicUrl ?? "";
  // Legacy description is retained for compatibility, but is no longer editable.
  for (const key of ["before", "after", "ended"] as const) {
    if (characters(config.notes[key]) > ACTIVITY_LIMITS.infoCharacters)
      addError(errors, `notes.${key}`, "说明不能超过 10,000 个字符。");
  }

  if (config.plan === "fixed") {
    const amount = amountCents(config.fixed.amount);
    const count = Number(config.fixed.count);
    if (amount === null)
      addError(errors, "fixed.amount", "请填写有效的每份 LDC 金额。");
    if (
      !/^\d+$/u.test(config.fixed.count) ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > ACTIVITY_LIMITS.rewards
    )
      addError(errors, "fixed.count", "奖励份数需要是 1–1000 的正整数。");
  } else if (config.plan === "random") {
    const amount = amountCents(config.random.amount);
    const count = Number(config.random.count);
    if (amount === null)
      addError(errors, "random.amount", "请填写有效的总奖池金额。");
    if (
      !/^\d+$/u.test(config.random.count) ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > ACTIVITY_LIMITS.rewards
    )
      addError(errors, "random.count", "奖励份数需要是 1–1000 的正整数。");
    if (
      amount !== null &&
      Number.isSafeInteger(count) &&
      count > 0 &&
      amount < BigInt(count)
    )
      addError(errors, "random.amount", "总金额不足，每份至少需要 0.01 LDC。");
  } else if (config.plan === "custom") {
    const lines = config.custom.amounts
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length)
      addError(errors, "custom.amounts", "请填写至少 1 份自定义金额。");
    if (lines.length > ACTIVITY_LIMITS.rewards)
      addError(errors, "custom.amounts", "自定义金额最多 1000 份。");
    if (lines.some((line) => amountCents(line) === null))
      addError(errors, "custom.amounts", "金额列表每行都需要是有效 LDC 金额。");
  } else {
    const amount = amountCents(config.draw.amount);
    const winners = Number(config.draw.winners);
    if (amount === null)
      addError(errors, "draw.amount", "请填写有效的总奖池金额。");
    if (
      !/^\d+$/u.test(config.draw.winners) ||
      !Number.isSafeInteger(winners) ||
      winners < 1 ||
      winners > ACTIVITY_LIMITS.rewards
    )
      addError(errors, "draw.winners", "获奖名额需要是 1–1000 的正整数。");
    if (
      amount !== null &&
      Number.isSafeInteger(winners) &&
      winners > 0 &&
      amount < BigInt(winners)
    )
      addError(
        errors,
        "draw.amount",
        "总奖池不足，每个获奖名额至少需要 0.01 LDC。",
      );
    const seconds = Number(config.draw.seconds);
    if (
      !/^\d+$/u.test(config.draw.seconds) ||
      !Number.isSafeInteger(seconds) ||
      seconds <= 0
    )
      addError(errors, "draw.seconds", "开奖倒计时需要填写正整数秒数。");
    const limit = Number(config.draw.limit);
    if (
      config.draw.limit &&
      (!/^\d+$/u.test(config.draw.limit) ||
        !Number.isSafeInteger(limit) ||
        limit <= 0)
    )
      addError(
        errors,
        "draw.limit",
        "报名上限可以留空；填写时需要使用正整数。",
      );
  }

  if (config.plan !== "draw") {
    const seconds = durationSeconds(config);
    if (seconds === null)
      addError(errors, "duration", "开放时长需要填写正整数。");
    else {
      const deadline = Date.now() + seconds * 1000;
      if (!Number.isFinite(deadline) || Math.abs(deadline) > 8640000000000000)
        addError(errors, "duration", "开放时长超出可支持范围。");
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, canonicalTopic };
}

function fixtureActivities(identity: Identity): ManagedActivity[] {
  const statuses = ["active", "draft", "ended", "archived"] as const;
  const titles = [
    "周末红包 · 20 份",
    "社区固定红包 · 12 份",
    "十月第一期红包",
    "文档整理红包 · 第三期",
    "月度随机红包",
    "十分钟限时开奖草稿",
    "项目资料整理红包",
    "社区资料包红包",
  ];
  return Array.from({ length: 24 }, (_, index) => {
    const config = fixtureActivityConfig(identity);
    const status = statuses[index % statuses.length] ?? "draft";
    config.rewardKind = "ldc";
    config.title = `${titles[index % titles.length]}${index >= 8 ? ` · 第 ${Math.floor(index / 8) + 1} 期` : ""}`;
    if (index % 8 === 4) config.plan = "random";
    if (index % 8 === 2) config.plan = "custom";
    if (index === 5 || index === 8) {
      config.plan = "draw";
      if (index === 8) config.title = "限时开奖 · 10 个获奖名额";
    }
    const count =
      index === 1 ? 12 : index % 4 === 0 ? 20 : index % 4 === 2 ? 30 : 8;
    const issue = index >= 8 ? ` · 第 ${Math.floor(index / 8) + 1} 期` : "";
    if (index % 8 === 1) config.title = `固定红包 · ${count} 份${issue}`;
    if (index % 8 === 5 && index !== 5)
      config.title = `固定红包草稿 · ${count} 份${issue}`;
    config.fixed.count = String(count);
    config.fixed.amount = index % 4 === 2 ? "0.50" : "0.88";
    config.random.count = String(count);
    config.random.amount = index % 4 === 0 ? "20.00" : "12.00";
    config.custom.amounts = Array.from(
      { length: count },
      (_, reward) => ["0.50", "0.88", "1.20"][reward % 3],
    ).join("\n");
    config.passwords = [
      {
        id: 1,
        value:
          index === 1
            ? "兑换口令2026"
            : `作者活动${String(index + 1).padStart(2, "0")}口令`,
      },
    ];
    config.topic = index === 1 ? "https://linux.do/t/topic/2964597/1216" : "";
    config.notes = {
      description: `第 ${index + 1} 期 LDC 活动介绍。`,
      before: `**${config.title}**\n\n每个账号可参与一次，成功兑换或中奖后查看奖励附言。`,
      after: `你已获得“${config.title}”的奖励。\n\n请在活动历史中核对本次结果；此附言随奖励分配解锁。`,
      ended: `“${config.title}”已结束。\n\n已有参与和奖励记录保留，可继续查看活动口令和允许公开的名单。`,
    };
    config.listed = status !== "draft";
    config.dedicated = identity !== "lite" && index === 0;
    const id = `${identity === "lite" ? "21000000" : "20000000"}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const claimed =
      status === "draft" || config.plan === "draw"
        ? 0
        : status === "active"
          ? 8
          : count;
    const deadlineAt = prototypeDeadlineAt(
      config.plan === "draw" ? "draw" : "ldc",
      status,
    );
    return {
      id,
      fixtureId: id,
      title: config.title,
      kind: planNames[config.plan],
      status,
      amount: rewardSummary(config),
      count: config.plan === "draw" ? 10 : count,
      claimed,
      rewardAmountInventory: createAmountInventory(config),
      registrations: config.plan === "draw" && status === "active" ? 30 : 0,
      createdAt: fixtureDate(
        -(index + 1) * 37 * 60_000 -
          (status === "archived"
            ? 9 * 24 * 60 * 60_000
            : status === "ended"
              ? 27 * 60 * 60_000
              : 0),
      ),
      deadlineAt,
      date:
        status === "draft"
          ? fixtureDate(-45 * 60_000)
          : status === "active"
            ? (deadlineAt ?? fixtureDate(0))
            : status === "ended"
              ? fixtureDate(-90 * 60_000)
              : fixtureDate(-8 * 24 * 60 * 60_000),
      config,
    };
  });
}

function fixturePayments(items: ManagedActivity[]): PaymentExample[] {
  const eligible = items.filter(
    (item) =>
      item.status !== "draft" &&
      !(item.config.plan === "draw" && item.status === "active"),
  );
  if (!eligible.length) return [];
  const sortedEligible = [...eligible].sort((left, right) => {
    const leftLarge = left.config.plan === "custom" && left.count > 20;
    const rightLarge = right.config.plan === "custom" && right.count > 20;
    if (leftLarge !== rightLarge) return leftLarge ? -1 : 1;
    return eligible.indexOf(left) - eligible.indexOf(right);
  });
  const kinds = [
    {
      state: "待发放",
      status: "pending" as const,
      detail: "奖励已分配，等待发放。",
    },
    {
      state: "已发放",
      status: "confirmed" as const,
      detail: "付款已确认；可用时间以 LDC 结算为准。",
    },
    {
      state: "等待恢复",
      status: "waiting" as const,
      detail: "奖励已保留，等待作者恢复发放。",
    },
  ];
  let serial = 0;
  const activityPayments = sortedEligible.flatMap((item, activityIndex) =>
    Array.from({ length: item.claimed }, (_, targetIndex) => {
      serial += 1;
      const kind = kinds[(activityIndex + targetIndex) % kinds.length];
      if (!kind) throw new Error("Invalid payment fixture");
      const amount =
        item.config.plan === "fixed"
          ? item.config.fixed.amount
          : item.rewardAmountInventory?.[targetIndex];
      if (!amount) throw new Error("Missing payment fixture amount snapshot");
      const recipient = recipientExamples[targetIndex];
      if (!recipient) throw new Error("Missing payment recipient fixture");
      const createdAt = recipient.time;
      // Explicit fixture confirmation, after every seeded claim; never a fallback
      // for a missing confirmation in a real payment record.
      const confirmedAt =
        kind.status === "confirmed" ? fixtureDate(-5_000) : null;
      return {
        ...kind,
        id: `HB20261006${String(serial).padStart(4, "0")}`,
        activityId: item.id,
        title: item.title,
        amount,
        date: createdAt,
        businessId: `CLAIM-${item.id.slice(-6)}-${String(targetIndex + 1).padStart(3, "0")}`,
        upstreamId:
          kind.status === "confirmed"
            ? `LDC-${String(860000 + serial)}`
            : kind.status === "waiting"
              ? `LDC-PENDING-${String(1200 + serial)}`
              : null,
        recipient: {
          name: recipient.name,
          username: recipient.username,
          color: recipient.color,
        },
        sentUsername:
          targetIndex % 6 === 0
            ? `old-${recipient.username}`
            : recipient.username,
        source: `关联活动：${item.title}`,
        createdAt,
        confirmedAt,
        firstSendAt:
          kind.status === "pending"
            ? null
            : new Date(Date.parse(createdAt) + 1_000).toISOString(),
        sendAcknowledgedAt:
          kind.status === "confirmed"
            ? new Date(Date.parse(createdAt) + 2_000).toISOString()
            : null,
        orderObservedAt:
          kind.status === "confirmed"
            ? new Date(Date.parse(createdAt) + 4_000).toISOString()
            : null,
        orderEvidence: "query" as const,
        canRepairCredentials: kind.status === "waiting",
        attempts:
          kind.status === "pending"
            ? []
            : [
                {
                  id: `send-${serial}`,
                  operation: "send" as const,
                  outcome:
                    kind.status === "confirmed" ? "请求已接收" : "凭证不可用",
                  startedAt: new Date(
                    Date.parse(createdAt) + 1_000,
                  ).toISOString(),
                  finishedAt: new Date(
                    Date.parse(createdAt) + 2_000,
                  ).toISOString(),
                  note:
                    kind.status === "waiting"
                      ? "原订单需要有效密钥才能继续核对。"
                      : null,
                },
                {
                  id: `query-${serial}`,
                  operation: "query" as const,
                  outcome:
                    kind.status === "confirmed" ? "已确认发放" : "等待核对",
                  startedAt: new Date(
                    Date.parse(createdAt) + 3_000,
                  ).toISOString(),
                  finishedAt: kind.status === "confirmed" ? confirmedAt : null,
                  note: null,
                },
              ],
        issue:
          kind.status === "waiting"
            ? "当前商户凭证需要恢复后继续发送。"
            : kind.status === "pending"
              ? "等待下一次付款队列处理。"
              : null,
        recovery:
          kind.status === "confirmed"
            ? "无需处理，记录仅供核对。"
            : kind.status === "waiting"
              ? "恢复有效凭证后从保留任务继续，不重新分配奖励。"
              : "队列会按计划继续发送或核对订单状态。",
      };
    }),
  );
  return activityPayments;
}

type StoreSnapshot = {
  activities: ManagedActivity[];
  payments: PaymentExample[];
};
export type WorkbenchStoresSnapshot = [Identity, StoreSnapshot][];
const stores = new Map<Identity, StoreSnapshot>();
const listeners = new Set<() => void>();
function normalizeActivityConfig(config: ActivityConfig): ActivityConfig {
  return {
    title: config.title,
    rewardKind: "ldc",
    plan: config.plan,
    fixed: config.fixed,
    random: config.random,
    custom: config.custom,
    draw: config.draw,
    passwords: config.passwords,
    topic: config.topic,
    listed: config.listed,
    dedicated: config.dedicated,
    quantity: config.quantity,
    showRecipients: config.showRecipients,
    hours: config.hours,
    durationUnit: config.durationUnit,
    notes: config.notes,
  };
}

function isLdcConfig(config: unknown): config is ActivityConfig {
  return (
    config !== null &&
    typeof config === "object" &&
    Reflect.get(config, "rewardKind") === "ldc" &&
    ["fixed", "random", "custom", "draw"].includes(Reflect.get(config, "plan"))
  );
}

function normalizeStoreSnapshot(store: StoreSnapshot): StoreSnapshot {
  const activities = store.activities
    .filter((activity) => isLdcConfig(activity.config))
    .map((activity) => ({
      ...activity,
      config: normalizeActivityConfig(activity.config),
    }));
  const activityIds = new Set(activities.map((activity) => activity.id));
  return {
    activities,
    payments: store.payments.filter((payment) =>
      payment.activityId === null ? true : activityIds.has(payment.activityId),
    ),
  };
}

function snapshot(identity: Identity): StoreSnapshot {
  const current = stores.get(identity);
  if (current) return current;
  const activities = identity === "standard" ? fixtureActivities(identity) : [];
  const initial = { activities, payments: fixturePayments(activities) };
  stores.set(identity, initial);
  return initial;
}
function publish(identity: Identity, next: StoreSnapshot) {
  stores.set(identity, next);
  for (const listener of listeners) listener();
}
export function exportWorkbenchStoresSnapshot(): WorkbenchStoresSnapshot {
  return structuredClone([...stores.entries()]);
}
export function importWorkbenchStoresSnapshot(
  snapshot: WorkbenchStoresSnapshot | undefined,
) {
  if (!snapshot) return;
  stores.clear();
  for (const [identity, store] of snapshot)
    stores.set(
      identity,
      identity === "standard"
        ? structuredClone(normalizeStoreSnapshot(store))
        : { activities: [], payments: [] },
    );
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWorkbenchStore(identity: Identity) {
  const getSnapshot = useCallback(() => snapshot(identity), [identity]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function findWorkbenchActivity(identity: Identity, id: string) {
  if (identity === "guest") return undefined;
  return snapshot(identity).activities.find(
    (item) => item.id === id || item.fixtureId === id,
  );
}

/** Published local activities remain addressable when the viewer changes. */
export function findPublishedWorkbenchActivity(id: string) {
  for (const store of stores.values()) {
    const item = store.activities.find(
      (activity) =>
        activity.status !== "draft" &&
        (activity.id === id || activity.fixtureId === id),
    );
    if (item) return toPrototypeActivity(item);
  }
  return undefined;
}

export function listPublishedWorkbenchActivities(): Activity[] {
  return [...stores.values()].flatMap((store) =>
    store.activities
      .filter((activity) => activity.status !== "draft")
      .map(toPrototypeActivity),
  );
}

export function toPrototypeActivity(
  item: ManagedActivity,
): Activity & { lifecycle: ActivityLifecycle } {
  return {
    id: item.fixtureId,
    title: item.title,
    author: "林间",
    username: "linjian",
    color: "sage",
    type: item.config.plan === "draw" ? "draw" : "ldc",
    rewardMode:
      item.config.plan === "draw"
        ? "timed_draw"
        : item.config.plan === "random"
          ? "instant_random"
          : item.config.plan === "custom"
            ? "custom"
            : "fixed",
    poolAmount:
      item.config.plan === "draw"
        ? item.config.draw.amount
        : item.config.plan === "random"
          ? item.config.random.amount
          : item.config.plan === "custom"
            ? customPool(item.config)
            : (fixedPoolAmount(item.config.fixed.amount, item.count) ??
              undefined),
    deadlineAt: item.deadlineAt,
    description: item.config.notes.description,
    topicUrl: item.config.topic || undefined,
    beforeInfo: item.config.notes.before,
    afterClaimInfo: item.config.notes.after,
    afterEndInfo: item.config.notes.ended,
    amount:
      item.config.plan === "draw"
        ? item.config.draw.amount
        : item.config.plan === "random"
          ? item.config.random.amount
          : item.config.plan === "custom"
            ? item.config.custom.amounts.split(/\r?\n/u)[0] || "0.00"
            : item.config.fixed.amount,
    count: item.count,
    registrationCount:
      item.config.plan === "draw" ? item.registrations : undefined,
    remaining: Math.max(0, item.count - item.claimed),
    publishedRecipientAmounts: item.rewardAmountInventory?.slice(
      0,
      Math.max(0, item.claimed),
    ),
    passwords: item.config.passwords.map((password) => password.value),
    ended: item.status === "ended" || item.status === "archived",
    lifecycle: item.status,
  };
}

export function deleteWorkbenchActivity(identity: Identity, id: string) {
  const current = snapshot(identity);
  const item = current.activities.find((activity) => activity.id === id);
  if (
    item?.status !== "draft" ||
    item.claimed ||
    item.registrations ||
    current.payments.some((payment) => payment.activityId === id)
  )
    return false;
  publish(identity, {
    ...current,
    activities: current.activities.filter((activity) => activity.id !== id),
  });
  return true;
}

export function endWorkbenchActivity(identity: Identity, id: string) {
  const current = snapshot(identity);
  const item = current.activities.find((activity) => activity.id === id);
  if (
    item?.status !== "active" ||
    item.claimed ||
    (item.config.plan === "draw" && item.registrations > 0)
  )
    return false;
  publish(identity, {
    ...current,
    activities: current.activities.map((activity) =>
      activity.id === id
        ? {
            ...activity,
            status: "ended",
            deadlineAt: new Date().toISOString(),
            date: new Date().toISOString(),
          }
        : activity,
    ),
  });
  return true;
}

export function saveWorkbenchActivity(
  identity: Identity,
  config: ActivityConfig,
  status: "draft" | "active",
  id?: string,
) {
  if (identity !== "standard" || !isLdcConfig(config)) return null;
  const current = snapshot(identity);
  const previous = id
    ? current.activities.find((item) => item.id === id)
    : undefined;
  if (id && !previous) return null;
  const nextConfig = structuredClone(
    previous && previous.status !== "draft"
      ? {
          ...previous.config,
          title: config.title,
          topic: config.topic,
          listed: previous.config.listed || config.listed,
          quantity: config.quantity,
          showRecipients: config.showRecipients,
          notes: config.notes,
        }
      : {
          ...normalizeActivityConfig(config),
          dedicated: previous ? previous.config.dedicated : config.dedicated,
          listed: previous
            ? previous.config.listed || config.listed
            : config.listed,
        },
  );
  const validation = validateActivityConfig(nextConfig);
  if (!validation.ok) return null;
  nextConfig.topic = validation.canonicalTopic;
  const count =
    nextConfig.plan === "draw"
      ? Number(nextConfig.draw.winners)
      : nextConfig.plan === "random"
        ? Number(nextConfig.random.count)
        : nextConfig.plan === "custom"
          ? nextConfig.custom.amounts
              .split(/\r?\n/u)
              .map((line) => line.trim())
              .filter(Boolean).length
          : Number(nextConfig.fixed.count);
  const deadlineAt =
    previous && previous.status !== "draft"
      ? previous.deadlineAt
      : status === "draft"
        ? null
        : deadlineForConfig(nextConfig, Date.now());
  if (
    status === "active" &&
    (!previous || previous.status === "draft") &&
    deadlineAt === null
  )
    return null;
  const next: ManagedActivity = {
    id: previous?.id ?? crypto.randomUUID(),
    fixtureId: previous?.fixtureId ?? "",
    title: nextConfig.title,
    kind: planNames[nextConfig.plan],
    status: previous && previous.status !== "draft" ? previous.status : status,
    amount: rewardSummary(nextConfig),
    count,
    claimed: previous?.claimed ?? 0,
    rewardAmountInventory:
      previous && sameAmountInventory(previous.config, nextConfig)
        ? previous.rewardAmountInventory
        : createAmountInventory(nextConfig),
    registrations: previous?.registrations ?? 0,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    deadlineAt,
    date:
      previous && previous.status !== "draft"
        ? previous.date
        : status === "active"
          ? (deadlineAt ?? new Date().toISOString())
          : new Date().toISOString(),
    config: nextConfig,
  };
  next.fixtureId = next.id;
  publish(identity, {
    ...current,
    activities: previous
      ? current.activities.map((item) => (item.id === id ? next : item))
      : [next, ...current.activities],
  });
  return next;
}
