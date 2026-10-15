import type {
  ActivityParticipationResponse,
  ActivityPasswords,
  ClaimDetail,
  ManagedActivity,
  PaymentView,
  PublicActivity,
} from "@hb/contracts";
import { rewardSummaryOf } from "./hongbao-text";
import type { RosterTitle } from "./titles";

// What a 红包 page shows, by the tiers the API serves (05 §数据分级): the
// public activity, the roster (always public), what opens at the end, and
// the viewer's own claim or sign-up. Pure mappers from production data to
// the shapes the 红包 components draw.

export type RewardMode = "fixed" | "random" | "custom" | "timed_draw";

/** The 红包 itself, as its components need it. */
export type HongbaoActivity = {
  id: string;
  title: string;
  author: { displayName: string; username: string; avatarUrl: string | null };
  mode: RewardMode;
  participation: "password" | "direct";
  /** Saved but not opened (草稿): only its sender can see it. */
  draft: boolean;
  topic?: { topicId: string; postNumber: number };
  totalAmount: string;
  unitAmount?: string;
  /** Shares offered; for a timed draw, the number of winners. */
  shares: number;
  rewardSummary: string;
  /** 说明 (Markdown). */
  beforeInfo: string;
  /** 口令尝试统计: attempts here are summed up for the sender (📊). */
  statistics: boolean;
  /** 自定义金额's order, known to the sender only. */
  custom?: { allocation: "sequential" | "random" };
  /** A 草稿's deadline as set: counted from opening, or a fixed time. */
  draftTiming?:
    | { kind: "duration"; value: number; unit: "minutes" | "hours" | "days" }
    | { kind: "at"; at: string };
  /** Every 口令: the sender's own view only. */
  passwords: string[];
};

/** 已领完 · 已过期 · 已开奖 · 无人报名 · 开奖中 · 已提前结束 */
export type EndReason =
  | "sold_out"
  | "expired"
  | "drawn"
  | "empty"
  | "settling"
  | "closed";

export const endLabels: Record<EndReason, string> = {
  sold_out: "已领完",
  expired: "已过期",
  drawn: "已开奖",
  empty: "无人报名",
  settling: "开奖中",
  closed: "已提前结束",
};

export type FuzzyLevel = "plenty" | "limited" | "low" | "empty";
/** Production's levels, without its "奖励" prefix. */
export const fuzzyLabels: Record<FuzzyLevel, string> = {
  plenty: "充足",
  limited: "有限",
  low: "少量",
  empty: "已领完",
};

export type DrawState = "waiting" | "settling" | "completed" | "empty";

export type PublicView = {
  ended: boolean;
  endReason: EndReason | null;
  openedAt: number;
  deadlineAt: number;
  /** Fuzzy shows only a level: no share count, no fixed-split total. */
  quantity:
    | { kind: "exact"; taken: number; total: number }
    | { kind: "fuzzy"; level: FuzzyLevel };
  draw: {
    state: DrawState;
    /** Sign-ups, winners and 报名上限 are hidden when quantity is fuzzy. */
    registered: number | null;
    winners: number | null;
    limit: number | null;
    /** 报名上限 reached: settling early rather than at the deadline. */
    full: boolean;
  } | null;
  /** 结束说明: public once the 红包 has ended. */
  afterEndInfo?: string;
};

const topicPattern = /^https:\/\/linux\.do\/t\/(?:topic\/)?(\d+)\/(\d+)$/u;

function topicOf(url: string | null) {
  const match = url ? topicPattern.exec(url) : null;
  return match?.[1] && match[2]
    ? { topicId: match[1], postNumber: Number(match[2]) }
    : undefined;
}

/** The 红包 as its components draw it; the sender's own read adds its setup. */
export function hongbaoOf(
  activity: PublicActivity,
  managed?: ManagedActivity | null,
): HongbaoActivity {
  const reward = activity.reward;
  const config = managed?.config;
  const deadline = config?.deadline;
  return {
    id: activity.id,
    title: activity.title,
    author: {
      displayName:
        activity.author.displayName || activity.author.username || "发红包的人",
      username: activity.author.username,
      avatarUrl: activity.author.avatarUrl,
    },
    mode: reward?.mode ?? "fixed",
    participation: activity.participationMode ?? "password",
    draft: activity.status === "draft",
    topic: topicOf(activity.topicUrl),
    totalAmount: reward?.totalAmount ?? "",
    unitAmount: reward?.unitAmount,
    shares:
      reward?.count ??
      (activity.quantity.mode === "exact" ? activity.quantity.total : 0),
    rewardSummary: rewardSummaryOf(reward),
    beforeInfo: activity.beforeInfo,
    statistics: activity.forceDedicated,
    custom:
      config && config.money.mode === "custom"
        ? { allocation: config.allocation }
        : undefined,
    draftTiming:
      activity.status !== "draft" || !deadline
        ? undefined
        : deadline.mode === "at"
          ? { kind: "at", at: deadline.at }
          : "value" in deadline
            ? { kind: "duration", value: deadline.value, unit: deadline.unit }
            : undefined,
    passwords: config?.passwords ?? [],
  };
}

function soldOut(activity: PublicActivity) {
  const { quantity } = activity;
  if (quantity.mode === "exact") return quantity.remaining <= 0;
  if (quantity.mode === "fuzzy") return quantity.level === "empty";
  if (quantity.mode === "availability") return !quantity.available;
  return false;
}

function endReasonOf(activity: PublicActivity, now: number): EndReason | null {
  if (activity.status === "draft") return null;
  const draw = activity.draw;
  if (draw) {
    if (draw.state === "settling") return "settling";
    if (draw.state === "completed") return "drawn";
    if (draw.state === "empty") return "empty";
    return activity.status === "active" ? null : "drawn";
  }
  if (soldOut(activity)) return "sold_out";
  const deadline = activity.deadlineAt ? Date.parse(activity.deadlineAt) : null;
  if (deadline !== null && deadline <= now) return "expired";
  if (activity.status === "active") return null;
  return "closed";
}

const fuzzyLevelOf = (activity: PublicActivity): FuzzyLevel => {
  const { quantity } = activity;
  if (quantity.mode === "fuzzy") return quantity.level;
  if (quantity.mode === "availability")
    return quantity.available ? "plenty" : "empty";
  return "plenty";
};

/** The public tier: anyone may see this. */
export function publicViewOf(
  activity: PublicActivity,
  now = Date.now(),
): PublicView {
  const endReason = endReasonOf(activity, now);
  const draw = activity.draw;
  const deadline = draw?.deadlineAt ?? activity.deadlineAt;
  const limit = draw?.participantLimit ?? null;
  const registered = draw?.registeredCount ?? null;
  return {
    ended: endReason !== null,
    endReason,
    openedAt: activity.openedAt ? Date.parse(activity.openedAt) : now,
    deadlineAt: deadline ? Date.parse(deadline) : now,
    quantity:
      activity.quantity.mode === "exact"
        ? {
            kind: "exact",
            taken: activity.quantity.claimed,
            total: activity.quantity.total,
          }
        : { kind: "fuzzy", level: fuzzyLevelOf(activity) },
    draw: draw
      ? {
          state: draw.state,
          registered,
          winners: draw.winnerCount,
          limit,
          full:
            draw.reason === "full" ||
            (limit !== null && registered !== null && registered >= limit),
        }
      : null,
    afterEndInfo: endReason ? activity.afterEndInfo : undefined,
  };
}

/** Under a seal that can no longer be opened (page and forum image). */
export function endHint(view: PublicView) {
  if (view.endReason === "settling")
    return view.draw?.full ? "报名已满，正在开奖…" : "报名已截止，正在开奖…";
  return {
    sold_out: "红包已领完",
    expired: "红包已过期",
    drawn: "已开奖",
    empty: "无人报名",
    closed: "红包已提前结束",
  }[view.endReason ?? "expired"];
}

export type RosterRow = {
  id: string;
  /** Place in the list: claim order, or prize order for winners. */
  rank: number;
  name: string;
  username: string;
  avatarUrl: string | null;
  you: boolean;
  amount: string | null;
  at: number;
  titles: RosterTitle[];
  /** The sender's view: the 口令 used and the payment (05 §作者名单). */
  password?: string | null;
  payment?: PaymentView | null;
};

/**
 * Always public. Claims (and sign-ups) in the order they happened, so a rank
 * never changes as more people join; a drawn timed draw adds its winners,
 * best prize first.
 */
export type Roster =
  | { kind: "claims"; rows: RosterRow[] }
  | { kind: "registrations"; rows: RosterRow[] }
  | { kind: "draw"; winners: RosterRow[]; registrations: RosterRow[] };

const centsOf = (amount: string | null) => {
  if (!amount) return 0;
  const [whole = "0", fraction = ""] = amount.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
};

/** The roster as the cover and the 名单弹窗 show it. */
export function rosterOf(
  view: PublicView,
  claims: RosterRow[],
  registrations: RosterRow[],
): Roster {
  if (!view.draw) return { kind: "claims", rows: claims };
  if (view.draw.state !== "completed")
    return { kind: "registrations", rows: registrations };
  const winners = [...claims]
    .sort((a, b) => centsOf(b.amount) - centsOf(a.amount) || a.at - b.at)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return { kind: "draw", winners, registrations };
}

/** Why a 口令 is known to this viewer, in the order the labels win. */
export type PasswordLabel =
  | "registered"
  | "claimed"
  | "solved"
  | "public"
  | "own";

export type PasswordView = {
  known: { text: string; label: PasswordLabel }[];
  hidden: number;
  /** 验证其他口令: took part, 口令 红包, still running, something left. */
  canVerify: boolean;
};

const noPasswords: PasswordView = { known: [], hidden: 0, canVerify: false };

/** The viewer's 口令 tier (the passwords endpoint), or every one for the sender. */
export function passwordViewOf(
  passwords: ActivityPasswords | undefined,
  sender?: { passwords: string[] } | null,
): PasswordView {
  if (sender)
    return {
      known: sender.passwords.map((text) => ({ text, label: "own" })),
      hidden: 0,
      canVerify: false,
    };
  if (!passwords) return noPasswords;
  return {
    known: passwords.passwords.map((item) => ({
      text: item.text,
      label: item.isRegistrationPassword
        ? "registered"
        : item.isClaimPassword
          ? "claimed"
          : item.isSolved
            ? "solved"
            : "public",
    })),
    hidden: passwords.hiddenCount,
    canVerify: passwords.canSolve && passwords.hiddenCount > 0,
  };
}

export type Mine =
  | {
      kind: "claimed";
      amount: string;
      password: string | null;
      at: number;
      titles: RosterTitle[];
      afterClaimInfo?: string;
      payment: PaymentView | null;
    }
  | {
      kind: "registered";
      outcome: "waiting" | "settling" | "won" | "lost";
      amount?: string;
      password: string | null;
      at: number;
      titles: RosterTitle[];
      afterClaimInfo?: string;
      payment: PaymentView | null;
    };

function claimed(claim: ClaimDetail, titles: RosterTitle[]): Mine {
  return {
    kind: "claimed",
    amount: claim.amount,
    password: claim.sourcePassword ?? null,
    at: Date.parse(claim.claimedAt),
    titles,
    afterClaimInfo: claim.afterClaimInfo || undefined,
    payment: claim.payment,
  };
}

/** The viewer's own claim or sign-up, with their titles from the roster. */
export function mineOf(
  participation: Partial<ActivityParticipationResponse> | null | undefined,
  view: PublicView,
  roster: Roster,
): Mine | null {
  const rows = roster.kind === "draw" ? roster.winners : roster.rows;
  const titles = rows.find((row) => row.you)?.titles ?? [];
  if (participation?.claim && !participation.registration)
    return claimed(participation.claim, titles);
  const registration = participation?.registration;
  if (!registration) return null;
  const outcome =
    registration.status === "won"
      ? "won"
      : registration.status === "not_won"
        ? "lost"
        : registration.status === "drawing" || view.draw?.state === "settling"
          ? "settling"
          : "waiting";
  const claim = registration.claim;
  return {
    kind: "registered",
    outcome,
    amount: outcome === "won" ? claim?.amount : undefined,
    password: registration.sourcePassword ?? null,
    at: Date.parse(registration.registeredAt),
    titles: outcome === "won" ? titles : [],
    afterClaimInfo:
      outcome === "won" ? claim?.afterClaimInfo || undefined : undefined,
    payment: outcome === "won" ? (claim?.payment ?? null) : null,
  };
}
