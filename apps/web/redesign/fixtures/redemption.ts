import { encodeActivityEmoji } from "@/lib/ecoji-v2";
import {
  activities,
  type FixtureActivity,
  findActivity,
  fixtureIds,
} from "./activities";

export type DiscoverResult =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "single"; activityId: string }
  | { kind: "multiple"; activityIds: string[] };

export type ClaimResult =
  | { kind: "claimed"; amount: string }
  | { kind: "registered" }
  | { kind: "incorrect" }
  | { kind: "ended" }
  | { kind: "already" }
  | { kind: "own" }
  | { kind: "not_found" };

export type RecentEntry = {
  password: string;
  status: "matched" | "unmatched" | "unconfirmed";
  activityIds: string[];
  at: number;
};

const UNKNOWN_ONCE = "网络中断测试";

export const networkLatency = 450;

export function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Mirrors POST /redemptions/discover: find candidates, never claim. */
export function discover(password: string, attempt: number): DiscoverResult {
  if (password === UNKNOWN_ONCE && attempt === 0) return { kind: "unknown" };
  // Drafts are not open yet; 口令尝试统计 红包 redeem on their own page only.
  const matches = activities.filter(
    (activity) =>
      activity.participation === "password" &&
      !activity.draft &&
      !activity.statistics &&
      activity.passwords.includes(password),
  );
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1 && matches[0])
    return { kind: "single", activityId: matches[0].id };
  return { kind: "multiple", activityIds: matches.map((item) => item.id) };
}

/** Mirrors GET /topics/:id/activities. */
export function lookupTopic(topicId: string, postNumber: number) {
  return activities
    .filter(
      (activity) =>
        !activity.draft &&
        activity.topic?.topicId === topicId &&
        activity.topic.postNumber === postNumber,
    )
    .map((activity) => activity.id);
}

/** Mirrors POST /activities/:id/claim (password or direct participation). */
export function claim(
  activity: FixtureActivity,
  password: string | null,
  alreadyClaimed: boolean,
  own = false,
): ClaimResult {
  if (activity.draft) return { kind: "not_found" };
  if (activity.status !== "active") return { kind: "ended" };
  // Production: 作者不能领取自己创建的 LDC 活动 (before any amount is drawn).
  if (own) return { kind: "own" };
  if (alreadyClaimed) return { kind: "already" };
  if (activity.participation === "password") {
    if (!password || !activity.passwords.includes(password))
      return { kind: "incorrect" };
  }
  if (activity.mode === "timed_draw") return { kind: "registered" };
  return { kind: "claimed", amount: activity.amount(activity.entries.length) };
}

/** The 红包 a sample 口令 opens (for the seeded 最近输入). */
const opens = (password: string) =>
  activities
    .filter((activity) => activity.passwords.includes(password))
    .map((activity) => activity.id);

/** Ten entries: the start page shows up to ten, wrapping onto more lines. */
export function seedRecent(now: number): RecentEntry[] {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const entries: [string, number][] = [
    ["公共口令2026", 6 * minute],
    ["阅读口令2026", 40 * minute],
    ["周末口令2026", 2 * hour],
    ["随机口令2026", 5 * hour],
    ["错误口令123", 26 * hour],
    ["答题口令2026", 30 * hour],
    ["十月口令2026", 3 * day],
    ["红包口令2025", 3.5 * day],
    ["假期口令2026", 4 * day],
    ["中秋口令2026", 6 * day],
  ];
  return entries.map(([password, ago]) => {
    const activityIds = opens(password);
    return {
      password,
      status: activityIds.length > 0 ? "matched" : "unmatched",
      activityIds,
      at: now - ago,
    };
  });
}

export type SampleInput = { group: string; label: string; value: string };

/** Example inputs for the dev toolbar; site links use the current origin. */
export function sampleInputs(origin: string): SampleInput[] {
  const weekend = findActivity(fixtureIds.weekend);
  const reading = findActivity(fixtureIds.reading);
  const random = findActivity(fixtureIds.random);
  const first = findActivity(fixtureIds.first);
  return [
    { group: "口令", label: "单个匹配", value: "周末口令2026" },
    { group: "口令", label: "多个匹配", value: "公共口令2026" },
    { group: "口令", label: "没有匹配", value: "不存在的口令" },
    { group: "口令", label: "已结束的红包", value: "十月口令2026" },
    { group: "口令", label: "自定义金额（按顺序）", value: "答题口令2026" },
    { group: "口令", label: "限时开奖（名额不公开）", value: "神秘口令2026" },
    { group: "口令", label: "结果未知后再次确认", value: UNKNOWN_ONCE },
    {
      group: "口令",
      label: "不合规（含全角与空格）",
      value: "周末 口令２０２６！",
    },
    { group: "红包", label: "红包 ID", value: weekend?.id ?? "" },
    {
      group: "红包",
      label: "表情码",
      value: reading ? encodeActivityEmoji(reading.id) : "",
    },
    {
      group: "红包",
      label: "红包地址",
      value: random ? `/🧧/${encodeActivityEmoji(random.id)}` : "",
    },
    {
      group: "红包",
      label: "本站红包链接",
      value: weekend ? `${origin}/🧧/${encodeActivityEmoji(weekend.id)}` : "",
    },
    {
      group: "红包",
      label: "开门红（第一个领）",
      value: first ? `${origin}/🧧/${encodeActivityEmoji(first.id)}` : "",
    },
    {
      group: "红包",
      label: "旧格式链接（已停用）",
      value: reading ? `${origin}/e/${encodeActivityEmoji(reading.id)}` : "",
    },
    {
      group: "帖子",
      label: "多个红包",
      value: "https://linux.do/t/topic/2964597",
    },
    {
      group: "帖子",
      label: "一个红包",
      value: "https://linux.do/t/topic/3001234/5",
    },
    { group: "帖子", label: "没有关联", value: "https://linux.do/t/topic/1" },
    { group: "命令", label: "全部命令", value: "/" },
    { group: "命令", label: "/hist", value: "/hist" },
    { group: "命令", label: "、lishi（中文输入法）", value: "、lishi" },
    { group: "命令", label: "全角 ／ｓｑｕａｒｅ", value: "／ｓｑｕａｒｅ" },
    { group: "命令", label: "/fhb 拼音首字母", value: "/fhb" },
    { group: "命令", label: "没有匹配", value: "/zzz" },
  ];
}
