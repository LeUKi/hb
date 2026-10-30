import { z } from "zod";
import type { PublicUserProfile } from "./profile";

// 施工中 (docs/roadmap-design.md): what the 站长 is building, what is done,
// what people asked for, and the votes on them. The 站长 runs it from 网站管理.

export const ROADMAP_LIMITS = {
  title: 40,
  detail: 500,
  note: 100,
  reason: 100,
} as const;

const characters = (value: string) => Array.from(value).length;

const text = (max: number, empty: string | null, too: string) =>
  z
    .string()
    .trim()
    .refine((value) => empty === null || value !== "", empty ?? "")
    .refine((value) => characters(value) <= max, too);

/** 提一个需求 (§3): 想要什么, and 说明 if any. */
export const roadmapRequestSchema = z.strictObject({
  title: text(ROADMAP_LIMITS.title, "写一下想要什么", "想要什么最多 40 个字"),
  detail: text(ROADMAP_LIMITS.detail, null, "说明最多 500 个字"),
});
export type RoadmapRequestInput = z.infer<typeof roadmapRequestSchema>;

/** 点赞, or take it back (§2.4). */
export const roadmapVoteSchema = z.strictObject({ voted: z.boolean() });

/** Where a thing stands; merged ones show nowhere. */
export type RoadmapStatus = "request" | "building" | "done" | "declined";

export type RoadmapItem = {
  id: string;
  status: RoadmapStatus;
  title: string;
  detail: string;
  /** Who asked for it; the 站长's own say nothing of it (byOwner). */
  author: PublicUserProfile;
  byOwner: boolean;
  votes: number;
  /** The viewer's vote; false for a guest. */
  voted: boolean;
  /** The viewer asked for it: theirs to change or take away until begun. */
  mine: boolean;
  createdAt: string;
  startedAt: string | null;
  doneAt: string | null;
  /** 不做's reason. */
  reason: string | null;
  /** The 站长's latest line on it (施工中). */
  note: { text: string; at: string } | null;
  /** 网站管理 only. */
  hidden?: boolean;
};

/** The page's top: all being built, and how many of the rest (§2). */
export type RoadmapSummary = {
  building: RoadmapItem[];
  counts: { request: number; done: number; declined: number };
};

export type RoadmapList = { items: RoadmapItem[]; nextCursor: string | null };

export type RoadmapDetail = {
  item: RoadmapItem;
  /** The 站长's lines, the newest first. */
  notes: { text: string; at: string }[];
};

/** 网站管理 · 施工 (§4): what the 站长 does to one. */
export const roadmapAdminActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("start") }),
  z.strictObject({
    action: z.literal("note"),
    text: text(ROADMAP_LIMITS.note, "写一句进展", "进展最多 100 个字"),
  }),
  z.strictObject({ action: z.literal("done") }),
  z.strictObject({
    action: z.literal("decline"),
    reason: text(ROADMAP_LIMITS.reason, "写一下原因", "原因最多 100 个字"),
  }),
  /** One step back: 已完成 → 施工中 → 功能请求; 不做 → 功能请求. */
  z.strictObject({ action: z.literal("back") }),
  z.strictObject({ action: z.literal("merge"), into: z.uuid() }),
  z.strictObject({ action: z.literal("hide") }),
  z.strictObject({ action: z.literal("unhide") }),
  z.strictObject({
    action: z.literal("edit"),
    title: roadmapRequestSchema.shape.title,
    detail: roadmapRequestSchema.shape.detail,
  }),
]);
export type RoadmapAdminAction = z.infer<typeof roadmapAdminActionSchema>;

/** 新建 (§4): the 站长's own, straight into 施工中 or 功能请求. */
export const roadmapCreateSchema = roadmapRequestSchema.extend({
  status: z.enum(["request", "building"]),
});
export type RoadmapCreateInput = z.infer<typeof roadmapCreateSchema>;
