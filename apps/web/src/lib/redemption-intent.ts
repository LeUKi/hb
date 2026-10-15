import type { PasswordClaimInput } from "@hb/contracts";
import { atom } from "jotai";

export type RedemptionIntentOperation = PasswordClaimInput & {
  discoveryId?: string;
};

/** An explicit, one-shot user operation. It never enters URLs or persistence. */
export const redemptionIntentAtom = atom<{
  userId: string;
  activityId: string;
  operation: RedemptionIntentOperation;
} | null>(null);
export const rewardAnimationAtom = atom<{
  activityId: string;
  token: string;
} | null>(null);
