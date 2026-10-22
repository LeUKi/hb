// 领取范围 (docs/claim-scope-design.md): who may claim a 红包 or sign up
// for it, by LINUX DO 信任等级 or by name. Absent: everyone. Either part
// lets someone in.
import { z } from "zod";
import { inviteUsernameSchema } from "./balance";

/** LINUX DO 信任等级: Lv0–Lv4. */
export const TRUST_LEVEL_MIN = 0;
export const TRUST_LEVEL_MAX = 4;
/** Each level's name as LINUX DO (Discourse in Chinese) says it, from Lv0. */
export const TRUST_LEVEL_NAMES = [
  "新用户",
  "基本用户",
  "成员",
  "活跃用户",
  "领导者",
] as const;
export const CLAIM_SCOPE_LIMITS = { users: 100 } as const;

const levelSchema = z.number().int().min(TRUST_LEVEL_MIN).max(TRUST_LEVEL_MAX);
const levelCount = TRUST_LEVEL_MAX - TRUST_LEVEL_MIN + 1;

/** Every level from `min` to `max`: how the first version's range reads now. */
function levelsBetween(min: number, max: number) {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

/** The levels picked, low to high, each once. */
function sortedLevels(levels: readonly number[]) {
  return [...new Set(levels)].sort((left, right) => left - right);
}

const levelsSchema = z
  .union([
    z.array(levelSchema),
    // The first version (2026-10-22 19:28) kept a range, { min, max }.
    z
      .strictObject({ min: levelSchema, max: levelSchema })
      .refine((value) => value.min <= value.max, "等级范围无效")
      .transform((value) => levelsBetween(value.min, value.max)),
  ])
  .transform(sortedLevels)
  .refine((levels) => levels.length > 0, "至少选一个等级")
  .refine((levels) => levels.length < levelCount, "等级全选就等于所有人");

export const claimScopeSchema = z
  .strictObject({
    /** The 信任等级 let in, any of Lv0–Lv4 but not all of them. */
    levels: levelsSchema.optional(),
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

/**
 * A 领取范围 as a 红包's config holds it: one saved by the first version
 * may still have its levels as a range.
 */
export type StoredClaimScope = Omit<ClaimScope, "levels"> & {
  levels?: number[] | { min: number; max: number };
};

/** A saved 领取范围 read today: a first-version range becomes its levels. */
export function readClaimScope(
  scope: StoredClaimScope | undefined,
): ClaimScope | undefined {
  if (!scope) return undefined;
  const { levels, ...rest } = scope;
  if (levels === undefined) return rest;
  return {
    ...rest,
    levels: Array.isArray(levels)
      ? sortedLevels(levels)
      : levelsBetween(levels.min, levels.max),
  };
}

/** What a 红包's public read says of its 领取范围: the people with their faces when known. */
export type PublicClaimScope = {
  levels?: number[];
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
    levels.includes(viewer.trustLevel)
  )
    return true;
  const name = viewer.username.toLowerCase();
  return (users ?? []).some((user) =>
    user.linuxDoId !== null
      ? user.linuxDoId === viewer.linuxDoId
      : user.username.toLowerCase() === name,
  );
}

/**
 * 信任等级 in words: levels in a row go together, “及以上” when the only
 * run reaches Lv4; apart, a 顿号 between: “Lv2 及以上”, “Lv0–2”, “Lv3”,
 * “Lv1、Lv3”, “Lv0–1、Lv3–4”.
 */
export function levelsText(levels: readonly number[]) {
  const runs: [number, number][] = [];
  for (const level of sortedLevels(levels)) {
    const last = runs.at(-1);
    if (last && level === last[1] + 1) last[1] = level;
    else runs.push([level, level]);
  }
  const [only] = runs;
  if (
    runs.length === 1 &&
    only &&
    only[0] !== only[1] &&
    only[1] === TRUST_LEVEL_MAX
  )
    return `Lv${only[0]} 及以上`;
  return runs
    .map(([low, high]) => (low === high ? `Lv${low}` : `Lv${low}–${high}`))
    .join("、");
}

/**
 * 信任等级 followed by words, a space between when it ends in Latin:
 * “Lv1–3 的人”, “Lv2 及以上的人”.
 */
export function levelPhrase(levels: readonly number[], rest: string) {
  const level = levelsText(levels);
  return /[A-Za-z0-9]$/.test(level) ? `${level} ${rest}` : `${level}${rest}`;
}

/** The tag on the 红包皮 and its card: “仅限 Lv2 及以上或指定的 3 人”. */
export function scopeTag(scope: PublicClaimScope) {
  const count = scope.users?.length ?? 0;
  if (scope.levels && count > 0)
    return `仅限 ${levelPhrase(scope.levels, "或指定的")} ${count} 人`;
  if (scope.levels) return `仅限 ${levelsText(scope.levels)}`;
  return `仅限指定的 ${count} 人`;
}

/**
 * The range in one sentence, its “或” plain and nothing said of where the
 * people are shown: “Lv2 及以上的人，或指定的 3 位，都能领。” `verb`: 领 or
 * 报名.
 */
export function scopeSentence(scope: PublicClaimScope, verb: "领" | "报名") {
  const count = scope.users?.length ?? 0;
  if (scope.levels && count > 0)
    return `${levelPhrase(scope.levels, "的人")}，或指定的 ${count} 位，都能${verb}。`;
  if (scope.levels) return `${levelPhrase(scope.levels, "的人")}能${verb}。`;
  return `只有指定的 ${count} 位能${verb}。`;
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
    levels.includes(viewer.trustLevel)
  )
    return true;
  const name = viewer.username.toLowerCase();
  return (users ?? []).some((user) => user.username.toLowerCase() === name);
}
