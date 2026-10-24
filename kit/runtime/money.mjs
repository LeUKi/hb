// Money for one share, in whole 分 (0.01). The platform, not the code,
// decides what is finally paid: whatever the code asks is pulled into the
// share's range, and the last share takes everything left.
import { randomIntegerInclusive } from "./random.mjs";

/**
 * This share's range: at least 每份至少, at most what leaves 每份至少 for
 * every share after it; the last one is exactly what is left.
 */
export function shareRange({ remaining, remainingCount, minEach }) {
  if (remainingCount <= 1)
    return { min: remaining, max: remaining, last: true };
  return {
    min: minEach,
    max: remaining - (remainingCount - 1) * minEach,
    last: false,
  };
}

/** What is paid for `asked`: pulled into the range. */
export function settle(asked, share) {
  return Math.min(share.max, Math.max(share.min, asked));
}

/** 2000 → "20.00". */
export function formatAmount(amount) {
  if (!Number.isSafeInteger(amount))
    throw new TypeError("format 要一个整数（分）");
  const sign = amount < 0 ? "-" : "";
  const value = Math.abs(amount);
  return `${sign}${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

/** What is left, shared out evenly (rounded down), within the range. */
export function evenAmount(hongbao, share) {
  return settle(Math.floor(hongbao.remaining / hongbao.remainingCount), share);
}

/**
 * One step of 拼手气 (hb's generateRandomAmounts, packages/contracts/src/
 * random.ts) for this share, with 每份至少 as the floor: "double" is 微信同款
 * (二倍均值), "bounded" 支付宝同款 (initial mean ± 50%).
 */
export function luckyAmount(kind, hongbao, share, fill) {
  if (share.last) return share.max;
  const remaining = BigInt(hongbao.remaining);
  const count = BigInt(hongbao.remainingCount);
  const minEach = BigInt(hongbao.minEach);
  let low;
  let high;
  if (kind === "double") {
    const reserving = remaining - (count - 1n) * minEach;
    const twiceMean = (2n * remaining) / count;
    low = minEach;
    high = reserving < twiceMean ? reserving : twiceMean;
  } else if (kind === "bounded") {
    const total = BigInt(hongbao.total);
    const twiceCount = 2n * BigInt(hongbao.count);
    const halfMean = total / twiceCount;
    const lower = halfMean > minEach ? halfMean : minEach;
    const upper = (3n * total + twiceCount - 1n) / twiceCount;
    const reservingMaximum = remaining - (count - 1n) * upper;
    const reservingMinimum = remaining - (count - 1n) * lower;
    low = lower > reservingMaximum ? lower : reservingMaximum;
    high = upper < reservingMinimum ? upper : reservingMinimum;
  } else {
    throw new RangeError('lucky 的 kind 只能是 "double" 或 "bounded"');
  }
  // Earlier shares chosen by the code may have left the algorithm's path;
  // the share's range below still holds.
  if (high < low) high = low;
  return settle(Number(randomIntegerInclusive(low, high, fill)), share);
}
