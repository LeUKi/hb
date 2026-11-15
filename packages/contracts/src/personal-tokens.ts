import { z } from "zod";

// 个人令牌 (docs/personal-token-design.md): someone's own token for scripts
// and clients that cannot carry the site's cookie. It stands for that one
// account and does a fixed few things the account can do on the page; it is
// shown once, as it is made.

export const PERSONAL_TOKEN_LIMITS = {
  /** Its name, to tell tokens apart. */
  nameMax: 20,
  /** Tokens in use at once. */
  activeMax: 10,
  /** How long one lasts: chosen as it is made, a year at most. */
  lifetimeDays: [30, 90, 365] as const,
} as const;

/** The prefix every personal token starts with. */
export const PERSONAL_TOKEN_PREFIX = "hbp_";

const characters = (value: string) => Array.from(value).length;

/** A new token: a name, and how many days it lasts. */
export const createPersonalTokenSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "请填名称")
    .refine(
      (value) => characters(value) <= PERSONAL_TOKEN_LIMITS.nameMax,
      `名称最多 ${PERSONAL_TOKEN_LIMITS.nameMax} 个字`,
    ),
  lifetimeDays: z.literal(PERSONAL_TOKEN_LIMITS.lifetimeDays, {
    error: "有效期只能选 30、90 或 365 天",
  }),
});
export type CreatePersonalTokenInput = z.infer<
  typeof createPersonalTokenSchema
>;

/** An admin's stop of someone's token: the reason they will read. */
export const adminRevokePersonalTokenSchema = z.strictObject({
  reason: z.string().trim().min(1, "请填原因").max(200),
});

/** In use; past its time; stopped by its owner; stopped by an admin. */
export type PersonalTokenStatus =
  | "active"
  | "expired"
  | "revoked"
  | "admin_revoked";

/** A token as its owner sees it: never the token itself. */
export type PersonalToken = {
  id: string;
  name: string;
  lastFour: string;
  status: PersonalTokenStatus;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  useCount: number;
  revokedAt: number | null;
  /** An admin's stop: why. */
  revokeReason: string | null;
};

/** A token just made: the token, shown this once, and its view. */
export type CreatedPersonalToken = {
  token: string;
  personalToken: PersonalToken;
};

/**
 * Each account's share of a minute, all its tokens together (§8): reads,
 * the 红包广场's list, 领取 and 口令兑换, 附带网页认人. Over it, 429. The
 * same numbers are the limiters in the API's wrangler configs.
 */
export const PERSONAL_TOKEN_RATE_LIMITS = {
  read: 60,
  square: 20,
  claim: 20,
  identity: 20,
} as const;

export type PersonalTokenRequestKind = keyof typeof PERSONAL_TOKEN_RATE_LIMITS;

/** Requests in one hour or day: let through by kind, and turned away. */
export type PersonalTokenUsageBucket = {
  at: string;
  read: number;
  square: number;
  claim: number;
  identity: number;
  /** Over the minute's share. */
  limited: number;
  /** While the 站长's switch was off. */
  paused: number;
};

export type PersonalTokenUsage = {
  /** False until the statistics can be read (no API token set). */
  available: boolean;
  /** The last 24 hours, by hour, oldest first. */
  hours: PersonalTokenUsageBucket[];
  /** The last 30 days, by day (Beijing time), oldest first. */
  days: PersonalTokenUsageBucket[];
};

/** Someone's own: theirs, and each token's last 30 days. */
export type MyPersonalTokenUsage = PersonalTokenUsage & {
  tokens: { id: string; calls: number; limited: number }[];
};

/** The 站长's view: the switch, everyone's usage, who calls most. */
export type PersonalTokenAdminView = {
  settings: { enabled: boolean; version: number; updatedAt: string };
  limits: typeof PERSONAL_TOKEN_RATE_LIMITS;
  usage: PersonalTokenUsage;
  /** The last 24 hours' busiest accounts, at most 20. */
  topUsers: {
    userId: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    calls: number;
    limited: number;
  }[];
};

export const updatePersonalTokenSettingsSchema = z.strictObject({
  expectedVersion: z.number().int().positive().safe(),
  enabled: z.boolean(),
});
export type UpdatePersonalTokenSettingsInput = z.infer<
  typeof updatePersonalTokenSettingsSchema
>;
