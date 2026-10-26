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

const notice =
  "不是红包站的网页，它能看到你的 IP 和浏览器信息。不要在里面付款、转账或做任何交易；发现违规推广，请联系站长 @lafish。";

const frameHeight = (page: Page) =>
  page
    .locator(".app-window-frame")
    .evaluate((element) => Math.round(element.getBoundingClientRect().height));

/** The sheet's top edge on the screen. */
const sheetTop = (page: Page) =>
  page
    // Not by its role: under a dialog the sheet is inert.
    .locator("button[aria-label^='上拉查看附带网页']")
    .evaluate((bar) => Math.round(bar.getBoundingClientRect().top));

test.describe("附带网页", () => {
  test("宽屏：分享下面的“附带网页”打开右边的网页窗口，打开才加载，再点收起、还在", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, viewer);
    const loads = await mock(page);
    await openApp(page, path);
    const toggle = page.locator("#page-button");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    // Under 分享, not beside it (the author's name runs there).
    const share = await page.locator("#share-button").boundingBox();
    const below = await toggle.boundingBox();
    expect(below?.y ?? 0).toBeGreaterThan(
      (share?.y ?? 0) + (share?.height ?? 0),
    );
    expect(await frameWidth(page)).toBeCloseTo(1200, 0);
    // Only looking at the 红包: its page knows nothing yet.
    expect(loads).toEqual([]);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // The 红包 window narrows beside it; the page loads, nothing asked,
    // the title bar saying whose it is and what it sees.
    await expect.poll(() => frameWidth(page)).toBeCloseTo(460, 0);
    await expect(page.getByText(notice)).toBeVisible();
    await expect(page.getByRole("separator")).toBeVisible();
    // Whose 红包 it comes from; the 站长 to tell, at his LINUX DO page.
    await expect(page.getByRole("link", { name: "@lafish" })).toHaveAttribute(
      "href",
      "https://linux.do/u/lafish",
    );
    // As tall as the 红包 window's 顶栏, in line with it.
    const bar = await page.locator("header.window-bar").boundingBox();
    const title = await page
      .getByText("来自 @xiaoman 的红包")
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
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(frame).toHaveCount(1);
    await toggle.click();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(460, 0);
    expect(loads).toEqual([pageUrl]);
    // The same button closes it.
    await toggle.click();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(1200, 0);
  });

  test("宽屏：这个浏览器记住开着的网页窗口，下次进来照样开着；关了就不再开", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, viewer);
    const loads = await mock(page);
    await openApp(page, path);
    await page.locator("#page-button").click();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(460, 0);
    await page.reload();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(460, 0);
    await expect(page.locator("#page-button")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect.poll(() => loads.length).toBe(2);
    // Closed, it stays closed next time, and nothing is loaded.
    await page.locator("#page-button").click();
    await expect.poll(() => frameWidth(page)).toBeCloseTo(1200, 0);
    await page.reload();
    await expect(page.locator("#page-button")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(await frameWidth(page)).toBeCloseTo(1200, 0);
    expect(loads.length).toBe(2);
  });

  test("宽屏：两扇窗合起来最宽 1680", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1000 });
    await mockSession(page, viewer);
    await mock(page);
    await openApp(page, path);
    await page.locator("#page-button").click();
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
    // The cover's tag (the button under 分享 has the same name).
    await page.locator("button.hb-chip-red", { hasText: "附带网页" }).click();
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
    await page.locator("#page-button").click();
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

  test("没有附带网页的红包：没有按钮、标签，说明里只有文字", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSession(page, viewer);
    await mock(page, false);
    await openApp(page, path);
    await expect(page.getByRole("heading", { name: "谜题红包" })).toBeVisible();
    await expect(page.locator("#share-button")).toBeVisible();
    await expect(page.locator("#page-button")).toHaveCount(0);
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
    // The button under 分享 pulls it up too.
    await page.locator("#page-button").click();
    await expect(page.getByText(notice)).toBeVisible();
  });

  test("手机：弹窗打开时抽屉让到屏幕下面，红包窗口铺到底、压暗盖满；关上弹窗抽屉回来", async ({
    page,
  }) => {
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
    // The 红包 window ends above the sheet.
    await expect.poll(() => frameHeight(page)).toBeLessThan(844);
    await page.getByRole("button", { name: "分享" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Below the screen; the window, and its 压暗层, reach the bottom: one
    // 压暗层 over everything, none of the sheet's own.
    await expect.poll(() => sheetTop(page)).toBeGreaterThan(844);
    await expect.poll(() => frameHeight(page)).toBe(844);
    const scrim = await page
      .locator("[data-window-layer] .scrim")
      .last()
      .boundingBox();
    expect((scrim?.y ?? 0) + (scrim?.height ?? 0)).toBeCloseTo(844, 0);
    await page.mouse.click(195, 40);
    await expect(dialog).toHaveCount(0);
    // Back: the sheet where it was, the window above it again.
    await expect.poll(() => sheetTop(page)).toBe(resting);
    await expect.poll(() => frameHeight(page)).toBeLessThan(844);
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
