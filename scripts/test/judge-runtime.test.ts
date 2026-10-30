import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Submission } from "../../kit/judge";
import {
  base32Decode,
  checkSource,
  createRandom,
  createTools,
  crockford,
  evenAmount,
  formatAmount,
  hmacSha1,
  hmacSha256,
  luckyAmount,
  moveMoney,
  nestsDeeper,
  normalizeText,
  othersProblem,
  personalCode,
  readSetup,
  readVerdict,
  sameCode,
  scanImports,
  seedCommitment,
  seedStream,
  settle,
  setupSeed,
  sha1,
  sha256,
  shareRange,
  submissionSeed,
  timeParts,
  timeWindow,
  totp,
  uncountedShares,
  userSeed,
} from "../../kit/runtime/index.mjs";
import { seedStream as contractsSeedStream } from "../../packages/contracts/src/draw-proof";
import { generateRandomAmounts } from "../../packages/contracts/src/random";
import {
  FROZEN_V1,
  FROZEN_V2,
  FROZEN_V3,
  FROZEN_V4,
  RUNTIME_COPY,
  runtimeCopy,
} from "../judge-runtime";

const seed = "a".repeat(64);
const secret = "0123456789abcdef".repeat(4);

/** A protocol 5 submission: 100 LDC, nobody paid, nothing pending. */
function submission(overrides: Partial<Submission> = {}): Submission {
  const hongbao = {
    title: "测试红包",
    total: 10000,
    unclaimed: 10000,
    remaining: 10000,
    count: 100,
    minEach: 1,
    remainingCount: 100,
    openedAt: Date.UTC(2026, 9, 24),
    endsAt: Date.UTC(2026, 9, 25),
  };
  return {
    input: "flag{x}",
    now: Date.UTC(2026, 9, 24, 0, 30),
    user: { id: 1, username: "tester", level: 2, attempts: 0 },
    hongbao,
    share: { min: 1, max: 10000, last: false },
    claims: [],
    state: null,
    params: {},
    player: { pending: 0, state: null, view: null },
    ...overrides,
  };
}

describe("hash.mjs", () => {
  it("matches node:crypto for SHA-256, SHA-1 and both HMACs", () => {
    for (let length = 0; length < 300; length += 7) {
      const data = randomBytes(length);
      const key = randomBytes((length * 3) % 150);
      expect(Buffer.from(sha256(data)).toString("hex")).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
      expect(Buffer.from(sha1(data)).toString("hex")).toBe(
        createHash("sha1").update(data).digest("hex"),
      );
      expect(Buffer.from(hmacSha256(key, data)).toString("hex")).toBe(
        createHmac("sha256", key).update(data).digest("hex"),
      );
      expect(Buffer.from(hmacSha1(key, data)).toString("hex")).toBe(
        createHmac("sha1", key).update(data).digest("hex"),
      );
    }
  });
});

describe("random.mjs", () => {
  it("gives the 开奖证明's bytes for the same seed", () => {
    const ours = seedStream(seed);
    const theirs = contractsSeedStream(seed);
    for (const size of [1, 5, 32, 33, 64, 7]) {
      const a = new Uint8Array(size);
      const b = new Uint8Array(size);
      ours(a);
      theirs(b);
      expect(a).toEqual(b);
    }
  });

  it("draws the same numbers from the same seed, within their ranges", () => {
    const first = createRandom(seed).api;
    const second = createRandom(seed).api;
    for (let i = 0; i < 200; i++) {
      const value = first.next();
      expect(value).toBe(second.next());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      const int = first.int(-3, 7);
      expect(int).toBe(second.int(-3, 7));
      expect(int).toBeGreaterThanOrEqual(-3);
      expect(int).toBeLessThanOrEqual(7);
    }
    const items = Array.from({ length: 20 }, (_, i) => i);
    const shuffled = first.shuffle(items);
    expect(shuffled).toEqual(second.shuffle(items));
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
    expect(items).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(items).toContain(first.pick(items));
    expect(() => first.int(2, 1)).toThrow(RangeError);
    expect(() => first.pick([])).toThrow(RangeError);
  });
});

describe("seeds.mjs", () => {
  const sha = (lines: string[]) =>
    createHash("sha256").update(lines.join("\n")).digest("hex");

  it("derives each seed from the secret, apart from the 开奖证明's", () => {
    expect(seedCommitment("hb-1", secret)).toBe(
      sha(["hb.lafi.sh/judge/v1", "hb-1", secret]),
    );
    expect(submissionSeed("hb-1", secret, 42, 3)).toBe(
      sha(["hb.lafi.sh/judge/v1/random", "hb-1", secret, "42", "3"]),
    );
    expect(userSeed("hb-1", secret, 42)).toBe(
      sha(["hb.lafi.sh/judge/v1/user-random", "hb-1", secret, "42"]),
    );
    // setup()'s Math.random() at opening (protocol 4).
    expect(setupSeed("hb-1", secret)).toBe(
      sha(["hb.lafi.sh/judge/v1/setup", "hb-1", secret]),
    );
    expect(submissionSeed("hb-1", secret, 42, 3)).not.toBe(
      submissionSeed("hb-1", secret, 42, 4),
    );
    expect(() => seedCommitment("hb-1", "short")).toThrow();
  });
});

describe("money.mjs", () => {
  it("keeps 每份至少 for every later share and gives the last one the rest", () => {
    expect(
      shareRange({ remaining: 400, remainingCount: 3, minEach: 100 }),
    ).toEqual({
      min: 100,
      max: 200,
      last: false,
    });
    expect(shareRange({ remaining: 4, remainingCount: 3, minEach: 1 })).toEqual(
      {
        min: 1,
        max: 2,
        last: false,
      },
    );
    expect(
      shareRange({ remaining: 91, remainingCount: 1, minEach: 1 }),
    ).toEqual({
      min: 91,
      max: 91,
      last: true,
    });
    const share = shareRange({ remaining: 4, remainingCount: 3, minEach: 1 });
    expect([settle(3, share), settle(0, share), settle(2, share)]).toEqual([
      2, 1, 2,
    ]);
    expect(formatAmount(2000)).toBe("20.00");
    expect(formatAmount(5)).toBe("0.05");
    expect(
      evenAmount(
        { remaining: 4000, remainingCount: 7 },
        shareRange({ remaining: 4000, remainingCount: 7, minEach: 1 }),
      ),
    ).toBe(571);
  });

  it("is 拼手气 step by step when every share follows it", () => {
    for (const [algorithm, kind] of [
      ["double_mean_v1", "double"],
      ["bounded_mean_v1", "bounded"],
    ] as const) {
      for (const [total, count] of [
        [100, 1],
        [101, 3],
        [10000, 10],
        [2000, 37],
        [999999, 120],
      ] as const) {
        const theirs = generateRandomAmounts(
          {
            mode: "random",
            algorithm,
            totalAmount: formatAmount(total),
            count,
          },
          contractsSeedStream(seed),
        );
        const fill = seedStream(seed);
        const ours: number[] = [];
        let remaining = total;
        for (let k = 0; k < count; k++) {
          const hongbao = {
            total,
            count,
            minEach: 1,
            remaining,
            remainingCount: count - k,
          };
          const amount = luckyAmount(kind, hongbao, shareRange(hongbao), fill);
          ours.push(amount);
          remaining -= amount;
        }
        expect(ours).toEqual(theirs);
      }
    }
  });

  it("never goes below 每份至少 and always adds up", () => {
    for (const kind of ["double", "bounded"] as const) {
      const fill = seedStream(seed);
      const total = 5000;
      const count = 20;
      let remaining = total;
      const amounts: number[] = [];
      for (let k = 0; k < count; k++) {
        const hongbao = {
          total,
          count,
          minEach: 100,
          remaining,
          remainingCount: count - k,
        };
        const amount = luckyAmount(kind, hongbao, shareRange(hongbao), fill);
        amounts.push(amount);
        remaining -= amount;
      }
      expect(Math.min(...amounts)).toBeGreaterThanOrEqual(100);
      expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(total);
    }
  });
});

describe("codes.mjs", () => {
  // RFC 6238 appendix B, SHA-1, eight digits.
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  it("makes RFC 6238's TOTP values", () => {
    expect(new TextDecoder().decode(base32Decode(rfcSecret))).toBe(
      "12345678901234567890",
    );
    for (const [seconds, code] of [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ] as const)
      expect(totp(rfcSecret, { now: seconds * 1000, digits: 8 })).toBe(code);
    expect(totp(rfcSecret, { now: 89 * 1000, digits: 8, offset: -1 })).toBe(
      "94287082",
    );
    expect(totp(rfcSecret, { now: 59 * 1000 })).toBe("287082");
  });

  it("writes Crockford Base32 and reads it loosely", () => {
    expect(crockford(new Uint8Array([0xff]))).toBe("ZW");
    expect(crockford(new Uint8Array([0, 0, 0, 0, 0]))).toBe("00000000");
    const code = personalCode("密钥", [42, "第三关"]);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(personalCode("密钥", [42, "第三关"])).toBe(code);
    expect(personalCode("密钥", [43, "第三关"])).not.toBe(code);
    expect(personalCode("密钥", [42], 16)).toHaveLength(16);
    expect(
      sameCode(` ${code.toLowerCase().slice(0, 5)}-${code.slice(5)} `, code),
    ).toBe(true);
    expect(sameCode("O1L", "011")).toBe(true);
    expect(sameCode("ABC", "ABD")).toBe(false);
    expect(timeWindow(Date.UTC(2026, 9, 24, 0, 30), 600)).toBe(
      Math.floor(Date.UTC(2026, 9, 24, 0, 30) / 600000),
    );
    expect(() => personalCode("", [])).toThrow(TypeError);
  });
});

describe("text.mjs and time.mjs", () => {
  it("normalizes text the way people mean it", () => {
    expect(normalizeText("  ＡＢＣ　１２３\u200B Flag  ")).toBe("abc 123 flag");
  });

  it("tells the date and time in a time zone", () => {
    const moment = Date.UTC(2026, 9, 24, 0, 30, 15);
    expect(timeParts(moment)).toEqual({
      year: 2026,
      month: 10,
      day: 24,
      hour: 8,
      minute: 30,
      second: 15,
      weekday: 6,
    });
    expect(timeParts(moment, "UTC").hour).toBe(0);
    expect(() => timeParts(moment, "Mars/Base")).toThrow(RangeError);
  });
});

describe("tools.mjs", () => {
  it("draws from this submission's and this person's streams", () => {
    const seeds = {
      submission: submissionSeed("hb-1", secret, 1, 0),
      user: userSeed("hb-1", secret, 1),
    };
    const a = createTools(submission(), seeds);
    const b = createTools(submission(), seeds);
    expect(a.tools.random.next()).toBe(b.tools.random.next());
    expect(a.next()).toBe(b.next());
    const later = createTools(submission(), {
      submission: submissionSeed("hb-1", secret, 1, 1),
      user: seeds.user,
    });
    expect(later.tools.userRandom.next()).toBe(
      createTools(submission(), seeds).tools.userRandom.next(),
    );
    expect(later.tools.random.next()).not.toBe(
      createTools(submission(), seeds).tools.random.next(),
    );
    // Protocol 5: n defaults to the pool in whole LDC (§3.5).
    expect(a.tools.money.even()).toBe(100);
    expect(a.tools.money.even(10)).toBe(1000);
    expect(a.tools.money.format(1234)).toBe("12.34");
    expect(a.tools.time.parts().hour).toBe(8);
    expect(Object.isFrozen(a.tools)).toBe(true);
  });
});

describe("verdict.mjs", () => {
  const share = { min: 100, max: 2000, last: false };

  it("reads an answer the way protocols 1–4 say", () => {
    expect(
      readVerdict(
        { ok: true, amount: 5000, message: "  前三名！\n" },
        share,
        3,
      ),
    ).toEqual({
      ok: true,
      asked: 5000,
      paid: 2000,
      note: "cap",
      message: "前三名！",
      state: { keep: true },
      unknown: [],
    });
    expect(readVerdict({ ok: true, amount: 0 }, share, 4)).toMatchObject({
      paid: 100,
      note: "floor",
    });
    expect(
      readVerdict({ ok: true, amount: 7 }, { min: 91, max: 91, last: true }, 4),
    ).toMatchObject({
      paid: 91,
      note: "last",
    });
    expect(
      readVerdict({ ok: false, state: { tried: ["a"] }, amout: 1 }, share, 3),
    ).toEqual({
      ok: false,
      message: undefined,
      state: { keep: false, value: { tried: ["a"] } },
      unknown: ["amout"],
    });
    expect(readVerdict({ ok: false, state: null }, share, 4)).toMatchObject({
      state: { keep: false, value: null },
    });
  });

  it("reads what everyone sees, a line in 动态 and an end from protocol 4 on", () => {
    expect(
      readVerdict(
        {
          ok: false,
          view: { summary: " 安全区间\n23–67 ", data: { low: 23 } },
          announce: " @a 猜了 50 ",
          end: true,
        },
        share,
        4,
      ),
    ).toEqual({
      ok: false,
      message: undefined,
      state: { keep: true },
      view: {
        keep: false,
        value: { summary: "安全区间 23–67", data: { low: 23 } },
      },
      announce: "@a 猜了 50",
      end: true,
      unknown: [],
    });
    expect(readVerdict({ ok: true, amount: 100 }, share, 4)).toMatchObject({
      view: { keep: true },
      end: false,
    });
    expect(readVerdict({ ok: false, view: null }, share, 4)).toMatchObject({
      view: { keep: false, value: null },
    });
    expect(
      readVerdict({ ok: false, view: { summary: " " } }, share, 4),
    ).toMatchObject({ view: { keep: false, value: {} } });
    // Before it, they are fields that protocol does not have.
    expect(
      readVerdict({ ok: false, view: {}, announce: "x", end: true }, share, 3),
    ).toEqual({
      ok: false,
      message: undefined,
      state: { keep: true },
      unknown: ["view", "announce", "end"],
    });
    for (const raw of [
      { ok: false, view: [] },
      { ok: false, view: "x" },
      { ok: false, view: { title: "x" } },
      { ok: false, view: { summary: 1 } },
      { ok: false, view: { summary: "字".repeat(201) } },
      { ok: false, view: { data: { big: "x".repeat(17000) } } },
      { ok: false, view: { data: () => 1 } },
      { ok: false, announce: 1 },
      { ok: false, announce: "字".repeat(101) },
      { ok: false, end: "yes" },
    ])
      expect(readVerdict(raw, share, 4)).toHaveProperty(
        "error.kind",
        "invalid",
      );
  });

  it("reads setup()'s answer at opening", () => {
    for (const raw of [undefined, null])
      expect(readSetup(raw)).toEqual({
        state: { keep: true },
        view: { keep: true },
        unknown: [],
      });
    expect(
      readSetup({ state: { card: [1] }, view: { summary: "开局" }, more: 1 }),
    ).toEqual({
      state: { keep: false, value: { card: [1] } },
      view: { keep: false, value: { summary: "开局" } },
      unknown: ["more"],
    });
    expect(readSetup([])).toHaveProperty("error.kind", "invalid");
    expect(readSetup({ view: { summary: 2 } })).toEqual({
      error: { kind: "invalid", detail: "setup 的 view.summary 要是字符串" },
    });
  });

  it("calls anything else an error", () => {
    for (const raw of [
      undefined,
      null,
      [],
      { ok: "yes" },
      { ok: true },
      { ok: true, amount: 1.5 },
      { ok: true, amount: "100" },
      { ok: false, message: 3 },
      { ok: false, message: "字".repeat(101) },
      { ok: false, state: { big: "x".repeat(17000) } },
      { ok: false, state: () => 1 },
    ])
      expect(readVerdict(raw, share, 4)).toHaveProperty(
        "error.kind",
        "invalid",
      );
  });

  it("holds state to 100 levels, however deep it goes and on any stack", () => {
    const nested = (depth: number) =>
      JSON.parse("[".repeat(depth) + "]".repeat(depth));
    expect(
      readVerdict({ ok: false, state: nested(100) }, share, 4),
    ).toMatchObject({ ok: false, state: { keep: false } });
    for (const depth of [101, 100_000])
      expect(
        readVerdict({ ok: false, state: nested(depth) }, share, 4),
      ).toEqual({
        error: { kind: "invalid", detail: "state 嵌套超过 100 层" },
      });
    expect(nestsDeeper(1, 0)).toBe(false);
    expect(nestsDeeper([], 0)).toBe(true);
    expect(nestsDeeper({ a: [{ b: 1 }] }, 3)).toBe(false);
    expect(nestsDeeper({ a: [{ b: [] }] }, 3)).toBe(true);
    // Wide is not deep.
    expect(
      nestsDeeper(
        Array.from({ length: 10_000 }, () => [1]),
        2,
      ),
    ).toBe(false);
    // A value that refers to itself stops at the limit.
    const loop: { self?: unknown } = {};
    loop.self = loop;
    expect(nestsDeeper(loop, 100)).toBe(true);
  });
});

describe("protocol 5 (docs/multi-prize-design.md §3)", () => {
  const share = { min: 1, max: 10000, last: false };
  const kept = { keep: true };

  it("reads add, settle, the one judged's own and others", () => {
    expect(
      readVerdict(
        {
          add: -20,
          settle: true,
          player: { state: { tries: 1 }, view: { summary: " 还剩\n1 次 " } },
          others: [
            { id: 7, add: 50, view: null, message: " 轮到你 " },
            { id: 8, settle: true },
          ],
          message: "炸了",
        },
        share,
      ),
    ).toEqual({
      add: -20,
      settle: true,
      shorthand: false,
      player: {
        state: { keep: false, value: { tries: 1 } },
        view: { keep: false, value: { summary: "还剩 1 次" } },
      },
      others: [
        {
          id: 7,
          add: 50,
          settle: false,
          state: kept,
          view: { keep: false, value: null },
          message: "轮到你",
        },
        {
          id: 8,
          add: 0,
          settle: true,
          state: kept,
          view: kept,
          message: undefined,
        },
      ],
      message: "炸了",
      state: kept,
      view: kept,
      announce: undefined,
      end: false,
      unknown: [],
    });
    // Nothing written is nothing done: the one judged plays on.
    expect(readVerdict({}, share)).toMatchObject({
      add: 0,
      settle: false,
      others: [],
    });
  });

  it("reads { ok, amount } as short for an add settled at once", () => {
    expect(readVerdict({ ok: true, amount: 100 }, share)).toMatchObject({
      add: 100,
      settle: true,
      shorthand: true,
    });
    expect(readVerdict({ ok: false, amount: 100 }, share)).toMatchObject({
      add: 0,
      settle: false,
      shorthand: true,
    });
    for (const [raw, detail] of [
      [
        { ok: true, amount: 1, add: 1 },
        "ok 和 add 不能一起写：{ ok: true, amount } 是 { add: amount, settle: true } 的简写",
      ],
      [
        { ok: false, settle: true },
        "ok 和 settle 不能一起写：{ ok: true, amount } 是 { add: amount, settle: true } 的简写",
      ],
      [{ amount: 100 }, "amount 只和 ok: true 一起写；给这个人加钱写 add"],
      [{ ok: true }, "ok 为 true 时 amount 要是整数，单位是分"],
    ] as const)
      expect(readVerdict(raw, share)).toEqual({
        error: { kind: "invalid", detail },
      });
  });

  it("calls anything else an error", () => {
    for (const [raw, detail] of [
      [null, "返回的要是一个对象，比如 { add: 50 } 或 {}"],
      [{ add: 1.5 }, "add 要是整数，单位是分，可以是负数"],
      [{ settle: 1 }, "settle 要是 true 或 false"],
      [{ player: [] }, "player 要是一个对象，比如 { state, view }"],
      [{ player: { pending: 1 } }, "player 只能有 state 和 view，多了 pending"],
      [
        { player: { state: { big: "x".repeat(4100) } } },
        "player.state 超过 4 KB",
      ],
      [
        { player: { view: { data: "x".repeat(4100) } } },
        "player.view.data 超过 4 KB",
      ],
      [
        { others: {} },
        "others 要是一个数组，每一项是一个人，比如 [{ id, add }]",
      ],
      [
        { others: Array.from({ length: 11 }, (_, id) => ({ id: id + 1 })) },
        "others 最多 10 个人",
      ],
      [
        { others: [{ id: "7" }] },
        "others 第 1 项的 id 要是 LINUX DO 数字 ID（同 submission.user.id）",
      ],
      [{ others: [{ id: 7 }, { id: 7 }] }, "others 里 7 写了两次"],
      [
        { others: [{ id: 7, pending: 1 }] },
        "others 第 1 项只能有 id、add、settle、state、view、message，多了 pending",
      ],
      [
        { others: [{ id: 7, state: { big: "x".repeat(4100) } }] },
        "others 第 1 项的 state 超过 4 KB",
      ],
      [
        { others: [{ id: 7, message: "字".repeat(101) }] },
        "others 第 1 项的 message 超过 100 个字",
      ],
    ] as const)
      expect(readVerdict(raw, share)).toEqual({
        error: { kind: "invalid", detail },
      });
  });

  it("moves each add so pending stays at least 0 and the pool is not overtaken", () => {
    expect(
      moveMoney(100, [
        { id: 1, pending: 30, add: -50 },
        { id: 2, pending: 0, add: 80 },
        { id: 3, pending: 10, add: 200 },
      ]),
    ).toEqual({
      moves: [
        // Taken off to 0: the 30 goes back to the pool.
        { id: 1, before: 30, after: 0 },
        { id: 2, before: 0, after: 80 },
        // Only what is left: 100 + 30 − 80.
        { id: 3, before: 10, after: 60 },
      ],
      unclaimed: 0,
    });
  });

  it("names who others may not name", () => {
    const standing = (id: number) =>
      id === 1 ? null : id === 2 ? "settled" : id === 3 ? "out" : "unknown";
    expect(othersProblem([{ id: 1 }], 9, standing)).toBeNull();
    expect(othersProblem([{ id: 9 }], 9, standing)).toBe(
      "others 第 1 项（9）是这次提交的人自己：给他的写在 add、settle、player 里",
    );
    expect(othersProblem([{ id: 1 }, { id: 2 }], 9, standing)).toBe(
      "others 第 2 项（2）已经结算了",
    );
    expect(othersProblem([{ id: 3 }], 9, standing)).toBe(
      "others 第 1 项（3）不在这个红包的领取范围以内",
    );
    expect(othersProblem([{ id: 4 }], 9, standing)).toBe(
      "others 第 1 项（4）没有在这个红包里被判定过",
    );
  });

  it("shares what is unclaimed into n, less those paid (§3.5)", () => {
    const seeds = {
      submission: submissionSeed("hb-1", secret, 1, 0),
      user: userSeed("hb-1", secret, 1),
    };
    const paid = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        user: { id: 100 + index, username: `p${index}` },
        amount: 100,
        input: "x",
        at: 0,
      }));
    // 20 LDC with the old code: 1.00 each, as 20 shares were (§5.3).
    const twenty = (claims: number) =>
      createTools(
        submission({
          hongbao: {
            ...submission().hongbao,
            total: 2000,
            count: 20,
            unclaimed: 2000 - claims * 100,
            remaining: 2000 - claims * 100,
            remainingCount: 20 - claims,
          },
          claims: paid(claims),
        }),
        seeds,
      ).tools.money;
    expect(twenty(0).even()).toBe(100);
    expect(twenty(19).even()).toBe(100);
    // n given: shared out by it, the last of n taking all.
    expect(twenty(0).even(4)).toBe(500);
    expect(twenty(3).even(4)).toBe(1700);
    expect(twenty(5).even(4)).toBe(1500);
    expect(twenty(19).lucky("double", 20)).toBe(100);
    const lucky = twenty(0).lucky("double", 4);
    expect(lucky).toBeGreaterThanOrEqual(1);
    expect(lucky).toBeLessThanOrEqual(1000);
    expect(() => twenty(0).even(0)).toThrow("even 的 n 要是正整数（按几份分）");
    expect(() => twenty(0).lucky("double", 1.5)).toThrow(
      "lucky 的 n 要是正整数（按几份分）",
    );
  });

  it("finds even() and lucky() called without n", () => {
    expect(
      uncountedShares(
        [
          "const a = tools.money.even();",
          "const b = tools.money.even(5);",
          'const c = tools.money.lucky("double");',
          'const d = tools.money.lucky("double", n);',
          "// tools.money.even()",
          'const e = "tools.money.even()";',
          "const f = money?.even(/* n */);",
        ].join("\n"),
      ).map((found) => found.line),
    ).toEqual([1, 3, 7]);
    expect(uncountedShares("tools.money.even()")[0]?.message).toBe(
      "even() 没传 n：按总奖池分，每份约 1 LDC；要分成几份就写 even(10)",
    );
  });
});

describe("imports.mjs", () => {
  it("finds static imports, re-exports and dynamic imports", () => {
    const source = `import { createHmac } from "node:crypto";
import "node:events";
import * as path from 'node:path';
export { x } from "./x.js";
export * from "lodash";
const later = await import("node:fs");
`;
    expect(
      scanImports(source).map((found) =>
        "specifier" in found ? found.specifier : found.kind,
      ),
    ).toEqual([
      "node:crypto",
      "node:events",
      "node:path",
      "./x.js",
      "lodash",
      "dynamic",
    ]);
  });

  it("is not fooled by strings, templates, regular expressions or comments", () => {
    const source = `// import("node:fs")
/* import x from "node:net" */
const a = "import(\\"node:fs\\")";
const b = \`import x from "node:http" \${ "import(1)" } and \${ { a: 1 }.a }\`;
const c = /import\\("node:dns"\\)/;
const d = 4 / 2 / 1;
const e = obj.import("x");
class K { import() { return 1; } }
const m = import.meta;
export function judge() { return { ok: false }; }
`;
    expect(scanImports(source)).toEqual([]);
  });

  it("says what breaks the rules, with the line", () => {
    const problems = checkSource(`import { readFileSync } from "node:fs";
import crypto from "crypto";
import _ from "lodash";
import x from "./x.js";
import y from "https://esm.sh/y";
import { createHash } from "node:crypto";
const z = await import("node:" + "fs");
`);
    expect(problems.map((problem) => problem.line)).toEqual([1, 2, 3, 4, 5, 7]);
    const [fs, bare, npm, file, url, dynamic] = problems.map(
      (problem) => problem.message,
    );
    expect(fs).toContain("node:fs 不在能用的模块里");
    expect(bare).toBe('要写成 import … from "node:crypto"');
    expect(npm).toContain("npm 包");
    expect(file).toContain("别的文件");
    expect(url).toContain("网址");
    expect(dynamic).toContain("动态 import()");
    expect(checkSource(`export const judge = () => ({ ok: false });`)).toEqual(
      [],
    );
  });
});

describe("the API's copy of the sandbox runtime", () => {
  it("is up to date (bun scripts/judge-runtime.ts)", () => {
    expect(readFileSync(RUNTIME_COPY, "utf8")).toBe(runtimeCopy());
  });

  // Protocol v1 is frozen: a 代码判定红包 opened with it on 2026-10-25, and
  // an opened 红包 keeps the runtime it opened with (docs/programmable-
  // hongbao-design.md §4.7). So is v2 (联网, §9), live since 2026-10-26,
  // frozen as v3 (docs/judge-square-design.md §5) came, and v3, live since
  // 2026-10-29, frozen as v4 (docs/judge-page-design.md §2) came, and v4,
  // live since 2026-10-29, frozen as v5 (docs/multi-prize-design.md) came.
  // v5 is kit/runtime as it is now; v1–v4 stay beside it as they were,
  // never edited.
  it("keeps protocol v1 as opened, unchanged", () => {
    expect(
      createHash("sha256").update(readFileSync(FROZEN_V1)).digest("hex"),
    ).toBe("dbfed16b0b3763a839828ddd0fe4ca1f4bd686580f2e77987a0e4a8096bcae23");
  });
  it("keeps protocol v2 as opened, unchanged", () => {
    expect(
      createHash("sha256").update(readFileSync(FROZEN_V2)).digest("hex"),
    ).toBe("954cf46722c9789aee36a297d9cc393e29a502e1183c0633eb04cbf70bd8cd0f");
  });
  it("keeps protocol v4 as opened, unchanged", () => {
    expect(
      createHash("sha256").update(readFileSync(FROZEN_V4)).digest("hex"),
    ).toBe("5f34fc53db4c4d2733d5e3e679a5e3cc192019507a883125d7d95bb4401aac3f");
  });
  it("keeps protocol v3 as opened, unchanged", () => {
    expect(
      createHash("sha256").update(readFileSync(FROZEN_V3)).digest("hex"),
    ).toBe("508bcaaf33c1b2ba003d593b6ebe0f61849f84ba55dffb39b8a829e7583479cd");
  });
});
