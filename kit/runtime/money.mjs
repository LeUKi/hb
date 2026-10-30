// Money for one share, in whole 分 (0.01). The platform, not the code,
// decides what is finally paid: whatever the code asks is pulled into the
// share's range, and the last share takes everything left. From protocol 5
// (docs/multi-prize-design.md §3.5) there are no shares: even(n) and
// lucky(kind, n) share out what is unclaimed as if into n, less those
// already paid, by the same formulas.
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

/**
 * Protocol 5's n when the code gives none: the pool in whole LDC, at least
 * 1 — about 1 LDC a share (§3.5). submission.hongbao.count says it.
 */
export function defaultCount(total) {
  return Math.max(1, Math.floor(total / 100));
}

/**
 * Protocol 5: the numbers the share formulas take, for `n` shares of what
 * is unclaimed, `settled` of them already paid out (claims): at least 0.01
 * each, and at least one share left, which, the last, takes it all.
 */
function sharesOf(hongbao, settled, n, name) {
  if (n !== undefined && (!Number.isSafeInteger(n) || n < 1))
    throw new RangeError(`${name} 的 n 要是正整数（按几份分）`);
  const count = n ?? hongbao.count;
  const numbers = {
    total: hongbao.total,
    count,
    minEach: 1,
    remaining: hongbao.unclaimed,
    remainingCount: Math.max(1, count - settled),
  };
  return { numbers, share: shareRange(numbers) };
}

/** even(n), protocol 5: what is unclaimed ÷ (n − those paid), at least ÷ 1. */
export function evenOf(hongbao, settled, n) {
  const { numbers, share } = sharesOf(hongbao, settled, n, "even");
  return evenAmount(numbers, share);
}

/** lucky(kind, n), protocol 5: lucky's step on the same numbers as evenOf. */
export function luckyOf(kind, hongbao, settled, n, fill) {
  const { numbers, share } = sharesOf(hongbao, settled, n, "lucky");
  return luckyAmount(kind, numbers, share, fill);
}
