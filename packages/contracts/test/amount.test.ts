import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatDisplayAmount,
  formatFullAmount,
  formatStep,
  formatUnitAmount,
  generateRandomAmounts,
  isValidStep,
  MAX_STEP,
  nextStep,
  parseUnitAmount,
  STEP_SERIES,
  stepDecimals,
} from "../src";

describe("amounts by unit (third-party-points-design §2)", () => {
  it("reads LDC exactly as the old two-decimal format", () => {
    for (const minor of [0, 1, 99, 100, 2000, 123456789, 9007199254740991])
      expect(formatUnitAmount(minor)).toBe(formatAmount(minor));
  });
  it("takes the unit's decimals from its step", () => {
    expect(stepDecimals(1)).toBe(2);
    expect(stepDecimals(25)).toBe(2);
    expect(stepDecimals(10)).toBe(1);
    expect(stepDecimals(50)).toBe(1);
    expect(stepDecimals(100)).toBe(0);
    expect(stepDecimals(10000)).toBe(0);
    expect(formatUnitAmount(2000, 100)).toBe("20");
    expect(formatUnitAmount(2050, 10)).toBe("20.5");
    expect(formatUnitAmount(2025, 25)).toBe("20.25");
    expect(formatUnitAmount(-300, 100)).toBe("-3");
  });
  it("never hides cents a whole unit is shown", () => {
    expect(formatUnitAmount(2050, 100)).toBe("20.50");
    expect(formatUnitAmount(2055, 10)).toBe("20.55");
  });
  it("groups thousands", () => {
    expect(formatFullAmount(123456789)).toBe("1,234,567.89");
    expect(formatFullAmount(99999900, 100)).toBe("999,999");
  });
  it("shortens from 100 万 to 万, 亿, 万亿, cutting one decimal", () => {
    expect(formatDisplayAmount(99999999).text).toBe("999,999.99");
    expect(formatDisplayAmount(99999999).short).toBe(false);
    // 1,234,567 → 123.4万 (cut, not 123.5)
    expect(formatDisplayAmount(123456700, 100).text).toBe("123.4万");
    // 99,999,999 stays under 1 亿.
    expect(formatDisplayAmount(9999999900, 100).text).toBe("9,999.9万");
    expect(formatDisplayAmount(12345678900, 100).text).toBe("1.2亿");
    expect(formatDisplayAmount(100000000, 100).text).toBe("100万");
    expect(formatDisplayAmount(1234567890123400, 100).text).toBe("12.3万亿");
    const top = formatDisplayAmount(9007199254740991);
    expect(top.text).toBe("90万亿");
    expect(top.full).toBe("90,071,992,547,409.91");
    expect(top.short).toBe(true);
    expect(formatDisplayAmount(-12345678900, 100).text).toBe("-1.2亿");
  });
  it("parses typed amounts for a unit", () => {
    expect(parseUnitAmount("12.5")).toBe(1250);
    expect(parseUnitAmount("1,234.56")).toBe(123456);
    expect(parseUnitAmount("0")).toBeNull();
    expect(parseUnitAmount("1.234")).toBeNull();
    expect(parseUnitAmount("300", 10000)).toBe(30000);
    expect(parseUnitAmount("150", 10000)).toBeNull();
    expect(parseUnitAmount("1.5", 100)).toBeNull();
    expect(parseUnitAmount("2.5", 50)).toBe(250);
    expect(parseUnitAmount("2.55", 50)).toBeNull();
    expect(parseUnitAmount("90071992547409.91")).toBe(9007199254740991);
    expect(parseUnitAmount("90071992547409.92")).toBeNull();
  });
  it("walks the 1-2-5 series for the stepper", () => {
    expect(STEP_SERIES[0]).toBe(1);
    expect(STEP_SERIES.at(-1)).toBe(MAX_STEP);
    expect(nextStep(100, 1)).toBe(200);
    expect(nextStep(2500, 1)).toBe(5000);
    expect(nextStep(2500, -1)).toBe(2000);
    expect(nextStep(1, -1)).toBeNull();
    expect(nextStep(MAX_STEP, 1)).toBeNull();
    expect(formatStep(1)).toBe("0.01");
    expect(formatStep(50)).toBe("0.5");
    expect(formatStep(10000)).toBe("100");
    expect(isValidStep(0)).toBe(false);
    expect(isValidStep(MAX_STEP + 1)).toBe(false);
  });
});

describe("splits by 最小单位", () => {
  const seeded = () => {
    let state = 7;
    return (bytes: Uint8Array) => {
      for (let index = 0; index < bytes.length; index++) {
        state = (state * 1103515245 + 12345) % 2147483648;
        bytes[index] = state & 255;
      }
    };
  };
  it("draws whole steps and the same LDC draw as ever", () => {
    const money = {
      mode: "random" as const,
      algorithm: "double_mean_v1" as const,
      totalAmount: "100",
      count: 7,
    };
    const ldc = generateRandomAmounts(money, seeded());
    expect(generateRandomAmounts(money, seeded(), 1)).toEqual(ldc);
    const whole = generateRandomAmounts(money, seeded(), 100);
    expect(whole.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(whole.every((amount) => amount % 100 === 0 && amount >= 100)).toBe(
      true,
    );
    expect(() =>
      generateRandomAmounts({ ...money, totalAmount: "100.5" }, seeded(), 100),
    ).toThrow();
    expect(() =>
      generateRandomAmounts({ ...money, totalAmount: "6" }, seeded(), 100),
    ).toThrow();
  });
});
