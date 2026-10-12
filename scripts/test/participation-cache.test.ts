import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canSkipDrawRefresh,
  claimDetailKey,
  hasParticipation,
  isCompleteParticipation,
  type ParticipationCache,
  participationKey,
  participationNeedsFullRead,
  participationRefresh,
  syncParticipationResult,
} from "../../apps/web/src/lib/participation-cache";
import { createAppQueryClient } from "../../apps/web/src/lib/query-cache";
import type {
  ActivityParticipationResponse,
  ClaimDetail,
  ClaimResult,
  RegistrationDetail,
} from "../../packages/contracts/src/index";

vi.mock("../../apps/web/src/api", () => ({ api: {} }));

const userId = "viewer";
const activityId = "activity";
const key = participationKey(userId, activityId);
const activity = {
  id: activityId,
  title: "参与缓存测试",
  status: "active" as const,
};
const claim: ClaimDetail = {
  id: "claim",
  activity,
  rewardType: "ldc",
  amount: "1.00",
  payment: {
    id: "payment",
    mode: "simulation",
    status: "confirmed",
    reason: null,
    confirmedAt: "2026-10-10T00:00:00.000Z",
  },
  afterClaimInfo: "奖励附言",
  claimedAt: "2026-10-10T00:00:00.000Z",
};
const registration: RegistrationDetail = {
  id: "registration",
  activity,
  registeredAt: "2026-10-10T00:00:00.000Z",
  status: "registered",
  drawAt: null,
  claim: null,
};
const empty: ActivityParticipationResponse = {
  claim: null,
  registration: null,
};
const clients: ReturnType<typeof createAppQueryClient>[] = [];
const successfulResults: ClaimResult[] = [
  { result: "claimed", claim },
  { result: "registered", registration },
];

function client() {
  const instance = createAppQueryClient();
  instance.setDefaultOptions({
    queries: { staleTime: 15_000, gcTime: Infinity, retry: false },
  });
  clients.push(instance);
  return instance;
}

function ldcClaim(confirmed: boolean): ClaimDetail {
  return {
    id: "ldc-claim",
    activity,
    claimedAt: claim.claimedAt,
    afterClaimInfo: claim.afterClaimInfo,
    rewardType: "ldc",
    amount: "1.00",
    payment: {
      id: "payment",
      mode: "simulation",
      status: confirmed ? "confirmed" : "pending",
      reason: null,
      confirmedAt: confirmed ? claim.claimedAt : null,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T00:00:00.000Z"));
});

afterEach(() => {
  for (const instance of clients.splice(0)) instance.clear();
  vi.useRealTimers();
});

describe("activity participation boundaries", () => {
  it("requires both explicit fields to confirm absence and allow a form", () => {
    expect(isCompleteParticipation(undefined)).toBe(false);
    expect(isCompleteParticipation({ claim: null })).toBe(false);
    expect(isCompleteParticipation({ registration: null })).toBe(false);
    expect(isCompleteParticipation(empty)).toBe(true);
    expect(hasParticipation(empty)).toBe(false);
    expect(hasParticipation({ claim })).toBe(true);
    expect(hasParticipation({ registration })).toBe(true);
  });

  it("reuses a fresh full snapshot and requires one full read for stale or partial data", () => {
    const now = Date.now();
    expect(participationNeedsFullRead(empty, now)).toBe(false);
    expect(participationNeedsFullRead(empty, now - 14_999)).toBe(false);
    expect(participationNeedsFullRead(empty, now - 15_000)).toBe(true);
    expect(participationNeedsFullRead(empty, now, true)).toBe(true);
    expect(participationNeedsFullRead({ registration }, now)).toBe(true);
  });

  it.each(["won", "not_won"] as const)(
    "keeps the claim interval after terminal registration %s without repeated draw refresh",
    (status) => {
      const data = { claim: null, registration: { ...registration, status } };
      expect(participationRefresh(data, "completed")).toBe(15_000);
      expect(canSkipDrawRefresh(data, "completed")).toBe(true);
    },
  );

  it("stops draw refresh for a completed draw with no personal registration", () => {
    expect(participationRefresh(empty, "completed")).toBe(15_000);
    expect(canSkipDrawRefresh(empty, "completed")).toBe(true);
    expect(canSkipDrawRefresh(empty, "empty")).toBe(true);
    expect(canSkipDrawRefresh(empty, "waiting")).toBe(false);
    expect(canSkipDrawRefresh(empty)).toBe(false);
  });

  it.each(["registered", "drawing"] as const)(
    "preserves 15s draw progress for %s even when a claim payment is confirmed",
    (status) => {
      const data = {
        claim: ldcClaim(true),
        registration: { ...registration, status },
      };
      expect(participationRefresh(data, "settling")).toBe(15_000);
      expect(canSkipDrawRefresh(data, "settling")).toBe(false);
    },
  );

  it("continues pending winnings and stops only confirmed winnings with terminal registration", () => {
    const won = { ...registration, status: "won" as const };
    expect(
      participationRefresh(
        { claim: ldcClaim(false), registration: won },
        "completed",
      ),
    ).toBe(15_000);
    expect(
      participationRefresh(
        { claim: ldcClaim(true), registration: won },
        "completed",
      ),
    ).toBe(false);
    expect(
      participationRefresh({ claim: ldcClaim(false), registration: null }),
    ).toBe(15_000);
    expect(
      participationRefresh({ claim: ldcClaim(true), registration: null }),
    ).toBe(false);
  });
});

describe("shared submission cache synchronization", () => {
  it.each(successfulResults)(
    "writes $result immediately without repeating a complete initial read",
    async (result) => {
      const cache = client();
      const request = vi.fn(async () => empty);
      const options = { queryKey: key, queryFn: request };
      await cache.fetchQuery(options);
      await syncParticipationResult(
        cache,
        userId,
        activityId,
        result,
        () => true,
      );
      const data = cache.getQueryData<ParticipationCache>(key);
      expect(isCompleteParticipation(data)).toBe(true);
      expect(hasParticipation(data)).toBe(true);
      expect(cache.getQueryState(key)?.isInvalidated).toBe(false);
      await cache.fetchQuery(options);
      expect(request).toHaveBeenCalledTimes(1);
      if ("claim" in result)
        expect(cache.getQueryData(claimDetailKey(userId, claim.id))).toEqual({
          claim,
        });
    },
  );

  it("keeps an absent global submission snapshot partial and fills it with exactly one GET", async () => {
    const cache = client();
    await syncParticipationResult(
      cache,
      userId,
      activityId,
      { result: "registered", registration },
      () => true,
    );
    expect(cache.getQueryData(key)).toEqual({ registration });
    expect(hasParticipation(cache.getQueryData(key))).toBe(true);
    expect(isCompleteParticipation(cache.getQueryData(key))).toBe(false);
    const request = vi.fn(async () => ({ claim: null, registration }));
    const options = { queryKey: key, queryFn: request };
    await cache.fetchQuery(options);
    await cache.fetchQuery(options);
    expect(request).toHaveBeenCalledTimes(1);
    expect(isCompleteParticipation(cache.getQueryData(key))).toBe(true);
  });

  it("preserves a previously known claim when registration does not provide winnings", async () => {
    const cache = client();
    cache.setQueryData(key, { claim, registration: null });
    await syncParticipationResult(
      cache,
      userId,
      activityId,
      { result: "registered", registration },
      () => true,
    );
    expect(cache.getQueryData(key)).toEqual({ claim, registration });
  });

  it("updates both the participation claim and detail cache from positive registration winnings", async () => {
    const cache = client();
    cache.setQueryData(key, empty);
    const winning = ldcClaim(true);
    const won = { ...registration, status: "won" as const, claim: winning };
    await syncParticipationResult(
      cache,
      userId,
      activityId,
      { result: "already_registered", registration: won },
      () => true,
    );
    expect(cache.getQueryData(key)).toEqual({
      claim: winning,
      registration: won,
    });
    expect(cache.getQueryData(claimDetailKey(userId, winning.id))).toEqual({
      claim: winning,
    });
  });

  it("cancels a late aggregate response before success is written", async () => {
    const cache = client();
    cache.setQueryData(key, empty);
    let release = (_data: ActivityParticipationResponse) => {};
    const pending = new Promise<ActivityParticipationResponse>((resolve) => {
      release = resolve;
    });
    // Ignore the transport signal so the test proves query cancellation guards writes too.
    const inFlight = cache
      .fetchQuery({ queryKey: key, queryFn: () => pending, staleTime: 0 })
      .catch(() => undefined);
    await syncParticipationResult(
      cache,
      userId,
      activityId,
      { result: "claimed", claim },
      () => true,
    );
    release(empty);
    await inFlight;
    expect(cache.getQueryData(key)).toEqual({ claim, registration: null });
  });

  it("checks the account again after cancellation before writing any private result", async () => {
    const cache = client();
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(
      await syncParticipationResult(
        cache,
        userId,
        activityId,
        { result: "claimed", claim },
        current,
      ),
    ).toBe(false);
    expect(cache.getQueryData(key)).toBeUndefined();
    expect(
      cache.getQueryData(claimDetailKey(userId, claim.id)),
    ).toBeUndefined();
  });

  it("does not fabricate an empty snapshot from an incorrect submission", async () => {
    const cache = client();
    await syncParticipationResult(
      cache,
      userId,
      activityId,
      { result: "incorrect" },
      () => true,
    );
    expect(cache.getQueryData(key)).toBeUndefined();
  });
});
