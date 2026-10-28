import { env } from "cloudflare:test";
import type {
  AdminAuditEntry,
  AdminCursorList,
  AdminJudgeCuration,
  SquareJudgeList,
} from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { getMyJudge } from "../src/judge/judges";
import { setMyJudgeListing } from "../src/judge/square";
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

// The 站长's hand on the 判定器广场 (docs/judge-square-design.md §9,
// §15.4): 撤下 and 恢复, 精选 put in, moved, moved on a version and taken
// out — each in 操作记录.

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
  await plus(admin);
  await give(admin, author, "10.00");
});

async function call<T>(
  method: string,
  path: string,
  user: Actor,
  body?: unknown,
) {
  const response = await app.request(
    `${origin}/api${path}`,
    {
      method,
      headers: {
        Cookie: user.cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": user.csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { ...bindings, ADMIN_LINUX_DO_IDS: admin.externalId },
  );
  return {
    status: response.status,
    body: (await response.json()) as T & {
      error?: { code: string; message: string };
    },
  };
}

/** A 判定器 of `who`, in the 广场, its 第 1 版 opened once. */
async function shared(who: Actor, name: string, featurable = true) {
  const code = unique();
  const deployed = await check(who, code, TESTS, { name });
  const id = deployed.body.check.judge?.id ?? "";
  await setMyJudgeListing(bindings, who.id, id, { listed: true, featurable });
  const draft = await createActivity(bindings, who.id, {
    requestId: crypto.randomUUID(),
    activity: coded({}, { code, tests: TESTS, judgeId: id }),
  });
  await openActivity(bindings, draft.id, who.id, draft.version);
  return id;
}

const names = (list: AdminJudgeCuration) =>
  list.features.map((feature) => [feature.name, feature.n]);

describe("站长精选 and 撤下", () => {
  it("puts in what its author allows, in the 站长's order; moves, changes version, takes out; others are refused", async () => {
    const first = await shared(author, "第一个");
    const second = await shared(author, "第二个");
    const closed = await shared(author, "不让选", false);
    const unlisted = (await check(author, unique(), TESTS, { name: "没加入" }))
      .body.check.judge?.id;
    expect(
      (
        await call("POST", "/admin/judge/features", author, {
          judgeId: first,
          n: 1,
        })
      ).status,
    ).toBe(403);
    const refusals = await Promise.all([
      call("POST", "/admin/judge/features", admin, { judgeId: closed, n: 1 }),
      call("POST", "/admin/judge/features", admin, { judgeId: unlisted, n: 1 }),
      call("POST", "/admin/judge/features", admin, { judgeId: first, n: 9 }),
    ]);
    expect(refusals.map((refused) => refused.body.error?.message)).toEqual([
      "作者没有允许选入精选",
      "这个判定器不在判定器广场里",
      "这一版不能选入精选",
    ]);
    await call("POST", "/admin/judge/features", admin, {
      judgeId: first,
      n: 1,
    });
    const both = await call<AdminJudgeCuration>(
      "POST",
      "/admin/judge/features",
      admin,
      { judgeId: second, n: 1 },
    );
    expect(names(both.body)).toEqual([
      ["第一个", 1],
      ["第二个", 1],
    ]);
    expect(
      (
        await call("POST", "/admin/judge/features", admin, {
          judgeId: first,
          n: 1,
        })
      ).body.error?.message,
    ).toBe("已经在精选里了");
    const moved = await call<AdminJudgeCuration>(
      "PUT",
      `/admin/judge/features/${second}`,
      admin,
      { move: "up" },
    );
    expect(names(moved.body)).toEqual([
      ["第二个", 1],
      ["第一个", 1],
    ]);
    // 作者有第 2 版 once 第 2 版 opened a 红包; then 换成第 2 版.
    const code = unique();
    await check(author, code, TESTS, { id: first });
    const draft = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: coded({}, { code, tests: TESTS, judgeId: first }),
    });
    await openActivity(bindings, draft.id, author.id, draft.version);
    const listed = await call<AdminJudgeCuration>(
      "GET",
      "/admin/judge/curation",
      admin,
    );
    expect(
      listed.body.features.find((feature) => feature.judgeId === first)?.newer,
    ).toBe(2);
    const changed = await call<AdminJudgeCuration>(
      "PUT",
      `/admin/judge/features/${first}`,
      admin,
      { n: 2 },
    );
    expect(names(changed.body)).toEqual([
      ["第二个", 1],
      ["第一个", 2],
    ]);
    expect((await getMyJudge(bindings, author.id, first)).featured).toBe(2);
    const out = await call<AdminJudgeCuration>(
      "DELETE",
      `/admin/judge/features/${second}`,
      admin,
    );
    expect(names(out.body)).toEqual([["第一个", 2]]);
    const square = await call<SquareJudgeList>("GET", "/judges", author);
    expect(square.body.items.map((item) => item.name)).toEqual(["第一个"]);
  });

  it("takes one down with a reason its author reads, and restores it; both in 操作记录", async () => {
    const id = await shared(author, "猜数字");
    expect(
      (
        await call("POST", `/admin/judges/${id}/take-down`, admin, {
          reason: " ",
        })
      ).body.error?.code,
    ).toBe("INVALID_ACTIVITY");
    const down = await call("POST", `/admin/judges/${id}/take-down`, admin, {
      reason: "抄袭别人的判定器",
    });
    expect(down.status).toBe(200);
    expect(await getMyJudge(bindings, author.id, id)).toMatchObject({
      listed: false,
      takenDown: { reason: "抄袭别人的判定器" },
    });
    expect(
      (await call<AdminJudgeCuration>("GET", "/admin/judge/curation", admin))
        .body.takenDown,
    ).toMatchObject([
      { judgeId: id, name: "猜数字", reason: "抄袭别人的判定器" },
    ]);
    // Not again: it is out already.
    expect(
      (
        await call("POST", `/admin/judges/${id}/take-down`, admin, {
          reason: "再撤",
        })
      ).body.error?.message,
    ).toBe("这个判定器不在判定器广场里");
    await call("POST", `/admin/judges/${id}/restore`, admin);
    expect(await getMyJudge(bindings, author.id, id)).toMatchObject({
      listed: true,
      takenDown: null,
    });
    const audit = await call<AdminCursorList<AdminAuditEntry>>(
      "GET",
      "/admin/audit?type=judge_square",
      admin,
    );
    expect(
      audit.body.items
        .filter((entry) => entry.judge?.id === id)
        .map((entry) => [entry.judge?.action, entry.judge?.reason]),
    ).toEqual([
      ["restore", null],
      ["take_down", "抄袭别人的判定器"],
    ]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM judge_square_changes WHERE judge_id = ?",
      )
        .bind(id)
        .first<number>("n"),
    ).toBe(2);
  });
});
