import { expect, type Page, test } from "@playwright/test";
import type {
  RoadmapDetail,
  RoadmapItem,
  RoadmapList,
  RoadmapSummary,
} from "../packages/contracts/src";
import { type MockUser, mockSession, openApp, viewer } from "./support/app";

// 施工中 (docs/roadmap-design.md): 正在施工 in gold, 已完成 and 不做的 folded,
// 功能请求 with votes, asking for one, one's own changed or taken back, and
// the 站长's moves in 网站管理.

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();
const person = (username: string) => ({
  username,
  displayName: username,
  avatarUrl: null,
});

function item(over: Partial<RoadmapItem> & { id: string; title: string }) {
  return {
    status: "request",
    detail: "",
    author: person("xiaoming"),
    byOwner: false,
    votes: 0,
    voted: false,
    mine: false,
    createdAt: daysAgo(3),
    startedAt: null,
    doneAt: null,
    reason: null,
    note: null,
    ...over,
  } satisfies RoadmapItem;
}

const BUILDING = "11111111-1111-4111-8111-111111111111";
const DONE = "22222222-2222-4222-8222-222222222222";
const HOT = "33333333-3333-4333-8333-333333333333";
const MINE = "44444444-4444-4444-8444-444444444444";
const DECLINED = "55555555-5555-4555-8555-555555555555";

const owner: MockUser = { ...viewer, isAdmin: true };

async function mockRoadmap(page: Page, user: MockUser | null) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const state = {
    building: item({
      id: BUILDING,
      status: "building",
      title: "判定记录",
      detail: "按时间线看每一次提交和判定器的判定。",
      votes: 27,
      startedAt: daysAgo(3),
      note: { text: "在写按人的列表", at: daysAgo(0.1) },
    }),
    hot: item({
      id: HOT,
      title: "深色模式",
      detail: "晚上打开太亮了。",
      votes: 19,
      author: person("xiaogang"),
    }),
    mine: item({
      id: MINE,
      title: "红包记录能按金额排序",
      votes: 1,
      voted: true,
      mine: true,
      createdAt: daysAgo(1),
    }),
    voteFails: false,
  };
  const done = item({
    id: DONE,
    status: "done",
    title: "定时开放",
    detail: "草稿定好时间，到点自己开放。",
    votes: 33,
    doneAt: daysAgo(1),
  });
  const declined = item({
    id: DECLINED,
    status: "declined",
    title: "红包能换封面",
    reason: "先不做图片上传",
    votes: 4,
  });
  await mockSession(page, user);
  await page.route("**/api/roadmap**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method !== "GET")
      sent.push({
        method,
        path,
        body: request.postData() ? request.postDataJSON() : null,
      });
    if (path === "/api/roadmap")
      return route.fulfill({
        json: {
          building: [state.building],
          counts: { request: 2, done: 1, declined: 1 },
        } satisfies RoadmapSummary,
      });
    if (path === "/api/roadmap/similar")
      return route.fulfill({
        json: {
          items: (url.searchParams.get("q") ?? "").includes("深色")
            ? [state.hot]
            : [],
          nextCursor: null,
        } satisfies RoadmapList,
      });
    if (path === "/api/roadmap/items" && method === "POST")
      return route.fulfill({
        status: 201,
        json: {
          item: item({
            id: "66666666-6666-4666-8666-666666666666",
            title: "导出领取记录",
            votes: 1,
            voted: true,
            mine: true,
          }),
        },
      });
    if (path === "/api/roadmap/items") {
      const status = url.searchParams.get("status");
      const sort = url.searchParams.get("sort");
      const items =
        status === "done"
          ? [done]
          : status === "declined"
            ? [declined]
            : sort === "new"
              ? [state.mine, state.hot]
              : [state.hot, state.mine];
      return route.fulfill({
        json: { items, nextCursor: null } satisfies RoadmapList,
      });
    }
    if (path.endsWith("/vote")) {
      if (state.voteFails)
        return route.fulfill({ status: 500, json: { error: {} } });
      const { voted } = request.postDataJSON() as { voted: boolean };
      state.hot = {
        ...state.hot,
        voted,
        votes: state.hot.votes + (voted ? 1 : -1),
      };
      return route.fulfill({
        json: { votes: state.hot.votes, voted },
      });
    }
    if (path === `/api/roadmap/items/${MINE}` && method === "DELETE")
      return route.fulfill({ json: { ok: true } });
    const id = path.split("/").at(-1);
    const found = [state.building, state.hot, state.mine, done, declined].find(
      (each) => each.id === id,
    );
    if (found)
      return route.fulfill({
        json: {
          item: found,
          notes:
            found.id === BUILDING
              ? [
                  { text: "在写按人的列表", at: daysAgo(0.1) },
                  { text: "表加好了", at: daysAgo(1) },
                ]
              : [],
        } satisfies RoadmapDetail,
      });
    return route.fulfill({ status: 404, json: { error: {} } });
  });
  return { sent, state };
}

test.describe("施工中", () => {
  test("游客：正在施工的金色卡，已完成和不做的收起，功能请求按最热、最新；点赞先登录", async ({
    page,
  }) => {
    const { sent } = await mockRoadmap(page, null);
    await openApp(page, "/roadmap");
    await expect(page).toHaveTitle(/施工中/);
    await expect(
      page.getByText(
        "站长正在做的、做完了的，还有大家想要的。想要哪个，就给它点个赞。",
      ),
    ).toBeVisible();
    const building = page.locator("article").filter({ hasText: "判定记录" });
    await expect(building).toContainText("施工中");
    await expect(building).toContainText("“在写按人的列表”");
    await expect(building).toContainText("开工 3 天 · @xiaoming 提的");
    await expect(building).toHaveClass(/loading-sheen-gold/);
    // 已完成, folded until asked.
    const done = page.getByRole("button", { name: "已完成 1 件" });
    await expect(done).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("定时开放")).toHaveCount(0);
    await done.click();
    await expect(page.getByText("定时开放")).toBeVisible();
    // 功能请求: 最热 first, then 最新 in the address.
    const cards = page.locator("article").filter({ hasNotText: "施工中" });
    await expect(cards.first()).toContainText("深色模式");
    await page.getByRole("button", { name: "最新" }).click();
    await expect(page).toHaveURL(/[?&]sort=new/);
    await expect(cards.first()).toContainText("红包记录能按金额排序");
    await page.getByRole("button", { name: "不做的 1 件" }).click();
    await expect(page.getByText("不做：先不做图片上传")).toBeVisible();
    // A guest's 赞 asks to sign in, and sends nothing.
    await page.getByRole("button", { name: /^点赞，现在 19 个/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(sent).toEqual([]);
  });

  test("点赞：按下就变朱红、数字加一，再点取消；存不上弹回去并写没有点上", async ({
    page,
  }) => {
    const { sent, state } = await mockRoadmap(page, viewer);
    await openApp(page, "/roadmap");
    const vote = page.getByRole("button", { name: /^点赞，现在 19 个/ });
    await vote.click();
    const voted = page.getByRole("button", { name: /^点赞，现在 20 个/ });
    await expect(voted).toHaveAttribute("aria-pressed", "true");
    expect(sent.at(-1)).toEqual({
      method: "PUT",
      path: `/api/roadmap/items/${HOT}/vote`,
      body: { voted: true },
    });
    state.voteFails = true;
    await voted.click();
    await expect(page.getByText("没有点上，再试一次。")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^点赞，现在 20 个/ }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("提一个需求：打字时列出像的，提交后切到最新；自己的打开能改、能删掉", async ({
    page,
  }) => {
    const { sent } = await mockRoadmap(page, viewer);
    await openApp(page, "/roadmap");
    await page.getByRole("button", { name: "提一个需求" }).first().click();
    const dialog = page.getByRole("dialog", { name: "提一个需求" });
    await dialog.getByLabel("想要什么").fill("深色模式");
    await expect(dialog.getByText("可能已经有人提了")).toBeVisible();
    await expect(dialog.getByText("一样的话，给它点个赞就行。")).toBeVisible();
    await dialog.getByLabel("想要什么").fill("导出领取记录");
    await dialog.getByLabel("说明").fill("想做表格");
    await dialog.getByRole("button", { name: "提交" }).click();
    await expect(dialog).toBeHidden();
    expect(sent.at(-1)).toEqual({
      method: "POST",
      path: "/api/roadmap/items",
      body: { title: "导出领取记录", detail: "想做表格" },
    });
    await expect(page).toHaveURL(/[?&]sort=new/);
    // One's own, opened from the address: 改 and 删掉.
    await openApp(page, `/roadmap?item=${MINE}`);
    const opened = page.getByRole("dialog", { name: "红包记录能按金额排序" });
    await expect(opened).toBeVisible();
    await opened.getByRole("button", { name: "删掉" }).click();
    const confirm = page.getByRole("dialog", { name: "删掉这个需求？" });
    await expect(confirm).toContainText("它和大家给它的赞一起删掉。");
    await confirm.getByRole("button", { name: "删掉" }).click();
    await expect(confirm).toBeHidden();
    expect(sent.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/api/roadmap/items/${MINE}`,
    });
  });

  test("施工中的一件打开：进展一句一行，新的在上", async ({ page }) => {
    await mockRoadmap(page, viewer);
    await openApp(page, "/roadmap");
    await page.getByRole("button", { name: "判定记录" }).click();
    const dialog = page.getByRole("dialog", { name: "判定记录" });
    await expect(page).toHaveURL(new RegExp(`[?&]item=${BUILDING}`));
    const notes = dialog.locator("li");
    await expect(notes).toHaveCount(2);
    await expect(notes.first()).toContainText("在写按人的列表");
  });

  test("网站管理 · 施工：开工直接改，不做要写原因，新建放进施工中", async ({
    page,
  }) => {
    await mockSession(page, owner);
    const acts: unknown[] = [];
    let counts = { request: 1, building: 0, done: 0, declined: 0 };
    await page.route("**/api/admin/roadmap**", (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        acts.push({
          path: new URL(request.url()).pathname,
          body: request.postDataJSON(),
        });
        counts = { ...counts, request: 0, building: 1 };
        return route.fulfill({
          json: { item: item({ id: HOT, title: "深色模式" }) },
        });
      }
      const status = new URL(request.url()).searchParams.get("status");
      return route.fulfill({
        json: {
          items:
            status === "request" && counts.request > 0
              ? [item({ id: HOT, title: "深色模式", votes: 19, hidden: false })]
              : [],
          nextCursor: null,
          counts,
        },
      });
    });
    await page.route("**/api/roadmap**", (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await openApp(page, "/admin/roadmap");
    await expect(
      page.getByText(
        "施工页上的每一件：开工、写进展、完成、不做、合并。改了马上生效。",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: /深色模式/ }).click();
    await page.getByRole("button", { name: "不做", exact: true }).click();
    const decline = page.getByRole("dialog", { name: "不做「深色模式」？" });
    await decline.getByLabel("原因").fill("先把亮色做好");
    await decline.getByRole("button", { name: "不做" }).click();
    await expect(decline).toBeHidden();
    expect(acts.at(-1)).toEqual({
      path: `/api/admin/roadmap/items/${HOT}`,
      body: { action: "decline", reason: "先把亮色做好" },
    });
    await page.getByRole("button", { name: "新建" }).click();
    const create = page.getByRole("dialog", { name: "新建" });
    await create.getByLabel("标题").fill("施工页");
    await create.getByRole("button", { name: "新建" }).click();
    await expect(create).toBeHidden();
    expect(acts.at(-1)).toEqual({
      path: "/api/admin/roadmap/items",
      body: { title: "施工页", detail: "", status: "building" },
    });
  });

  test("首页的常用命令有施工中", async ({ page }) => {
    await mockSession(page, null);
    await openApp(page, "/");
    await expect(page.getByRole("link", { name: /施工中/ })).toBeVisible();
  });
});
