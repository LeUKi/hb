import { expect, type Page, test } from "@playwright/test";

const email = "copy-feedback@example.test";
const user = {
  id: "copy-feedback-user",
  username: "copyfeedback",
  displayName: "复制反馈用户",
  avatarUrl: null,
  isAdmin: false,
  email,
};

type Box = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type PendingClipboardWrite = {
  reject: (error: Error) => void;
  resolve: () => void;
  value: string;
};

async function mockAccount(page: Page) {
  const state = {
    copied: undefined as string | undefined,
    logoutFails: false,
    external: [] as string[],
    clipboardHold: false,
    clipboardReject: false,
    pendingWrites: [] as PendingClipboardWrite[],
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.exposeFunction("__hbClipboardWrite", (value: string) => {
    if (state.clipboardReject) {
      throw new Error("clipboard write failed");
    }
    if (state.clipboardHold) {
      return new Promise<void>((resolve, reject) => {
        state.pendingWrites.push({ reject, resolve, value });
      });
    }
    state.copied = value;
  });
  await page.addInitScript(() => {
    const globals = window as typeof window & {
      __hbClipboardWrite?: (value: string) => Promise<void> | void;
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          await globals.__hbClipboardWrite?.(value);
        },
      },
    });
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      state.external.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/session" || url.pathname === "/api/me") {
      return route.fulfill({
        json: {
          user,
          csrfToken: "copy-feedback-csrf",
          attemptCooldown: null,
        },
      });
    }
    if (url.pathname === "/api/auth/logout") {
      return route.fulfill({
        status: state.logoutFails ? 503 : 200,
        json: state.logoutFails
          ? { error: { message: "退出服务暂不可用" } }
          : { ok: true },
      });
    }
    if (url.pathname.startsWith("/api/me/activity-images")) {
      return route.fulfill({
        json: { timeZone: "Asia/Shanghai", recentRequest: null },
      });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  return state;
}

const emailButton = (page: Page) =>
  page.getByRole("button", { name: /^复制 Connect 邮箱/ });

const emailRow = (page: Page) =>
  page.locator(".work-account-rows > div").filter({ hasText: "Connect 邮箱" });

async function requireBox(locatorName: string, box: Box | null) {
  if (!box) throw new Error(`Expected ${locatorName} to have a layout box.`);
  return box;
}

async function expectStableBox(actualBox: Box | null, expectedBox: Box) {
  if (!actualBox) throw new Error("Expected element to have a layout box.");
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actualBox[key] - expectedBox[key])).toBeLessThan(1);
  }
}

async function freezeClock(page: Page) {
  await page.clock.pauseAt(Date.now() + 1_000);
}

type AccountMock = Awaited<ReturnType<typeof mockAccount>>;

function setClipboardReject(state: AccountMock, reject: boolean) {
  state.clipboardReject = reject;
}

function holdClipboardWrites(state: AccountMock, hold: boolean) {
  state.clipboardHold = hold;
}

function releaseClipboardWrite(state: AccountMock, succeed = true) {
  const pending = state.pendingWrites.shift();
  if (!pending) return;
  if (!succeed) {
    pending.reject(new Error("clipboard release failed"));
    return;
  }
  state.copied = pending.value;
  pending.resolve();
}

function pendingClipboardWrites(state: AccountMock) {
  return state.pendingWrites.length;
}

async function openAccountWithEmail(page: Page, width: number) {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.goto("/account");
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(emailButton(page)).toHaveText("复制");
}

for (const width of [1440, 375]) {
  test(`账号邮箱复制成功在原按钮反馈且不移动布局 ${width}px`, async ({
    page,
  }) => {
    await page.clock.install();
    const state = await mockAccount(page);
    await openAccountWithEmail(page, width);
    const row = emailRow(page);
    const button = emailButton(page);
    const rowBefore = await requireBox("email row", await row.boundingBox());
    const buttonBefore = await requireBox(
      "email copy button",
      await button.boundingBox(),
    );
    await freezeClock(page);

    await button.click();

    await expect(button).toHaveText("已复制");
    await expect(button).toHaveAccessibleName("复制 Connect 邮箱，已复制");
    await expect.poll(() => state.copied).toBe(email);
    await expectStableBox(await row.boundingBox(), rowBefore);
    await expectStableBox(await button.boundingBox(), buttonBefore);
    await expect(page.getByText("已复制", { exact: true })).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    await page.clock.runFor(2_999);
    await expect(button).toHaveText("已复制");
    await expectStableBox(await row.boundingBox(), rowBefore);
    await expectStableBox(await button.boundingBox(), buttonBefore);
    await page.clock.runFor(1);
    await expect(button).toHaveText("复制");
    await expect(button).toHaveAccessibleName("复制 Connect 邮箱");
    await expectStableBox(await row.boundingBox(), rowBefore);
    await expectStableBox(await button.boundingBox(), buttonBefore);
    expect(state.external).toEqual([]);
  });

  test(`账号邮箱复制失败在原按钮反馈且可重试 ${width}px`, async ({ page }) => {
    await page.clock.install();
    const state = await mockAccount(page);
    await openAccountWithEmail(page, width);
    const row = emailRow(page);
    const button = emailButton(page);
    const rowBefore = await requireBox("email row", await row.boundingBox());
    const buttonBefore = await requireBox(
      "email copy button",
      await button.boundingBox(),
    );
    await freezeClock(page);

    setClipboardReject(state, true);
    await button.click();

    await expect(button).toHaveText("复制失败");
    await expect(button).toHaveAccessibleName("复制 Connect 邮箱，复制失败");
    await expect.poll(() => state.copied).toBeUndefined();
    await expectStableBox(await row.boundingBox(), rowBefore);
    await expectStableBox(await button.boundingBox(), buttonBefore);
    await expect(page.getByText("复制失败", { exact: true })).toHaveCount(1);

    setClipboardReject(state, false);
    await button.click();
    await expect(button).toHaveText("已复制");
    await expect(button).toHaveAccessibleName("复制 Connect 邮箱，已复制");
    await expect.poll(() => state.copied).toBe(email);
    await expectStableBox(await row.boundingBox(), rowBefore);
    await expectStableBox(await button.boundingBox(), buttonBefore);

    await page.clock.runFor(2_999);
    await expect(button).toHaveText("已复制");
    await page.clock.runFor(1);
    await expect(button).toHaveText("复制");
    expect(state.external).toEqual([]);
  });
}

test("账号邮箱迟到复制结果在离开再返回后不显示旧成功", async ({ page }) => {
  const state = await mockAccount(page);
  await openAccountWithEmail(page, 1440);
  holdClipboardWrites(state, true);

  await emailButton(page).click();
  await expect.poll(() => pendingClipboardWrites(state)).toBe(1);
  await page.goto("/");
  releaseClipboardWrite(state);
  await expect.poll(() => state.copied).toBe(email);

  await openAccountWithEmail(page, 1440);
  await expect(emailButton(page)).toHaveText("复制");
  await expect(page.getByText("已复制", { exact: true })).toHaveCount(0);
  await expect(page.getByText("复制失败", { exact: true })).toHaveCount(0);
  expect(state.external).toEqual([]);
});

for (const width of [1440, 375]) {
  test(`退出失败在原按钮显示且三秒还原 ${width}px`, async ({ page }) => {
    const state = await mockAccount(page);
    state.logoutFails = true;
    await openAccountWithEmail(page, width);
    const button = page.getByRole("button", { name: /^退出登录/ });
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await expect(button).toHaveText("退出失败");
    await expect(button).toHaveAttribute("title", /退出登录失败/);
    await expect(page.locator("main > .form-message")).toHaveCount(0);
    await expect(button).toHaveText("退出登录", { timeout: 5000 });
  });
}
