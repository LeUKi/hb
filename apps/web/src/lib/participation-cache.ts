import type {
  ActivityParticipationResponse,
  ClaimDetail,
  ClaimResult,
  DrawSummary,
} from "@hb/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { type SessionResponse, sessionQueryKey, sessionScope } from "./auth";

/** Missing fields are unknown; only a complete GET can confirm an empty record. */
export type ParticipationCache = Partial<ActivityParticipationResponse> & {
  /** Internal proof that these personal facts were read in this session. */
  readSessionScope?: string;
  /** Successful personal GET or confirmed submission; cache reuse never renews it. */
  readAt?: number;
};

export const participationKey = (userId: string, activityId: string) =>
  ["claim-private", userId, "participation", activityId] as const;

export const claimDetailKey = (userId: string, claimId: string) =>
  ["claim-private", userId, "detail", claimId] as const;

export function isCompleteParticipation(
  data: ParticipationCache | undefined,
): data is ActivityParticipationResponse {
  return data?.claim !== undefined && data.registration !== undefined;
}

export function hasParticipation(data: ParticipationCache | undefined) {
  return Boolean(data?.claim || data?.registration);
}

export function isTerminalRegistration(data: ParticipationCache | undefined) {
  const status = data?.registration?.status;
  return status === "won" || status === "not_won";
}

export function claimRefresh(claim?: ClaimDetail | null) {
  // Stopped in attention, only its claimant moves it again (by a request);
  // 未发出 is over; a 🐟额红包's share has no payment to wait for.
  return claim?.rewardType === "ldc" &&
    (!claim.payment ||
      claim.payment.status === "confirmed" ||
      claim.payment.status === "attention" ||
      claim.payment.status === "failed")
    ? false
    : 15_000;
}

export function participationRefresh(
  data: ParticipationCache | undefined,
  drawState?: DrawSummary["state"],
) {
  if (claimRefresh(data?.claim)) return 15_000;
  return registrationRefresh(data, drawState);
}

export function registrationRefresh(
  data: ParticipationCache | undefined,
  drawState?: DrawSummary["state"],
) {
  if (drawState === undefined || isTerminalRegistration(data)) return false;
  const status = data?.registration?.status;
  return status === "registered" ||
    status === "drawing" ||
    drawState === "waiting" ||
    drawState === "settling"
    ? 15_000
    : false;
}

export function canSkipDrawRefresh(
  data: ParticipationCache | undefined,
  drawState?: DrawSummary["state"],
) {
  return (
    isCompleteParticipation(data) &&
    (isTerminalRegistration(data) ||
      (drawState !== undefined && !registrationRefresh(data, drawState)))
  );
}

export function participationNeedsFullRead(
  data: ParticipationCache | undefined,
  dataUpdatedAt: number,
  invalidated = false,
) {
  return (
    !isCompleteParticipation(data) ||
    invalidated ||
    Date.now() - dataUpdatedAt >= 15_000
  );
}

function sameKey(left: readonly unknown[], right: readonly unknown[]) {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}

/** Both activity submission paths share cancellation, identity and cache rules. */
export async function syncParticipationResult(
  client: QueryClient,
  userId: string,
  activityId: string,
  result: ClaimResult,
  isCurrentIdentity: () => boolean,
) {
  if (!isCurrentIdentity()) return false;
  if (!("claim" in result) && !("registration" in result)) return true;
  const key = participationKey(userId, activityId);
  const claim = "claim" in result ? result.claim : result.registration.claim;
  const detailKey = claim ? claimDetailKey(userId, claim.id) : undefined;
  await Promise.all([
    client.cancelQueries({ queryKey: key, exact: true }),
    ...(detailKey
      ? [client.cancelQueries({ queryKey: detailKey, exact: true })]
      : []),
  ]);
  if (!isCurrentIdentity()) return false;

  const previous = client.getQueryData<ParticipationCache>(key);
  const session = client.getQueryData<SessionResponse>(sessionQueryKey);
  const next: ParticipationCache = {
    ...previous,
    ...(session ? { readSessionScope: sessionScope(session) } : {}),
    readAt: Date.now(),
    ...(claim ? { claim } : {}),
    ...("registration" in result ? { registration: result.registration } : {}),
  };
  const complete = isCompleteParticipation(next);
  client.setQueryData<ParticipationCache>(key, next, {
    updatedAt: complete ? Date.now() : 0,
  });
  if (claim && detailKey) client.setQueryData(detailKey, { claim });

  if (!complete) void client.invalidateQueries({ queryKey: key, exact: true });
  if (claim)
    void client.invalidateQueries({
      queryKey: ["claim-private", userId],
      predicate: (query) =>
        !sameKey(query.queryKey, key) &&
        (!detailKey || !sameKey(query.queryKey, detailKey)),
    });
  void client.invalidateQueries({
    queryKey: ["participation-private", userId],
  });
  void client.invalidateQueries({ queryKey: ["history-private", userId] });
  return true;
}
