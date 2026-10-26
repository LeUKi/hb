import { expect, type Page, test } from "@playwright/test";
import { encodeActivityEmoji } from "../packages/contracts/src";
import { mockSession, openApp, viewer } from "./support/app";

// 附带网页 (docs/attached-page-design.md §2): the page beside a 红包 on a
// wide screen and in a sheet on a narrow one, loaded once opened (not
// before), and kept loaded while hidden.

const id = "77777777-6666-4777-8888-999999999999";
const path = `/🧧/${encodeActivityEmoji(id)}`;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const pageUrl = "https://puzzle.example.com/today";

const note = "今天的题在旁边，[打开谜题](#附带网页)，答对就能领。";

function activity(page?: { url: string; host: string }, beforeInfo = note) {
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
    beforeInfo,
    paymentMode: "simulation",
    rosterPreview: [],
    ...(page ? { page } : {}),
  };
}

/** The 红包 (with its page or not), and the page itself, counted. */
/** Who the page was told sent it (the Referer of each load). */
let referrers: (string | undefined)[] = [];

async function mock(page: Page, attached = true, beforeInfo = note) {
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
            beforeInfo,
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

const notice = "不是本站的网页，它能看到你的 IP 和浏览器信息";

/** The sheet's top edge on the screen. */
const sheetTop = (page: Page) =>
  page
    // Not by its role: under a dialog the sheet is inert.
    .locator("button[aria-label^='上拉查看附带网页']")
    .evaluate((bar) => Math.round(bar.getBoundingClientRect().top));

test.describe("附带网页", () => {
  test("宽屏：边缘标签打开右边的网页窗口，打开才加载，隐藏后还在", async ({
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
    // Only looking at the 红包: its page knows nothing yet.
    expect(loads).toEqual([]);
    await tab.click();
    // The 红包 window narrows beside it; the page loads, nothing asked,
    // the title bar saying whose it is and what it sees.
    await expect.poll(() => frameWidth(page)).toBeCloseTo(460, 0);
    await expect(page.getByText(notice)).toBeVisible();
    await expect(page.getByRole("separator")).toBeVisible();
    // As tall as the 红包 window's 顶栏, in line with it.
    const bar = await page.locator("header.window-bar").boundingBox();
    const title = await page
      .getByText(notice)
      .locator("xpath=../..")
      .boundingBox();
    expect(title?.y).toBeCloseTo(bar?.y ?? 0, 0);
    expect(title?.height).toBeCloseTo(bar?.height ?? 0, 0);
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

  test("宽屏：红包皮上的“附带网页”和说明里的按钮都打开网页窗口", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, viewer);
    const loads = await mock(page);
    await openApp(page, path);
    await page.getByRole("button", { name: "附带网页", exact: true }).click();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(460, 0);
    await expect.poll(() => loads).toEqual([pageUrl]);
    await page.getByRole("button", { name: "隐藏（不会卸载）" }).click();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(1200, 0);
    // `[打开谜题](#附带网页)` in the 说明 is a button, not a link.
    await expect(page.getByRole("link", { name: "打开谜题" })).toHaveCount(0);
    await page.getByRole("button", { name: "打开谜题" }).click();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(460, 0);
  });

  test("宽屏：把手拖过头，松手关闭网页窗口；拖回来就不关", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, viewer);
    await mock(page);
    await openApp(page, path);
    await page
      .getByRole("button", { name: "打开 puzzle.example.com 的网页" })
      .click();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(460, 0);
    const handle = page.getByRole("separator");
    const box = await handle.boundingBox();
    if (!box) throw new Error("no handle");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const closing = page.getByText("松手关闭网页");
    // Past the end (1000 wide here) and 96 more: it would close…
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 700, y, { steps: 20 });
    await expect(closing).toBeVisible();
    await expect(page.getByText("往回拖可以取消")).toBeVisible();
    // …but back within it, it would not; let go there, it stays.
    await page.mouse.move(x + 560, y, { steps: 8 });
    await expect(closing).toBeHidden();
    await page.mouse.up();
    await expect(handle).toBeVisible();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(1000, 0);
    // Far past it, let go: the page window hides, the 红包 window whole.
    const again = await handle.boundingBox();
    if (!again) throw new Error("no handle");
    await page.mouse.move(again.x + again.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(again.x + 300, y, { steps: 12 });
    await expect(closing).toBeVisible();
    await page.mouse.up();
    await expect(handle).toHaveCount(0);
    await expect.poll(() => frameWidth(page)).toBeCloseTo(1200, 0);
  });

  test("没有附带网页的红包：没有边缘标签、标签，说明里只有文字", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, viewer);
    await mock(page, false);
    await openApp(page, path);
    await expect(page.getByRole("heading", { name: "谜题红包" })).toBeVisible();
    await expect(page.getByRole("button", { name: /的网页$/ })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "附带网页", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("打开谜题")).toBeVisible();
    await expect(page.getByRole("button", { name: "打开谜题" })).toHaveCount(0);
  });

  test("手机：点底部横栏拉满抽屉才加载，收起回到横栏", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSession(page, viewer);
    const loads = await mock(page);
    await openApp(page, path);
    const bar = page.getByRole("button", {
      name: "上拉查看附带网页：puzzle.example.com",
    });
    await expect(bar).toBeVisible();
    expect(loads).toEqual([]);
    await bar.click();
    await expect(page.getByText(notice)).toBeVisible();
    await expect(
      page
        .frameLocator("iframe[title='puzzle.example.com 的网页']")
        .getByText("今日第 3 题"),
    ).toBeVisible();
    await page.getByRole("button", { name: "收起" }).click();
    await expect(bar).toBeVisible();
    expect(loads).toEqual([pageUrl]);
  });

  test("手机：弹窗打开时抽屉也压暗、拖不动，点它关上弹窗", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // Still, so where it rests is where it is (no bounce, no nod).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockSession(page, viewer);
    await mock(page);
    await openApp(page, path);
    await expect(
      page.getByRole("button", { name: /^上拉查看附带网页/ }),
    ).toBeVisible();
    await expect.poll(() => sheetTop(page)).toBeGreaterThan(700);
    const resting = await sheetTop(page);
    await page.getByRole("button", { name: "分享" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Pulled from its bar, it does not move.
    await page.mouse.move(195, 830);
    await page.mouse.down();
    await page.mouse.move(195, 400, { steps: 10 });
    await page.mouse.up();
    expect(await sheetTop(page)).toBe(resting);
    // Its 压暗层 is the window's: a tap closes the dialog.
    await page.mouse.click(195, 830);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(notice)).toHaveCount(0);
  });

  test("手机：说明弹窗里的按钮先关上弹窗，再拉满抽屉", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSession(page, viewer);
    const loads = await mock(
      page,
      true,
      `${"规则写在这里，一行一行地往下写。\n\n".repeat(10)}[打开谜题](#附带网页)`,
    );
    await openApp(page, path);
    await page.getByRole("button", { name: "展开全文" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "打开谜题" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(notice)).toBeVisible();
    await expect.poll(() => loads).toEqual([pageUrl]);
  });
});
