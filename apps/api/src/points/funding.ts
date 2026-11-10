// A 三方积分红包's money (docs/third-party-points-design.md §5 §8): the
// site switch on, its system online, the sender's key saved, every amount
// a whole number of the system's 最小单位; at opening, 额度 enough for this
// 红包 and what the sender's others may still pay.
import {
  type AmountUnit,
  formatAmountWithUnit,
  type LdcActivityInput,
  ldcTotalMinor,
  moneyStepIssue,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import type { ApiBindings } from "../env";
import { availableNow, committedElsewhere, readKey } from "./keys";
import {
  type PointsSystemRow,
  readPointsSettings,
  readSystem,
} from "./systems";

export function unitOfSystem(system: PointsSystemRow): AmountUnit {
  return { unit: system.unit, step: system.step };
}

function refuse(code: string, message: string): never {
  throw new ActivityError(409, code, message);
}

/** Creating or saving one: the switch, the system, one's key, the step. */
export async function requirePointsFunding(
  env: ApiBindings,
  authorId: string,
  input: LdcActivityInput,
) {
  const settings = await readPointsSettings(env);
  if (!settings.enabled) refuse("POINTS_DISABLED", "三方积分红包还没开放");
  const system = input.pointsSystemId
    ? await readSystem(env, input.pointsSystemId)
    : null;
  if (system?.status !== "online")
    refuse("POINTS_NOT_ONLINE", "这种三方积分现在没有上线");
  if (!(await readKey(env, system.id, authorId)))
    refuse("POINTS_KEY_NEEDED", `先填好你在 ${system.host} 的密钥`);
  const issue = moneyStepIssue(input.money, unitOfSystem(system));
  if (issue) throw new ActivityError(400, "INVALID_ACTIVITY", issue);
  return system;
}

/** The step a 红包's amounts are split by: its system's, or 1 (LDC, 🐟). */
export async function stepOf(
  env: ApiBindings,
  activity: { funding: string; pointsSystemId: string | null },
) {
  if (activity.funding !== "points" || !activity.pointsSystemId) return 1;
  const system = await readSystem(env, activity.pointsSystemId);
  return system?.step ?? 1;
}

/**
 * At opening (and at a 定时开放's time, and before a 限时开奖's draw):
 * 额度 at least this 红包's pool plus what the sender's other open ones of
 * the system may still pay. Returns the reason it cannot, in words, or null.
 */
export async function pointsOpeningProblem(
  env: ApiBindings,
  activity: {
    id: string;
    authorId: string;
    pointsSystemId: string | null;
    config: string;
  },
  options: { pool?: number } = {},
) {
  const settings = await readPointsSettings(env);
  if (!settings.enabled) return "三方积分红包还没开放";
  const system = activity.pointsSystemId
    ? await readSystem(env, activity.pointsSystemId)
    : null;
  if (system?.status !== "online") return "这种三方积分现在没有上线";
  const pool =
    options.pool ??
    ldcTotalMinor(JSON.parse(activity.config) as LdcActivityInput);
  const [balance, elsewhere] = await Promise.all([
    availableNow(env, activity.authorId, system),
    committedElsewhere(env, activity.authorId, system.id, activity.id),
  ]);
  const unit = unitOfSystem(system);
  if (balance.kind === "no_key") return `还没填你在 ${system.host} 的密钥`;
  if (balance.kind === "key_invalid")
    return `${system.host} 说你的密钥无效，请换一把`;
  if (balance.kind === "unreachable")
    return `暂时连不上 ${system.host}，查不了额度`;
  const needed = pool + elsewhere;
  if (balance.available < needed)
    return elsewhere > 0
      ? `额度不够：可用 ${formatAmountWithUnit(balance.available, unit)}，这个红包要 ${formatAmountWithUnit(pool, unit)}，你其他开放中的红包还要 ${formatAmountWithUnit(elsewhere, unit)}`
      : `额度不够：可用 ${formatAmountWithUnit(balance.available, unit)}，这个红包要 ${formatAmountWithUnit(pool, unit)}`;
  return null;
}

/** What blocks opening that needs no call (the management view, §5). */
export async function pointsBlockedReason(
  env: ApiBindings,
  activity: { authorId: string; pointsSystemId: string | null },
) {
  const settings = await readPointsSettings(env);
  if (!settings.enabled) return "POINTS_HONGBAO_PAUSED" as const;
  const system = activity.pointsSystemId
    ? await readSystem(env, activity.pointsSystemId)
    : null;
  if (system?.status !== "online") return "POINTS_NOT_ONLINE" as const;
  if (!(await readKey(env, system.id, activity.authorId)))
    return "POINTS_KEY_NEEDED" as const;
  return undefined;
}

/**
 * Before a 限时开奖's draw (§5): the prizes it would pay against 额度 now.
 * Only a sure no stops it (额度不够, a bad or missing key); an issuer that
 * does not answer does not cost the registrants their draw.
 */
export async function pointsDrawStop(
  env: ApiBindings,
  activity: { id: string; authorId: string; pointsSystemId: string | null },
  prizes: number,
) {
  const system = activity.pointsSystemId
    ? await readSystem(env, activity.pointsSystemId)
    : null;
  if (!system || system.status === "retired") return "retired" as const;
  if (prizes <= 0) return null;
  const [balance, elsewhere] = await Promise.all([
    availableNow(env, activity.authorId, system),
    committedElsewhere(env, activity.authorId, system.id, activity.id),
  ]);
  if (balance.kind === "no_key") return "key_removed" as const;
  if (balance.kind === "key_invalid") return "key_invalid" as const;
  if (balance.kind === "ok" && balance.available < prizes + elsewhere)
    return "insufficient" as const;
  return null;
}

/** The snapshot a 三方积分红包 keeps of its system (contracts points.ts). */
export function snapshotOf(system: PointsSystemRow) {
  return {
    id: system.id,
    name: system.name,
    unit: system.unit,
    step: system.step,
    host: system.host,
  };
}

/** A 红包's views: its 三方积分 as kept, and why it stopped by itself. */
export function activityPointsOf(row: {
  funding: string;
  config: string;
  pointsStopReason: string | null;
}) {
  if (row.funding !== "points") return {};
  const points = (JSON.parse(row.config) as { points?: unknown }).points as
    | ReturnType<typeof snapshotOf>
    | undefined;
  if (!points) return { funding: "points" as const };
  return {
    funding: "points" as const,
    points: {
      ...points,
      ...(row.pointsStopReason ? { stop: row.pointsStopReason } : {}),
    },
  };
}
