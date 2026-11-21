import { describe, expect, it } from "vitest";
import { ADMIN_DIAGNOSTIC_THRESHOLDS, adminThresholdText } from "../src";

// The 站长's checks (redesign/07 §10): the numbers the API counts and
// filters by, and the words the pages name them with (sweep 2026-11-21).
describe("the 站长's thresholds", () => {
  it("are named as the pages always named them", () => {
    const { paymentWaitMs, drawWaitMs, outboxWaitMs, maintenanceStaleMs } =
      ADMIN_DIAGNOSTIC_THRESHOLDS;
    expect(adminThresholdText(paymentWaitMs)).toBe("一小时");
    expect(adminThresholdText(drawWaitMs)).toBe("十分钟");
    expect(adminThresholdText(outboxWaitMs)).toBe("十分钟");
    expect(adminThresholdText(maintenanceStaleMs)).toBe("十五分钟");
  });

  it("are written in whole hours, else minutes, in words up to 99", () => {
    const minutes = (count: number) => count * 60_000;
    expect(adminThresholdText(minutes(1))).toBe("一分钟");
    expect(adminThresholdText(minutes(2))).toBe("两分钟");
    expect(adminThresholdText(minutes(12))).toBe("十二分钟");
    expect(adminThresholdText(minutes(20))).toBe("二十分钟");
    expect(adminThresholdText(minutes(22))).toBe("二十二分钟");
    expect(adminThresholdText(minutes(45))).toBe("四十五分钟");
    expect(adminThresholdText(minutes(90))).toBe("九十分钟");
    expect(adminThresholdText(minutes(120))).toBe("两小时");
    expect(adminThresholdText(minutes(24 * 60))).toBe("二十四小时");
    expect(adminThresholdText(minutes(150))).toBe("150 分钟");
  });
});
