import { describe, expect, it } from "vitest";
import { nextQuotaReset, quotaResumeAt } from "../src/payments/quota";

/** A moment given in Shanghai time (UTC+8). */
const shanghai = (iso: string) => Date.parse(`${iso}+08:00`);

describe("Credit's daily limit turns over at midnight in Shanghai", () => {
  it("finds the next midnight there, whatever the hour", () => {
    expect(nextQuotaReset(shanghai("2026-10-17T14:00:00"))).toBe(
      shanghai("2026-10-18T00:00:00"),
    );
    expect(nextQuotaReset(shanghai("2026-10-17T23:59:59"))).toBe(
      shanghai("2026-10-18T00:00:00"),
    );
    // Midnight itself already belongs to the new day.
    expect(nextQuotaReset(shanghai("2026-10-18T00:00:00"))).toBe(
      shanghai("2026-10-19T00:00:00"),
    );
    expect(nextQuotaReset(shanghai("2026-10-18T07:59:00"))).toBe(
      shanghai("2026-10-19T00:00:00"),
    );
  });

  it("resumes between 00:05 and 00:30, spread out", () => {
    const now = shanghai("2026-10-17T21:30:00");
    const from = shanghai("2026-10-18T00:05:00");
    const until = shanghai("2026-10-18T00:30:00");
    const seen = new Set<number>();
    for (let index = 0; index < 50; index++) {
      const at = quotaResumeAt(now);
      expect(at).toBeGreaterThanOrEqual(from);
      expect(at).toBeLessThan(until);
      seen.add(at);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
