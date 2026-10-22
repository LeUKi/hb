import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  DRAND_QUICKNET,
  drandRoundAfter,
  drandRoundAt,
  drandRoundMatches,
  drawPlanV2,
  drawSeed,
  hasQueue,
  type LdcMoney,
  queueAmountsV2,
  queueCommitment,
  queueSeed,
  rosterHash,
  seedStream,
  sha256,
  sha256Text,
  type TimedDrawMoney,
} from "../src/index";
// The same data tests the verification script (scripts/test/verify-draw.test.ts).
import vectors from "./fixtures/draw-proof-v2.json";

const nodeSha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

describe("SHA-256", () => {
  it("matches node's on every padding boundary and a long input", () => {
    for (let length = 0; length < 200; length++) {
      const data = randomBytes(length);
      expect(bytesToHex(sha256(data))).toBe(nodeSha256(data));
    }
    const long = randomBytes(70_000);
    expect(bytesToHex(sha256(long))).toBe(nodeSha256(long));
    expect(sha256Text("开奖")).toBe(nodeSha256("开奖"));
  });
});

describe("a seed's byte stream", () => {
  it('is SHA-256("<seed>:i") end to end, however it is taken', () => {
    const { seed, first64 } = vectors.stream;
    const whole = new Uint8Array(64);
    seedStream(seed)(whole);
    expect(bytesToHex(whole)).toBe(first64);
    const pieces = seedStream(seed);
    const parts = [5, 27, 1, 31].map((size) => {
      const part = new Uint8Array(size);
      pieces(part);
      return bytesToHex(part);
    });
    expect(parts.join("")).toBe(first64);
  });

  it("only takes a 64-digit hex seed", () => {
    expect(() => seedStream("abc")).toThrow();
    expect(() => seedStream("A".repeat(64))).toThrow();
  });
});

describe("drand quicknet rounds", () => {
  it("takes the first round strictly after closing", () => {
    const at = drandRoundAt(20_000_000);
    expect(at).toBe((DRAND_QUICKNET.genesisSeconds + 19_999_999 * 3) * 1000);
    expect(drandRoundAfter(at - 1)).toBe(20_000_000);
    expect(drandRoundAfter(at)).toBe(20_000_001);
    expect(drandRoundAfter(at + 2_999)).toBe(20_000_001);
    expect(drandRoundAfter(at + 3_000)).toBe(20_000_002);
    expect(drandRoundAfter(0)).toBe(1);
  });

  it("checks a round's randomness against its signature", () => {
    const round = vectors.draws[0]?.drand;
    if (!round) throw new Error("No vector");
    expect(drandRoundMatches(round)).toBe(true);
    expect(drandRoundMatches({ ...round, randomness: "0".repeat(64) })).toBe(
      false,
    );
    expect(
      drandRoundMatches({ ...round, signature: round.signature.slice(2) }),
    ).toBe(false);
  });
});

describe("限时开奖 v2", () => {
  it.each(vectors.draws)("recomputes $activityId from its vector", (vector) => {
    const hash = rosterHash([...vector.roster].reverse());
    expect(hash).toBe(vector.rosterHash);
    const seed = drawSeed({
      activityId: vector.activityId,
      rosterHash: hash,
      round: vector.drand.round,
      randomness: vector.drand.randomness,
    });
    expect(seed).toBe(vector.seed);
    const plan = drawPlanV2({
      seed,
      registered: vector.roster.length,
      money: vector.money as TimedDrawMoney,
    });
    expect(plan).toEqual({
      picked: vector.picked,
      amounts: vector.amounts,
      assignedPositions: vector.assignedPositions,
      winners: vector.winners,
    });
    if (vector.amounts.length > 0)
      expect(vector.amounts.reduce((sum, amount) => sum + amount, 0)).toBe(
        Math.round(Number(vector.money.totalAmount) * 100),
      );
  });

  it("changes with any part of the roster", () => {
    const vector = vectors.draws[0];
    if (!vector) throw new Error("No vector");
    const roster = vector.roster.map((entry) => ({ ...entry }));
    (roster[3] as { registrationId: string }).registrationId += "0";
    expect(rosterHash(roster)).not.toBe(vector.rosterHash);
  });
});

describe("拼手气 and 自定义 in random order v2", () => {
  it.each(vectors.queues)("recomputes $activityId's queue", (vector) => {
    expect(queueCommitment(vector.activityId, vector.secret)).toBe(
      vector.commitment,
    );
    const seed = queueSeed(vector.activityId, vector.secret);
    expect(seed).toBe(vector.seed);
    expect(seed).not.toBe(vector.commitment);
    const money = vector.money as LdcMoney;
    expect(queueAmountsV2({ seed, money })).toEqual(vector.queue);
  });

  it("is a 自定义's own amounts, reordered", () => {
    const vector = vectors.queues.find(
      (queue) => queue.money.mode === "custom",
    );
    if (!vector || !("amounts" in vector.money)) throw new Error("No vector");
    expect([...vector.queue].sort((a, b) => a - b)).toEqual(
      vector.money.amounts
        .map((amount) => Math.round(Number(amount) * 100))
        .sort((a, b) => a - b),
    );
  });

  it("only queues random money", () => {
    const fixed = { mode: "fixed", unitAmount: "1.00", count: 2 } as LdcMoney;
    const custom = { mode: "custom", amounts: ["1.00"] } as LdcMoney;
    const random = vectors.queues[0]?.money as LdcMoney;
    expect(hasQueue(random, "sequential")).toBe(true);
    expect(hasQueue(custom, "random")).toBe(true);
    expect(hasQueue(custom, "sequential")).toBe(false);
    expect(hasQueue(fixed, "random")).toBe(false);
  });
});
