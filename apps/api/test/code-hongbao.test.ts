import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedCommitment } from "../../../kit/runtime/index.mjs";
import {
  createActivity,
  getManagedActivity,
  getPublicActivity,
  openActivity,
  updateActivity,
} from "../src/activities/service";
import { readAccount } from "../src/balance/ledger";
import { findJudgeRow, readSeed } from "../src/judge/storage";
import { sha256Hex } from "../src/security/crypto";
import {
  type Actor,
  actor,
  bindings,
  check,
  coded,
  give,
  JUDGE,
  plus,
  rejects,
  settings,
  TESTS,
} from "./code-fixtures";

// 代码判定红包 (docs/programmable-hongbao-design.md): who may send one, how its
// code is kept, 在线检查, and opening with a sealed seed and a locked pool.

const draft = (input = coded()) =>
  createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1, code_hongbao_enabled: 1 });
  await plus(author);
  await give(admin, author, "5.00");
});

describe("代码判定红包: sending one", () => {
  it("is for 🐟额 PLUS while its switch is on", async () => {
    const stranger = await actor();
    await rejects(
      createActivity(bindings, stranger.id, {
        requestId: crypto.randomUUID(),
        activity: coded(),
      }),
      "CODE_HONGBAO_NOT_ALLOWED",
    );
    await settings({ code_hongbao_enabled: 0 });
    await rejects(draft(), "CODE_HONGBAO_PAUSED");
  });

  it("keeps the code to its sender: encrypted, back in their own read, never on the page", async () => {
    const saved = await draft();
    expect(saved.config.judge).toEqual({
      prompt: "输入 flag",
      code: JUDGE,
      tests: TESTS,
    });
    const row = await env.DB.prepare(
      "SELECT * FROM activity_code WHERE activity_id = ?",
    )
      .bind(saved.id)
      .first<Record<string, unknown>>();
    expect(row?.fingerprint).toBe(await sha256Hex(JUDGE));
    expect(String(row?.code_ciphertext)).not.toContain("flag{ok}");
    expect(row?.seed_commitment).toBeNull();
    const config = await env.DB.prepare(
      "SELECT config FROM activities WHERE id = ?",
    )
      .bind(saved.id)
      .first<string>("config");
    expect(config).not.toContain("flag{ok}");
    expect(
      JSON.stringify(await getPublicActivity(bindings, saved.id, author.id)),
    ).not.toContain("flag{ok}");

    // A draft may change its code, or stop being 代码判定.
    const changed = await updateActivity(bindings, saved.id, author.id, {
      version: saved.version,
      activity: coded({}, { code: `${JUDGE}// v2\n` }),
    });
    expect(changed.config.judge?.code).toContain("// v2");
    const { judge: _judge, ...rest } = coded();
    const fixed = await updateActivity(bindings, saved.id, author.id, {
      version: changed.version,
      activity: {
        ...rest,
        participationMode: "direct",
        forceDedicated: false,
        money: { mode: "fixed", totalAmount: "0.03", count: 3 },
      },
    });
    expect(fixed.config.judge).toBeUndefined();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM activity_code WHERE activity_id = ?",
      )
        .bind(saved.id)
        .first("n"),
    ).toBe(0);
  });

  it("checks the code online by the kit's rules, ten times a day", async () => {
    const passed = await check(author);
    expect(passed.status).toBe(200);
    expect(passed.body.check).toMatchObject({
      fingerprint: await sha256Hex(JUDGE),
      testsDigest: await sha256Hex(TESTS),
      passed: true,
      problems: [],
      unstable: [],
      remainingToday: 9,
    });
    expect(passed.body.check.tests.map((test) => test.passed)).toEqual([
      true,
      true,
    ]);

    const failing = await check(
      author,
      JUDGE,
      JSON.stringify([
        { name: "答对", input: "flag{ok}", expect: { ok: true, amount: 50 } },
      ]),
    );
    expect(failing.body.check.passed).toBe(false);
    expect(failing.body.check.tests[0]?.problem).toBe("应该发 50，实际发 30");

    const imports = await check(author, `import fs from "node:fs";\n${JUDGE}`);
    expect(imports.body.check).toMatchObject({
      passed: false,
      problems: [{ line: 1 }],
      tests: [],
    });
    const broken = await check(author, "export function judge( {");
    expect(broken.body.check.passed).toBe(false);
    expect(broken.body.check.loadProblem).toContain("代码加载不了");
    const badTests = await check(author, JUDGE, "[{}]");
    expect(badTests.body.check.testsProblem).toContain("第 1 条测试");

    const random = await check(
      author,
      `export function judge() {
  return { ok: false, message: String(crypto.getRandomValues(new Uint32Array(1))[0]) };
}`,
      JSON.stringify([{ name: "随便", input: "x", expect: { ok: false } }]),
    );
    expect(random.body.check.unstable).toEqual(["随便"]);

    await settings({ code_check_daily_limit: 6 });
    const used = await check(author);
    expect(used.status).toBe(429);
    expect(used.body.error?.code).toBe("JUDGE_CHECK_LIMIT");
    const stranger = await actor();
    expect((await check(stranger)).status).toBe(403);
  });

  it("opens only with code and tests that passed, sealing a seed and locking the pool", async () => {
    const saved = await draft();
    expect(saved.openingBlockedReason).toBe("JUDGE_CHECK_REQUIRED");
    await rejects(
      openActivity(bindings, saved.id, author.id, saved.version),
      "JUDGE_CHECK_REQUIRED",
    );
    // A pass for other tests is not a pass for these.
    await check(
      author,
      JUDGE,
      JSON.stringify([{ name: "答错", input: "x", expect: { ok: false } }]),
    );
    expect(
      (await getManagedActivity(bindings, saved.id, author.id))
        .openingBlockedReason,
    ).toBe("JUDGE_CHECK_REQUIRED");
    await check(author);
    expect(
      (await getManagedActivity(bindings, saved.id, author.id))
        .openingBlockedReason,
    ).toBeUndefined();

    const opened = await openActivity(
      bindings,
      saved.id,
      author.id,
      saved.version,
    );
    expect(opened.status).toBe("active");
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 400,
      lockedMinor: 100,
    });
    const row = await findJudgeRow(bindings, saved.id);
    if (!row) throw new Error("No code row");
    const seed = await readSeed(bindings, row);
    expect(row.seedCommitment).toBe(seedCommitment(saved.id, seed));
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM reward_inventory WHERE activity_id = ?",
      )
        .bind(saved.id)
        .first("n"),
    ).toBe(0);

    // From now on the code, tests and prompt stay as they were.
    await rejects(
      updateActivity(bindings, saved.id, author.id, {
        version: opened.version,
        activity: coded({}, { code: `${JUDGE}// v2\n` }),
      }),
      "INVALID_ACTIVITY",
    );
    const edited = await updateActivity(bindings, saved.id, author.id, {
      version: opened.version,
      activity: { ...opened.config, title: "改个标题" },
    });
    expect(edited.title).toBe("改个标题");
    await expect(
      env.DB.prepare(
        "UPDATE activity_code SET prompt = '换个提示' WHERE activity_id = ?",
      )
        .bind(saved.id)
        .run(),
    ).rejects.toThrow(/immutable_activity_code/);
  });

  it("opens as many a day as 网站设置 says", async () => {
    await settings({ code_hongbao_daily_limit: 1 });
    await check(author);
    const first = await draft();
    await openActivity(bindings, first.id, author.id, first.version);
    const second = await draft();
    expect(second.openingBlockedReason).toBe("CODE_HONGBAO_DAILY_LIMIT");
    await rejects(
      openActivity(bindings, second.id, author.id, second.version),
      "CODE_HONGBAO_DAILY_LIMIT",
    );
  });

  it("holds its rules in the database too", async () => {
    await check(author);
    const saved = await draft();
    const opened = await openActivity(
      bindings,
      saved.id,
      author.id,
      saved.version,
    );
    // No 口令, and a share only as judged, within its range.
    await expect(
      env.DB.prepare(
        "INSERT INTO activity_passwords (id, activity_id, digest, ciphertext, position, created_at) VALUES (?, ?, 'd', 'c', 0, 0)",
      )
        .bind(crypto.randomUUID(), opened.id)
        .run(),
    ).rejects.toThrow(/direct_activity_has_no_passwords/);
    for (const amount of [0, 99, 100])
      await expect(
        env.DB.prepare(
          "INSERT INTO reward_inventory (id, activity_id, position, kind, amount_minor, created_at) VALUES (?, ?, 0, 'ldc', ?, 0)",
        )
          .bind(crypto.randomUUID(), opened.id, amount)
          .run(),
      ).rejects.toThrow();
    // 1.00 in 3 shares of at least 0.01: the first may take up to 0.98.
    await env.DB.prepare(
      "INSERT INTO reward_inventory (id, activity_id, position, kind, amount_minor, created_at) VALUES (?, ?, 0, 'ldc', 98, 0)",
    )
      .bind(crypto.randomUUID(), opened.id)
      .run();
    await expect(
      env.DB.prepare(
        "UPDATE reward_inventory SET amount_minor = 1 WHERE activity_id = ?",
      )
        .bind(opened.id)
        .run(),
    ).rejects.toThrow(/immutable_code_share/);
  });
});
