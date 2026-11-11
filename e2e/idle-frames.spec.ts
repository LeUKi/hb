import { expect, type Page, test } from "@playwright/test";
import { encodeActivityEmoji } from "../packages/contracts/src";
import { mockSession, openApp, viewer } from "./support/app";

// 闲着不画 (docs/redesign/09-idle-frames.md): a 红包 page left open, with
// its 附带网页 beside it, draws nothing once nobody is here. Every frame
// drawn under a window's glass blurs the whole window again, so a loop
// that never ends keeps the GPU busy (and the fans on). Loading looks (the
// skeleton's sheen, 开 while it waits) are allowed; nothing else may loop,
// and the page may change at most a few times a second (a clock ticking).

const id = "88888888-6666-4777-8888-999999999999";
const path = `/🧧/${encodeActivityEmoji(id)}`;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const LOADING = new Set(["skeleton-sheen", "hb-seal-sheen-fast"]);

async function mock(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("hb.page-sites", JSON.stringify(["game.example.com"])),
  );
  await page.route(`**/api/activities/${id}**`, (route) => {
    const rest = new URL(route.request().url()).pathname.slice(
      `/api/activities/${id}`.length,
    );
    if (rest === "")
      return route.fulfill({
        json: {
          activity: {
            id,
            title: "闲着不画",
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
            beforeInfo: "旁边是一个小游戏。",
            paymentMode: "simulation",
            rosterPreview: [],
            page: {
              url: "https://game.example.com/",
              host: "game.example.com",
              autoOpen: true,
            },
          },
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
  await page.route("https://game.example.com/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><title>游戏</title><h1>小游戏</h1>",
    }),
  );
}

/** Loops running now, other than the loading looks. */
const loops = (page: Page) =>
  page.evaluate(
    (loading) =>
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getTiming().iterations === Infinity &&
            !loading.includes((animation as CSSAnimation).animationName ?? ""),
        )
        .map((animation) => (animation as CSSAnimation).animationName ?? "?"),
    [...LOADING],
  );

/** How many times a second the page changes (MutationObserver batches), over `ms`. */
const changesPerSecond = (page: Page, ms: number) =>
  page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        let batches = 0;
        const observer = new MutationObserver(() => {
          batches += 1;
        });
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        setTimeout(() => {
          observer.disconnect();
          resolve((batches * 1000) / ms);
        }, ms);
      }),
    ms,
  );

test("闲着的红包页（旁边开着附带网页）不画：8 秒没人动以后没有一直循环的动画，每秒最多变几次；一动又醒", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockSession(page, viewer);
  await mock(page);
  await openApp(page, path);
  await expect(page.locator(".hb-seal").first()).toBeVisible();
  await expect(page.locator("iframe")).toBeAttached();
  // Awake at first: 开's sheen sweeps.
  expect(
    await page.evaluate(() =>
      document.documentElement.hasAttribute("data-awake"),
    ),
  ).toBe(true);
  // Nobody here for longer than AWAKE_MS (8 s).
  await page.waitForTimeout(9_500);
  expect(
    await page.evaluate(() =>
      document.documentElement.hasAttribute("data-awake"),
    ),
  ).toBe(false);
  expect(await loops(page)).toEqual([]);
  expect(await changesPerSecond(page, 3_000)).toBeLessThanOrEqual(5);
  // Someone moves the pointer: awake again, the sheen sweeps again.
  await page.mouse.move(200, 300);
  await page.mouse.move(240, 320);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.hasAttribute("data-awake")),
    )
    .toBe(true);
  await expect.poll(() => loops(page)).toContain("hb-seal-sheen");
});
