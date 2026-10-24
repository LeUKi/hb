import { z } from "zod";

// 排行榜 (docs/leaderboard-design.md): 发出 and 领到, over the last 7 days
// or everything; 领到 anonymous unless one chooses to be shown.

export const rankBoardSchema = z.enum(["sent", "received"]);
export type RankBoard = z.infer<typeof rankBoardSchema>;
export const rankRangeSchema = z.enum(["week", "all"]);
export type RankRange = z.infer<typeof rankRangeSchema>;

export const RANK_PAGE_SIZE = 20;
/** A board is worked out again once its snapshot is this old. */
export const RANK_SNAPSHOT_MS = 5 * 60 * 1000;
/** 近 7 天: the 7 × 24 hours before now, not a calendar week. */
export const RANK_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Who is shown by name until they choose otherwise. */
export const RANK_VISIBLE_BY_DEFAULT: Record<RankBoard, boolean> = {
  sent: true,
  received: false,
};

export const rankQuerySchema = z.strictObject({
  board: rankBoardSchema.default("sent"),
  range: rankRangeSchema.default("week"),
  /** Where the next 20 start in the board. */
  cursor: z
    .string()
    .regex(/^\d{1,7}$/)
    .optional(),
});

export const rankVisibilityInputSchema = z.strictObject({
  board: rankBoardSchema,
  visible: z.boolean(),
});

export type RankVisibility = Record<RankBoard, boolean>;

/** Who someone is on a board; null for one shown as 匿名. */
export type RankPerson = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type RankEntry = {
  /** Their place in the board's order, from 0: unique, unlike `rank`. */
  position: number;
  /** 第 N 名: the same for the same amount (1, 2, 2, 4). */
  rank: number;
  person: RankPerson | null;
  /** The one reading: shown as themselves to themselves either way. */
  me: boolean;
  amount: string;
  /** 发出: 红包 taken from; 领到: 红包 taken. */
  activities: number;
  /** 发出: times taken from them; 领到: the same as `activities`. */
  claims: number;
};

/** The one reading, on this board; `rank` is null until they are on it. */
export type RankMe = {
  rank: number | null;
  position: number | null;
  amount: string;
  activities: number;
  claims: number;
  visible: boolean;
};

export type RankPage = {
  board: RankBoard;
  range: RankRange;
  computedAt: number;
  total: number;
  items: RankEntry[];
  nextCursor: string | null;
  /** Signed in only. */
  me: RankMe | null;
};
