// Reproducible random numbers: a seed's bytes, taken in order, the way the
// 开奖证明 takes them (hb's packages/contracts/src/draw-proof.ts), so the
// same seed always gives the same numbers, here and on the site.
import { sha256, utf8 } from "./hash.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

/** A seed's bytes: SHA-256("<seed>:0"), SHA-256("<seed>:1"), … end to end. */
export function seedStream(seed) {
  if (!HEX64.test(seed)) throw new Error("Invalid seed");
  let block = new Uint8Array(0);
  let used = 0;
  let counter = 0;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      if (used === block.length) {
        block = sha256(utf8(`${seed}:${counter}`));
        counter += 1;
        used = 0;
      }
      bytes[i] = block[used];
      used += 1;
    }
  };
}

/** Rejection sampling, as 拼手气: no modulo bias, exact for any range. */
export function randomIntegerInclusive(minimum, maximum, fill) {
  if (minimum > maximum) throw new RangeError("Invalid random interval");
  const range = maximum - minimum + 1n;
  if (range === 1n) return minimum;
  const bits = (range - 1n).toString(2).length;
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  const mask = 255 >>> (bytes.length * 8 - bits);
  for (;;) {
    fill(bytes);
    bytes[0] &= mask;
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    if (value < range) return minimum + value;
  }
}

/**
 * tools.random and tools.userRandom: next, int, pick and shuffle, all
 * drawing from one stream in the order the code calls them. `fill` is the
 * stream itself, for tools.money.
 */
export function createRandom(seed) {
  const fill = seedStream(seed);
  const int = (min, max) => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max)
      throw new RangeError("int(min, max) 要两个整数，min 不大于 max");
    return Number(randomIntegerInclusive(BigInt(min), BigInt(max), fill));
  };
  const api = Object.freeze({
    /** [0, 1), 53 bits. */
    next() {
      const bytes = new Uint8Array(7);
      fill(bytes);
      let value = 0n;
      for (const byte of bytes) value = (value << 8n) | BigInt(byte);
      return Number(value >> 3n) / 2 ** 53;
    },
    int,
    pick(items) {
      if (!Array.isArray(items) || items.length === 0)
        throw new RangeError("pick 要一个非空数组");
      return items[int(0, items.length - 1)];
    },
    /** Fisher–Yates, as 拼手气's order: a shuffled copy. */
    shuffle(items) {
      if (!Array.isArray(items)) throw new TypeError("shuffle 要一个数组");
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index--) {
        const target = int(0, index);
        [copy[index], copy[target]] = [copy[target], copy[index]];
      }
      return copy;
    },
  });
  return { api, fill };
}
