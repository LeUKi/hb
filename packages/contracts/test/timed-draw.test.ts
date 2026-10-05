import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRAW_COUNTDOWN_SECONDS,
  emptyActivityInput,
  type LdcActivityInput,
  ldcAmounts,
  ldcMoneySchema,
  ldcRewardCount,
  ldcTotalMinor,
  MAX_DRAW_COUNTDOWN_SECONDS,
  newActivityInputSchema,
  sameLdcMoney,
  type TimedDrawMoney,
} from "../src/index";

const money: TimedDrawMoney = {
  mode: "timed_draw",
  algorithm: "double_mean_v1",
  totalAmount: "10.00",
  count: 10,
  participantLimit: 10,
  countdownSeconds: DEFAULT_DRAW_COUNTDOWN_SECONDS,
  distributeFullPool: true,
};

function activity(): LdcActivityInput {
  const { rewards: _rewards, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "限时开奖",
    rewardType: "ldc",
    allocation: "random",
    merchantId: "760a1a6f-1aa5-4a4a-a3ba-58f6e4c59aaf",
    passwords: ["DRAW123"],
    money: { ...money },
  };
}

describe("timed draw contracts", () => {
  it.each([null, 1, 5, 10, 100, 1001, Number.MAX_SAFE_INTEGER])(
    "keeps registration cap %s independent from prize count",
    (participantLimit) => {
      const input = activity();
      input.money = { ...money, participantLimit };
      expect(newActivityInputSchema.parse(input).money).toMatchObject({
        count: 10,
        participantLimit,
      });
    },
  );

  it("rejects invalid counts, unsafe time arithmetic and underfunded prizes", () => {
    for (const patch of [
      { count: 0 },
      { count: 1001 },
      { count: 1.5 },
      { participantLimit: 0 },
      { participantLimit: -1 },
      { participantLimit: 1.5 },
      { participantLimit: Number.MAX_SAFE_INTEGER + 1 },
      { countdownSeconds: 0 },
      { countdownSeconds: 1.5 },
      { countdownSeconds: MAX_DRAW_COUNTDOWN_SECONDS + 1 },
      { totalAmount: "0.09" },
      { distributeFullPool: "true" },
      { algorithm: "new_algorithm" },
      { amounts: ["10.00"] },
    ]) {
      expect(ldcMoneySchema.safeParse({ ...money, ...patch }).success).toBe(
        false,
      );
    }
    expect(
      ldcMoneySchema.parse({ ...money, count: 1000, totalAmount: "10.00" })
        .count,
    ).toBe(1000);
    expect(
      ldcMoneySchema.parse({ ...money, totalAmount: "90071992547409.91" })
        .totalAmount,
    ).toBe("90071992547409.91");
  });

  it("rejects sequential timed allocation and a second deadline", () => {
    expect(
      newActivityInputSchema.safeParse({
        ...activity(),
        allocation: "sequential",
      }).success,
    ).toBe(false);
    expect(
      newActivityInputSchema.safeParse({
        ...activity(),
        deadline: { mode: "at", at: "2099-01-01T00:00:00Z" },
      }).success,
    ).toBe(false);
    expect(newActivityInputSchema.safeParse(activity()).success).toBe(true);
  });

  it("calculates configuration totals without generating authoritative inventory", () => {
    expect(ldcRewardCount(activity())).toBe(10);
    expect(ldcTotalMinor(activity())).toBe(1000);
    expect(() => ldcAmounts(activity())).toThrow();
    expect(sameLdcMoney(money, { ...money, totalAmount: "10" })).toBe(true);
    for (const patch of [
      { algorithm: "bounded_mean_v1" as const },
      { count: 5 },
      { totalAmount: "11.00" },
      { participantLimit: null },
      { countdownSeconds: 60 },
      { distributeFullPool: false },
    ]) {
      expect(sameLdcMoney(money, { ...money, ...patch })).toBe(false);
      expect(sameLdcMoney({ ...money, ...patch }, money)).toBe(false);
    }
    expect(
      sameLdcMoney(money, {
        mode: "random",
        algorithm: money.algorithm,
        count: money.count,
        totalAmount: money.totalAmount,
      }),
    ).toBe(false);
    expect(
      sameLdcMoney(money, {
        mode: "fixed",
        count: money.count,
        totalAmount: money.totalAmount,
      }),
    ).toBe(false);
  });
});
