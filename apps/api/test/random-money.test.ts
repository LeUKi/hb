import {
  amountToMinor,
  boundedMeanLimits,
  formatAmount,
  type RandomLdcMoney,
} from "@hb/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  generateRandomAmounts,
  randomIntegerInclusive,
} from "../src/activities/random-money";

const algorithms = ["double_mean_v1", "bounded_mean_v1"] as const;
const zeroBytes = (bytes: Uint8Array) => {
  bytes.fill(0);
};
function seededBytes() {
  let state = 0x12345678;
  return (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[i] = state & 255;
    }
  };
}

describe("cryptographic integer sampling", () => {
  it("rejects out-of-range samples instead of reducing them modulo the interval", () => {
    const fill = vi
      .fn<(bytes: Uint8Array) => void>()
      .mockImplementationOnce((bytes) => bytes.fill(3))
      .mockImplementationOnce((bytes) => bytes.fill(2));
    expect(randomIntegerInclusive(10n, 12n, fill)).toBe(12n);
    expect(fill).toHaveBeenCalledTimes(2);
  });

  it("supports inclusive endpoints beyond 32-bit amounts without floating point", () => {
    const maximum = BigInt(Number.MAX_SAFE_INTEGER);
    expect(randomIntegerInclusive(1n, maximum, zeroBytes)).toBe(1n);
    const fill = (bytes: Uint8Array) => {
      expect(bytes).toHaveLength(7);
      bytes.fill(255);
      bytes[bytes.length - 1] = 254;
    };
    expect(randomIntegerInclusive(1n, maximum, fill)).toBe(maximum);
    expect(randomIntegerInclusive(maximum, maximum + 3n, zeroBytes)).toBe(
      maximum,
    );
  });

  it("does not consume entropy for a single possible result", () => {
    const fill = vi.fn(zeroBytes);
    expect(randomIntegerInclusive(42n, 42n, fill)).toBe(42n);
    expect(fill).not.toHaveBeenCalled();
    expect(() => randomIntegerInclusive(2n, 1n, fill)).toThrow();
  });
});

describe("versioned pregenerated random amount algorithms", () => {
  it.each(algorithms)(
    "keeps one share and minimum-total pools exact: %s",
    (algorithm) => {
      const fill = vi.fn(zeroBytes);
      expect(
        generateRandomAmounts(
          {
            mode: "random",
            algorithm,
            totalAmount: "90071992547409.91",
            count: 1,
          },
          fill,
        ),
      ).toEqual([Number.MAX_SAFE_INTEGER]);
      expect(
        generateRandomAmounts(
          { mode: "random", algorithm, totalAmount: "10", count: 1000 },
          fill,
        ),
      ).toEqual(Array<number>(1000).fill(1));
      expect(fill).not.toHaveBeenCalled();
    },
  );

  it("uses the documented intervals and reserves a feasible remainder", () => {
    const money: RandomLdcMoney = {
      mode: "random",
      algorithm: "double_mean_v1",
      totalAmount: "1",
      count: 4,
    };
    expect(generateRandomAmounts(money, zeroBytes)).toEqual([1, 1, 1, 97]);
    expect(
      generateRandomAmounts(
        { ...money, algorithm: "bounded_mean_v1" },
        zeroBytes,
      ),
    ).toEqual([12, 12, 38, 38]);
  });

  it.each(algorithms)(
    "conserves safe-integer totals across small, uneven and maximum pools: %s",
    (algorithm) => {
      const fill = seededBytes();
      for (const [total, count] of [
        [3, 2],
        [101, 3],
        [1001, 1000],
        [100003, 99],
        [Number.MAX_SAFE_INTEGER, 2],
        [Number.MAX_SAFE_INTEGER, 1000],
      ] as const) {
        const amounts = generateRandomAmounts(
          {
            mode: "random",
            algorithm,
            totalAmount: formatAmount(total),
            count,
          },
          fill,
        );
        expect(amounts).toHaveLength(count);
        expect(
          amounts.every((amount) => Number.isSafeInteger(amount) && amount > 0),
        ).toBe(true);
        expect(amounts.reduce((sum, amount) => sum + BigInt(amount), 0n)).toBe(
          BigInt(total),
        );
        if (algorithm === "bounded_mean_v1") {
          const { min, max } = boundedMeanLimits(total, count);
          expect(
            amounts.every((amount) => amount >= min && amount <= max),
          ).toBe(true);
        }
      }
    },
  );

  it("rejects infeasible counts instead of constructing invalid intervals", () => {
    for (const count of [0, 1.5, 1001, 3])
      expect(() =>
        generateRandomAmounts({
          mode: "random",
          algorithm: "double_mean_v1",
          totalAmount: "0.02",
          count,
        }),
      ).toThrow();
    expect(amountToMinor("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
  });
});
