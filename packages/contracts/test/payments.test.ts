import { describe, expect, it } from "vitest";
import {
  activityInputSchema,
  amountToMinor,
  boundedMeanLimits,
  createMerchantSchema,
  emptyActivityInput,
  formatAmount,
  type LdcActivityInput,
  ldcAmounts,
  ldcMoneySchema,
  ldcRewardCount,
  ldcTotalMinor,
  moneySchema,
  paymentLabel,
  type RandomLdcMoney,
  sameLdcMoney,
  updateMerchantSchema,
} from "../src";

describe("payment channel contracts", () => {
  const merchant = {
    requestId: "725ce41c-5596-4d4b-98d0-7d4f9b6217f1",
    label: "测试商户",
    clientId: "test_client",
    secret: "virtual-secret",
  };
  it("defaults old creation requests to simulation and accepts explicit real drafts", () => {
    expect(createMerchantSchema.parse(merchant).mode).toBe("simulation");
    expect(createMerchantSchema.parse({ ...merchant, mode: "real" }).mode).toBe(
      "real",
    );
    expect(
      createMerchantSchema.safeParse({ ...merchant, mode: "other" }).success,
    ).toBe(false);
  });
  it("keeps the payment channel fixed and accepts versioned client updates", () => {
    expect(
      updateMerchantSchema.safeParse({
        version: 1,
        label: "名称",
        requestId: merchant.requestId,
        clientId: "replacement",
        secret: "virtual-replacement",
      }).success,
    ).toBe(true);
    for (const change of [{ mode: "real" }, { clientId: "" }]) {
      expect(
        updateMerchantSchema.safeParse({ version: 1, label: "名称", ...change })
          .success,
      ).toBe(false);
    }
  });
  it("uses a compact confirmed label and distinguishes simulation", () => {
    expect(paymentLabel("simulation", "confirmed")).toBe("模拟发放已确认");
    expect(paymentLabel("real", "confirmed")).toBe("已发放");
    expect(paymentLabel("real", "reconciling")).toBe("核对中");
  });
});

describe("integer money contracts", () => {
  it("rejects malformed input without throwing from safeParse", () => {
    for (const value of [
      "",
      "abc",
      "1e2",
      "-1",
      "0",
      "0.00",
      "1.001",
      " 1",
      "01",
      "Infinity",
      "90071992547409.92",
    ]) {
      expect(() => moneySchema.safeParse(value)).not.toThrow();
      expect(moneySchema.safeParse(value).success).toBe(false);
      expect(() =>
        ldcMoneySchema.safeParse({
          mode: "fixed",
          totalAmount: value,
          count: 2,
        }),
      ).not.toThrow();
      expect(() =>
        ldcMoneySchema.safeParse({ mode: "custom", amounts: [value, "1"] }),
      ).not.toThrow();
    }
  });
  it("round-trips exact decimal amounts and safe integer boundary", () => {
    for (const [value, minor] of [
      ["0.01", 1],
      ["12.30", 1230],
      ["90071992547409.91", Number.MAX_SAFE_INTEGER],
    ] as const) {
      expect(amountToMinor(value)).toBe(minor);
      expect(formatAmount(minor)).toBe(value);
    }
  });
  it("rejects fractional division and unsafe totals", () => {
    expect(
      ldcMoneySchema.safeParse({ mode: "fixed", totalAmount: "1.00", count: 3 })
        .success,
    ).toBe(false);
    expect(
      ldcMoneySchema.safeParse({ mode: "fixed", totalAmount: "1.00", count: 4 })
        .success,
    ).toBe(true);
    expect(
      ldcMoneySchema.safeParse({
        mode: "custom",
        amounts: ["90071992547409.91", "0.01"],
      }).success,
    ).toBe(false);
  });
});

describe("random reward configuration", () => {
  const money: RandomLdcMoney = {
    mode: "random",
    algorithm: "double_mean_v1",
    totalAmount: "1",
    count: 3,
  };
  const input: LdcActivityInput = {
    ...emptyActivityInput(),
    title: "随机活动",
    passwords: ["Random123"],
    rewardType: "ldc",
    merchantId: "725ce41c-5596-4d4b-98d0-7d4f9b6217f1",
    allocation: "random",
    money,
  };

  it("accepts both algorithms without requiring divisibility", () => {
    for (const algorithm of ["double_mean_v1", "bounded_mean_v1"] as const) {
      expect(
        activityInputSchema.safeParse({
          ...input,
          money: { ...money, algorithm },
        }).success,
      ).toBe(true);
    }
    expect(ldcRewardCount(input)).toBe(3);
    expect(ldcTotalMinor(input)).toBe(100);
    expect(() => ldcAmounts(input)).toThrow(/saved server inventory/);
  });

  it("rejects sequential allocation, insufficient totals and unsupported algorithms", () => {
    expect(
      activityInputSchema.safeParse({ ...input, allocation: "sequential" })
        .success,
    ).toBe(false);
    for (const changes of [
      { totalAmount: "0.02", count: 3 },
      { totalAmount: "1.001" },
      { totalAmount: "90071992547409.92" },
      { count: 1001 },
      { count: 0 },
      { algorithm: "unknown" },
    ])
      expect(ldcMoneySchema.safeParse({ ...money, ...changes }).success).toBe(
        false,
      );
  });

  it("compares normalized amounts and only regeneration-relevant properties", () => {
    expect(sameLdcMoney(money, { ...money, totalAmount: "1.00" })).toBe(true);
    expect(sameLdcMoney(money, { ...money, count: 4 })).toBe(false);
    expect(sameLdcMoney(money, { ...money, totalAmount: "2" })).toBe(false);
    expect(
      sameLdcMoney(money, { ...money, algorithm: "bounded_mean_v1" }),
    ).toBe(false);
    expect(
      sameLdcMoney(money, { mode: "fixed", totalAmount: "1", count: 3 }),
    ).toBe(false);
    expect(
      sameLdcMoney(
        { mode: "custom", amounts: ["1", "2"] },
        { mode: "custom", amounts: ["1.00", "2.00"] },
      ),
    ).toBe(true);
    expect(
      sameLdcMoney(
        { mode: "custom", amounts: ["1", "2"] },
        { mode: "custom", amounts: ["2", "1"] },
      ),
    ).toBe(false);
  });

  it("rounds bounds outward without exceeding safe integer totals", () => {
    expect(boundedMeanLimits(100, 4)).toEqual({ min: 12, max: 38 });
    expect(boundedMeanLimits(5, 4)).toEqual({ min: 1, max: 2 });
    expect(boundedMeanLimits(1000, 1000)).toEqual({ min: 1, max: 1 });
    expect(boundedMeanLimits(Number.MAX_SAFE_INTEGER, 1)).toEqual({
      min: Number.MAX_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
    });
    const limits = boundedMeanLimits(Number.MAX_SAFE_INTEGER, 1000);
    expect(Number.isSafeInteger(limits.min)).toBe(true);
    expect(Number.isSafeInteger(limits.max)).toBe(true);
    expect(() => boundedMeanLimits(2, 3)).toThrow();
  });
});
