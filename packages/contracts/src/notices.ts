import { z } from "zod";

// 私信通知 (docs/notification-design.md): mail to a user's 社区 隐私邮箱,
// which the 社区 turns into a private message from the 站长's account.
// Each kind below can be turned off on /notifications; 等的红包开放了 has no
// switch here, the 红包's own “开放时提醒我” is its switch.

export const NOTICE_CATEGORIES = [
  "draw_won",
  "payout_failed",
  "payout_stuck",
  "payout_stopped",
  "schedule_failed",
  "hongbao_stopped",
  "points_hongbao_ended",
  "tip_received",
  "transfer_received",
  "judge_withdrawn",
  "points_review",
  "points_status",
  "points_breaker",
] as const;
export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];

/**
 * Every kind a notice is written as: the switches, 等的红包开放了, and
 * 红包广场's 下一个红包开放时提醒我 (each its own button, used once).
 */
export type NoticeKind = NoticeCategory | "opening_watch" | "square_watch";

export type NoticeGroup = "claim" | "send" | "money" | "judge" | "points";

export const NOTICE_GROUPS: { id: NoticeGroup; title: string }[] = [
  { id: "claim", title: "领红包" },
  { id: "send", title: "发红包" },
  { id: "money", title: "打赏和转账" },
  { id: "judge", title: "判定器" },
  { id: "points", title: "三方积分" },
];

export const NOTICE_SWITCHES: {
  id: NoticeCategory;
  group: NoticeGroup;
  title: string;
  /** When it is sent, under the switch. */
  hint: string;
}[] = [
  {
    id: "draw_won",
    group: "claim",
    title: "限时开奖中了",
    hint: "你报名的限时开奖开奖了，而且你中了。",
  },
  {
    id: "payout_failed",
    group: "claim",
    title: "领到的奖励发放失败",
    hint: "你领到的奖励因红包作者的 Credit 余额不足，自动重试 3 天仍未成功，发放已终止。",
  },
  {
    id: "payout_stuck",
    group: "send",
    title: "奖励发放暂停",
    hint: "有人领取后，因你的 Credit 余额不足或今日额度已用完，奖励暂未发放。余额不足时写明自动重试到何时；每次暂停只提醒一次。",
  },
  {
    id: "payout_stopped",
    group: "send",
    title: "奖励发放已终止",
    hint: "你的 Credit 余额不足持续 3 天，未发放的奖励终止发放，用这个商户发的进行中红包结束。",
  },
  {
    id: "schedule_failed",
    group: "send",
    title: "定时开放没开成",
    hint: "定时开放的红包到点没开成，退回了草稿。",
  },
  {
    id: "hongbao_stopped",
    group: "send",
    title: "红包被站长停用",
    hint: "站长停用了你的红包，剩下的退回了🐟额。",
  },
  {
    id: "points_hongbao_ended",
    group: "send",
    title: "三方积分红包提前结束",
    hint: "用三方积分发的红包因为余额不够、密钥失效或积分下架提前结束。",
  },
  {
    id: "tip_received",
    group: "money",
    title: "收到打赏",
    hint: "每收到一笔打赏。",
  },
  {
    id: "transfer_received",
    group: "money",
    title: "收到转账",
    hint: "每收到一笔🐟额转账。",
  },
  {
    id: "judge_withdrawn",
    group: "judge",
    title: "判定器被撤下",
    hint: "站长把你的判定器从判定器广场撤下。",
  },
  {
    id: "points_review",
    group: "points",
    title: "审核结果",
    hint: "你添加的积分审核通过，或者被退回。",
  },
  {
    id: "points_status",
    group: "points",
    title: "被暂停、恢复、下架",
    hint: "站长暂停、恢复或下架了你添加的积分。",
  },
  {
    id: "points_breaker",
    group: "points",
    title: "接口连不上",
    hint: "你添加的积分的接口连续没有回复，积分分发暂停了。一次故障只提醒一次。",
  },
];

export function isNoticeCategory(value: unknown): value is NoticeCategory {
  return (
    typeof value === "string" &&
    (NOTICE_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Why this account gets no notices: none, the 站长 (the 社区 cannot message itself), or no 隐私邮箱. */
export type NoticeAvailability = "ok" | "owner" | "no_email";

export type NoticeRecent = {
  id: string;
  subject: string;
  /** queued: still going; failed: never reached the 社区. */
  status: "queued" | "sent" | "failed";
  createdAt: string;
  sentAt: string | null;
};

export type NoticeSettingsView = {
  availability: NoticeAvailability;
  switches: Record<NoticeCategory, boolean>;
  /** Groups only some see: 判定器 for those who wrote one, 三方积分 for those who added one. */
  groups: { judge: boolean; points: boolean };
  /** The last 30 days', newest first. */
  recent: NoticeRecent[];
};

/** The 站长's view of the outbox (/admin). */
export type NoticeAdminStats = {
  /** Today in Beijing time. */
  today: { sent: number; skipped: number; failed: number; queued: number };
  /** Sending is set up: an SMTP account and its token. */
  configured: boolean;
  failures: {
    id: string;
    kind: string;
    subject: string;
    reason: string | null;
    createdAt: string;
  }[];
};

/**
 * 开放时提醒我 (§3.1) on a timed 红包 not yet open: null when this viewer
 * cannot use it (signed out, its sender, or no notice can reach them).
 */
export type OpeningWatchView = { openingWatch: { watching: boolean } | null };

/**
 * 红包广场's 下一个红包开放时提醒我 (§3.1): this viewer's button (null when
 * they cannot use it), and how many wait now, shown to everyone.
 */
export type SquareWatchView = {
  squareWatch: { watching: boolean } | null;
  waiting: number;
};

/**
 * 私信通知's pace (§2.3), set in 网站管理 → 设置: the 社区 drops mail that
 * comes too close together.
 */
export type NoticePace = {
  version: number;
  /** Any two mails, whoever they go to. */
  anyGapSeconds: number;
  /** Two mails to one person. */
  samePersonGapSeconds: number;
  updatedAt: string;
};

export const updateNoticePaceSchema = z.strictObject({
  expectedVersion: z.number().int().positive().safe(),
  anyGapSeconds: z.number().int().min(0).max(600),
  samePersonGapSeconds: z.number().int().min(0).max(3600),
});
export type UpdateNoticePaceInput = z.infer<typeof updateNoticePaceSchema>;
