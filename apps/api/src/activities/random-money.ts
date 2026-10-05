import {
  ACTIVITY_LIMITS,
  amountToMinor,
  type RandomLdcMoney,
} from "@hb/contracts";

type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => void;
const secureRandomBytes: RandomBytes = (bytes) => {
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
