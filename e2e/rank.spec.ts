import { expect, type Page, test } from "@playwright/test";
import type { RankEntry, RankMe, RankPage } from "../packages/contracts/src";
import { csrfToken, mockSession, openApp, shown, viewer } from "./support/app";

// 排行榜 (07 §15) against a mocked API: anyone can look, 匿名 says nobody,
// the switches reach the server, and one's own row is held at the bottom
// until one's place is reached.

function entry(
  position: number,
  name: string | null,
  amount: string,
  me = false,
): RankEntry {
  return {
    position,
    rank: position + 1,
    person: name
      ? { username: `user${position}`, displayName: name, avatarUrl: null }
      : null,
    me,
    amount,
    activities: 3,
    claims: 12,
  };
}

function rankPage(items: RankEntry[], extra: Partial<RankPage> = {}): RankPage {
  return {
    board: "sent",
    range: "week",
    computedAt: Date.now() - 60_000,
    total: items.length,
    items,
    nextCursor: null,
    me: null,
    ...extra,
  };
}

/** Answers /api/rank; records each query it got. */
async function answerRank(page: Page, body: (url: URL) => RankPage) {
  const seen: URLSearchParams[] = [];
  await page.route(
    (url) => url.pathname === "/api/rank",
    (route) => {
      const url = new URL(route.request().url());
      seen.push(url.searchParams);
      return route.fulfill({ json: body(url) });
    },
  );
  return seen;
}

test.describe("排行榜", () => {
  test("游客：领奖台和列表，匿名不说是谁，页签和时间范围写进地址", async ({
    page,
  }) => {
    await mockSession(page, null);
    const queries = await answerRank(page, (url) =>
      rankPage(
        url.searchParams.get("board") === "received"
          ? [
              entry(0, null, "315.34"),
              entry(1, "秋刀鱼", "285.24"),
              entry(2, null, "281.93"),
              entry(3, null, "234.01"),
            ]
          : [
              entry(0, "阿青", "1846.17"),
              entry(1, "老周", "614.60"),
              entry(2, "南风", "509.00"),
              entry(3, "木木", "374.06"),
              entry(4, null, "293.61"),
            ],
      ),
    );
    await openApp(page, "/rank");
    await expect(
      page.getByRole("heading", { level: 1, name: "排行榜" }),
    ).toBeVisible();
    await expect(page.getByText("你的排名")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "阿青" })).toBeVisible();
    await expect(shown(page, "第 1 名")).toBeVisible();
    await expect(shown(page, "3 个红包")).toHaveCount(3);
    await expect(shown(page, "3 个红包 · 12 人次")).toHaveCount(2);
    await expect(shown(page, "匿名")).toHaveCount(1);

    await page.getByRole("button", { name: "领到" }).click();
    await expect(page).toHaveURL(/\/rank\?board=received$/);
    await expect(shown(page, "匿名")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "秋刀鱼" })).toBeVisible();
    await expect(shown(page, "领了 3 个红包")).toHaveCount(4);

    await page.getByRole("button", { name: "全部" }).click();
    await expect(page).toHaveURL(/board=received&range=all$/);
    // Each choice read once (the dev build mounts twice, reading again).
    await expect
      .poll(() => [...new Set(queries.map((query) => query.toString()))])
      .toEqual([
        "board=sent&range=week",
        "board=received&range=week",
        "board=received&range=all",
      ]);
  });

  test("登录后：你的排名和开关，你那一行贴在底部直到滚到你的位置", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const me: RankMe = {
      rank: 26,
      position: 25,
      amount: "12.00",
      activities: 2,
      claims: 5,
      visible: true,
    };
    const people = Array.from({ length: 30 }, (_, position) =>
      entry(
        position,
        position === 25 ? null : `第${position + 1}位`,
        (100 - position).toFixed(2),
        position === 25,
      ),
    );
    await answerRank(page, (url) => {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      return rankPage(people.slice(start, start + 20), {
        total: 30,
        nextCursor: start === 0 ? "20" : null,
        me,
      });
    });
    const saves: { body: unknown; csrf: string | null }[] = [];
    await page.route("**/api/me/rank-visibility", (route) => {
      saves.push({
        body: route.request().postDataJSON(),
        csrf: route.request().headers()["x-csrf-token"] ?? null,
      });
      return route.fulfill({ json: { sent: false, received: false } });
    });
    await openApp(page, "/rank");
    await expect(shown(page, "第 26 名")).toBeVisible();
    // Not loaded yet: one's row is held at the bottom of the window.
    await expect(shown(page, "你")).toHaveCount(1);
    await expect(shown(page, "大家看得到你")).toHaveCount(2);

    await page.getByRole("switch", { name: "在发出榜上显示我" }).click();
    await expect(shown(page, "别人看到匿名")).toHaveCount(2);
    await expect(
      shown(page, "别人看到的是“匿名”，名次和金额照常。"),
    ).toBeVisible();
    expect(saves).toEqual([
      { body: { board: "sent", visible: false }, csrf: csrfToken },
    ]);

    // Down to one's place: the held row goes, the list's own stays.
    const scroller = page.locator(".view-scroll").first();
    const toBottom = () =>
      scroller.evaluate((element) =>
        element.scrollTo({ top: element.scrollHeight }),
      );
    await toBottom();
    await expect(page.getByText("第30位", { exact: true })).toBeVisible();
    // No total at the end (the user's call): only that it is all here.
    await expect(shown(page, "已全部加载")).toBeVisible();
    await toBottom();
    await expect(page.locator(".sticky")).toHaveCount(0);
    await expect(shown(page, "你")).toHaveCount(1);
    // Back up past the first rows: held at the bottom again.
    await scroller.evaluate((element) => element.scrollTo({ top: 0 }));
    await expect(page.locator(".sticky")).toHaveCount(1);
  });

  test("只列前 100 名：名次在 100 以外的人，你那一行停在列表末尾", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const people = Array.from({ length: 100 }, (_, position) =>
      entry(position, `第${position + 1}位`, (200 - position).toFixed(2)),
    );
    await answerRank(page, (url) => {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      return rankPage(people.slice(start, start + 20), {
        total: 130,
        nextCursor: start + 20 < 100 ? String(start + 20) : null,
        me: {
          rank: 126,
          position: 125,
          amount: "1.00",
          activities: 1,
          claims: 1,
          visible: false,
        },
      });
    });
    await openApp(page, "/rank");
    await expect(shown(page, "第 126 名")).toBeVisible();
    await expect(page.locator(".sticky")).toHaveCount(1);
    const scroller = page.locator(".view-scroll").first();
    for (let batch = 0; batch < 6; batch++)
      await scroller.evaluate((element) =>
        element.scrollTo({ top: element.scrollHeight }),
      );
    await expect(shown(page, "只列前 100 名")).toBeVisible();
    await expect(page.getByText("第100位", { exact: true })).toBeVisible();
    // Still there at the end: one's place is past the list.
    await expect(page.locator(".sticky")).toHaveCount(1);
    await expect(shown(page, "你")).toHaveCount(1);
  });

  test("没人上榜：近 7 天提示换到全部", async ({ page }) => {
    await mockSession(page, null);
    await answerRank(page, () => rankPage([]));
    await openApp(page, "/rank");
    await expect(shown(page, "近 7 天还没有人上榜")).toBeVisible();
    await expect(shown(page, "换到“全部”看看。")).toBeVisible();
  });
});
