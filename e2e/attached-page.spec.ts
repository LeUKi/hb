import { expect, type Page, test } from "@playwright/test";
import { encodeActivityEmoji } from "../packages/contracts/src";
import { mockSession, openApp, viewer } from "./support/app";

// 附带网页 (docs/attached-page-design.md §2): the page beside a 红包 on a
// wide screen and in a sheet on a narrow one, not loaded until asked, and
// kept loaded while hidden.

const id = "77777777-6666-4777-8888-999999999999";
const path = `/🧧/${encodeActivityEmoji(id)}`;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const pageUrl = "https://puzzle.example.com/today";

function activity(page?: { url: string; host: string }) {
  return {
    id,
    title: "谜题红包",
    rewardType: "ldc",
    participationMode: "direct",
    status: "active",
    author: {
      id: "author-e2e",
      username: "xiaoman",
      displayName: "小满",
      avatarUrl: null,
    },
    forceDedicated: false,
    topicUrl: null,
    openedAt: iso(now - 600_000),
    deadlineAt: iso(now + 3_600_000),
    quantity: { mode: "exact", total: 5, claimed: 1, remaining: 4 },
    reward: {
      mode: "fixed",
      totalAmount: "0.50",
      unitAmount: "0.10",
      count: 5,
    },
    beforeInfo: "",
    paymentMode: "simulation",
    rosterPreview: [],
    ...(page ? { page } : {}),
  };
}

/** The 红包 (with its page or not), and the page itself, counted. */
/** Who the page was told sent it (the Referer of each load). */
let referrers: (string | undefined)[] = [];

async function mock(page: Page, attached = true) {
  const loads: string[] = [];
  referrers = [];
  await page.route(`**/api/activities/${id}**`, (route) => {
    const rest = new URL(route.request().url()).pathname.slice(
      `/api/activities/${id}`.length,
    );
    if (rest === "")
      return route.fulfill({
        json: {
          activity: activity(
            attached ? { url: pageUrl, host: "puzzle.example.com" } : undefined,
          ),
        },
      });
    if (rest.startsWith("/participation") || rest === "/claim")
      return route.fulfill({ json: { claim: null, registration: null } });
    if (rest === "/passwords")
      return route.fulfill({
        json: { passwords: [], hiddenCount: 0, canSolve: false },
      });
    return route.fulfill({
      json: {
        items: [],
        nextCursor: null,
        titles: { highestClaimIds: [], lowestClaimIds: [] },
      },
    });
  });
  await page.route("https://puzzle.example.com/**", (route) => {
    loads.push(route.request().url());
    referrers.push(route.request().headers().referer);
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><title>谜题</title><h1>今日第 3 题</h1>",
    });
  });
  return loads;
}

const frameWidth = (page: Page) =>
  page
    .locator(".app-window-frame")
    .evaluate((element) => element.getBoundingClientRect().width);

test.describe("附带网页", () => {
  test("宽屏：边缘标签打开右边的网页窗口，点了才加载，隐藏后还在", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, viewer);
    const loads = await mock(page);
    await openApp(page, path);
    const tab = page.getByRole("button", {
      name: "打开 puzzle.example.com 的网页",
    });
    await expect(tab).toBeVisible();
    expect(await frameWidth(page)).toBeCloseTo(1200, 0);
    await tab.click();
    // The 红包 window narrows beside it, and nothing is loaded yet.
    await expect.poll(() => frameWidth(page)).toBeCloseTo(460, 0);
    await expect(
      page.getByText("发红包的人提供的网页 · 不是本站"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "这是发红包的人提供的网页，不是本站的。加载以后，对方能看到你的 IP 地址和浏览器信息。",
      ),
    ).toBeVisible();
    expect(loads).toEqual([]);
    await expect(page.getByRole("separator")).toBeVisible();

    await page.getByRole("button", { name: "加载网页" }).click();
    const frame = page.locator("iframe[title='puzzle.example.com 的网页']");
    await expect(frame).toHaveAttribute("src", pageUrl);
    await expect(frame).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-orientation-lock allow-presentation allow-storage-access-by-user-activation",
    );
    // Never the page away; never the camera, the microphone, the place.
    await expect(frame).not.toHaveAttribute("sandbox", /allow-top-navigation/);
    await expect(frame).not.toHaveAttribute(
      "allow",
      /camera|microphone|geolocation|payment/,
    );
    await expect(frame).toHaveAttribute(
      "allow",
      /fullscreen; clipboard-write; .*storage-access/,
    );
    // It is told which 红包 page it is on.
    await expect(frame).toHaveAttribute(
      "referrerpolicy",
      "no-referrer-when-downgrade",
    );
    await expect(
      page
        .frameLocator("iframe[title='puzzle.example.com 的网页']")
        .getByText("今日第 3 题"),
    ).toBeVisible();
    expect(loads).toEqual([pageUrl]);
    expect(decodeURI(referrers[0] ?? "")).toContain(path);

    // Hidden, it stays loaded: back again, the same page, not read again.
    await page.getByRole("button", { name: "隐藏（不会卸载）" }).click();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(1200, 0);
    await expect(frame).toHaveCount(1);
    await tab.click();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(460, 0);
    expect(loads).toEqual([pageUrl]);
  });

  test("宽屏：两扇窗合起来最宽 1680", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1000 });
    await mockSession(page, viewer);
    await mock(page);
    await openApp(page, path);
    await page
      .getByRole("button", { name: "打开 puzzle.example.com 的网页" })
      .click();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(460, 0);
    // From the 红包 window's left edge to the page window's right one.
    const both = () =>
      page.evaluate(() => {
        const main = document.querySelector(".app-window-frame");
        const side = main?.nextElementSibling;
        if (!main || !side) return 0;
        return (
          side.getBoundingClientRect().right - main.getBoundingClientRect().left
        );
      });
    await expect.poll(both).toBeCloseTo(1680, 0);
  });

  test("没有附带网页的红包：没有边缘标签", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, viewer);
    await mock(page, false);
    await openApp(page, path);
    await expect(page.getByRole("heading", { name: "谜题红包" })).toBeVisible();
    await expect(page.getByRole("button", { name: /的网页$/ })).toHaveCount(0);
  });

  test("手机：底部抽屉拉起、加载、收起", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSession(page, viewer);
    const loads = await mock(page);
    await openApp(page, path);
    const pull = page.getByRole("button", { name: "拉起" });
    await expect(pull).toBeVisible();
    await pull.click();
    await page.getByRole("button", { name: "加载网页" }).click();
    await expect(
      page
        .frameLocator("iframe[title='puzzle.example.com 的网页']")
        .getByText("今日第 3 题"),
    ).toBeVisible();
    await page.getByRole("button", { name: "收起" }).click();
    await expect(page.getByRole("button", { name: "拉起" })).toBeVisible();
    expect(loads).toEqual([pageUrl]);
  });
});
