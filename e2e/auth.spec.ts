import { expect, type Page, test } from "@playwright/test";

const anonymousSession = { user: null, csrfToken: null };
const signedInSession = {
  user: { id: "u_123", username: "ada", displayName: "Ada" },
  csrfToken: "csrf-token-1",
};

async function refocusAfterSessionStale(page: Page) {
  await page.clock.fastForward(31_000);
  const other = await page.context().newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await page.bringToFront();
  await other.close();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("匿名用户看到登录入口，登录链接只带相对 returnTo", async ({ page }) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(anonymousSession),
    }),
  );

  await page.goto("/");

  await expect(
    page.getByRole("link", { name: "登录", exact: true }),
  ).toHaveAttribute("href", "/api/auth/login?returnTo=%2F");
  await expect(
    page.getByRole("link", { name: "登录 Linux DO 账号" }),
  ).toHaveAttribute("href", "/api/auth/login?returnTo=%2F");
});

test("账号页对匿名用户展示登录提示，并隐藏原始 authError", async ({ page }) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(anonymousSession),
    }),
  );

  await page.goto("/account?authError=provider_stack_secret");

  await expect(page.getByText("登录没有完成，请重新尝试。")).toBeVisible();
  await expect(page.getByText("provider_stack_secret")).toHaveCount(0);
  await expect(page.getByText("请先使用 Linux DO 账号登录。")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "登录 Linux DO 账号" }),
  ).toHaveAttribute("href", "/api/auth/login?returnTo=%2Faccount");
});

test("后端 authError 只展示安全文案", async ({ page }) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(anonymousSession),
    }),
  );

  await page.goto("/account?authError=auth_not_configured");
  await expect(
    page.getByText("登录服务暂时不可用，请稍后再试。"),
  ).toBeVisible();
  await expect(page.getByText("auth_not_configured")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "登录 Linux DO 账号" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "登录", exact: true }),
  ).toHaveCount(0);

  await page.goto("/account?authError=invalid_state");
  await expect(page.getByText("登录会话已失效，请重新登录。")).toBeVisible();
  await expect(page.getByText("invalid_state")).toHaveCount(0);

  await page.goto("/account?authError=auth_failed");
  await expect(page.getByText("登录没有完成，请重新尝试。")).toBeVisible();
  await expect(page.getByText("auth_failed")).toHaveCount(0);

  await page.goto("/account?authError=access_denied");
  await expect(page.getByText("登录已取消，可以重新尝试。")).toBeVisible();
  await expect(page.getByText("access_denied")).toHaveCount(0);
});

test("已登录用户可查看账号并通过 CSRF 退出", async ({ page }) => {
  let signedIn = true;
  let csrfHeader: string | undefined;

  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(signedIn ? signedInSession : anonymousSession),
    }),
  );
  await page.route("**/api/auth/logout", async (route) => {
    csrfHeader = route.request().headers()["x-csrf-token"];
    signedIn = false;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto("/account");

  const account = page.getByRole("main");
  await expect(account.getByText("Ada", { exact: true })).toBeVisible();
  await expect(account.getByText("@ada", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByText("请先使用 Linux DO 账号登录。")).toBeVisible();
  expect(csrfHeader).toBe("csrf-token-1");
});

test("已有账号缓存时，身份刷新失败不会继续显示私有账号详情", async ({
  page,
}) => {
  await page.clock.install();
  let simulateFailure = false;
  let failedCalls = 0;

  await page.route("**/api/me", (route) => {
    if (!simulateFailure) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(signedInSession),
      });
    }

    failedCalls += 1;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "UNAVAILABLE" } }),
    });
  });

  await page.goto("/account");
  await expect(page.getByText("@ada", { exact: true })).toBeVisible();

  simulateFailure = true;
  await refocusAfterSessionStale(page);
  await expect.poll(() => failedCalls).toBeGreaterThan(0);

  await expect(page.getByText("身份检查失败：HTTP 503")).toBeVisible();
  await expect(page.getByText("@ada", { exact: true })).toHaveCount(0);
});

test("退出登录会取消并清除私有会话缓存，避免延迟响应重新填回账号", async ({
  page,
}) => {
  await page.clock.install();
  let meCalls = 0;
  let delaySession = false;
  let releaseDelayedSession: (() => void) | undefined;

  await page.route("**/api/me", async (route) => {
    meCalls += 1;

    if (!delaySession) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(signedInSession),
      });
      return;
    }

    await new Promise<void>((resolve) => {
      releaseDelayedSession = resolve;
    });

    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(signedInSession),
      });
    } catch {
      // The client may abort this request when logout cancels session queries.
    }
  });
  await page.route("**/api/auth/logout", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await page.goto("/account");
  await expect(page.getByText("@ada", { exact: true })).toBeVisible();

  const baselineMeCalls = meCalls;
  delaySession = true;
  await refocusAfterSessionStale(page);
  await expect.poll(() => meCalls).toBeGreaterThan(baselineMeCalls);

  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByText("请先使用 Linux DO 账号登录。")).toBeVisible();
  releaseDelayedSession?.();

  await expect(page.getByText("@ada", { exact: true })).toHaveCount(0);
  await expect(page.getByText("请先使用 Linux DO 账号登录。")).toBeVisible();
});

test("身份检查失败时可以安全重试", async ({ page }) => {
  let fail = true;
  let failedCalls = 0;

  await page.route("**/api/me", (route) => {
    if (fail) {
      failedCalls += 1;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "UNAVAILABLE" } }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(anonymousSession),
    });
  });

  await page.goto("/account");

  await expect.poll(() => failedCalls).toBe(2);
  await expect(page.getByText("身份检查失败：HTTP 503")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "重新检查" }).click();
  await expect(page.getByText("请先使用 Linux DO 账号登录。")).toBeVisible();
});

test("窄屏账号导航不产生横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(signedInSession),
    }),
  );

  await page.goto("/account");

  await expect(page.getByRole("link", { name: "Ada" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
