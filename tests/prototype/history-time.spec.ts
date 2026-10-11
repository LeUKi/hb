import { expect, test } from "@playwright/test";
import { prototypeStartedAt } from "../../apps/web/prototype/activity-metadata";
import {
  getSampleResult,
  historySamples,
  randomActivities,
} from "../../apps/web/prototype/fixtures";

test("virtual participation times precede saved deadlines and retain recent active records", () => {
  let previousActive: number | undefined;
  for (const [index, activity] of [
    ...randomActivities,
    ...historySamples,
  ].entries()) {
    const result = getSampleResult(activity.id);
    if (!result) throw new Error("Missing virtual participation result");
    const time = Date.parse(result.participatedAt);
    const deadline = Date.parse(activity.deadlineAt ?? "");
    expect(time).toBeLessThan(prototypeStartedAt);
    expect(time).toBeLessThan(deadline);
    expect(time).toBe(
      Math.min(
        prototypeStartedAt - (index + 1) * 18 * 60000,
        deadline - 18 * 60000,
      ),
    );
    if (activity.lifecycle === "active") {
      if (previousActive !== undefined)
        expect(time).toBeLessThan(previousActive);
      expect(time).toBeGreaterThan(prototypeStartedAt - 24 * 3600000);
      previousActive = time;
    }
  }
});
