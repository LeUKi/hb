// 开奖证明 v2 (docs/draw-proof-design.md): everything that decides a v2
// 红包's random parts, written once for the API, the browser and the
// verification script's tests. Hashes are SHA-256 of UTF-8 text, each part
// on its own line, so anyone can redo them with `printf … | sha256sum`.
import type { LdcMoney, TimedDrawMoney } from "./index";
import { amountToMinor } from "./payments";
import {
  drawAmounts,
  generateRandomAmounts,
  type RandomBytes,
  sampleOrdinals,
  shuffle,
} from "./random";

// SHA-256 (FIPS 180-4), synchronous so the same code runs everywhere.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = data.length;
  const blocks = Math.ceil((length + 9) / 64);
  const message = new Uint8Array(blocks * 64);
  message.set(data);
  message[length] = 0x80;
  const view = new DataView(message.buffer);
  // The bit length, big-endian, in the last 8 bytes.
  view.setUint32(message.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(message.length - 4, (length * 8) >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const s1 =
        rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25);
      const ch =
        ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const t1 =
        ((hh as number) + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 =
        rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22);
      const maj =
        ((a as number) & (b as number)) ^
        ((a as number) & (c as number)) ^
        ((b as number) & (c as number));
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] as number) + (a as number)) >>> 0;
    h[1] = ((h[1] as number) + (b as number)) >>> 0;
    h[2] = ((h[2] as number) + (c as number)) >>> 0;
    h[3] = ((h[3] as number) + (d as number)) >>> 0;
    h[4] = ((h[4] as number) + (e as number)) >>> 0;
    h[5] = ((h[5] as number) + (f as number)) >>> 0;
    h[6] = ((h[6] as number) + (g as number)) >>> 0;
    h[7] = ((h[7] as number) + (hh as number)) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] as number);
  return out;
}

export function bytesToHex(bytes: Uint8Array) {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

export function hexToBytes(hex: string) {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("Invalid hex");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** SHA-256 of some text (UTF-8), in lower-case hex. */
export function sha256Text(text: string) {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

const isHex64 = (value: string) => /^[0-9a-f]{64}$/.test(value);

/**
 * A seed's bytes: SHA-256("<seed>:0"), SHA-256("<seed>:1"), … end to end,
 * taken in order as the algorithms ask for them.
 */
export function seedStream(seed: string): RandomBytes {
  if (!isHex64(seed)) throw new Error("Invalid seed");
  let block = new Uint8Array(0);
  let used = 0;
  let counter = 0;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      if (used === block.length) {
        block = sha256(new TextEncoder().encode(`${seed}:${counter}`));
        counter += 1;
        used = 0;
      }
      bytes[i] = block[used] as number;
      used += 1;
    }
  };
}

/** drand's quicknet: a round every 3 s since its genesis (unchained, BLS on G1). */
export const DRAND_QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  genesisSeconds: 1692803367,
  periodSeconds: 3,
} as const;

/** When a round comes out (ms). */
export function drandRoundAt(round: number) {
  return (
    (DRAND_QUICKNET.genesisSeconds +
      (round - 1) * DRAND_QUICKNET.periodSeconds) *
    1000
  );
}

/** The first round that comes out after `ms`: a 限时开奖's, from its closing. */
export function drandRoundAfter(ms: number) {
  const elapsed = ms / 1000 - DRAND_QUICKNET.genesisSeconds;
  return Math.max(1, Math.floor(elapsed / DRAND_QUICKNET.periodSeconds) + 2);
}

/**
 * A quicknet round as its nodes give it: its randomness is the SHA-256 of
 * its signature, which anyone can check without the BLS maths.
 */
export function drandRoundMatches(round: {
  randomness: string;
  signature: string;
}) {
  return (
    isHex64(round.randomness) &&
    /^[0-9a-f]{96}$/.test(round.signature) &&
    bytesToHex(sha256(hexToBytes(round.signature))) === round.randomness
  );
}

/** 名单哈希: “序号:报名编号” per line, in 报名 order, joined by line breaks. */
export function rosterHash(
  entries: { ordinal: number; registrationId: string }[],
) {
  return sha256Text(
    [...entries]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((entry) => `${entry.ordinal}:${entry.registrationId}`)
      .join("\n"),
  );
}

/** A 限时开奖's seed: its 红包, roster, and the drand round after closing. */
export function drawSeed(input: {
  activityId: string;
  rosterHash: string;
  round: number;
  randomness: string;
}) {
  return sha256Text(
    [
      "hb.lafi.sh/draw/v2",
      input.activityId,
      input.rosterHash,
      String(input.round),
      input.randomness,
    ].join("\n"),
  );
}

/**
 * A 限时开奖 v2, from its seed: the winners' ordinals as they were drawn,
 * the prize pool, and each winner's prize (winners in ordinal order, as the
 * roster has them). The steps of v1, with the seed's bytes.
 */
export function drawPlanV2(input: {
  seed: string;
  registered: number;
  money: TimedDrawMoney;
}) {
  const bytes = seedStream(input.seed);
  const count = Math.min(input.registered, input.money.count);
  const picked = sampleOrdinals(input.registered, count, bytes);
  const { amounts, assignedPositions } = drawAmounts(
    input.money,
    input.registered,
    bytes,
  );
  const winners = [...picked]
    .sort((left, right) => left - right)
    .map((ordinal, index) => {
      const position = assignedPositions[index];
      const amountMinor =
        position === undefined ? undefined : amounts[position];
      if (position === undefined || amountMinor === undefined)
        throw new Error("Drawing assignment is incomplete");
      return { ordinal, position, amountMinor };
    });
  return { picked, amounts, assignedPositions, winners };
}

/** 封存值: what a 拼手气 shows from its opening; its secret comes at the end. */
export function queueCommitment(activityId: string, secret: string) {
  if (!isHex64(secret)) throw new Error("Invalid secret");
  return sha256Text(["hb.lafi.sh/queue/v2", activityId, secret].join("\n"));
}

/** The seed a 拼手气's queue is made from: the secret, never shown before. */
export function queueSeed(activityId: string, secret: string) {
  if (!isHex64(secret)) throw new Error("Invalid secret");
  return sha256Text(
    ["hb.lafi.sh/queue/v2/seed", activityId, secret].join("\n"),
  );
}

/** Money that hands out a queue (v2): 拼手气, or 自定义 in random order. */
export function hasQueue(money: LdcMoney, allocation: "sequential" | "random") {
  return (
    money.mode === "random" ||
    (money.mode === "custom" && allocation === "random")
  );
}

/**
 * A queue v2, from its seed: 拼手气's amounts generated then shuffled, or a
 * 自定义's own amounts shuffled. The k-th claim takes the k-th.
 */
export function queueAmountsV2(input: { seed: string; money: LdcMoney }) {
  const bytes = seedStream(input.seed);
  const { money } = input;
  if (money.mode === "random")
    return shuffle(generateRandomAmounts(money, bytes), bytes);
  if (money.mode === "custom")
    return shuffle(money.amounts.map(amountToMinor), bytes);
  throw new Error("No queue for this money");
}
