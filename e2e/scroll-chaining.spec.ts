import { expect, type Locator, type Page, test } from "@playwright/test";

const user = {
  id: "scroll-user",
  username: "scrolluser",
  displayName: "滚动验收",
  avatarUrl: null,
};

const author = {
  id: "author-scroll",
  username: "author",
  displayName: "作者",
  avatarUrl: null,
};

function activity(id: string, index: number) {
  return {
    id,
    title: `滚动链路活动 ${index}`,
    rewardType: "ldc",
    status: "active",
    author,
    forceDedicated: false,
    topicUrl: null,
    openedAt: "2026-10-07T00:00:00.000Z",
    deadlineAt: "2026-10-08T00:00:00.000Z",
    quantity: {
      mode: "exact",
      total: 30,
      claimed: index % 12,
      remaining: 30 - (index % 12),
    },
    showRecipientList: false,
    showRecipientUsername: false,
    showRecipientTime: false,
    myClaim: null,
    myRegistration: null,
    reward: { mode: "fixed", unitAmount: "0.88", totalAmount: "26.40" },
  };
}

function paymentActivity(id: string, index: number) {
  return {
    ...activity(id, index),
    merchantId: "merchant-scroll",
    version: 1,
    createdAt: "2026-10-07T00:00:00.000Z",
    totalCount: 30,
    claimedCount: index % 12,
    paymentMode: "simulation",
  };
}

function paymentTarget(id: string, index: number) {
  return {
    id,
    mode: "simulation",
    status: index % 2 === 0 ? "confirmed" : "pending",
    reason: null,
    confirmedAt: index % 2 === 0 ? "2026-10-07T02:00:00.000Z" : null,
    amount: "0.88",
    businessNo: `business-${id}`,
    externalOrderId: null,
    createdAt: "2026-10-07T01:00:00.000Z",
    nextRunAt: "2026-10-07T01:05:00.000Z",
    source: "claim",
    claimId: `claim-${id}`,
    activityId: "payment-a-0",
    acceptanceId: null,
    recipientProfile: {
      id: `recipient-${index}`,
      username: `recipient${index}`,
      displayName: `收款人 ${index}`,
      avatarUrl: null,
    },
  };
}

function statistics() {
  return {
    totalAttempts: 48,
    uniqueUsers: 16,
    successfulClaims: 8,
    items: Array.from({ length: 20 }, (_, index) => ({
      password: `提交内容 ${index + 1}`,
      attempts: 3,
      uniqueUsers: 2,
      matchedAttempts: 1,
      unmatchedAttempts: 2,
      successfulClaims: index % 3 === 0 ? 1 : 0,
    })),
    validPasswords: Array.from({ length: 20 }, (_, index) => ({
      password: `有效口令 ${index + 1}`,
      successfulClaims: index + 1,
    })),
    nextCursor: null,
  };
}

async function installRoutes(page: Page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:5173") return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    if (url.pathname === "/api/discovery/activities")
      return route.fulfill({
        json: {
          total: 36,
          nextCursor: null,
          items: Array.from({ length: 36 }, (_, index) =>
            activity(`square-${index}`, index + 1),
          ),
        },
      });
    if (url.pathname === "/api/me/history-summary")
      return route.fulfill({
        json: { initiatedCount: 36, participatedCount: 0 },
      });
    if (url.pathname === "/api/me/merchants")
      return route.fulfill({
        json: {
          items: [],
          currentMerchantId: null,
          canCreate: false,
          canSimulate: true,
        },
      });
    if (url.pathname === "/api/me/activities")
      return route.fulfill({
        json: {
          total: 36,
          nextCursor: null,
          statusCounts: {
            all: 36,
            draft: 0,
            active: 36,
            ended: 0,
            archived: 0,
          },
          items: Array.from({ length: 36 }, (_, index) => ({
            ...paymentActivity(`author-${index}`, index + 1),
            forceDedicated: true,
            openedAt: "2026-10-07T00:00:00.000Z",
          })),
        },
      });
    if (url.pathname.match(/^\/api\/me\/activities\/[^/]+\/statistics$/))
      return route.fulfill({ json: statistics() });
    if (url.pathname.match(/^\/api\/me\/activities\/[^/]+$/))
      return route.fulfill({
        json: { activity: paymentActivity("payment-a-0", 1) },
      });
    if (url.pathname === "/api/me/payment-activities")
      return route.fulfill({
        json: {
          total: 24,
          nextCursor: null,
          items: Array.from({ length: 24 }, (_, index) =>
            paymentActivity(`payment-a-${index}`, index + 1),
          ),
        },
      });
    if (url.pathname.match(/^\/api\/me\/activities\/[^/]+\/payments$/))
      return route.fulfill({
        json: {
          activityId: "payment-a-0",
          merchantId: "merchant-scroll",
          total: 24,
          summary: {
            pendingAmount: "10.56",
            confirmedAmount: "10.56",
            totalAmount: "21.12",
            pendingCount: 12,
            confirmedCount: 12,
            totalCount: 24,
          },
          nextCursor: null,
          items: Array.from({ length: 24 }, (_, index) =>
            paymentTarget(`payment-${index}`, index + 1),
          ),
        },
      });
    return route.fulfill({ json: {} });
  });
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return {
    x: (box?.x ?? 0) + (box?.width ?? 0) / 2,
    y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
  };
}

async function scrollTop(locator: Locator) {
  return locator.evaluate((element) => element.scrollTop);
}

async function setScrollTop(locator: Locator, value: number | "max") {
  await locator.evaluate((element, next) => {
    element.scrollTop = next === "max" ? element.scrollHeight : next;
  }, value);
}

async function expectScrollable(locator: Locator) {
  await expect
    .poll(() =>
      locator.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 2,
      ),
    )
    .toBe(true);
}

async function createScrollStress(page: Page) {
  await page.addStyleTag({
    content: `
      .scroll-chain-test-spacer { min-height: 900px; }
      .scroll-chain-test-panel .list-panel__scroll { max-height: 220px; }
    `,
  });
  await page
    .locator(".list-panel")
    .first()
    .evaluate((element) => {
      element.classList.add("scroll-chain-test-panel");
    });
  await page.locator(".site-main").evaluate((element) => {
    if (element.querySelector(".scroll-chain-test-spacer")) return;
    const spacer = document.createElement("div");
    spacer.className = "scroll-chain-test-spacer";
    spacer.setAttribute("aria-hidden", "true");
    element.append(spacer);
  });
}

async function waitAnimationFrames(page: Page, count = 2) {
  await page.evaluate(
    (frames) =>
      new Promise<void>((resolve) => {
        const step = (remaining: number) => {
          if (remaining <= 0) {
            resolve();
            return;
          }
          requestAnimationFrame(() => step(remaining - 1));
        };
        step(frames);
      }),
    count,
  );
}

async function overscroll(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      x: style.overscrollBehaviorX,
      y: style.overscrollBehaviorY,
    };
  });
}

test("普通列表滚到边界后继续滚动会链到主内容", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRoutes(page);
  await page.goto("/my/activities");
  await expect(page.getByRole("heading", { name: "活动历史" })).toBeVisible();
  await createScrollStress(page);

  const main = page.locator(".site-main");
  const records = page.locator(".list-panel__scroll").first();
  await expectScrollable(records);
  await expectScrollable(main);
  await setScrollTop(main, 0);
  const directPoint = await center(
    page.getByRole("heading", { name: "活动历史" }),
  );
  await page.mouse.move(directPoint.x, directPoint.y);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => scrollTop(main)).toBeGreaterThan(0);
  await setScrollTop(main, 0);
  await setScrollTop(records, "max");
  await waitAnimationFrames(page, 2);
  const before = await scrollTop(main);
  const point = await center(records);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(150);
  await page.mouse.wheel(0, 900);
  await expect.poll(() => scrollTop(main)).toBeGreaterThan(before);
  await expect(overscroll(records)).resolves.toEqual({ x: "auto", y: "auto" });
});

test("公开活动模态内筛选菜单与列表边界不滚动背景，横向保留默认", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRoutes(page);
  await page.goto("/square");
  const dialog = page.getByRole("dialog", { name: "活动广场", exact: true });
  await expect(dialog).toBeVisible();
  await createScrollStress(page);
  const main = page.locator(".site-main");
  await expectScrollable(main);
  await setScrollTop(main, 0);
  await dialog.getByRole("button", { name: "活动状态筛选" }).click();
  const menu = dialog.getByRole("menu", { name: "活动状态筛选" });
  await expect(menu).toBeVisible();
  await expect(overscroll(menu)).resolves.toEqual({ x: "auto", y: "auto" });
  const point = await center(menu);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => scrollTop(main)).toBe(0);
  await page.keyboard.press("Escape");
  const records = dialog.locator(".list-panel__scroll");
  await expectScrollable(records);
  await setScrollTop(records, "max");
  const recordPoint = await center(records);
  await page.mouse.move(recordPoint.x, recordPoint.y);
  await page.mouse.wheel(0, 900);
  await expect.poll(() => scrollTop(main)).toBe(0);
  await expect(overscroll(records)).resolves.toEqual({
    x: "auto",
    y: "contain",
  });
});

test("真正模态只隔离纵向背景滚动，横向 overscroll 保持浏览器默认", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 260 });
  await installRoutes(page);
  await page.goto("/my/activities?type=all&statistics=author-0");
  const dialog = page.getByRole("dialog", {
    name: "兑换尝试统计",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const main = page.locator(".site-main");
  const body = dialog.locator(".attempt-statistics-dialog__body");
  await expectScrollable(body);
  await setScrollTop(main, 0);
  await setScrollTop(body, "max");
  const before = await scrollTop(main);
  const point = await center(body);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 900);
  await expect.poll(() => scrollTop(main)).toBe(before);
  await expect(overscroll(body)).resolves.toEqual({ x: "auto", y: "contain" });
});

test("代表页面的普通滚动容器不设置横向 overscroll containment", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRoutes(page);

  await page.goto("/square");
  await expect(page.getByRole("heading", { name: "活动广场" })).toBeVisible();
  await expect(overscroll(page.locator(".site-main"))).resolves.toMatchObject({
    x: "auto",
  });
  await expect(
    overscroll(page.locator(".list-panel__scroll").first()),
  ).resolves.toEqual({ x: "auto", y: "contain" });

  await page.goto("/my/payments?activityId=payment-a-0");
  await expect(page.getByRole("heading", { name: "付款记录" })).toBeVisible();
  await expect(page.locator(".work-payment-detail-body")).toBeVisible();
  for (const locator of [
    page.locator(".work-payment-activities .list-panel__scroll"),
    page.locator(".work-payment-targets .list-panel__scroll"),
    page.locator(".work-payment-detail-body"),
  ])
    await expect(overscroll(locator)).resolves.toEqual({
      x: "auto",
      y: "auto",
    });

  await page.goto("/my/activities?type=all&statistics=author-0");
  const dialog = page.getByRole("dialog", {
    name: "兑换尝试统计",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    overscroll(dialog.locator(".attempt-statistics-dialog__body")),
  ).resolves.toEqual({ x: "auto", y: "contain" });
});
