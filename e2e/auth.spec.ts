import { expect, type Page, test } from "@playwright/test";

const anonymousSession = {
  user: null,
  csrfToken: null,
  loginOptions: { liteauthEnabled: true },
};
const signedInSession = {
  user: {
    id: "u_123",
    username: "ada",
    displayName: "Ada",
    avatarUrl: null,
    email: "ada-private@example.test",
    accountTier: "standard",
    canUseLdc: true,
    loginProvider: "connect",
  },
  csrfToken: "csrf-token-1",
  loginOptions: { liteauthEnabled: true },
};

const otherSignedInSession = {
  user: {
    id: "u_456",
    username: "lin",
    displayName: "Lin",
    avatarUrl: null,
    email: "lin-private@example.test",
    accountTier: "standard",
    canUseLdc: true,
    loginProvider: "connect",
  },
  csrfToken: "csrf-token-2",
  loginOptions: { liteauthEnabled: true },
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
  await page.route(/\/api\/(?:session|me)$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(anonymousSession),
    }),
  );

  await page.goto("/");

  await expect(
    page.locator("header").getByRole("link", { name: "登录", exact: true }),
  ).toHaveAttribute("href", "/account?returnTo=%2F");
  let submissions = 0;
  await page.route("**/api/redemptions", (route) => {
    submissions++;
    return route.abort();
  });
  await page.getByLabel("口令", { exact: true }).fill("GuestPassword");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "请先登录。" }),
  ).toBeVisible();
  expect(submissions).toBe(0);
  await page
    .locator("header")
    .getByRole("link", { name: "登录", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "通过LINUX DO登录", exact: true }),
  ).toHaveAttribute("href", "/api/auth/login?returnTo=%2F");
  await page.getByRole("button", { name: "青春版登录" }).click();
  await expect(
    page.getByRole("link", { name: "通过 LiteAuth 登录", exact: true }),
  ).toHaveAttribute("href", "/api/auth/liteauth/login?returnTo=%2F");
});

test("集中登录保留受保护页面和筛选，拒绝外部返回地址", async ({ page }) => {
  await page.route(/\/api\/(?:session|me)$/, (route) =>
    route.fulfill({ json: anonymousSession }),
  );
  const returnTo = "/my/claims?status=ended&type=text";
  await page.goto(returnTo);
  await page.getByRole("link", { name: "前往登录", exact: true }).click();
  const encodedReturnTo = encodeURIComponent(returnTo);
  await expect(
    page.getByRole("link", { name: "通过LINUX DO登录", exact: true }),
  ).toHaveAttribute("href", `/api/auth/login?returnTo=${encodedReturnTo}`);
  await page.getByRole("button", { name: "青春版登录", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "通过 LiteAuth 登录", exact: true }),
  ).toHaveAttribute(
    "href",
    `/api/auth/liteauth/login?returnTo=${encodedReturnTo}`,
  );
  for (const unsafe of [
    "https://example.invalid",
    "//example.invalid",
    "/\\example.invalid",
  ]) {
    await page.goto(`/account?returnTo=${encodeURIComponent(unsafe)}`);
    await expect(
      page.getByRole("link", { name: "通过LINUX DO登录", exact: true }),
    ).toHaveAttribute("href", "/api/auth/login?returnTo=%2F");
  }
});

test("账号页对匿名用户展示登录提示，并隐藏原始 authError", async ({ page }) => {
  await page.route(/\/api\/(?:session|me)$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(anonymousSession),
    }),
  );

  await page.goto("/account?authError=provider_stack_secret");

  await expect(page.getByText("登录没有完成，请重新尝试。")).toBeVisible();
  await expect(page.getByText("provider_stack_secret")).toHaveCount(0);
  await expect(page.getByText("登录解meme")).toBeVisible();
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "通过LINUX DO登录", exact: true }),
  ).toHaveAttribute("href", "/api/auth/login?returnTo=%2Faccount");
});

test("后端 authError 只展示安全文案", async ({ page }) => {
  await page.route(/\/api\/(?:session|me)$/, (route) =>
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
    page.getByRole("link", { name: "通过LINUX DO登录", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("main")
    .getByRole("button", { name: "青春版登录" })
    .click();
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "通过 LiteAuth 登录", exact: true }),
  ).toBeVisible();

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

test("LiteAuth暂不可用不影响官方登录，升级错误只显示固定文案", async ({
  page,
}) => {
  await page.route(/\/api\/(?:session|me)$/, (route) =>
    route.fulfill({ json: anonymousSession }),
  );
  await page.goto("/account?authError=liteauth_not_configured");
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "通过LINUX DO登录", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "通过 LiteAuth 登录", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("main")
      .getByText(
        "LiteAuth青春版登录暂时不可用，可以使用官方Connect或稍后重试。",
        { exact: true },
      ),
  ).toBeVisible();
  for (const [code, message] of [
    [
      "identity_mismatch",
      "官方Connect返回了不同账号，升级未完成，当前账号没有切换。请使用同一Linux DO账号重试。",
    ],
    ["upgrade_session_required", "请先登录当前账号，再使用官方Connect升级。"],
    [
      "upgrade_session_changed",
      "升级期间当前账号已变化或登录失效，请重新确认账号后升级。",
    ],
    ["liteauth_failed", "登录没有完成，请重新尝试。"],
  ]) {
    await page.goto(`/account?authError=${code}`);
    await expect(
      page.getByRole("main").getByText(message as string, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(code as string, { exact: true })).toHaveCount(
      0,
    );
  }
});

test("已登录用户可查看账号并通过 CSRF 退出", async ({ page }) => {
  let signedIn = true;
  let csrfHeader: string | undefined;

  await page.route(/\/api\/(?:session|me)$/, (route) =>
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
  await expect(
    account.locator("dd").filter({ hasText: /^Ada$/ }),
  ).toBeVisible();
  await expect(
    account.locator("dd").filter({ hasText: /^@ada$/ }),
  ).toBeVisible();
  await expect(
    account.getByText("ada-private@example.test", { exact: true }),
  ).toBeVisible();
  const accountLink = page
    .locator("header")
    .getByRole("link", { name: "我的账号" });
  await expect(accountLink).toHaveAttribute("href", "/account");
  await accountLink.hover();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByText("登录解meme")).toBeVisible();
  expect(csrfHeader).toBe("csrf-token-1");
});

test("已有账号缓存时，身份刷新失败不会继续显示私有账号详情", async ({
  page,
}) => {
  await page.clock.install();
  let simulateFailure = false;
  let failedCalls = 0;

  await page.route(/\/api\/(?:session|me)$/, (route) => {
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
  await expect(page.getByRole("definition").getByText("@ada")).toBeVisible();

  simulateFailure = true;
  await refocusAfterSessionStale(page);
  await expect.poll(() => failedCalls).toBeGreaterThan(0);

  await expect(page.getByText("身份检查失败：HTTP 503")).toBeVisible();
  await expect(page.getByText("@ada", { exact: true })).toHaveCount(0);
  await expect(page.getByText("ada-private@example.test")).toHaveCount(0);
});

test("退出登录会取消并清除私有会话缓存，避免延迟响应重新填回账号", async ({
  page,
}) => {
  await page.clock.install();
  let signedIn = true;
  let meCalls = 0;
  let delayNextSession = false;
  let releaseDelayedSession: (() => void) | undefined;

  await page.route(/\/api\/(?:session|me)$/, async (route) => {
    meCalls += 1;

    if (!delayNextSession) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(signedIn ? signedInSession : anonymousSession),
      });
      return;
    }

    delayNextSession = false;
    const delayedSnapshot = signedIn ? signedInSession : anonymousSession;
    await new Promise<void>((resolve) => {
      releaseDelayedSession = resolve;
    });

    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(delayedSnapshot),
      });
    } catch {
      // The client may abort this request when logout cancels session queries.
    }
  });
  await page.route("**/api/auth/logout", async (route) => {
    signedIn = false;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto("/account");
  await expect(page.getByRole("definition").getByText("@ada")).toBeVisible();

  const baselineMeCalls = meCalls;
  delayNextSession = true;
  await refocusAfterSessionStale(page);
  await expect.poll(() => meCalls).toBeGreaterThan(baselineMeCalls);

  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByText("登录解meme")).toBeVisible();
  releaseDelayedSession?.();

  await expect(page.getByText("@ada", { exact: true })).toHaveCount(0);
  await expect(page.getByText("ada-private@example.test")).toHaveCount(0);
  await expect(page.getByText("登录解meme")).toBeVisible();
});

test("成功退出后后续身份刷新可以恢复新登录身份", async ({ page }) => {
  await page.clock.install();
  let session: typeof signedInSession | typeof anonymousSession =
    signedInSession;

  await page.route(/\/api\/(?:session|me)$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    }),
  );
  await page.route("**/api/auth/logout", async (route) => {
    session = anonymousSession;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto("/account");
  await expect(page.getByRole("definition").getByText("@ada")).toBeVisible();

  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByText("登录解meme")).toBeVisible();

  session = otherSignedInSession;
  await refocusAfterSessionStale(page);

  await expect(page.getByRole("definition").getByText("@lin")).toBeVisible();
  await expect(page.getByText("lin-private@example.test")).toBeVisible();
  await expect(page.getByText("@ada", { exact: true })).toHaveCount(0);
  await expect(page.getByText("ada-private@example.test")).toHaveCount(0);
});

test("退出失败后恢复原会话并显示失败提示", async ({ page }) => {
  let meCalls = 0;
  let logoutCalls = 0;

  await page.route(/\/api\/(?:session|me)$/, (route) => {
    meCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(signedInSession),
    });
  });
  await page.route("**/api/auth/logout", async (route) => {
    logoutCalls += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "LOGOUT_FAILED" } }),
    });
  });

  await page.goto("/account");
  await expect(page.getByRole("definition").getByText("@ada")).toBeVisible();
  const baselineMeCalls = meCalls;

  await page.getByRole("button", { name: "退出" }).click();

  await expect.poll(() => logoutCalls).toBe(1);
  await expect.poll(() => meCalls).toBeGreaterThan(baselineMeCalls);
  await expect(page.getByText("退出失败，请重试")).toBeVisible();
  await expect(page.getByRole("definition").getByText("@ada")).toBeVisible();
  await expect(page.getByText("ada-private@example.test")).toBeVisible();
  await expect(page.getByText("登录解meme")).toHaveCount(0);
});

test("身份检查失败时可以安全重试", async ({ page }) => {
  let fail = true;
  let failedCalls = 0;

  await page.route(/\/api\/(?:session|me)$/, (route) => {
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
  await expect(page.getByText("登录解meme")).toBeVisible();
});

test("窄屏账号导航不产生横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route(/\/api\/(?:session|me)$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(signedInSession),
    }),
  );

  await page.goto("/account");

  await expect(page.getByText("账号信息", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
