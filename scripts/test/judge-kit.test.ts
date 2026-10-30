import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  COMPATIBILITY_DATE,
  type CommandOptions,
  checkCommand,
  openSandbox,
  PROTOCOL,
  replayCommand,
  SANDBOX_MODULES,
  simulateCommand,
  startPage,
  TESTS_BYTES,
  testCommand,
} from "../../kit/cli/index.mjs";
import type { JudgeRecords } from "../../kit/judge";
import {
  allowedBy,
  judgeNext,
  paramsCommitment,
  readHongbaoRules,
  readNetwork,
  requestProblem,
  seedCommitment,
  sha256Text,
  startScenario,
  TEST_DEFAULTS,
  TEST_HONGBAO_ID,
  TEST_SEED,
} from "../../kit/runtime/index.mjs";
import {
  JUDGE_LIMITS,
  JUDGE_PROTOCOL,
} from "../../packages/contracts/src/judge";
import { SANDBOX_MODULES as SITE_MODULES } from "../judge-runtime";

// The kit's four commands (docs/programmable-hongbao-design.md §5) on the
// real local workerd, through wrangler's Miniflare as an author runs them.

const root = join(import.meta.dirname, "../..");
const kitDir = join(root, "kit");
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A kit directory of its own: judge.js and whichever JSON files are given. */
function kit(files: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "hb-kit-"));
  made.push(dir);
  for (const [name, content] of Object.entries(files))
    writeFileSync(
      join(dir, name),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  return dir;
}

/** A command's lines and exit code, nothing printed. */
async function run<T extends { exitCode: number }>(
  command: (options: CommandOptions) => Promise<T>,
  options: Omit<CommandOptions, "print">,
) {
  const lines: string[] = [];
  const result = await command({
    ...options,
    print: (line) => lines.push(line),
  });
  return { ...result, lines };
}

const ANSWER = "flag{n0t_s0_s1mpl3}";

/** One submission straight to a sandbox, as runTest would make it (protocol 5). */
function submissionOf(input: string) {
  return {
    input,
    now: Date.UTC(2026, 9, 24),
    user: { id: 1, username: "tester", level: 2 as const, attempts: 0 },
    hongbao: {
      title: "测试红包",
      total: 10000,
      unclaimed: 10000,
      remaining: 10000,
      count: 100,
      minEach: 1,
      remainingCount: 100,
      openedAt: 0,
      endsAt: Date.UTC(2027, 0, 1),
    },
    share: { min: 1, max: 10000, last: false },
    claims: [],
    state: null,
    params: {},
    player: { pending: 0, state: null, view: null },
  };
}
const SEEDS = { submission: TEST_SEED, user: TEST_SEED };

describe("the kit's sandbox", () => {
  it("is built as the site builds it", () => {
    const site = readFileSync(
      join(root, "apps/api/src/judge/sandbox.ts"),
      "utf8",
    );
    expect(SANDBOX_MODULES).toEqual(SITE_MODULES);
    expect(site).toContain(`COMPATIBILITY_DATE = "${COMPATIBILITY_DATE}"`);
    expect(PROTOCOL).toBe(JUDGE_PROTOCOL);
    expect(TESTS_BYTES).toBe(JUDGE_LIMITS.testsBytes);
    // Authors run the workerd and Miniflare the site is built with.
    const wrangler = (path: string) =>
      JSON.parse(readFileSync(join(root, path), "utf8")).devDependencies
        .wrangler;
    expect(wrangler("kit/package.json")).toBe(wrangler("package.json"));
  });

  it("has nodejs_compat and no network, and starts afresh after an endless loop", async () => {
    const sandbox = await openSandbox(`import { createHash } from "node:crypto";
export async function judge(submission) {
  if (submission.input === "loop") for (;;) {}
  if (submission.input === "net") await fetch("https://example.com/");
  return { ok: false, message: createHash("sha256").update(submission.input).digest("hex") };
}`);
    const submission = submissionOf;
    const seeds = SEEDS;
    try {
      expect(sandbox.loadMs).toEqual(expect.any(Number));
      expect(await sandbox.run(submission("a"), seeds)).toEqual({
        verdict: {
          ok: false,
          message: createHash("sha256").update("a").digest("hex"),
        },
      });
      expect(await sandbox.run(submission("net"), seeds)).toMatchObject({
        failure: "threw",
        detail: expect.stringContaining(
          "联网失败：这个红包没有联网（judge.js 没有导出 network）",
        ),
      });
      const started = Date.now();
      expect(await sandbox.run(submission("loop"), seeds)).toEqual({
        failure: "timeout",
        detail: "超过 1 秒没有判定完",
      });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(sandbox.restarts).toBe(1);
      expect(await sandbox.run(submission("b"), seeds)).toMatchObject({
        verdict: { ok: false },
      });
    } finally {
      await sandbox.close();
    }
  }, 20_000);

  it("times out every judgment at once when judge.js's top level never ends", async () => {
    const sandbox = await openSandbox(`for (;;) {}
export function judge() { return { ok: false }; }`);
    try {
      expect(sandbox.loadMs).toBeNull();
      const started = Date.now();
      for (const input of ["a", "b", "c"])
        expect(await sandbox.run(submissionOf(input), SEEDS)).toEqual({
          failure: "timeout",
          detail: "judge.js 顶层的代码超过 1 秒还没跑完",
        });
      // No judgment waits for its second, nor starts workerd afresh.
      expect(Date.now() - started).toBeLessThan(500);
      expect(sandbox.restarts).toBe(0);
    } finally {
      await sandbox.close();
    }
  }, 20_000);
});

describe("npm test", () => {
  it("passes on the templates, a multi-step test included", async () => {
    const { exitCode, lines } = await run(testCommand, { dir: kitDir });
    expect(lines.at(-1)).toMatch(/^测试 (\d+) \/ \1 通过$/);
    expect(lines).toContainEqual(
      expect.stringMatching(/^✓ 几个人依次猜（6 步，\d+ 毫秒/),
    );
    expect(lines).not.toContainEqual(expect.stringMatching(/慢|提醒/));
    expect(exitCode).toBe(0);
  }, 20_000);

  it("shows what the code returned when a test fails, and its console output", async () => {
    const dir = kit({
      "judge.js": `export function judge(submission) {
  console.log("收到", submission.input);
  return { ok: true, amount: 30, message: "对了" };
}`,
      "tests.json": {
        tests: [
          { name: "对了", input: "x", expect: { ok: true, amount: 30 } },
          { name: "给多了", input: "y", expect: { ok: true, amount: 50 } },
        ],
      },
    });
    const { exitCode, lines } = await run(testCommand, { dir });
    expect(lines).toEqual([
      expect.stringMatching(/^✓ 对了（\d+ 毫秒）$/),
      "  收到 x",
      "✗ 给多了：应该领到 50，实际领到 30",
      '  实际：{"ok":true,"amount":30,"add":30,"settle":true,"pending":0,"settled":30,"player":{"state":null,"view":null},"message":"对了","state":null}',
      "  收到 y",
      "测试 1 / 2 通过",
    ]);
    expect(exitCode).toBe(1);

    const only = await run(testCommand, { dir, args: ["多"] });
    expect(only.lines.at(-1)).toBe("测试 0 / 1 通过");
  }, 20_000);

  it("catches an import outside the list before running anything", async () => {
    // No tests.json: the imports are checked first.
    const dir = kit({
      "judge.js": `import { readFileSync } from "node:fs";
import _ from "lodash";
export function judge() { return { ok: false }; }`,
    });
    const { exitCode, lines } = await run(testCommand, { dir });
    expect(lines).toEqual([
      expect.stringMatching(/^✗ judge\.js 第 1 行：node:fs 不在能用的模块里/),
      "✗ judge.js 第 2 行：不能 import npm 包（lodash），要用的部分放进 judge.js",
      "先改好上面的问题，测试没跑",
    ]);
    expect(exitCode).toBe(1);
  });

  it("times out an endless loop, kills the runtime and goes on", async () => {
    const dir = kit({
      "judge.js": `export function judge(submission) {
  if (submission.input === "loop") for (;;) {}
  return { ok: false };
}`,
      "tests.json": {
        tests: [
          { name: "死循环", input: "loop", expect: { ok: false } },
          { name: "之后照常", input: "x", expect: { ok: false } },
        ],
      },
    });
    const { exitCode, lines } = await run(testCommand, { dir });
    expect(lines).toEqual([
      "✗ 死循环：超时：超过 1 秒没有判定完",
      expect.stringMatching(/^✓ 之后照常（\d+ 毫秒）$/),
      "测试 1 / 2 通过",
    ]);
    expect(exitCode).toBe(1);
  }, 20_000);

  it("times out a judgment waiting on a Promise that never settles, and goes on", async () => {
    const dir = kit({
      "judge.js": `export async function judge(submission) {
  if (submission.input === "hang") await new Promise(() => {});
  return { ok: false };
}`,
      "tests.json": {
        tests: [
          { name: "等不到", input: "hang", expect: { ok: false } },
          { name: "之后照常", input: "x", expect: { ok: false } },
        ],
      },
    });
    const { exitCode, lines } = await run(testCommand, { dir });
    expect(lines).toEqual([
      "✗ 等不到：超时：代码一直没有返回（在等一个永远不会完成的 Promise）",
      expect.stringMatching(/^✓ 之后照常（\d+ 毫秒）$/),
      "测试 1 / 2 通过",
    ]);
    expect(exitCode).toBe(1);
  }, 20_000);

  it("says when judge.js's top level is slow: online it runs in a sandbox's first judgment", async () => {
    // About 200 ms here: well past 50 ms, well short of the 1 s timeout.
    const dir = kit({
      "judge.js": `let sum = 0;
for (let i = 1; i < 3e7; i++) sum += Math.sqrt(i) % 1;
export const total = sum;
export function judge() { return { ok: false }; }`,
      "tests.json": {
        tests: [{ name: "a", input: "x", expect: { ok: false } }],
      },
    });
    const slowLoad = expect.stringMatching(
      /^提醒：judge\.js 顶层的代码跑了 \d+ 毫秒，超过 50 毫秒：线上算在每个沙箱的第一次判定里，可能超时$/,
    );
    const tested = await run(testCommand, { dir });
    expect(tested.lines).toEqual([
      expect.stringMatching(/^✓ a（\d+ 毫秒）$/),
      slowLoad,
      "测试 1 / 1 通过",
    ]);
    expect(tested.exitCode).toBe(0);
    const checked = await run(checkCommand, { dir });
    expect(checked.lines).toContainEqual(slowLoad);
    expect(checked.lines.at(-1)).toBe("可以去网站部署了");
  }, 20_000);
});

describe("npm run check", () => {
  it("passes on the templates with the site's fingerprint", async () => {
    const { exitCode, lines, fingerprint } = await run(checkCommand, {
      dir: kitDir,
    });
    const code = readFileSync(join(kitDir, "judge.js"), "utf8");
    const sha = createHash("sha256").update(code).digest("hex");
    expect(fingerprint).toBe(sha);
    expect(lines.slice(0, 3)).toEqual([
      "✓ import 都在清单里",
      "✓ 代码能加载、导出了 judge",
      expect.stringMatching(/^✓ 测试 (\d+) \/ \1 通过$/),
    ]);
    expect(lines).toContain(`  代码指纹 ${sha}`);
    expect(lines).not.toContainEqual(expect.stringContaining("提醒"));
    expect(lines.at(-1)).toBe("可以去网站部署了");
    expect(exitCode).toBe(0);
  }, 20_000);

  it("reads files saved with CRLF or a BOM as the site gets them pasted", async () => {
    const code = readFileSync(join(kitDir, "judge.js"), "utf8");
    const windows = (text: string) => `\uFEFF${text.replace(/\n/g, "\r\n")}`;
    const dir = kit({
      "judge.js": windows(code),
      "tests.json": windows(readFileSync(join(kitDir, "tests.json"), "utf8")),
    });
    const { exitCode, lines, fingerprint } = await run(checkCommand, { dir });
    // The site's editor gives LF and no BOM: its fingerprint is of that.
    expect(fingerprint).toBe(createHash("sha256").update(code).digest("hex"));
    expect(lines.at(-1)).toBe("可以去网站部署了");
    expect(exitCode).toBe(0);
  }, 20_000);

  it("flags true randomness, which no replay can match", async () => {
    const dir = kit({
      "judge.js": `export function judge() {
  return { ok: false, message: crypto.getRandomValues(new Uint32Array(4)).join() };
}`,
      "tests.json": {
        tests: [
          { name: "可以重放", input: "x", expect: { ok: false } },
          {
            name: "真随机",
            steps: [{ who: "小明", input: "x", expect: { ok: false } }],
          },
        ],
      },
    });
    const { exitCode, lines, unstable } = await run(checkCommand, { dir });
    expect(unstable).toEqual(["可以重放", "真随机"]);
    expect(lines).toContain(
      "提醒：两次跑出的结果不一样：可以重放、真随机。用了真随机，线上没法重放",
    );
    expect(lines.at(-1)).toBe("可以去网站部署了");
    expect(exitCode).toBe(0);
  }, 20_000);

  it("says what stops a 红包 from opening", async () => {
    const dir = kit({
      "judge.js": "export function judge( {",
      "tests.json": {
        tests: [{ name: "a", input: "x", expect: { ok: false } }],
      },
    });
    const { exitCode, lines } = await run(checkCommand, { dir });
    expect(lines.slice(0, 3)).toEqual([
      "✓ import 都在清单里",
      "✗ 代码能加载、导出了 judge",
      "  代码加载不了：Failed to start Worker:",
    ]);
    expect(lines).toContainEqual(expect.stringContaining("SyntaxError"));
    expect(lines.at(-1)).toBe("还不能开放");
    expect(exitCode).toBe(1);
  }, 20_000);
});

/**
 * A 拼手气 for each who gets it right, the pool in 3: the seed decides
 * every amount, and the third takes what is left.
 */
const LUCKY = `export function judge(submission, tools) {
  if (submission.input !== "${ANSWER}") return { message: "不对" };
  return { add: tools.money.lucky("double", 3), settle: true, state: { last: submission.user.username } };
}`;
/** The same, as written before protocol 5: shares decide. */
const LUCKY_OLD = `export function judge(submission, tools) {
  if (submission.input !== "${ANSWER}") return { ok: false, message: "不对" };
  return { ok: true, amount: tools.money.lucky(), state: { last: submission.user.username } };
}`;

/** One wrong, each right in turn, then the first again. */
const turns = (people: string[]) => [
  { who: people[0] ?? "", input: "flag{guess}" },
  ...people.map((who) => ({ who, input: ANSWER })),
  { who: people[0] ?? "", input: ANSWER },
];

function simulation(people: string[]) {
  return { hongbao: { total: 1000 }, submissions: turns(people) };
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MINUTE = 60_000;

/**
 * A run as npm run simulate made it before protocol 5 (`count` shares), on
 * that protocol's runtime: what 红包 opened then left in their records.
 */
async function simulateOld(
  code: string,
  {
    count,
    people,
    seed: text,
  }: { count: number; people: string[]; seed: string },
  protocol: number,
) {
  const seed = sha256Text(`hb.lafi.sh/judge/v1/simulate\n${text}`);
  const now = TEST_DEFAULTS.now;
  const hongbao = {
    title: "测试红包",
    total: 1000,
    count,
    minEach: 1,
    openedAt: now - HOUR,
    endsAt: now + DAY,
  };
  const scenario = startScenario({
    hongbao,
    hongbaoId: TEST_HONGBAO_ID,
    secret: seed,
    protocol,
    ...(protocol >= 3 ? { params: {} } : {}),
  });
  const sandbox = await openSandbox(code, { protocol });
  const ids = new Map<string, number>();
  const judged = [];
  try {
    for (const [index, { who, input }] of turns(people).entries()) {
      ids.set(who, ids.get(who) ?? 10001 + ids.size);
      const at = now + index * MINUTE;
      const user = { id: ids.get(who) ?? 0, username: who, level: 2 as const };
      judged.push({
        who,
        user,
        input,
        at,
        fetch: [],
        ...(await judgeNext(scenario, { user, input, at }, sandbox.run)),
      });
    }
  } finally {
    await sandbox.close();
  }
  return { hongbao, hongbaoId: TEST_HONGBAO_ID, seed, judged };
}

describe("npm run simulate", () => {
  it("runs the template", async () => {
    const { exitCode, lines } = await run(simulateCommand, { dir: kitDir });
    expect(lines.at(-1)).toMatch(/^发出 .+ \/ 总奖池 .+，\d+ 人领到钱/);
    expect(exitCode).toBe(0);
  }, 20_000);

  it("is the same for a seed, and stops judging once the pool is taken", async () => {
    const dir = kit({
      "judge.js": LUCKY,
      "simulate.json": simulation(["小明", "小红", "小刚", "小李", "小王"]),
    });
    const first = await run(simulateCommand, { dir });
    const again = await run(simulateCommand, { dir });
    const other = await run(simulateCommand, { dir, args: ["--seed", "2"] });
    expect(again.lines).toEqual(first.lines);
    expect(other.lines.slice(2)).not.toEqual(first.lines.slice(2));
    expect(first.lines.slice(0, 1)).toEqual(["测试红包：总奖池 10.00"]);
    expect(first.lines.slice(2)).toEqual([
      '第 1 次  小明  "flag{guess}"  没加钱  代码的回复：不对',
      expect.stringMatching(
        /^第 2 次 {2}小明 {2}"flag\{n0t_s0_s1mpl3\}" {2}\+\d+\.\d\d · 结算 \d+\.\d\d$/,
      ),
      expect.stringMatching(/^第 3 次 {2}小红 .* · 结算 \d+\.\d\d$/),
      expect.stringMatching(/^第 4 次 {2}小刚 .* · 结算 \d+\.\d\d$/),
      "奖池占满了，红包结束",
      '第 5 次  小李  "flag{n0t_s0_s1mpl3}"  已结束',
      '第 6 次  小王  "flag{n0t_s0_s1mpl3}"  已结束',
      '第 7 次  小明  "flag{n0t_s0_s1mpl3}"  已结束',
      "发出 10.00 / 总奖池 10.00，3 人领到钱",
    ]);
    // The code is never asked once it has ended.
    expect(
      first.simulation?.judged.map((entry) =>
        "refused" in entry ? entry.refused : "judged",
      ),
    ).toEqual([
      "judged",
      "judged",
      "judged",
      "judged",
      "ended",
      "ended",
      "ended",
    ]);
    expect(first.exitCode).toBe(0);

    const settled = await run(simulateCommand, {
      dir,
      args: ["more.json"],
      cwd: kit({ "more.json": simulation(["小明", "小红"]) }),
    });
    expect(settled.lines.at(-2)).toBe(
      '第 4 次  小明  "flag{n0t_s0_s1mpl3}"  已结算',
    );
    expect(settled.lines.at(-1)).toMatch(
      /，2 人领到钱，剩下的 \d+\.\d\d 退回$/,
    );
  }, 30_000);

  it("settles at the deadline whoever the code has not", async () => {
    const dir = kit({
      "judge.js": `export function judge(submission) {
  return { add: 30, message: "攒着" };
}`,
      "simulate.json": {
        hongbao: { total: 1000 },
        submissions: [
          { who: "小明", input: "a" },
          { who: "小红", input: "b" },
          { who: "小明", input: "c" },
        ],
      },
    });
    const { lines } = await run(simulateCommand, { dir });
    expect(lines.slice(2)).toEqual([
      '第 1 次  小明  "a"  +0.30 · 待结算 0.30  代码的回复：攒着',
      '第 2 次  小红  "b"  +0.30 · 待结算 0.30  代码的回复：攒着',
      '第 3 次  小明  "c"  +0.30 · 待结算 0.60  代码的回复：攒着',
      "到截止时间，还没结算的人一起结算：小明 0.60、小红 0.30",
      "发出 0.90 / 总奖池 10.00，2 人领到钱，剩下的 9.10 退回",
    ]);
  }, 20_000);
});

type Simulated = Pick<
  NonNullable<Awaited<ReturnType<typeof simulateCommand>>["simulation"]>,
  "hongbao" | "hongbaoId" | "seed" | "judged"
> & {
  setup?: NonNullable<
    Awaited<ReturnType<typeof simulateCommand>>["simulation"]
  >["setup"];
};

/**
 * The full records the site would give for a simulated run (records.ts),
 * opened on `protocol`: from 5, each answer as the code wrote it.
 */
function recordsOf(
  simulated: Simulated,
  code: string,
  protocol = PROTOCOL,
): JudgeRecords {
  const { hongbao, hongbaoId, seed } = simulated;
  const judgments: JudgeRecords["judgments"] = [];
  for (const entry of simulated.judged) {
    if ("refused" in entry || !entry.reading || "error" in entry.reading)
      continue;
    const { reading, submission } = entry;
    if ("add" in reading) {
      if (!("verdict" in entry.answer)) continue;
      judgments.push({
        at: submission.now,
        input: submission.input,
        user: submission.user,
        title: submission.hongbao.title,
        verdict: entry.answer
          .verdict as JudgeRecords["judgments"][number]["verdict"],
      });
      continue;
    }
    judgments.push({
      at: submission.now,
      input: submission.input,
      user: submission.user,
      title: submission.hongbao.title,
      verdict: {
        ok: reading.ok,
        ...(reading.ok ? { amount: reading.asked } : {}),
        ...(reading.message ? { message: reading.message } : {}),
        ...(reading.state.keep ? {} : { state: reading.state.value }),
        ...(reading.view && !reading.view.keep
          ? { view: reading.view.value }
          : {}),
        ...(reading.announce !== undefined
          ? { announce: reading.announce }
          : {}),
        ...(reading.end ? { end: true as const } : {}),
      },
      ...(reading.ok
        ? {
            paid: reading.paid,
            ...(reading.note ? { note: reading.note } : {}),
            claimedAt: entry.at,
          }
        : {}),
    });
  }
  return {
    protocol,
    hongbao: {
      id: hongbaoId,
      total: hongbao.total,
      ...(protocol < 5
        ? { count: hongbao.count, minEach: hongbao.minEach }
        : {}),
      openedAt: hongbao.openedAt,
      endsAt: hongbao.endsAt,
      fingerprint: createHash("sha256").update(code).digest("hex"),
      seedCommitment: seedCommitment(hongbaoId, seed),
      seed,
    },
    ...(simulated.setup
      ? {
          setup: {
            at: hongbao.openedAt,
            title: hongbao.title,
            ...(simulated.setup.state.keep
              ? {}
              : { state: simulated.setup.state.value }),
            ...(simulated.setup.view.keep
              ? {}
              : { view: simulated.setup.view.value }),
          },
        }
      : {}),
    judgments,
  };
}

describe("npm run replay", () => {
  it("agrees with a simulated run, and says where it does not", async () => {
    const dir = kit({
      "judge.js": LUCKY,
      "simulate.json": simulation(["小明", "小红", "小刚", "小李"]),
    });
    const { simulation: simulated } = await run(simulateCommand, {
      dir,
      args: ["--seed", "replay"],
    });
    if (!simulated) throw new Error("No simulation");
    const records = recordsOf(simulated, LUCKY);
    expect(records.judgments).toHaveLength(4);
    const downloads = kit({ "judge-records-x.json": records });
    const replayed = await run(replayCommand, {
      dir,
      cwd: downloads,
      args: ["judge-records-x.json"],
    });
    expect(replayed.lines).toEqual([
      `✓ 指纹一致 ${records.hongbao.fingerprint}`,
      "✓ 种子和封存值对得上",
      "第 1 次判定 一致",
      "第 2 次判定 一致",
      "第 3 次判定 一致",
      "第 4 次判定 一致",
      "4 次判定全部一致",
    ]);
    expect(replayed.exitCode).toBe(0);

    const replayWith = (changed: unknown) => {
      writeFileSync(
        join(downloads, "judge-records-x.json"),
        JSON.stringify(changed),
      );
      return run(replayCommand, {
        dir,
        cwd: downloads,
        args: ["judge-records-x.json"],
      });
    };

    // A seed that is not the sealed one, or none yet: nothing is replayed.
    const otherSeed = await replayWith({
      ...records,
      hongbao: { ...records.hongbao, seed: "0".repeat(64) },
    });
    expect(otherSeed.lines).toEqual([
      `✓ 指纹一致 ${records.hongbao.fingerprint}`,
      "✗ 种子和封存值对不上：记录里的种子不是开放时封存的那个",
    ]);
    expect(otherSeed.exitCode).toBe(1);
    const unsealed = await replayWith({
      ...records,
      hongbao: { ...records.hongbao, seed: null },
    });
    expect(unsealed.lines).toEqual([
      `✓ 指纹一致 ${records.hongbao.fingerprint}`,
      "✗ 记录里还没有种子：红包结束后才公开，到时候再下载一次完整记录",
    ]);
    expect(unsealed.exitCode).toBe(1);
    await expect(replayWith({ ...records, protocol: 6 })).rejects.toThrow(
      "记录是第 6 版协议，这个开发包只认第 1 到第 5 版：换一个新的开发包再重放",
    );

    // The last, so the pool before the others is as it was.
    const last = records.judgments[3];
    if (!last) throw new Error("No fourth judgment");
    last.verdict = { ...last.verdict, add: 1, state: { last: "别人" } };
    const tampered = await replayWith(records);
    expect(tampered.lines).toContainEqual(
      expect.stringMatching(
        /^第 4 次判定 不一致：add 记录是 1，重放是 \d+；state 记录是 \{"last":"别人"\}，重放是 \{"last":"小刚"\}$/,
      ),
    );
    expect(tampered.lines.at(-1)).toBe("4 次判定里 1 次不一致");
    expect(tampered.exitCode).toBe(1);

    // judge.js changed since: nothing is replayed.
    writeFileSync(join(dir, "judge.js"), `${LUCKY}\n`);
    const changed = await run(replayCommand, {
      dir,
      cwd: downloads,
      args: ["judge-records-x.json"],
    });
    expect(changed.lines.slice(0, 1)).toEqual([
      "✗ 本地 judge.js 的指纹和记录里的不一样",
    ]);
    expect(changed.lines).not.toContainEqual(expect.stringContaining("次判定"));
    expect(changed.exitCode).toBe(1);
  }, 30_000);
});

// 联网 (docs/programmable-hongbao-design.md §9): the rules, and the kit's
// commands answering requests from what the tests wrote.
describe("network", () => {
  const API = "https://api.example.com/hb/";

  it("reads the list judge.js exports, and lets out only what it names", () => {
    expect(readNetwork(undefined)).toEqual({ list: null });
    expect(readNetwork([API, "https://b.example.com"])).toEqual({
      list: [API, "https://b.example.com/"],
    });
    const problems = (value: unknown) =>
      (readNetwork(value) as { problems: string[] }).problems;
    expect(problems("x")[0]).toContain("network 要是字符串数组");
    expect(problems([])[0]).toContain("至少写一个地址");
    expect(problems([API, API])).toEqual(["network 第 2 个和前面的重复了"]);
    expect(problems(["a", "b", "c", "d"])).toEqual(["network 最多写 3 个地址"]);
    for (const [entry, said] of [
      ["http://api.example.com/", "只能用 https://"],
      ["https://1.2.3.4/", "不能写 IP 地址"],
      ["https://[::1]/", "不能写 IP 地址"],
      ["https://localhost/", "要写完整的域名"],
      ["https://connect.linux.do/", "不能请求 linux.do 和它的子域名"],
      ["https://hb.lafi.sh/api/", "不能请求 hb.lafi.sh 和它的子域名"],
      ["https://api.example.com:8443/", "不能带端口"],
      ["https://u:p@api.example.com/", "不能带用户名和密码"],
      ["https://api.example.com/?x=1", "不能带 ? 和 #"],
      ["https://API.example.com/hb", "要写成 https://api.example.com/hb"],
      ["https://api.example.com/a%2fb", "编码过的斜杠"],
    ] as const)
      expect(problems([entry])[0]).toContain(said);

    const list = ["https://a.example.com/api", "https://b.example.com/x/"];
    for (const [address, allowed] of [
      ["https://a.example.com/api", true],
      ["https://a.example.com/api/v1?q=1", true],
      ["https://a.example.com/apix", false],
      ["https://a.example.com/api/../admin", false],
      ["https://a.example.com/api/%2e%2e/admin", false],
      ["https://a.example.com/api/a%2Fb", false],
      ["https://a.example.com:444/api", false],
      ["http://a.example.com/api", false],
      ["https://b.example.com/x/y", true],
      ["https://b.example.com/x", false],
      ["https://c.example.com/api", false],
    ] as const)
      expect([address, allowedBy(list, address)]).toEqual([address, allowed]);
    expect(
      requestProblem(
        { method: "PUT", address: `${API}x`, headers: [], bodyBytes: 0 },
        [API],
      ),
    ).toBe("只能用 GET 和 POST");
    expect(
      requestProblem(
        {
          method: "POST",
          address: `${API}x`,
          headers: ["X-Hb-Hongbao"],
          bodyBytes: 0,
        },
        [API],
      ),
    ).toBe("不能设请求头 X-Hb-Hongbao");
    expect(
      requestProblem(
        { method: "POST", address: `${API}x`, headers: [], bodyBytes: 20_000 },
        [API],
      ),
    ).toBe("请求体超过 16 KB");
  });

  const NETWORKED = `export const network = ["${API}"];
export async function judge(submission) {
  const response = await fetch("${API}check?input=" + encodeURIComponent(submission.input));
  const answer = await response.json();
  return answer.right ? { ok: true, amount: 100, message: answer.say } : { ok: false, message: answer.say };
}
`;
  const right = (input: string) => ({
    url: `${API}check?input=${input}`,
    json: { right: true, say: "对" },
  });
  const wrong = (input: string) => ({
    url: `${API}check?input=${input}`,
    json: { right: false, say: "不对" },
  });

  it("answers requests from the tests, and fails a test that misses one or leaves one unused", async () => {
    const dir = kit({
      "judge.js": NETWORKED,
      "tests.json": {
        tests: [
          {
            name: "对",
            input: "a",
            fetch: [right("a")],
            expect: { ok: true, amount: 100, message: "对" },
          },
          {
            name: "没写返回",
            input: "b",
            expect: { ok: false },
          },
          {
            name: "多写了",
            input: "c",
            fetch: [wrong("c"), wrong("d")],
            expect: { ok: false, message: "不对" },
          },
        ],
      },
    });
    const tested = await run(testCommand, { dir });
    expect(tested.lines[0]).toMatch(/^✓ 对（\d+ 毫秒）$/);
    expect(tested.lines[1]).toContain(
      `✗ 没写返回：代码抛错：TypeError: 联网失败：测试里没写这个请求的返回：GET ${API}check?input=b`,
    );
    expect(tested.lines).toContain(
      `✗ 多写了：写了的返回没用上：GET ${API}check?input=d`,
    );
    expect(tested.exitCode).toBe(1);
    const checked = await run(checkCommand, { dir });
    expect(checked.lines).toContain(`✓ 联网：${API}`);
  }, 30_000);

  it("gives check the tests' answers too, both runs of each", async () => {
    const dir = kit({
      "judge.js": NETWORKED,
      "tests.json": {
        tests: [
          {
            name: "对",
            input: "a",
            fetch: [right("a")],
            expect: { ok: true, amount: 100, message: "对" },
          },
          {
            name: "不对",
            input: "b",
            fetch: [wrong("b")],
            expect: { ok: false, message: "不对" },
          },
        ],
      },
    });
    const checked = await run(checkCommand, { dir });
    expect(checked.lines).toContain("✓ 测试 2 / 2 通过");
    expect(checked.unstable).toEqual([]);
    expect(checked.lines.at(-1)).toBe("可以去网站部署了");
    expect(checked.exitCode).toBe(0);
  }, 30_000);

  it("says what is wrong with the list before any test runs", async () => {
    const dir = kit({
      "judge.js": `export const network = ["http://api.example.com/"];
export function judge() { return { ok: false }; }`,
      "tests.json": {
        tests: [{ name: "不发", input: "x", expect: { ok: false } }],
      },
    });
    const tested = await run(testCommand, { dir });
    expect(tested.lines).toEqual([
      "✗ network 第 1 个（http://api.example.com/）：只能用 https://",
      "先改好 judge.js 的 network，测试没跑",
    ]);
    const checked = await run(checkCommand, { dir });
    expect(checked.lines).toContain("✗ network 写得不对");
    expect(checked.exitCode).toBe(1);
  }, 30_000);

  it("replays a 联网 红包 with the answers the site got, and says where the requests differ", async () => {
    const dir = kit({
      "judge.js": NETWORKED,
      "simulate.json": {
        submissions: [
          { who: "小明", input: "a", fetch: [wrong("a")] },
          { who: "小明", input: "b", fetch: [right("b")] },
        ],
      },
    });
    const { simulation: simulated } = await run(simulateCommand, {
      dir,
      args: ["--seed", "network"],
    });
    if (!simulated) throw new Error("No simulation");
    const records = recordsOf(simulated, NETWORKED);
    const [first, second] = records.judgments;
    if (!first || !second) throw new Error("No judgments");
    // As the site's gateway kept them (records.ts).
    first.fetches = [
      {
        method: "GET",
        url: `${API}check?input=a`,
        status: 200,
        contentType: "application/json",
        response: JSON.stringify({ right: false, say: "不对" }),
        ms: 5,
      },
    ];
    second.fetches = [
      {
        method: "GET",
        url: `${API}check?input=b`,
        status: 200,
        contentType: "application/json",
        response: JSON.stringify({ right: true, say: "对" }),
        ms: 5,
      },
    ];
    const downloads = kit({ "judge-records-x.json": records });
    const replay = () =>
      run(replayCommand, {
        dir,
        cwd: downloads,
        args: ["judge-records-x.json"],
      });
    expect((await replay()).lines.slice(-3)).toEqual([
      "第 1 次判定 一致",
      "第 2 次判定 一致",
      "2 次判定全部一致",
    ]);
    first.fetches = first.fetches.map((asked) => ({
      ...asked,
      url: `${API}check?input=z`,
    }));
    writeFileSync(
      join(downloads, "judge-records-x.json"),
      JSON.stringify(records),
    );
    const differing = await replay();
    expect(differing.lines).toContain(
      `第 1 次判定 不一致：第 1 个请求 记录是 GET ${API}check?input=z，重放是 GET ${API}check?input=a；重放时代码抛错：TypeError: 联网失败：测试里没写这个请求的返回：GET ${API}check?input=a`,
    );
    expect(differing.exitCode).toBe(1);
  }, 30_000);

  it("replays a 红包 opened on the first protocol with its own runtime", async () => {
    const dir = kit({ "judge.js": LUCKY_OLD });
    const simulated = await simulateOld(
      LUCKY_OLD,
      { count: 3, people: ["小明", "小红"], seed: "v1" },
      1,
    );
    const records = recordsOf(simulated, LUCKY_OLD, 1);
    const downloads = kit({ "judge-records-x.json": records });
    const replayed = await run(replayCommand, {
      dir,
      cwd: downloads,
      args: ["judge-records-x.json"],
    });
    expect(replayed.lines.at(-1)).toBe(
      `${records.judgments.length} 次判定全部一致`,
    );
    expect(replayed.exitCode).toBe(0);
  }, 30_000);
});

// 协议第三版 (docs/judge-square-design.md §3–§5): meta, params, hongbao and
// check, through every command.
const GUESS = `export const meta = { name: "猜数字", description: "猜中的领" };
export const params = [
  { key: "max", label: "最大", type: "integer", min: 2, max: 1000, default: 100 },
  { key: "answer", label: "答案", type: "integer", secret: true },
  { key: "words", label: "提示", type: "list", required: false },
];
export const hongbao = { count: { min: 1, max: 10, default: 5 } };
export function check(params) {
  return params.answer > params.max
    ? [{ key: "answer", message: "答案不能大于最大" }]
    : [];
}
export function judge(submission) {
  const ok = Number(submission.input) === submission.params.answer;
  return ok
    ? { ok, amount: submission.share.min }
    : { ok, message: \`不对，范围 1–\${submission.params.max}\` };
}`;
const GUESS_TESTS = {
  params: { answer: 42 },
  tests: [
    { name: "猜中", input: "42", expect: { ok: true } },
    {
      name: "猜错",
      input: "7",
      expect: { ok: false, message: "不对，范围 1–100" },
    },
    {
      name: "自己的参数",
      input: "7",
      params: { answer: 7, max: 10 },
      expect: { ok: true },
    },
    {
      name: "参数不对",
      input: "7",
      params: { answer: "七" },
      expect: { ok: false },
    },
    {
      name: "没过 check",
      input: "7",
      params: { answer: 500 },
      expect: { ok: false },
    },
  ],
};

describe("协议第三版：参数", () => {
  it("npm test gives each test its params, held to the declarations and to check()", async () => {
    const dir = kit({ "judge.js": GUESS, "tests.json": GUESS_TESTS });
    const { exitCode, lines } = await run(testCommand, { dir });
    expect(lines).toEqual([
      expect.stringMatching(/^✓ 猜中（/),
      expect.stringMatching(/^✓ 猜错（/),
      expect.stringMatching(/^✓ 自己的参数（/),
      "✗ 参数不对：params 的 answer：答案要是整数",
      "✗ 没过 check：params 没通过 check：answer：答案不能大于最大",
      "测试 3 / 5 通过",
    ]);
    expect(exitCode).toBe(1);
  }, 20_000);

  it("npm run check draws the form, and says what is wrong with the declarations", async () => {
    const good = kit({
      "judge.js": GUESS,
      "tests.json": { ...GUESS_TESTS, tests: GUESS_TESTS.tests.slice(0, 3) },
    });
    const passed = await run(checkCommand, { dir: good });
    expect(passed.lines.slice(0, 6)).toEqual([
      "✓ import 都在清单里",
      "✓ 代码能加载、导出了 judge",
      "✓ 参数表单预览",
      "  最大（整数，2–1000，默认 100）",
      "  答案（整数，保密）",
      "  提示（列表，选填）",
    ]);
    expect(passed.lines.at(-1)).toBe("可以去网站部署了");
    const bad = kit({
      "judge.js": `export const meta = { name: "名字太长了名字太长了名字太长了名字太长了名字" };
export const params = [{ key: "x", label: "选", type: "choice", options: [{ value: "a", label: "A" }] }];
export const hongbao = { deadline: { value: 2, unit: "weeks" } };
export function judge() { return { ok: false }; }`,
      "tests.json": {
        tests: [{ name: "一条", input: "x", expect: { ok: false } }],
      },
    });
    const failed = await run(checkCommand, { dir: bad });
    expect(failed.lines.slice(2, 6)).toEqual([
      "✗ 参数声明写得不对",
      "  meta.name 最多 20 个字",
      "  params 第 1 项（x）：options 要 2–20 个",
      '  hongbao.deadline 要写成 { value: 正整数, unit: "minutes" | "hours" | "days" }',
    ]);
    expect(failed.lines.at(-1)).toBe("还不能开放");
    expect(failed.exitCode).toBe(1);
  }, 20_000);

  it("npm run check shows the 附带网页 meta.page carries, and says what is wrong with it (judge-page §11.9)", async () => {
    const tests = {
      tests: [{ name: "一条", input: "x", expect: { ok: false } }],
    };
    const judge = (
      page: string,
    ) => `export const meta = { name: "炸弹", page: "${page}" };
export function judge() { return { ok: false }; }`;
    const good = await run(checkCommand, {
      dir: kit({
        "judge.js": judge("https://Bomb.Example.com/play"),
        "tests.json": tests,
      }),
    });
    expect(good.lines).toContain("✓ 附带网页：https://bomb.example.com/play");
    expect(good.exitCode).toBe(0);
    const bad = await run(checkCommand, {
      dir: kit({
        "judge.js": judge("https://127.0.0.1/play"),
        "tests.json": tests,
      }),
    });
    expect(bad.lines.slice(2, 4)).toEqual([
      "✗ 参数声明写得不对",
      "  meta.page：不能写 IP 地址",
    ]);
    expect(bad.exitCode).toBe(1);
  }, 20_000);

  it("npm run simulate sends the params in, and stops at ones that do not pass", async () => {
    const dir = kit({
      "judge.js": GUESS,
      "simulate.json": {
        params: { answer: 42 },
        hongbao: { total: 1000 },
        submissions: [
          { who: "小明", input: "7" },
          { who: "小红", input: "42" },
        ],
      },
    });
    const simulated = await run(simulateCommand, { dir });
    expect(simulated.lines).toContainEqual(
      expect.stringMatching(
        /^第 1 次 {2}小明 {2}"7" {2}没加钱 {2}代码的回复：不对，范围 1–100/,
      ),
    );
    expect(simulated.lines).toContainEqual(
      expect.stringMatching(/^第 2 次 {2}小红 {2}"42" {2}\+0\.01 · 结算 0\.01/),
    );
    const missing = kit({
      "judge.js": GUESS,
      "simulate.json": { submissions: [{ who: "小明", input: "7" }] },
    });
    const refused = await run(simulateCommand, { dir: missing });
    expect(refused.lines.at(-1)).toBe("✗ params 的 answer：请填写答案");
    expect(refused.exitCode).toBe(1);
  }, 30_000);

  it("npm run replay gives a third-protocol 红包 its params, and a second-protocol one its own runtime", async () => {
    const dir = kit({
      "judge.js": GUESS,
      "simulate.json": {
        params: { answer: 42, max: 50 },
        hongbao: { total: 1000 },
        submissions: [
          { who: "小明", input: "7" },
          { who: "小红", input: "42" },
        ],
      },
    });
    const { simulation: simulated } = await run(simulateCommand, { dir });
    if (!simulated) throw new Error("No simulation");
    const records = {
      ...recordsOf(simulated, GUESS),
      params: { answer: 42, max: 50, words: [] },
    };
    const downloads = kit({ "judge-records-x.json": records });
    const replayed = await run(replayCommand, {
      dir,
      cwd: downloads,
      args: ["judge-records-x.json"],
    });
    expect(replayed.lines.at(-1)).toBe("2 次判定全部一致");
    // Its secret params against their 封存值, once it is over.
    const salt = "c".repeat(64);
    const sealed = kit({
      "judge-records-x.json": {
        ...records,
        paramsSealed: {
          keys: ["answer"],
          commitment: paramsCommitment({ answer: 42 }, salt),
          salt,
        },
      },
    });
    const checked = await run(replayCommand, {
      dir,
      cwd: sealed,
      args: ["judge-records-x.json"],
    });
    expect(checked.lines).toContain("✓ 保密参数和封存值对得上");
    const forged = kit({
      "judge-records-x.json": {
        ...records,
        paramsSealed: {
          keys: ["answer"],
          commitment: paramsCommitment({ answer: 7 }, salt),
          salt,
        },
      },
    });
    const caught = await run(replayCommand, {
      dir,
      cwd: forged,
      args: ["judge-records-x.json"],
    });
    expect(caught.lines.at(-1)).toBe(
      "✗ 保密参数和封存值对不上：记录里的参数不是开放时封存的那份",
    );
    expect(caught.exitCode).toBe(1);
    // Another answer: the replay is given it, and the judgments differ.
    const other = kit({
      "judge-records-x.json": { ...records, params: { answer: 7, max: 50 } },
    });
    const differing = await run(replayCommand, {
      dir,
      cwd: other,
      args: ["judge-records-x.json"],
    });
    expect(differing.exitCode).toBe(1);

    const lucky = kit({ "judge.js": LUCKY_OLD });
    const second = await simulateOld(
      LUCKY_OLD,
      { count: 3, people: ["小明", "小红"], seed: "v2" },
      2,
    );
    const v2 = kit({
      "judge-records-x.json": recordsOf(second, LUCKY_OLD, 2),
    });
    const old = await run(replayCommand, {
      dir: lucky,
      cwd: v2,
      args: ["judge-records-x.json"],
    });
    expect(old.lines.at(-1)).toMatch(/^\d+ 次判定全部一致$/);
    expect(old.exitCode).toBe(0);
  }, 40_000);
});

// 数字炸弹, small (docs/judge-page-design.md §7): setup() hides the bomb,
// each guess narrows what everyone sees and says so in 动态, the one who
// steps on it is paid and ends the 红包.
const BOMB = `export const params = [{ key: "word", label: "暗号", type: "text", secret: true, required: false }];
export function setup() {
  const bomb = 1 + Math.floor(Math.random() * 100);
  return {
    state: { bomb, low: 1, high: 100 },
    view: { summary: "安全区间 1–100", data: { low: 1, high: 100 } },
  };
}
export function judge({ input, state, user, params, share }) {
  const guess = Number(input);
  if (!Number.isInteger(guess) || guess < state.low || guess > state.high)
    return { ok: false, message: \`要猜 \${state.low}–\${state.high} 的整数\` };
  if (guess === state.bomb)
    return { ok: true, amount: share.max, announce: \`@\${user.username} 踩中了炸弹\`, end: true };
  const low = guess < state.bomb ? guess + 1 : state.low;
  const high = guess > state.bomb ? guess - 1 : state.high;
  const said = params.word ? \`\${params.word}：\` : "";
  return {
    ok: false,
    message: "安全",
    state: { ...state, low, high },
    view: { summary: \`\${said}安全区间 \${low}–\${high}\`, data: { low, high } },
    announce: \`@\${user.username} 猜了 \${guess}，安全\`,
  };
}`;
const BOMB_STATE = { bomb: 50, low: 1, high: 100 };

describe("协议第四版：公开数据、动态和结束", () => {
  it("npm test checks view, announce and end, and turns away whoever comes after the end", async () => {
    const dir = kit({
      "judge.js": BOMB,
      "tests.json": {
        tests: [
          {
            name: "安全",
            state: BOMB_STATE,
            input: "30",
            expect: {
              ok: false,
              viewIncludes: { summary: "安全区间 31–100" },
              announce: "@tester 猜了 30，安全",
              end: false,
            },
          },
          {
            name: "踩中",
            state: BOMB_STATE,
            input: "50",
            expect: { ok: true, announce: "@tester 踩中了炸弹", end: true },
          },
          {
            name: "说错了",
            state: BOMB_STATE,
            input: "30",
            expect: {
              ok: false,
              view: { summary: "安全区间 1–29" },
              announce: "猜了 30",
              end: true,
            },
          },
          {
            name: "结束以后",
            state: BOMB_STATE,
            steps: [
              { who: "小明", input: "50", expect: { ok: true, end: true } },
              { who: "小红", input: "10", expect: { ok: false } },
            ],
          },
        ],
      },
    });
    const { exitCode, lines } = await run(testCommand, { dir });
    expect(lines[0]).toMatch(/^✓ 安全（/);
    expect(lines[1]).toMatch(/^✓ 踩中（/);
    expect(lines).toContain(
      "✗ 说错了：view 和 expect.view 不一样；动态应该是“猜了 30”，实际是“@tester 猜了 30，安全”；应该结束红包，实际没结束",
    );
    expect(lines).toContain(
      "✗ 结束以后：第 2 步（小红）：红包已经结束了，线上不会交给代码",
    );
    expect(lines.at(-1)).toBe("测试 2 / 4 通过");
    expect(exitCode).toBe(1);
  }, 20_000);

  it("npm run check warns when a secret param shows in what everyone sees", async () => {
    const dir = kit({
      "judge.js": BOMB,
      "tests.json": {
        params: { word: "芝麻开门" },
        tests: [
          {
            name: "安全",
            state: BOMB_STATE,
            input: "30",
            expect: { ok: false },
          },
        ],
      },
    });
    const { exitCode, lines } = await run(checkCommand, { dir });
    expect(lines).toContain(
      "提醒：公开数据里出现了保密参数 word 的值，开放后所有人都看得到。",
    );
    expect(lines.at(-1)).toBe("可以去网站部署了");
    expect(exitCode).toBe(0);
  }, 20_000);

  it("npm run simulate opens with setup() and says what everyone sees, 动态 and the end", async () => {
    // 1, 2, 3, … : someone steps on the bomb, wherever setup() hid it.
    const dir = kit({
      "judge.js": BOMB,
      "simulate.json": {
        hongbao: { total: 1000 },
        submissions: Array.from({ length: 100 }, (_, index) => ({
          who: `第${index + 1}人`,
          input: String(index + 1),
        })),
      },
    });
    const { lines, simulation } = await run(simulateCommand, { dir });
    expect(lines.slice(2, 4)).toEqual([
      "开放时 setup",
      '  公开：安全区间 1–100  data {"low":1,"high":100}',
    ]);
    const state = simulation?.setup?.state;
    if (!state || state.keep) throw new Error("No state from setup()");
    const { bomb } = state.value as { bomb: number };
    if (bomb > 1) {
      expect(lines.slice(4, 7)).toEqual([
        '第 1 次  第1人  "1"  没加钱  代码的回复：安全',
        '  公开：安全区间 2–100  data {"low":2,"high":100}',
        "  动态：@第1人 猜了 1，安全",
      ]);
    }
    const hit = lines.findIndex((line) =>
      line.startsWith(
        `第 ${bomb} 次  第${bomb}人  "${bomb}"  +10.00 · 结算 10.00`,
      ),
    );
    expect(lines.slice(hit + 1, hit + 3)).toEqual([
      `  动态：@第${bomb}人 踩中了炸弹`,
      "判定器结束了这个红包",
    ]);
    if (bomb < 100)
      expect(lines[hit + 3]).toBe(
        `第 ${bomb + 1} 次  第${bomb + 1}人  "${bomb + 1}"  已结束`,
      );
  }, 30_000);

  it("npm run replay checks setup() and each view, line in 动态 and end", async () => {
    const dir = kit({
      "judge.js": BOMB,
      "simulate.json": {
        hongbao: { total: 1000 },
        submissions: Array.from({ length: 100 }, (_, index) => ({
          who: `第${index + 1}人`,
          input: String(index + 1),
        })),
      },
    });
    const { simulation } = await run(simulateCommand, { dir });
    if (!simulation) throw new Error("No simulation");
    const records = recordsOf(simulation, BOMB);
    expect(records.setup?.state).toMatchObject({ low: 1, high: 100 });
    expect(records.judgments.at(-1)?.verdict.end).toBe(true);
    const downloads = kit({ "judge-records-x.json": records });
    const replayed = await run(replayCommand, {
      dir,
      cwd: downloads,
      args: ["judge-records-x.json"],
    });
    expect(replayed.lines[2]).toBe("开放时 setup 一致");
    expect(replayed.lines.at(-1)).toBe(
      `${records.judgments.length} 次判定全部一致`,
    );
    expect(replayed.exitCode).toBe(0);
    // Another bomb at opening: setup() differs.
    const forged = kit({
      "judge-records-x.json": {
        ...records,
        setup: { ...records.setup, state: { bomb: 101, low: 1, high: 100 } },
      },
    });
    const caught = await run(replayCommand, {
      dir,
      cwd: forged,
      args: ["judge-records-x.json"],
    });
    expect(caught.lines[2]).toMatch(/^开放时 setup 不一致：state 记录是 /);
    expect(caught.exitCode).toBe(1);
    // A line in 动态 the code never wrote, and an end it never made.
    const [first, ...rest] = records.judgments;
    if (!first) throw new Error("No judgments");
    const said = kit({
      "judge-records-x.json": {
        ...records,
        judgments: [
          {
            ...first,
            verdict: { ...first.verdict, announce: "别人写的", end: true },
          },
          ...rest,
        ],
      },
    });
    const differing = await run(replayCommand, {
      dir,
      cwd: said,
      args: ["judge-records-x.json"],
    });
    expect(differing.lines[3]).toMatch(
      /^第 1 次判定 不一致：动态 记录是“别人写的”，重放是“@第1人 猜了 1，安全”；记录里结束了红包，重放没结束$|^第 1 次判定 不一致：动态 记录是“别人写的”，重放是“@第1人 踩中了炸弹”$/,
    );
    expect(differing.exitCode).toBe(1);
  }, 40_000);
});

// The six 判定器 of the first 站长精选 (docs/judge-square-design.md §9,
// §15.5): each passes its own tests and its check, declarations and all.
describe("kit/examples", () => {
  const examples = [
    "guess-number",
    "quiz",
    "daily-question",
    "by-level",
    "first-correct",
    "timed-password",
  ];
  it.each(examples)("%s passes npm test and npm run check", async (name) => {
    const dir = join(kitDir, "examples", name);
    const tested = await run(testCommand, { dir, cwd: dir, args: [] });
    expect(tested.lines.at(-1)).toMatch(/^测试 (\d+) \/ \1 通过$/);
    expect(tested.exitCode).toBe(0);
    const checked = await run(checkCommand, { dir, cwd: dir, args: [] });
    expect(checked.lines).toContain("✓ 参数表单预览");
    expect(checked.exitCode).toBe(0);
  });
});

// 判定器带的标题和说明 (docs/judge-square-design.md §4.1).
describe("hongbao.title 和 hongbao.note", () => {
  it("keeps them trimmed, line ends as LF, and says what is wrong", () => {
    expect(
      readHongbaoRules({
        title: " 数字炸弹 ",
        note: "第一行\r\n\n[打开网页参与游戏](#附带网页)\n",
      }),
    ).toEqual({
      rules: {
        title: "数字炸弹",
        note: "第一行\n\n[打开网页参与游戏](#附带网页)",
      },
    });
    expect(
      readHongbaoRules({ title: "字".repeat(101), note: "字".repeat(2001) }),
    ).toEqual({
      problems: ["hongbao.title 最多 100 个字", "hongbao.note 最多 2000 个字"],
    });
    expect(readHongbaoRules({ title: "", note: 3 })).toEqual({
      problems: [
        "hongbao.title 要是不空的字符串",
        "hongbao.note 要是不空的字符串",
      ],
    });
    expect(readHongbaoRules({ name: "x" })).toEqual({
      problems: [
        "hongbao 里不认识 name：只能写 count、total、minEach、deadline、prompt、humanCheck、title、note",
      ],
    });
  });
});

// 附带网页 (docs/judge-page-design.md §11.10): the two samples with a page,
// the SDK the kit serves, and npm run page's 假红包页.
describe("附带网页", () => {
  it.each(["number-bomb", "scratch-card"])(
    "examples/%s passes npm test and npm run check, and has a page",
    async (name) => {
      const dir = join(kitDir, "examples", name);
      const tested = await run(testCommand, { dir, cwd: dir, args: [] });
      expect(tested.lines.at(-1)).toMatch(/^测试 (\d+) \/ \1 通过$/);
      const checked = await run(checkCommand, { dir, cwd: dir, args: [] });
      expect(checked.lines.at(-1)).toBe("可以去网站部署了");
      expect(readFileSync(join(dir, "page/index.html"), "utf8")).toContain(
        '<script src="https://hb.lafi.sh/sdk/v1.js"></script>',
      );
    },
    40_000,
  );

  it("serves the site's own SDK", () => {
    expect(readFileSync(join(kitDir, "cli/page/sdk-v1.js"), "utf8")).toBe(
      readFileSync(join(root, "apps/web/public/sdk/v1.js"), "utf8"),
    );
  });

  it("npm run page: the 红包 page and the page on two addresses, the SDK pointed here, submissions judged by judge.js", async () => {
    const lines: string[] = [];
    const page = await startPage({
      root: join(kitDir, "examples/number-bomb"),
      port: 0,
      cooldown: 60,
      print: (line) => lines.push(line),
    });
    try {
      expect(new URL(page.hostUrl).hostname).toBe("127.0.0.1");
      expect(new URL(page.pageUrl).hostname).toBe("localhost");
      const host = await (await fetch(page.hostUrl)).text();
      expect(host).toContain("<title>假红包页</title>");
      expect(host).toContain(`"pageOrigin":"${page.pageUrl}"`);
      const html = await (await fetch(`${page.pageUrl}/`)).text();
      expect(html).toContain(`<script src="${page.hostUrl}/sdk/v1.js">`);
      expect(html).not.toContain("https://hb.lafi.sh/sdk/v1.js");
      expect(await (await fetch(`${page.hostUrl}/sdk/v1.js`)).text()).toBe(
        readFileSync(join(kitDir, "cli/page/sdk-v1.js"), "utf8"),
      );
      // Nothing outside page/.
      expect(
        (await fetch(`${page.pageUrl}/..%2Fjudge.js`)).status,
      ).toBeGreaterThanOrEqual(400);
      const state = await (await fetch(`${page.hostUrl}/api/state`)).json();
      expect(state.hongbao).toMatchObject({
        title: "数字炸弹",
        code: true,
        status: "active",
        // No shares from protocol 5: what is left unclaimed instead.
        shares: null,
        pool: "30.00",
        unclaimed: "30.00",
        judged: 0,
      });
      expect(state.view.summary).toBe("第 1 颗炸弹 · 安全区间 1–100");
      const submit = async (who: string, input: string) =>
        (
          await fetch(`${page.hostUrl}/api/submit`, {
            method: "POST",
            body: JSON.stringify({ who, input }),
          })
        ).json();
      // What it moved for them too (multi-prize §4.4).
      expect((await submit("小明", "500")).result).toEqual({
        judged: true,
        claimed: false,
        reply: "请猜 1 到 100 之间的整数",
        added: "0.00",
        pending: "0.00",
        settled: false,
      });
      expect((await submit("小明", "7")).result).toMatchObject({
        judged: false,
        reason: "cooldown",
      });
      expect((await submit("没登录", "7")).result).toEqual({
        judged: false,
        reason: "login",
      });
      expect((await submit("小红", "第一行\n第二行")).result).toEqual({
        judged: false,
        reason: "invalid_input",
        message: "只能输入一行",
      });
      const mine = await (
        await fetch(
          `${page.hostUrl}/api/mine?who=${encodeURIComponent("小明")}`,
        )
      ).json();
      expect(mine).toMatchObject({
        total: 1,
        items: [
          { n: 1, input: "500", claimed: false, added: "0.00", settled: false },
        ],
        next: null,
      });
      // hb.me()'s 待结算 and hb.myView(), as the site gives them.
      expect(
        await (
          await fetch(
            `${page.hostUrl}/api/me?who=${encodeURIComponent("小明")}`,
          )
        ).json(),
      ).toEqual({ pending: "0.00", settled: null, myView: null });
      expect(
        await (
          await fetch(
            `${page.hostUrl}/api/me?who=${encodeURIComponent("小红")}`,
          )
        ).json(),
      ).toEqual({ pending: null, settled: null, myView: null });
      expect(lines).toContain(
        '小明  "500"  没加钱  代码的回复：请猜 1 到 100 之间的整数',
      );
    } finally {
      await page.close();
    }
  }, 40_000);
});
