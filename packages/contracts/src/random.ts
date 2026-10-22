// The random parts of a 红包 (拼手气 amounts, a 限时开奖's winners and
// prizes), shared by the API and the browser: each takes its bytes from a
// source, crypto's by default, or a 开奖证明 seed's stream (draw-proof.ts)
// so anyone can run it again.
import {
  ACTIVITY_LIMITS,
  type RandomLdcMoney,
  type TimedDrawMoney,
} from "./index";
import { amountToMinor } from "./payments";

export type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => void;

export const secureRandomBytes: RandomBytes = (bytes) => {
  crypto.getRandomValues(bytes);
};

/** Rejection sampling avoids both modulo bias and unsafe Number arithmetic. */
export function randomIntegerInclusive(
  minimum: bigint,
  maximum: bigint,
  fillRandom: RandomBytes = secureRandomBytes,
): bigint {
  if (minimum > maximum) throw new Error("Invalid random amount interval");
  const range = maximum - minimum + 1n;
  if (range === 1n) return minimum;
  const bits = (range - 1n).toString(2).length;
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  const mask = 255 >>> (bytes.length * 8 - bits);
  for (;;) {
    fillRandom(bytes);
    bytes[0] = (bytes[0] ?? 0) & mask;
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    if (value < range) return minimum + value;
  }
}

export function generateRandomAmounts(
  money: RandomLdcMoney,
  fillRandom: RandomBytes = secureRandomBytes,
): number[] {
  const total = amountToMinor(money.totalAmount);
  if (
    !Number.isInteger(money.count) ||
    money.count < 1 ||
    money.count > ACTIVITY_LIMITS.rewards ||
    total < money.count
  )
    throw new Error("Invalid random amount configuration");
  const totalMinor = BigInt(total);
  const twiceCount = 2n * BigInt(money.count);
  const halfMean = totalMinor / twiceCount;
  const lower = halfMean > 1n ? halfMean : 1n;
  const upper = (3n * totalMinor + twiceCount - 1n) / twiceCount;
  let remaining = totalMinor;
  const amounts: number[] = [];
  for (let count = BigInt(money.count); count > 0n; count--) {
    let minimum: bigint;
    let maximum: bigint;
    if (money.algorithm === "double_mean_v1") {
      minimum = count === 1n ? remaining : 1n;
      const reservingMinimum = remaining - count + 1n;
      const twiceMean = (2n * remaining) / count;
      maximum =
        count === 1n
          ? remaining
          : reservingMinimum < twiceMean
            ? reservingMinimum
            : twiceMean;
    } else if (money.algorithm === "bounded_mean_v1") {
      const reservingMaximum = remaining - (count - 1n) * upper;
      const reservingMinimum = remaining - (count - 1n) * lower;
      minimum = lower > reservingMaximum ? lower : reservingMaximum;
      maximum = upper < reservingMinimum ? upper : reservingMinimum;
    } else {
      throw new Error("Unsupported random amount algorithm");
    }
    const amount = randomIntegerInclusive(minimum, maximum, fillRandom);
    amounts.push(Number(amount));
    remaining -= amount;
  }
  return amounts;
}

/** Floyd sampling is O(winner count), even when participation has no configured cap. */
export function sampleOrdinals(
  population: number,
  count: number,
  fillRandom: RandomBytes = secureRandomBytes,
): number[] {
  if (
    !Number.isSafeInteger(population) ||
    population < 0 ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > population ||
    count > ACTIVITY_LIMITS.rewards
  )
    throw new Error("Invalid drawing population");
  const selected = new Set<number>();
  for (let value = population - count + 1; value <= population; value++) {
    const candidate = Number(
      randomIntegerInclusive(1n, BigInt(value), fillRandom),
    );
    selected.add(selected.has(candidate) ? value : candidate);
  }
  return [...selected];
}

/** Fisher–Yates, in place: every order equally likely. */
export function shuffle<T>(
  items: T[],
  fillRandom: RandomBytes = secureRandomBytes,
): T[] {
  for (let index = items.length - 1; index > 0; index--) {
    const target = Number(
      randomIntegerInclusive(0n, BigInt(index), fillRandom),
    );
    [items[index], items[target]] = [items[target] as T, items[index] as T];
  }
  return items;
}

/**
 * A 限时开奖's prizes for `participantCount` people: the pool's amounts,
 * and which of them each winner (in roster order) gets.
 */
export function drawAmounts(
  money: TimedDrawMoney,
  participantCount: number,
  fillRandom: RandomBytes = secureRandomBytes,
) {
  const count = Math.min(participantCount, money.count);
  if (count === 0) return { amounts: [], assignedPositions: [] };
  const poolCount =
    money.distributeFullPool && count < money.count ? count : money.count;
  const amounts = generateRandomAmounts(
    {
      mode: "random",
      algorithm: money.algorithm,
      totalAmount: money.totalAmount,
      count: poolCount,
    },
    fillRandom,
  );
  const assignedPositions = shuffle(
    sampleOrdinals(poolCount, count, fillRandom).map((ordinal) => ordinal - 1),
    fillRandom,
  );
  return { amounts, assignedPositions };
}
