/**
 * Internal service dependency for exercising the real-activity pipeline against
 * an injected payment transport. HTTP, DO and recovery entry points omit it
 * and use the durable production controls and credential publication policy.
 */
export type ActivityExecutionPolicy = {
  canUseRealActivity(activityId: string): boolean;
};

export function permitsRealActivity(
  activityId: string,
  policy?: ActivityExecutionPolicy,
) {
  return policy?.canUseRealActivity(activityId) === true;
}
