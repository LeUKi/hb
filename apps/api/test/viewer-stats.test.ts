import { describe, expect, it } from "vitest";
import {
  VIEWER_CURVE_POINTS,
  viewerCurve,
} from "../src/activities/viewer-stats";

// 在看人数's curve (docs/viewer-stats-design.md §3) from the object's rows:
// one a minute with comings or goings.

describe("viewer curve", () => {
  it("has none before anyone came", () => {
    expect(viewerCurve([])).toBeNull();
  });

  it("carries a quiet minute at the count the last one ended with, never below the count a minute began with", () => {
    const curve = viewerCurve([
      { minute: 100, top: 3, last: 3 },
      // Two left early in minute 103: it began at 3, so its most is 3.
      { minute: 103, top: 1, last: 1 },
      { minute: 104, top: 4, last: 2 },
    ]);
    expect(curve).toEqual({
      start: new Date(100 * 60_000).toISOString(),
      stepSeconds: 60,
      values: [3, 3, 3, 3, 4],
      last: 2,
    });
  });

  it("takes several minutes a point past the limit, each the most of them", () => {
    const rows = Array.from(
      { length: VIEWER_CURVE_POINTS * 2 + 1 },
      (_, i) => ({
        minute: i,
        top: i === 7 ? 50 : 1,
        last: 1,
      }),
    );
    const curve = viewerCurve(rows);
    expect(curve?.stepSeconds).toBe(180);
    expect(curve?.values.length).toBeLessThanOrEqual(VIEWER_CURVE_POINTS);
    expect(curve?.values[2]).toBe(50);
    expect(curve?.values[0]).toBe(1);
  });
});
