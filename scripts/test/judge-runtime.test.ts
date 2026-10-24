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
  normalizeText,
  personalCode,
  readVerdict,
  sameCode,
  scanImports,
  seedCommitment,
  seedStream,
  settle,
  sha1,
  sha256,
  shareRange,
  submissionSeed,
  timeParts,
  timeWindow,
  totp,
  userSeed,
} from "../../kit/runtime/index.mjs";
import { seedStream as contractsSeedStream } from "../../packages/contracts/src/draw-proof";
import { generateRandomAmounts } from "../../packages/contracts/src/random";
import { RUNTIME_COPY, runtimeCopy } from "../judge-runtime";

const seed = "a".repeat(64);
const secret = "0123456789abcdef".repeat(4);

function submission(overrides: Partial<Submission> = {}): Submission {
  const hongbao = {
    title: "测试红包",
    total: 10000,
    count: 10,
    minEach: 1,
    remaining: 10000,
    remainingCount: 10,
    openedAt: Date.UTC(2026, 9, 24),
    endsAt: Date.UTC(2026, 9, 25),
  };
  return {
    input: "flag{x}",
    now: Date.UTC(2026, 9, 24, 0, 30),
    user: { id: 1, username: "tester", level: 2, attempts: 0 },
    hongbao,
    share: shareRange(hongbao),
    claims: [],
    state: null,
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
    expect(a.tools.money.even()).toBe(1000);
    expect(a.tools.money.format(1234)).toBe("12.34");
    expect(a.tools.time.parts().hour).toBe(8);
    expect(Object.isFrozen(a.tools)).toBe(true);
  });
});

describe("verdict.mjs", () => {
  const share = { min: 100, max: 2000, last: false };

  it("reads an answer the way the protocol says", () => {
    expect(
      readVerdict({ ok: true, amount: 5000, message: "  前三名！\n" }, share),
    ).toEqual({
      ok: true,
      asked: 5000,
      paid: 2000,
      note: "cap",
      message: "前三名！",
      state: { keep: true },
      unknown: [],
    });
    expect(readVerdict({ ok: true, amount: 0 }, share)).toMatchObject({
      paid: 100,
      note: "floor",
    });
    expect(
      readVerdict({ ok: true, amount: 7 }, { min: 91, max: 91, last: true }),
    ).toMatchObject({
      paid: 91,
      note: "last",
    });
    expect(
      readVerdict({ ok: false, state: { tried: ["a"] }, amout: 1 }, share),
    ).toEqual({
      ok: false,
      message: undefined,
      state: { keep: false, value: { tried: ["a"] } },
      unknown: ["amout"],
    });
    expect(readVerdict({ ok: false, state: null }, share)).toMatchObject({
      state: { keep: false, value: null },
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
      expect(readVerdict(raw, share)).toHaveProperty("error.kind", "invalid");
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
});
