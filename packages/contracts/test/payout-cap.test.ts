import { describe, expect, it } from "vitest";
import {
  drawAmounts,
  emptyActivityInput,
  generateRandomAmounts,
  type LdcActivityInput,
  newActivityInputSchema,
  sameLdcMoney,
  shareCapProblem,
  withShareCap,
} from "../src/index";

// 每人上限 (docs/payout-cap-design.md §1).
const base = (money: LdcActivityInput["money"], extra = {}) =>
  ({
    ...emptyActivityInput(),
    title: "t",
    merchantId: "",
    money,
    ...extra,
  }) as LdcActivityInput;
const sequence = (seed: number) => {
  let state = seed;
  return (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) {
      state = (state * 1103515245 + 12345) >>> 0;
      bytes[i] = state >>> 24;
    }
  };
};

describe("每人上限", () => {
  it("caps 商户直发 at 800, 2000 with largeShares, and nothing else", () => {
    const fixed = base({ mode: "fixed", totalAmount: "2888.00", count: 1 });
    expect(shareCapProblem(fixed)).toMatchObject({ cap: 80_000 });
    expect(shareCapProblem({ ...fixed, largeShares: true })).toMatchObject({
      cap: 200_000,
    });
    expect(shareCapProblem({ ...fixed, funding: "balance" })).toBeNull();
    expect(shareCapProblem({ ...fixed, funding: "points" })).toBeNull();
    expect(
      shareCapProblem(
        base({ mode: "fixed", totalAmount: "2400.00", count: 3 }),
      ),
    ).toBeNull();
  });

  it("holds a split's total to the cap times its shares", () => {
    const random = base({
      mode: "random",
      algorithm: "double_mean_v1",
      totalAmount: "1600.01",
      count: 2,
    });
    expect(shareCapProblem(random)).toEqual({
      path: ["money", "totalAmount"],
      cap: 80_000,
      maxTotal: 160_000,
    });
    expect(
      shareCapProblem(base({ mode: "custom", amounts: ["1.00", "800.01"] }))
        ?.path,
    ).toEqual(["money", "amounts", 1]);
    // A 代码判定红包 is capped as its people play, not when it is made.
    expect(
      shareCapProblem(base({ mode: "code", totalAmount: "5000.00" })),
    ).toBeNull();
  });

  it("refuses a new 红包 over it, saying how to send more", () => {
    const checked = newActivityInputSchema.safeParse(
      base({ mode: "fixed", totalAmount: "2888.00", count: 1 }),
    );
    expect(checked.success).toBe(false);
    expect(
      checked.error?.issues.find((issue) => issue.path[0] === "money")?.message,
    ).toBe("每份最多 800 LDC。要发更多，打开“单份可以超过 800 LDC”。");
  });

  it("writes the cap into the money it splits by, and compares it", () => {
    const random = base({
      mode: "random",
      algorithm: "double_mean_v1",
      totalAmount: "100.00",
      count: 2,
    });
    const capped = withShareCap(random);
    expect(capped.money).toMatchObject({ maxEach: "800.00" });
    expect(withShareCap({ ...random, largeShares: true }).money).toMatchObject({
      maxEach: "2000.00",
    });
    expect(
      "maxEach" in withShareCap({ ...capped, funding: "balance" }).money,
    ).toBe(false);
    expect(sameLdcMoney(random.money, capped.money)).toBe(false);
    expect(
      withShareCap(base({ mode: "fixed", totalAmount: "1.00", count: 1 })),
    ).toMatchObject({ money: { mode: "fixed" } });
  });

  it.each(["double_mean_v1", "bounded_mean_v1"] as const)(
    "splits %s with no share above the cap",
    (algorithm) => {
      for (let seed = 1; seed <= 200; seed++) {
        const amounts = generateRandomAmounts(
          {
            mode: "random",
            algorithm,
            totalAmount: "2300.00",
            count: 3,
            maxEach: "800.00",
          },
          sequence(seed),
        );
        expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(230_000);
        expect(Math.max(...amounts)).toBeLessThanOrEqual(80_000);
        expect(Math.min(...amounts)).toBeGreaterThan(0);
      }
      // Exactly the cap times the shares: each is the cap.
      expect(
        generateRandomAmounts(
          {
            mode: "random",
            algorithm,
            totalAmount: "2400.00",
            count: 3,
            maxEach: "800.00",
          },
          sequence(7),
        ),
      ).toEqual([80_000, 80_000, 80_000]);
      expect(() =>
        generateRandomAmounts({
          mode: "random",
          algorithm,
          totalAmount: "2400.01",
          count: 3,
          maxEach: "800.00",
        }),
      ).toThrow();
    },
  );

  it("gives fewer winners of a full pool no more than the cap, the rest unpaid", () => {
    const { amounts } = drawAmounts(
      {
        mode: "timed_draw",
        algorithm: "double_mean_v1",
        totalAmount: "4000.00",
        count: 5,
        participantLimit: null,
        distributeFullPool: true,
        maxEach: "800.00",
      },
      2,
      sequence(3),
    );
    expect(amounts).toEqual([80_000, 80_000]);
  });
});
