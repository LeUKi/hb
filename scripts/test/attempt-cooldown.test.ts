import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAttemptCooldown,
  applyRetryAfterCooldown,
  applySessionAttemptCooldown,
  attemptCooldownRemainingMs,
  clearAttemptCooldown,
} from "../../apps/web/src/lib/attempt-cooldown";

describe("attempt cooldown state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    clearAttemptCooldown(undefined, { broadcast: false });
  });

  afterEach(() => {
    clearAttemptCooldown(undefined, { broadcast: false });
    vi.useRealTimers();
  });

  it("keeps newer account revision over stale session snapshots", () => {
    applyAttemptCooldown(
      "user-a",
      { revision: 2, serverTime: 1_000_000, nextAllowedAt: 1_010_000 },
      { broadcast: false },
    );
    applySessionAttemptCooldown("user-a", {
      revision: 1,
      serverTime: 1_000_000,
      nextAllowedAt: 1_100_000,
    });
    expect(attemptCooldownRemainingMs("user-a")).toBe(10_000);
  });

  it("does not clear a known user cooldown from a null session field", () => {
    applyAttemptCooldown(
      "user-a",
      { revision: 3, serverTime: 1_000_000, nextAllowedAt: 1_020_000 },
      { broadcast: false },
    );
    applySessionAttemptCooldown("user-a", null);
    expect(attemptCooldownRemainingMs("user-a")).toBe(20_000);
  });

  it("does not restart a cooldown when cached or late same-revision metadata is received", () => {
    const snapshot = {
      revision: 2,
      serverTime: 1_000_000,
      nextAllowedAt: 1_005_000,
    };
    applySessionAttemptCooldown("user-a", snapshot);
    vi.setSystemTime(1_003_000);
    applySessionAttemptCooldown("user-a", snapshot);
    expect(attemptCooldownRemainingMs("user-a")).toBe(2_000);
    applyAttemptCooldown(
      "user-a",
      { ...snapshot, serverTime: 999_000 },
      { broadcast: false },
    );
    expect(attemptCooldownRemainingMs("user-a")).toBe(2_000);
  });

  it("clears the previous account when a different identity becomes current", () => {
    applySessionAttemptCooldown("user-a", {
      revision: 2,
      serverTime: 1_000_000,
      nextAllowedAt: 1_005_000,
    });
    applySessionAttemptCooldown("user-b", {
      revision: 0,
      serverTime: 1_000_000,
      nextAllowedAt: 0,
    });
    expect(attemptCooldownRemainingMs("user-a")).toBe(0);
  });

  it("clears all account cooldowns for a guest session", () => {
    applyAttemptCooldown(
      "user-a",
      { revision: 3, serverTime: 1_000_000, nextAllowedAt: 1_020_000 },
      { broadcast: false },
    );
    applySessionAttemptCooldown(null, null);
    expect(attemptCooldownRemainingMs("user-a")).toBe(0);
  });

  it("lets a later server revision replace a legacy retry-after fallback", () => {
    applyRetryAfterCooldown("user-a", 60);
    applySessionAttemptCooldown("user-a", {
      revision: 1,
      serverTime: 1_000_000,
      nextAllowedAt: 1_005_000,
    });
    expect(attemptCooldownRemainingMs("user-a")).toBe(5_000);
  });

  it("creates a retry-after fallback cooldown for legacy 429 responses", () => {
    applyRetryAfterCooldown("user-a", 2.2);
    expect(attemptCooldownRemainingMs("user-a")).toBe(3_000);
    vi.setSystemTime(1_003_001);
    expect(attemptCooldownRemainingMs("user-a")).toBe(0);
  });
});
