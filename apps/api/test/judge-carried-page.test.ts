import type { JudgePage, SquareJudgeList } from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { refreshJudgeStats, setMyJudgeListing } from "../src/judge/square";
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
} from "./code-fixtures";

// 判定器带的附带网页 (docs/judge-page-design.md §4, §11.9): judge.js's
// meta.page, kept with its version; anyone may give a 代码判定红包 the
// page its 判定器 carries, others' pages stay PLUS's; the 广场 and the
// 判定器页 say so while the switch is on.

const page = "https://game.example.com/play";

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1, page_enabled: 1 });
  await judgeSettings({
    enabled: 1,
    daily_deploy_limit: 20,
    daily_open_limit: 20,
  });
  await plus(author);
  await give(admin, author, "20.00");
});

/** judge.js with a meta of its own, unique to this test. */
const withMeta = (meta: string) =>
  `export const meta = ${meta};\n${JUDGE}// ${crypto.randomUUID()}\n`;

/** The author's 判定器 carrying `page`, in the 广场, one 红包 opened with it. */
async function shared() {
  const code = withMeta(
    `{ name: "猜数字", page: "https://Game.Example.com/play" }`,
  );
  const deployed = await check(author, code, TESTS, { name: "猜数字" });
  expect(deployed.body.check.passed).toBe(true);
  const id = deployed.body.check.judge?.id ?? "";
  await setMyJudgeListing(bindings, author.id, id, {
    listed: true,
    featurable: true,
  });
  const draft = await createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: coded({}, { code, tests: TESTS, judgeId: id }),
  });
  await openActivity(bindings, draft.id, author.id, draft.version);
  await refreshJudgeStats(bindings);
  return { id, code };
}

async function sender() {
  const person = await actor();
  await give(admin, person, "5.00");
  return person;
}

const borrowed = (judgeId: string) =>
  coded({}, { judgeId, version: 1, code: "// 不用这份", tests: "" });

async function get<T>(path: string) {
  const response = await app.request(`${origin}/api${path}`, {}, bindings);
  return (await response.json()) as T;
}

describe("判定器带的附带网页", () => {
  it("keeps meta.page with the version, as the URL standard writes it, and refuses one outside the rules", async () => {
    const judge = await shared();
    const detail = await get<{ judge: JudgePage }>(`/judges/${judge.id}`);
    expect(detail.judge.version?.declarations?.meta).toEqual({
      name: "猜数字",
      page,
    });
    const wrong = await check(
      author,
      withMeta(`{ name: "猜数字", page: "http://game.example.com" }`),
      TESTS,
      { name: "另一个" },
    );
    expect(wrong.body.check.passed).toBe(false);
    expect(JSON.stringify(wrong.body.check)).toContain(
      "meta.page：只能用 https:// 开头的地址",
    );
  });

  it("lets anyone keep, change or drop the page its 判定器 carries (pages are everyone's since 2026-10-30)", async () => {
    const judge = await shared();
    const someone = await sender();
    const kept = await createActivity(bindings, someone.id, {
      requestId: crypto.randomUUID(),
      activity: { ...borrowed(judge.id), pageUrl: page },
    });
    expect(kept.config.pageUrl).toBe(page);
    const changed = await createActivity(bindings, someone.id, {
      requestId: crypto.randomUUID(),
      activity: { ...borrowed(judge.id), pageUrl: "https://example.com/" },
    });
    expect(changed.config.pageUrl).toBe("https://example.com/");
    // While the switch is off, none is newly set, not even this one.
    await settings({ page_enabled: 0 });
    await rejects(
      createActivity(bindings, someone.id, {
        requestId: crypto.randomUUID(),
        activity: { ...borrowed(judge.id), pageUrl: page },
      }),
      "PAGE_PAUSED",
    );
  });

  it("shows on the 广场's card and the 判定器页 while the switch is on", async () => {
    const judge = await shared();
    const card = async () =>
      (await get<SquareJudgeList>("/judges?tab=all")).items.find(
        (item) => item.id === judge.id,
      );
    expect((await card())?.page).toBe(page);
    expect(
      (await get<{ judge: JudgePage }>(`/judges/${judge.id}`)).judge.page,
    ).toBe(page);
    await settings({ page_enabled: 0 });
    expect(await card()).not.toHaveProperty("page");
    expect(
      (await get<{ judge: JudgePage }>(`/judges/${judge.id}`)).judge,
    ).not.toHaveProperty("page");
  });
});
