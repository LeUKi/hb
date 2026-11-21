import { describe, expect, it } from "vitest";
import { startOfBeijingDay as fromBalance } from "../src/balance/day";
import {
  BEIJING_OFFSET_MS,
  nextBeijingMidnight,
  startOfBeijingDay,
} from "../src/runtime/day";

/** A moment given in Beijing time (UTC+8). */
const beijing = (iso: string) => Date.parse(`${iso}+08:00`);

// The one copy of the site's day (sweep 2026-11-21): daily limits, “今天” on
// the panels and Credit's daily limit all turn over at midnight in Beijing.
describe("the site's day starts at midnight in Beijing", () => {
  it("is eight hours ahead of UTC", () => {
    expect(BEIJING_OFFSET_MS).toBe(8 * 3_600_000);
  });

  it("finds today's midnight, whatever the hour", () => {
    expect(startOfBeijingDay(beijing("2026-11-21T14:00:00"))).toBe(
      beijing("2026-11-21T00:00:00"),
    );
    expect(startOfBeijingDay(beijing("2026-11-21T23:59:59.999"))).toBe(
      beijing("2026-11-21T00:00:00"),
    );
    // Midnight itself already belongs to the new day.
    expect(startOfBeijingDay(beijing("2026-11-22T00:00:00"))).toBe(
      beijing("2026-11-22T00:00:00"),
    );
    // 07:59 in Beijing is still the previous day in UTC.
    expect(startOfBeijingDay(beijing("2026-11-22T07:59:00"))).toBe(
      beijing("2026-11-22T00:00:00"),
    );
  });

  it("finds the next midnight after any moment", () => {
    expect(nextBeijingMidnight(beijing("2026-11-21T14:00:00"))).toBe(
      beijing("2026-11-22T00:00:00"),
    );
    expect(nextBeijingMidnight(beijing("2026-11-22T00:00:00"))).toBe(
      beijing("2026-11-23T00:00:00"),
    );
  });

  it("is the same day for code that still imports it from balance", () => {
    const now = beijing("2026-11-21T09:30:00");
    expect(fromBalance(now)).toBe(startOfBeijingDay(now));
  });
});
