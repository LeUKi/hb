import { z } from "zod";

export type AttemptCooldown = {
  revision: number;
  serverTime: number;
  nextAllowedAt: number;
};

export const updateAttemptRateLimitsSchema = z.strictObject({
  expectedVersion: z.number().int().positive().safe(),
  homeIntervalSeconds: z.number().int().min(1).max(3600),
  activityIntervalSeconds: z.number().int().min(1).max(3600),
});
export type UpdateAttemptRateLimitsInput = z.infer<
  typeof updateAttemptRateLimitsSchema
>;

export type AttemptRateLimits = {
  version: number;
  homeIntervalSeconds: number;
  activityIntervalSeconds: number;
  updatedAt: number;
  updatedByUserId: string | null;
};

export type AttemptRateLimitChange = {
  id: string;
  actorUserId: string;
  actorDisplayName: string;
  previousVersion: number;
  nextVersion: number;
  previousHomeIntervalSeconds: number;
  homeIntervalSeconds: number;
  previousActivityIntervalSeconds: number;
  activityIntervalSeconds: number;
  createdAt: number;
};

export type AttemptRateLimitsResponse = {
  config: AttemptRateLimits;
  recentChanges: AttemptRateLimitChange[];
};
