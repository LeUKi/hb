import { env } from "cloudflare:test";
import type {
  JudgePage,
  JudgeStats,
  MyJudgeDetail,
  SquareJudgeList,
} from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { getMyJudge } from "../src/judge/judges";
import {
  judgePage,
  refreshJudgeStats,
  setMyJudgeListing,
} from "../src/judge/square";
import { stopCodeActivity } from "../src/judge/stop";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import {
  type Actor,
  actor,
  bindings,
  check,
  coded,
  give,
  judgeSettings,
  origin,
  plus,
  settings,
  TESTS,
  unique,
} from "./code-fixtures";

// 判定器广场 (docs/judge-square-design.md §8, §15): joining it, its numbers,
// 大家做的 and 站长精选, and who sees a 判定器's page.

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1 });
  await judgeSettings({
    enabled: 1,
    daily_deploy_limit: 20,
    daily_open_limit: 20,
  });
  await plus(author);
  await give(admin, author, "20.00");
});

/** A 判定器 of the author's, deployed once (第 1 版). */
async function made(name = "猜数字") {
  const code = unique();
  const deployed = await check(author, code, TESTS, { name });
  expect(deployed.body.check.passed).toBe(true);
  return { id: deployed.body.check.judge?.id ?? "", code };
}

/** A 红包 opened with it, by its author. */
async function opened(judge: { id: string; code: string }) {
  const draft = await createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: coded({}, { code: judge.code, tests: TESTS, judgeId: judge.id }),
  });
  return openActivity(bindings, draft.id, author.id, draft.version);
}

async function get<T>(path: string, user?: Actor) {
  const response = await app.request(
    `${origin}/api${path}`,
    user ? { headers: { Cookie: user.cookie } } : {},
    bindings,
  );
  return { status: response.status, body: (await response.json()) as T };
}

const listed = (id: string) =>
  setMyJudgeListing(bindings, author.id, id, {
    listed: true,
    featurable: true,
  });

describe("判定器广场", () => {
  it("joins with its code public for good; 大家做的 lists it once a version opened a 红包, with what its 红包 did", async () => {
    const judge = await made();
    await listed(judge.id);
    const mine: MyJudgeDetail = await getMyJudge(bindings, author.id, judge.id);
    expect(mine).toMatchObject({
      listed: true,
      featurable: true,
      codePublic: "always",
      publicN: null,
      stats: { hongbao: 0, judged: 0, claimed: 0 },
    });
    await refreshJudgeStats(bindings);
    let all = await get<SquareJudgeList>("/judges?tab=all");
    expect(all.body.items.map((item) => item.id)).not.toContain(judge.id);
    const hongbao = await opened(judge);
    for (const input of ["x", "flag{ok}"]) {
      const user = await actor();
      await claimActivity(bindings, hongbao.id, user.id, {
        submissionId: crypto.randomUUID(),
        participationMode: "code",
        input,
      });
      await advanceAttemptCooldown(env.DB, user.id);
    }
    await refreshJudgeStats(bindings);
    all = await get<SquareJudgeList>("/judges?tab=all");
    const card = all.body.items.find((item) => item.id === judge.id);
    expect(card).toMatchObject({
      name: "猜数字",
      featured: false,
      network: false,
      basedOn: null,
      stats: { hongbao: 1, judged: 2, claimed: 1 } satisfies JudgeStats,
    });
    expect((await getMyJudge(bindings, author.id, judge.id)).publicN).toBe(1);
    // Out of it, it goes; its code stays public.
    await setMyJudgeListing(bindings, author.id, judge.id, {
      listed: false,
      featurable: false,
    });
    all = await get<SquareJudgeList>("/judges?tab=all");
    expect(all.body.items.map((item) => item.id)).not.toContain(judge.id);
    expect(await getMyJudge(bindings, author.id, judge.id)).toMatchObject({
      listed: false,
      featurable: false,
      codePublic: "always",
    });
  });

  it("opens its page to anyone while it is in the 广场 — its code, the versions that opened — and out of it to its author and the 站长 only", async () => {
    const judge = await made();
    // 第 2 版, deployed and never opened: others never see it.
    await check(author, unique(), TESTS, { id: judge.id });
    await opened(judge);
    const other = await actor();
    expect((await get(`/judges/${judge.id}`, other)).status).toBe(404);
    await listed(judge.id);
    const page = await get<{ judge: JudgePage }>(`/judges/${judge.id}`);
    expect(page.status).toBe(200);
    expect(page.body.judge).toMatchObject({
      own: false,
      listed: true,
      codePublic: "always",
      version: { n: 1, code: judge.code, network: null },
      versions: [{ n: 1, opened: 1 }],
    });
    expect(page.body.judge.takenDown).toBeUndefined();
    expect((await get(`/judges/${judge.id}/versions/2`)).status).toBe(404);
    expect(
      (await get<{ code: string }>(`/judges/${judge.id}/versions/1`)).body.code,
    ).toBe(judge.code);
    expect(
      (await get<{ judge: JudgePage }>(`/judges/${judge.id}`, author)).body
        .judge.own,
    ).toBe(true);
    // 撤下 (§15.3): out for everyone but its author and the 站长.
    await env.DB.prepare(
      "UPDATE judges SET listed_at = NULL, taken_down_at = ?, taken_down_reason = '抄袭', taken_down_by = ? WHERE id = ?",
    )
      .bind(Date.now(), admin.id, judge.id)
      .run();
    expect((await get(`/judges/${judge.id}`, other)).status).toBe(404);
    expect(
      (await judgePage(bindings, judge.id, { id: admin.id, isAdmin: true }))
        .takenDown,
    ).toEqual({ at: expect.any(String), reason: "抄袭" });
    await expect(listed(judge.id)).rejects.toMatchObject({
      code: "JUDGE_TAKEN_DOWN",
      message: "这个判定器已被站长撤下，不能再加入。",
    });
    expect((await getMyJudge(bindings, author.id, judge.id)).takenDown).toEqual(
      { at: expect.any(String), reason: "抄袭" },
    );
  });

  it("lists 站长精选 in the 站长's order, and leaves out any that goes online while 联网 is off", async () => {
    const first = await made("第一个");
    const second = await made("第二个");
    for (const judge of [first, second]) await listed(judge.id);
    const feature = (id: string, position: number) =>
      env.DB.prepare(
        "INSERT INTO judge_features (judge_id, n, position, created_by, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)",
      )
        .bind(id, position, admin.id, Date.now(), Date.now())
        .run();
    await feature(second.id, 0);
    await feature(first.id, 1);
    const featured = await get<SquareJudgeList>("/judges");
    expect(
      featured.body.items
        .filter((item) => [first.id, second.id].includes(item.id))
        .map((item) => [item.name, item.featured]),
    ).toEqual([
      ["第二个", true],
      ["第一个", true],
    ]);
    // Its page offers the 精选 version, opened or not.
    expect(
      (await get<{ judge: JudgePage }>(`/judges/${first.id}`)).body.judge
        .version?.n,
    ).toBe(1);
    await env.DB.prepare(
      "UPDATE judge_versions SET network = '[\"https://api.example.com/\"]', protocol = 3 WHERE judge_id = ?",
    )
      .bind(first.id)
      .run();
    await judgeSettings({ network_enabled: 0 });
    expect(
      (await get<SquareJudgeList>("/judges")).body.items.map((item) => item.id),
    ).not.toContain(first.id);
  });

  it("orders 大家做的 by the latest opening, or by 红包 sent (用得最多); a 红包 the 站长 stopped counts for nothing", async () => {
    const busy = await made("常用");
    const recent = await made("最近");
    for (const judge of [busy, recent]) await listed(judge.id);
    await opened(busy);
    const stopped = await opened(busy);
    await opened(recent);
    await refreshJudgeStats(bindings);
    const order = async (sort: string) =>
      (await get<SquareJudgeList>(`/judges?tab=all&sort=${sort}`)).body.items
        .filter((item) => [busy.id, recent.id].includes(item.id))
        .map((item) => [item.name, item.stats.hongbao]);
    expect(await order("recent")).toEqual([
      ["最近", 1],
      ["常用", 2],
    ]);
    expect(await order("used")).toEqual([
      ["常用", 2],
      ["最近", 1],
    ]);
    await stopCodeActivity(bindings, stopped.id, admin.id);
    await refreshJudgeStats(bindings);
    // As many now: the latest opening first.
    expect(await order("used")).toEqual([
      ["最近", 1],
      ["常用", 1],
    ]);
  });

  it("is in it only with its code public and not taken down (the database's own rule)", async () => {
    const judge = await made();
    await expect(
      env.DB.prepare("UPDATE judges SET listed_at = ? WHERE id = ?")
        .bind(Date.now(), judge.id)
        .run(),
    ).rejects.toThrow(/immutable_judge/);
    await expect(
      env.DB.prepare(
        "UPDATE judges SET taken_down_at = ?, taken_down_by = ? WHERE id = ?",
      )
        .bind(Date.now(), admin.id, judge.id)
        .run(),
    ).rejects.toThrow(/immutable_judge/);
  });

  it("copies one in the 广场 (复制一份来改): its source kept; one out of it is not found, and costs no deploy", async () => {
    const source = await made("原版");
    const copier = await actor();
    await plus(copier);
    const copy = (code: string) =>
      check(copier, code, TESTS, {
        name: "改版",
        basedOn: source.id,
      } as never);
    const refused = await copy(unique());
    expect(refused.status).toBe(404);
    expect(refused.body.error?.code).toBe("JUDGE_NOT_FOUND");
    // Turned away before it ran: no run, no deploy counted.
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS runs FROM judge_checks WHERE user_id = ?",
      )
        .bind(copier.id)
        .first<number>("runs"),
    ).toBe(0);
    await listed(source.id);
    const copied = await copy(unique());
    expect(copied.status).toBe(200);
    const id = copied.body.check.judge?.id ?? "";
    // Its 广场 page names the one it came from once it is in the 广场.
    await setMyJudgeListing(bindings, copier.id, id, {
      listed: true,
      featurable: true,
    });
    expect(
      (await get<{ judge: JudgePage }>(`/judges/${id}`)).body.judge.basedOn,
    ).toMatchObject({ id: source.id, listed: true });
  });
});
