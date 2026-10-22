// 领取范围 (docs/claim-scope-design.md): who may claim a 红包 or sign up
// for it, by LINUX DO 信任等级 or by name. Absent: everyone. Either part
// lets someone in.
import { z } from "zod";
import { inviteUsernameSchema } from "./balance";

/** LINUX DO 信任等级: Lv0–Lv4. */
export const TRUST_LEVEL_MIN = 0;
export const TRUST_LEVEL_MAX = 4;
export const CLAIM_SCOPE_LIMITS = { users: 100 } as const;

const levelSchema = z.number().int().min(TRUST_LEVEL_MIN).max(TRUST_LEVEL_MAX);

export const claimScopeSchema = z
  .strictObject({
    /** A range of 信任等级; both ends are in it. */
    levels: z
      .strictObject({ min: levelSchema, max: levelSchema })
      .refine((value) => value.min <= value.max, "等级范围无效")
      .refine(
        (value) => value.min > TRUST_LEVEL_MIN || value.max < TRUST_LEVEL_MAX,
        "等级选了全部，就等于所有人",
      )
      .optional(),
    /**
     * People by name. The server notes the LINUX DO ID of each who has been
     * here when it saves; the others it knows by name only.
     */
    users: z
      .array(
        z.strictObject({
          username: inviteUsernameSchema,
          linuxDoId: z
            .string()
            .regex(/^\d{1,20}$/)
            .nullable(),
        }),
      )
      .max(CLAIM_SCOPE_LIMITS.users, "最多指定 100 人")
      .refine(
        (value) =>
          new Set(value.map((user) => user.username.toLowerCase())).size ===
          value.length,
        "有重复的用户名",
      )
      .optional(),
  })
  .refine(
    (value) => value.levels !== undefined || (value.users?.length ?? 0) > 0,
    "至少选一项：等级或指定的人",
  );

export type ClaimScope = z.infer<typeof claimScopeSchema>;

/** What a 红包's public read says of its 领取范围: the people with their faces when known. */
export type PublicClaimScope = {
  levels?: { min: number; max: number };
  users?: {
    username: string;
    displayName?: string;
    avatarUrl?: string | null;
  }[];
};

/** Who is asking: their LINUX DO ID and name, and 信任等级 as last read (null: unknown). */
export type ScopeViewer = {
  linuxDoId: string;
  username: string;
  trustLevel: number | null;
};

/** In a 领取范围 (or no range at all): either part lets someone in. */
export function scopeAllows(
  scope: ClaimScope | undefined,
  viewer: ScopeViewer,
) {
  if (!scope) return true;
  const { levels, users } = scope;
  if (
    levels &&
    viewer.trustLevel !== null &&
    viewer.trustLevel >= levels.min &&
    viewer.trustLevel <= levels.max
  )
    return true;
  const name = viewer.username.toLowerCase();
  return (users ?? []).some((user) =>
    user.linuxDoId !== null
      ? user.linuxDoId === viewer.linuxDoId
      : user.username.toLowerCase() === name,
  );
}

/** A range of 信任等级 in words: “Lv2 及以上”, “Lv0–2”, “Lv1–3”, “Lv0”. */
export function levelRangeText(levels: { min: number; max: number }) {
  if (levels.min === levels.max) return `Lv${levels.min}`;
  if (levels.max === TRUST_LEVEL_MAX) return `Lv${levels.min} 及以上`;
  return `Lv${levels.min}–${levels.max}`;
}

/** The tag on the 红包皮 and its card: “仅限 Lv2 及以上或指定的 3 人”. */
export function scopeTag(scope: PublicClaimScope) {
  const count = scope.users?.length ?? 0;
  if (scope.levels && count > 0)
    return `仅限 ${levelRangeText(scope.levels)}或指定的 ${count} 人`;
  if (scope.levels) return `仅限 ${levelRangeText(scope.levels)}`;
  return `仅限指定的 ${count} 人`;
}

/**
 * The range in one sentence, its “或” plain: “Lv2 及以上的人，或下面这 3
 * 位，都能领。” `verb`: 领 or 报名.
 */
export function scopeSentence(scope: PublicClaimScope, verb: "领" | "报名") {
  const count = scope.users?.length ?? 0;
  if (scope.levels && count > 0)
    return `${levelRangeText(scope.levels)}的人，或下面这 ${count} 位，都能${verb}。`;
  if (scope.levels) return `${levelRangeText(scope.levels)}的人能${verb}。`;
  return `只有下面这 ${count} 位能${verb}。`;
}

/**
 * The page's own check before asking (the server decides): the range as a
 * read shows it, its names as they are now.
 */
export function publicScopeAllows(
  scope: PublicClaimScope | undefined,
  viewer: { username: string; trustLevel: number | null },
) {
  if (!scope) return true;
  const { levels, users } = scope;
  if (
    levels &&
    viewer.trustLevel !== null &&
    viewer.trustLevel >= levels.min &&
    viewer.trustLevel <= levels.max
  )
    return true;
  const name = viewer.username.toLowerCase();
  return (users ?? []).some((user) => user.username.toLowerCase() === name);
}
