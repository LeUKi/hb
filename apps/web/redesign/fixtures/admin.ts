import { activities, openedAtOf } from "./activities";
import { merchants } from "./merchants";
import {
  type FixturePayment,
  hex,
  isOpenPayment,
  sitePayments,
  usernames,
  uuidOf,
  waitedMinutes,
} from "./payments";
import { demoProfile, demoViewerName } from "./session";

// 网站管理 (/admin): everything an admin reads. Production's admin area is
// read-only apart from the 尝试间隔 settings; these are made-up numbers in
// the same shapes as /api/admin/*.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const loadedAt = Date.now();

// ── 用户 ──────────────────────────────────────────────────────────────

export type SiteUser = {
  id: string;
  linuxDoId: number;
  username: string;
  displayName: string;
  active: boolean;
  admin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  sent: number;
  claims: number;
  registrations: number;
  merchants: number;
};

let users: SiteUser[] | null = null;

/** Senders, claimers and the demo account, one row each. */
export function siteUsers(): SiteUser[] {
  if (users) return users;
  const names = new Map<string, string>();
  names.set(demoViewerName, "linjian");
  for (const activity of activities) {
    names.set(activity.author.displayName, activity.author.username);
    for (const entry of activity.entries)
      names.set(entry.name, usernames[entry.name] ?? "user");
  }
  users = [...names].map(([displayName, username], index) => {
    const seed = Number.parseInt(hex(`user:${username}`, 6), 16);
    const sent = activities.filter(
      (activity) => activity.author.username === username,
    );
    const entries = activities.flatMap((activity) =>
      activity.entries
        .filter((entry) => entry.name === displayName)
        .map(() => activity),
    );
    const demo = username === "linjian";
    // The demo account's own earlier claims are `mine`, not entries.
    const mine = demo
      ? activities.flatMap((activity) => (activity.mine ? [activity] : []))
      : [];
    return {
      id: demo ? demoProfile.accountId : uuidOf(`user:${username}`),
      linuxDoId: 10_000 + (seed % 190_000),
      username,
      displayName,
      // One account switched off on the forum (production copies `active`
      // from the LINUX DO profile at each sign-in).
      active: username !== "baikaishui",
      admin: demo,
      createdAt: loadedAt - (12 + (seed % 160)) * DAY,
      lastLoginAt: demo
        ? loadedAt - 25 * MINUTE
        : index % 7 === 6
          ? null
          : loadedAt - ((seed % 90) + 2) * HOUR,
      sent: sent.length,
      claims: [...entries, ...mine].filter(
        (activity) => activity.mode !== "timed_draw",
      ).length,
      registrations: [...entries, ...mine].filter(
        (activity) => activity.mode === "timed_draw",
      ).length,
      merchants: demo ? merchants.length : sent.length > 0 ? 1 : 0,
    };
  });
  users.sort((a, b) => b.createdAt - a.createdAt);
  return users;
}

// ── 概览 ──────────────────────────────────────────────────────────────

export type Diagnostic = {
  key: string;
  label: string;
  count: number;
  /** Where the list is, filtered to these. */
  link?: {
    to: "/admin/payments" | "/admin/activities";
    anomaly?: string;
    state?: string;
  };
};

export function diagnostics(now = Date.now()): Diagnostic[] {
  const payments = sitePayments();
  const open = payments.filter(isOpenPayment);
  return [
    {
      key: "unknown",
      label: "付款结果未知",
      count: open.filter((payment) => payment.state === "reconciling").length,
      link: { to: "/admin/payments", anomaly: "unknown" },
    },
    {
      key: "attention",
      label: "付款异常待处理",
      count: open.filter((payment) => payment.state === "attention").length,
      // A payment state of its own: the list's state filter.
      link: { to: "/admin/payments", state: "attention" },
    },
    {
      key: "overdue",
      label: "付款等待超过一小时",
      count: open.filter((payment) => waitedMinutes(payment, now) > 60).length,
      link: { to: "/admin/payments", anomaly: "overdue" },
    },
    {
      key: "draw",
      label: "开奖等待超过十分钟",
      count: 0,
      link: { to: "/admin/activities", anomaly: "draw" },
    },
    {
      key: "undelivered",
      label: "任务未投递超过十分钟",
      count: 0,
      link: { to: "/admin/payments", anomaly: "undelivered" },
    },
    { key: "maintenance", label: "维护失败或超过十五分钟未更新", count: 0 },
  ];
}

/** Whether payments match an anomaly filter from the overview. */
export function matchesAnomaly(
  payment: FixturePayment,
  anomaly: string,
  now = Date.now(),
) {
  if (anomaly === "unknown") return payment.state === "reconciling";
  if (anomaly === "overdue")
    return isOpenPayment(payment) && waitedMinutes(payment, now) > 60;
  if (anomaly === "undelivered") return false;
  return true;
}

export const permissions = [
  { label: "真实红包开放", allowed: true, blockers: [] as string[] },
  { label: "真实领取", allowed: true, blockers: [] as string[] },
  { label: "真实付款", allowed: true, blockers: [] as string[] },
  { label: "限时开奖", allowed: true, blockers: [] as string[] },
];

export const maintenanceJobs = [
  {
    name: "红包与开奖维护",
    state: "已完成",
    startedAt: loadedAt - 3 * MINUTE,
    finishedAt: loadedAt - 3 * MINUTE + 4_000,
    reason: null as string | null,
  },
  {
    name: "付款补偿",
    state: "已完成",
    startedAt: loadedAt - 2 * MINUTE,
    finishedAt: loadedAt - 2 * MINUTE + 9_000,
    reason: null as string | null,
  },
  {
    name: "凭证检查恢复",
    state: "已完成",
    startedAt: loadedAt - 6 * MINUTE,
    finishedAt: loadedAt - 6 * MINUTE + 2_000,
    reason: null as string | null,
  },
  {
    name: "会话清理",
    state: "已完成",
    startedAt: loadedAt - 9 * HOUR,
    finishedAt: loadedAt - 9 * HOUR + 1_000,
    reason: null as string | null,
  },
];

// ── 网站设置与操作记录 ────────────────────────────────────────────────

export type RateLimits = { home: number; page: number };

export type AuditRecord = {
  id: string;
  at: number;
  operator: { displayName: string; id: string };
  from: number;
  to: number;
  before: RateLimits;
  after: RateLimits;
};

const operator = { displayName: demoViewerName, id: demoProfile.accountId };

/** Saved settings: production's defaults are 5 s and 2 s. */
export const savedRateLimits = {
  version: 4,
  value: { home: 5, page: 2 } as RateLimits,
  updatedAt: loadedAt - 6 * DAY,
  operator,
};

export const auditRecords: AuditRecord[] = [
  {
    id: hex("audit:4", 12),
    at: loadedAt - 6 * DAY,
    operator,
    from: 3,
    to: 4,
    before: { home: 8, page: 2 },
    after: { home: 5, page: 2 },
  },
  {
    id: hex("audit:3", 12),
    at: loadedAt - 13 * DAY - 2 * HOUR,
    operator,
    from: 2,
    to: 3,
    before: { home: 8, page: 3 },
    after: { home: 8, page: 2 },
  },
  {
    id: hex("audit:2", 12),
    at: loadedAt - 29 * DAY,
    operator,
    from: 1,
    to: 2,
    before: { home: 5, page: 2 },
    after: { home: 8, page: 3 },
  },
];

/** When a 红包 was created, for the admin list (before it opened). */
export function createdAtOf(activityId: string) {
  const activity = activities.find((item) => item.id === activityId);
  if (!activity) return loadedAt;
  const seed = Number.parseInt(hex(`created:${activityId}`, 4), 16);
  return openedAtOf(activity) - ((seed % 50) + 3) * MINUTE;
}
