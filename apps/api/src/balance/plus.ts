// 🐟额 PLUS (docs/balance-design.md §13) on the 🐟额 page: what opening it
// adds goes only to a member (plus-features.ts); everyone else sees 乱码 in
// its place, as many rows as there are, nothing of what they say.
import type { ApiBindings } from "../env";
import { readJudgeSettings } from "../judge/settings";
import { memberOf } from "./invites";
import { plusFeatures } from "./plus-features";
import { transferAccess } from "./transfers";

/**
 * The bubble on PLUS: whether this person has it (or is the 站长), who
 * invited them and since when, and what it adds — the words only for them.
 */
export async function plusOf(env: ApiBindings, userId: string) {
  const [access, member, judge] = await Promise.all([
    transferAccess(env, userId),
    memberOf(env, userId),
    readJudgeSettings(env),
  ]);
  const plus = access.allowed;
  return {
    plus,
    owner: access.owner,
    invitedBy: member?.invitedBy ?? null,
    since: member?.since ?? null,
    features: plus
      ? plusFeatures(judge.dailyDeployLimitPlus, access.owner)
      : null,
    featureCount: plusFeatures(0).length,
  };
}
