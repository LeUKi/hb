import { describe, expect, it } from "vitest";
import {
  createInviteSchema,
  feeOf,
  formatSignedAmount,
  quoteTopup,
  updateBalanceSettingsSchema,
} from "../src";

describe("🐟额 amounts", () => {
  it("takes Credit's fee as it does: rounded half up to the cent", () => {
    expect(feeOf(10_000, 12)).toBe(1200);
    expect(feeOf(11_364, 12)).toBe(1364); // 13.6368
    expect(feeOf(11_363, 12)).toBe(1364); // 13.6356
    expect(feeOf(12, 50)).toBe(6);
    expect(feeOf(1, 50)).toBe(1); // 0.005 rounds up
    expect(feeOf(5000, 0)).toBe(0);
  });

  it("quotes a 转入 from what Credit takes", () => {
    expect(quoteTopup(12, { debitMinor: 10_000 })).toEqual({
      debitMinor: 10_000,
      feeMinor: 1200,
      creditMinor: 8800,
    });
    expect(quoteTopup(12, { debitMinor: 11_363 }).creditMinor).toBe(9999);
  });

  it("quotes a 转入 from what should arrive: the least that brings it", () => {
    expect(quoteTopup(12, { creditMinor: 10_000 })).toEqual({
      debitMinor: 11_364,
      feeMinor: 1364,
      creditMinor: 10_000,
    });
    for (const percent of [0, 1, 4, 12, 15, 33, 50])
      for (const creditMinor of [1, 2, 99, 100, 101, 8800, 9999, 123_457]) {
        const quote = quoteTopup(percent, { creditMinor });
        expect(quote.creditMinor).toBeGreaterThanOrEqual(creditMinor);
        expect(quote.debitMinor - quote.feeMinor).toBe(quote.creditMinor);
        if (quote.debitMinor > 1)
          expect(
            quoteTopup(percent, { debitMinor: quote.debitMinor - 1 })
              .creditMinor,
          ).toBeLessThan(creditMinor);
      }
  });

  it("writes signed amounts", () => {
    expect(formatSignedAmount(1234)).toBe("12.34");
    expect(formatSignedAmount(-5)).toBe("-0.05");
    expect(formatSignedAmount(0)).toBe("0.00");
  });

  it("checks the settings: fee range and cap, and no allowlist any more", () => {
    const base = {
      expectedVersion: 1,
      topupEnabled: true,
      withdrawEnabled: false,
      topupFeePercent: 12,
      withdrawFeePercent: 12,
      withdrawMaxMinor: 100_000,
    };
    expect(updateBalanceSettingsSchema.safeParse(base).success).toBe(true);
    expect(
      updateBalanceSettingsSchema.safeParse({ ...base, topupFeePercent: 51 })
        .success,
    ).toBe(false);
    expect(
      updateBalanceSettingsSchema.safeParse({ ...base, withdrawMaxMinor: 99 })
        .success,
    ).toBe(false);
    // Invitations replaced it (docs/balance-design.md §13).
    expect(
      updateBalanceSettingsSchema.safeParse({ ...base, allowlist: ["730002"] })
        .success,
    ).toBe(false);
  });

  it("reads an invitee's username as typed, with or without @", () => {
    expect(createInviteSchema.parse({ username: " @Lafish " })).toEqual({
      username: "Lafish",
    });
    expect(createInviteSchema.safeParse({ username: "两个字" }).success).toBe(
      false,
    );
    expect(createInviteSchema.safeParse({ username: "@" }).success).toBe(false);
  });
});
