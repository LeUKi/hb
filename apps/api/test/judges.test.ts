import { env } from "cloudflare:test";
import type { JudgeInput, JudgeVersions, MyJudgeDetail } from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createActivity,
  getManagedActivity,
  openActivity,
  updateActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import {
  getMyJudge,
  listMyJudges,
  migrateJudgesOf,
  myJudgeVersion,
  updateMyJudge,
} from "../src/judge/judges";
import { findJudgeRow, judgeData, textDigest } from "../src/judge/storage";
import { encryptString } from "../src/security/crypto";
import {
  type Actor,
  actor,
  bindings,
  check,
  coded,
  give,
  JUDGE,
  judgeSettings,
  origin,
  plus,
  rejects,
  settings,
  TESTS,
  unique,
} from "./code-fixtures";

// 判定器 (docs/judge-square-design.md §1, §14): deploys go into one of its
// author's 判定器, each new code its next version; a draft names its
// 判定器 and keeps its params; 红包 from before move over as their sender
// reads them, or a few at a time in maintenance.

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1 });
  await judgeSettings({ enabled: 1, daily_deploy_limit: 20 });
  await plus(author);
  await give(admin, author, "5.00");
});

const OTHER_TESTS = JSON.stringify({
  tests: [{ name: "答错", input: "x", expect: { ok: false, message: "不对" } }],
});

function request(path: string, user: Actor, method = "GET", body?: unknown) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        Cookie: user.cookie,
        ...(method !== "GET"
          ? {
              Origin: origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": user.csrf,
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}

describe("判定器: deploying into one", () => {
  it("makes one by its first deploy, numbers each new code, and keeps a rerun on its version", async () => {
    const first = unique();
    const made = await check(author, first, TESTS, {
      name: "  猜数字 ",
      description: "猜中的领",
    });
    expect(made.status).toBe(200);
    expect(made.body.check).toMatchObject({
      passed: true,
      judge: { name: "猜数字", description: "猜中的领", version: 1 },
    });
    const id = made.body.check.judge?.id ?? "";
    const second = await check(author, unique(), TESTS, { id });
    expect(second.body.check.judge).toMatchObject({ id, version: 2 });
    // The first code again, other tests: the same version, its last run.
    const rerun = await check(author, first, OTHER_TESTS, { id });
    expect(rerun.body.check).toMatchObject({
      kind: "rerun",
      judge: { version: 1 },
    });
    const versions = rerun.body.check.judge?.versions as JudgeVersions;
    expect(versions.next).toBe(3);
    expect(versions.versions.map((version) => version.n)).toEqual([1, 2]);
    expect(versions.versions[0]?.testsDigest).toBe(
      await textDigest(OTHER_TESTS),
    );
    // 换回 puts back the newest that passed.
    expect(versions.restore?.n).toBe(2);
    expect(await myJudgeVersion(bindings, author.id, id, 1)).toMatchObject({
      code: first,
      tests: OTHER_TESTS,
      versions: { next: 3 },
      declarations: { params: [] },
    });
  });

  it("asks a new one for a name, and keeps no one else's", async () => {
    const issue = (answer: Awaited<ReturnType<typeof check>>) =>
      (answer.body.error as { issues?: { message: string }[] } | undefined)
        ?.issues?.[0]?.message;
    const nameless = await check(author, unique(), TESTS, { name: "  " });
    expect(nameless.status).toBe(400);
    expect(issue(nameless)).toBe("先给判定器起个名字");
    const long = await check(author, unique(), TESTS, {
      name: "一二三四五六七八九十一二三四五六七八九十一",
    });
    expect(issue(long)).toBe("名字最多 20 个字");
    const mine = await check(author, unique(), TESTS, { name: "我的" });
    const stranger = await actor();
    await plus(stranger);
    const theirs = await check(stranger, unique(), TESTS, {
      id: mine.body.check.judge?.id ?? "",
    });
    expect(theirs.status).toBe(404);
    expect(theirs.body.error?.message).toBe("未找到判定器");
    // Without one named, a run is kept nowhere (a page from before).
    const loose = await check(author, unique(), TESTS);
    expect(loose.body.check.judge).toBeUndefined();
  });

  it("keeps what a v3 code declares on its version", async () => {
    const code = `export const meta = { name: "猜数字" };
export const params = [{ key: "answer", label: "答案", type: "text", secret: true }];
export const hongbao = { count: { min: 1, max: 5 } };
${JUDGE}// ${crypto.randomUUID()}`;
    const tests = JSON.stringify({
      params: { answer: "flag{ok}" },
      tests: [{ name: "答错", input: "x", expect: { ok: false } }],
    });
    const made = await check(author, code, tests, { name: "猜" });
    expect(made.body.check.passed).toBe(true);
    const detail = await getMyJudge(
      bindings,
      author.id,
      made.body.check.judge?.id ?? "",
    );
    expect(detail.versions[0]?.declarations).toEqual({
      meta: { name: "猜数字" },
      params: [{ key: "answer", label: "答案", type: "text", secret: true }],
      hongbao: { count: { min: 1, max: 5 } },
      check: false,
      setup: false,
    });
    expect(detail.usable).toMatchObject({ n: 1 });
  });
});

describe("判定器: a draft names one", () => {
  it("keeps its 判定器, the version its code is, its name as typed and its params", async () => {
    const code = unique();
    const made = await check(author, code, TESTS, { name: "猜数字" });
    const id = made.body.check.judge?.id ?? "";
    const judge: Partial<JudgeInput> = {
      code,
      judgeId: id,
      name: "猜数字二",
      description: "改了名字",
      params: { answer: 42 },
    };
    const saved = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: coded({}, judge),
    });
    expect((await findJudgeRow(env, saved.id))?.judgeVersion).toBe(1);
    const read = (await getManagedActivity(env, saved.id, author.id)).config
      .judge;
    expect(read).toMatchObject({
      judgeId: id,
      name: "猜数字二",
      description: "改了名字",
      params: { answer: 42 },
      versions: { next: 2, versions: [{ n: 1, passed: true }] },
    });
    // Code not deployed there: no version.
    const edited = await updateActivity(bindings, saved.id, author.id, {
      version: saved.version,
      activity: coded({}, { ...judge, code: unique() }),
    });
    expect((await findJudgeRow(env, edited.id))?.judgeVersion).toBeNull();
    const stranger = await actor();
    await plus(stranger);
    await give(admin, stranger, "5.00");
    await rejects(
      createActivity(bindings, stranger.id, {
        requestId: crypto.randomUUID(),
        activity: coded({}, { judgeId: id }),
      }),
      "JUDGE_NOT_FOUND",
    );
  });

  it("fixes its 判定器 and params once open", async () => {
    const code = unique();
    const made = await check(author, code, TESTS, { name: "猜数字" });
    const judge = {
      code,
      judgeId: made.body.check.judge?.id ?? "",
      params: { answer: 42 },
    };
    const saved = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: coded({}, judge),
    });
    const opened = await openActivity(
      bindings,
      saved.id,
      author.id,
      saved.version,
    );
    await expect(
      updateActivity(bindings, saved.id, author.id, {
        version: opened.version,
        activity: coded({}, { ...judge, params: { answer: 7 } }),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      env.DB.prepare(
        "UPDATE activity_code SET judge_version = NULL WHERE activity_id = ?",
      )
        .bind(saved.id)
        .run(),
    ).rejects.toThrow("immutable_activity_code");
  });
});

describe("判定器: 我的判定器", () => {
  it("lists the newest first, with the 红包 opened and the version to use", async () => {
    const older = await check(author, unique(), TESTS, { name: "旧的" });
    const code = unique();
    const newer = await check(author, code, TESTS, {
      name: "新的",
      description: "一句话",
    });
    const id = newer.body.check.judge?.id ?? "";
    const saved = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: coded({}, { code, judgeId: id }),
    });
    await openActivity(bindings, saved.id, author.id, saved.version);
    const listed = await listMyJudges(bindings, author.id);
    expect(listed.map((judge) => judge.name)).toEqual(["新的", "旧的"]);
    expect(listed[0]).toMatchObject({
      description: "一句话",
      codePublic: "ended",
      latest: { n: 1, passed: true },
      usable: { n: 1, declarations: { params: [] }, network: null },
      opened: 1,
    });
    expect(listed[1]?.id).toBe(older.body.check.judge?.id);
    const answer = await request("/api/me/judges", author);
    expect(((await answer.json()) as { items: unknown[] }).items).toHaveLength(
      2,
    );
    expect(
      (await getMyJudge(bindings, author.id, id)).versions[0]?.opened,
    ).toBe(1);
  });

  it("changes its name and line, and makes its code public for good", async () => {
    const made = await check(author, unique(), TESTS, { name: "猜数字" });
    const id = made.body.check.judge?.id ?? "";
    const put = await request(`/api/me/judges/${id}`, author, "PUT", {
      name: "猜大小",
      description: "大了小了",
      codePublic: "always",
    });
    expect(put.status).toBe(200);
    expect(
      ((await put.json()) as { judge: MyJudgeDetail }).judge,
    ).toMatchObject({
      name: "猜大小",
      description: "大了小了",
      codePublic: "always",
    });
    await rejects(
      updateMyJudge(bindings, author.id, id, {
        name: "猜大小",
        description: "",
        codePublic: "ended",
      }),
      "JUDGE_CODE_PUBLIC",
    );
    const stranger = await actor();
    expect((await request(`/api/me/judges/${id}`, stranger)).status).toBe(404);
  });
});

describe("判定器: 红包 from before (§14.3)", () => {
  /** A draft saved the old way: its versions kept with it. */
  async function legacyDraft() {
    const first = unique();
    const second = unique();
    await check(author, first);
    await check(author, second, OTHER_TESTS);
    const [one, two] = await Promise.all([
      textDigest(first),
      textDigest(second),
    ]);
    const at = new Date().toISOString();
    const digest = await textDigest(TESTS);
    const versions: JudgeVersions = {
      next: 3,
      versions: [
        {
          n: 1,
          fingerprint: one,
          at,
          testsDigest: digest,
          passed: true,
          protocol: 3,
        },
        {
          n: 2,
          fingerprint: two,
          at,
          testsDigest: await textDigest(OTHER_TESTS),
          passed: true,
          protocol: 3,
        },
      ],
      restore: { n: 1, code: first },
    };
    const saved = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: {
        ...coded({}, { code: second, versions }),
        title: "老红包的名字很长很长很长很长很长很长",
      },
    });
    return { saved, first, second, versions };
  }

  it("moves a draft over as its sender reads it: the versions it kept the code of", async () => {
    // Saved the old way, it is read back at once, and moved then.
    const { saved, first, second } = await legacyDraft();
    const read = await getManagedActivity(env, saved.id, author.id);
    expect(read.config.judge).toMatchObject({
      name: "老红包的名字很长很长很长很长很长很长",
      versions: { next: 3, versions: [{ n: 1 }, { n: 2 }] },
    });
    const row = await findJudgeRow(env, saved.id);
    expect(row).toMatchObject({ judgeVersion: 2 });
    expect(
      await env.DB.prepare(
        "SELECT versions_ciphertext AS versions FROM activity_code WHERE activity_id = ?",
      )
        .bind(saved.id)
        .first("versions"),
    ).toBeNull();
    const id = row?.judgeId ?? "";
    // Each with the draft's tests now: passed if that run did.
    const detail = await getMyJudge(bindings, author.id, id);
    expect(detail.versions.map(({ n, passed }) => ({ n, passed }))).toEqual([
      { n: 2, passed: false },
      { n: 1, passed: true },
    ]);
    expect((await myJudgeVersion(bindings, author.id, id, 1)).code).toBe(first);
    expect((await myJudgeVersion(bindings, author.id, id, 2)).code).toBe(
      second,
    );
    // Once is enough.
    expect(await migrateJudgesOf(bindings, { activityId: saved.id })).toEqual({
      moved: 0,
      left: 0,
    });
  });

  it("moves the rest over in maintenance, and an opened one with the version it opened with", async () => {
    const { saved, versions } = await legacyDraft();
    // Not read since it was saved: as a 红包 from before the release.
    await env.DB.prepare(
      "UPDATE activity_code SET judge_id = NULL, judge_version = NULL, versions_ciphertext = ? WHERE activity_id = ?",
    )
      .bind(
        await encryptString(
          JSON.stringify(versions),
          env,
          judgeData(saved.id, "versions"),
        ),
        saved.id,
      )
      .run();
    const { moved } = await migrateJudgesOf(bindings);
    expect(moved).toBeGreaterThanOrEqual(1);
    expect((await findJudgeRow(env, saved.id))?.judgeVersion).toBe(2);
    // Opened without one (a page from before): it gets one with its version.
    const code = unique();
    await check(author, code);
    const plain = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: coded({}, { code }),
    });
    await openActivity(bindings, plain.id, author.id, plain.version);
    const row = await findJudgeRow(env, plain.id);
    expect(row?.judgeVersion).toBe(1);
    expect(
      await getMyJudge(bindings, author.id, row?.judgeId ?? ""),
    ).toMatchObject({
      name: "代码判定 · 3 份",
      opened: 1,
      versions: [{ n: 1, passed: true, opened: 1 }],
    });
  });
});

describe("判定器: check and 试一试 (§3, §6)", () => {
  const GUESS = `export const params = [
  { key: "max", label: "最大", type: "integer", min: 2, default: 100 },
  { key: "answer", label: "答案", type: "integer", secret: true },
];
export function check(params, hongbao) {
  return params.answer > params.max
    ? [{ key: "answer", message: \`答案不能大于 \${params.max}\` }]
    : [];
}
export function judge(submission, tools) {
  if (Number(submission.input) !== submission.params.answer)
    return { ok: false, message: "不对" };
  return { ok: true, amount: tools.money.even(), message: \`对了，\${submission.hongbao.count} 份\` };
}
`;
  const GUESS_TESTS = JSON.stringify({
    params: { answer: 7 },
    tests: [{ name: "猜中", input: "7", expect: { ok: true } }],
  });
  const hongbao = { title: "猜数字", total: 300, count: 3, minEach: 1 };

  async function deployed() {
    const code = `${GUESS}// ${crypto.randomUUID()}`;
    const made = await check(author, code, GUESS_TESTS, { name: "猜数字" });
    expect(made.body.check.passed).toBe(true);
    return `/api/me/judges/${made.body.check.judge?.id}/versions/1`;
  }

  it("holds params to the declarations, then to check(), item by item", async () => {
    const base = await deployed();
    const post = async (params: Record<string, unknown>) =>
      (await (
        await request(`${base}/check`, author, "POST", { params, hongbao })
      ).json()) as unknown;
    expect(await post({ max: 1 })).toEqual({
      problems: [
        { key: "max", message: "最大最小是 2" },
        { key: "answer", message: "请填写答案" },
      ],
    });
    expect(await post({ max: 10, answer: 20 })).toEqual({
      problems: [{ key: "answer", message: "答案不能大于 10" }],
    });
    expect(await post({ answer: 20 })).toEqual({ problems: [] });
  });

  it("judges one made-up submission with the params, no money and no record", async () => {
    const base = await deployed();
    const tried = async (input: string) =>
      (await (
        await request(`${base}/try`, author, "POST", {
          params: { answer: 7 },
          hongbao,
          input,
        })
      ).json()) as unknown;
    // Protocol 5: what it added for the one trying, and whether it settled.
    expect(await tried("7")).toEqual({
      judged: true,
      added: 100,
      settled: true,
      message: "对了，3 份",
    });
    expect(await tried("8")).toEqual({
      judged: true,
      added: 0,
      settled: false,
      message: "不对",
    });
    const missing = await request(`${base}/try`, author, "POST", {
      params: {},
      hongbao,
      input: "7",
    });
    expect(missing.status).toBe(400);
    expect(
      ((await missing.json()) as { error: { message: string } }).error.message,
    ).toBe("请填写答案");
    // Counted as runs, and in 用量.
    const usage = await env.DB.prepare(
      "SELECT COUNT(*) AS tries FROM judge_tries WHERE user_id = ?",
    )
      .bind(author.id)
      .first<number>("tries");
    expect(usage).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM code_judgments c JOIN activities a ON a.id = c.activity_id WHERE a.author_id = ?",
      )
        .bind(author.id)
        .first<number>("n"),
    ).toBe(0);
  });

  it("stops at the runs a day nobody is shown", async () => {
    const base = await deployed();
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 49 }, () =>
        env.DB.prepare(
          "INSERT INTO judge_tries (id, user_id, kind, created_at) VALUES (?, ?, 'try', ?)",
        ).bind(crypto.randomUUID(), author.id, now),
      ),
    );
    const refused = await request(`${base}/try`, author, "POST", {
      params: { answer: 7 },
      hongbao,
      input: "7",
    });
    expect(refused.status).toBe(429);
    expect(
      ((await refused.json()) as { error: { message: string } }).error.message,
    ).toBe("今天试得太多了，明天再来。");
  });
});
