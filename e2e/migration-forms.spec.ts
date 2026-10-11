import { expect, type Page, test } from "@playwright/test";

const anonymousSession = {
  user: null,
  csrfToken: null,
  loginOptions: { liteauthEnabled: true },
};
const liteUser = {
  id: "lite-user-1",
  username: "liteada",
  displayName: "Lite Ada",
  avatarUrl: null,
  email: null,
  accountTier: "lite" as const,
  canUseLdc: false,
  loginProvider: "liteauth" as const,
};

type FormUser = Omit<typeof liteUser, "accountTier" | "loginProvider"> & {
  accountTier: "lite" | "standard";
  loginProvider: "liteauth" | "connect";
};

async function mockSession(page: Page, user: FormUser | null) {
  await page.route(/\/api\/(?:session|me)$/, (route) =>
    route.fulfill({
      json: user ? { user, csrfToken: "csrf-1" } : anonymousSession,
    }),
  );
  await page.route("**/api/me/merchants**", (route) =>
    route.fulfill({
      json: {
        items: [],
        currentMerchantId: null,
        canCreate: false,
        canSimulate: true,
      },
    }),
  );
}

test("账号页访客登录卡在常用视口居中，LiteAuth 默认折叠且可 Esc 收起", async ({
  page,
}) => {
  await mockSession(page, null);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 900 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/account");
    const card = page.locator(".work-login-card");
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      expect(Math.abs(centerX - viewport.width / 2)).toBeLessThanOrEqual(24);
      expect(Math.abs(centerY - viewport.height / 2)).toBeLessThanOrEqual(90);
    }
    await expect(
      page.getByRole("link", { name: "通过LINUX DO登录", exact: true }),
    ).toHaveAttribute("href", "/api/auth/login?returnTo=%2Faccount");
    const liteTrigger = page.getByRole("button", { name: "青春版登录" });
    await expect(
      page.getByRole("link", { name: "通过 LiteAuth 登录" }),
    ).toHaveCount(0);
    await liteTrigger.click();
    await expect(
      page.getByRole("link", { name: "通过 LiteAuth 登录" }),
    ).toHaveAttribute("href", "/api/auth/liteauth/login?returnTo=%2Faccount");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("link", { name: "通过 LiteAuth 登录" }),
    ).toHaveCount(0);
    await expect(liteTrigger).toBeFocused();
  }
});

test("活动说明共享一个 Markdown 视图切换，提交错误会从 Markdown 切回分栏并聚焦字段", async ({
  page,
}) => {
  await mockSession(page, liteUser);
  await page.goto("/activities/new");
  await page.locator("summary", { hasText: "更多设置" }).click();

  const viewSwitch = page.getByRole("group", { name: "说明预览模式" });
  await expect(viewSwitch).toBeVisible();
  await expect(
    viewSwitch.getByRole("button", { name: "分栏" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("暂无内容")).toHaveCount(0);
  await expect(page.locator("textarea#activity-beforeInfo")).toBeVisible();
  await expect(page.locator(".work-note-preview")).toHaveCount(3);

  await viewSwitch.getByRole("button", { name: "Markdown" }).click();
  await expect(page.locator("textarea#activity-beforeInfo")).toHaveCount(0);

  await page.locator("#activity-title").fill("说明校验活动");
  await page.locator("#activity-password-1").fill("口令ABC123");
  await page
    .getByRole("group", { name: "奖励类型", exact: true })
    .getByRole("button", { name: "文本 / CDK", exact: true })
    .click();
  await page.locator("#activity-text-rewards").fill("TEXT-CODE-1");
  await viewSwitch.getByRole("button", { name: "分栏" }).click();
  await page.locator("textarea#activity-beforeInfo").fill("x".repeat(10_001));
  await page.locator("textarea#activity-beforeInfo").blur();
  await expect(page.locator("#activity-beforeInfo-error")).toContainText(
    "说明不能超过 10,000 个字符",
  );
  await page.locator("textarea#activity-beforeInfo").fill("修正后的说明");
  await expect(page.locator("#activity-beforeInfo-error")).toHaveCount(0);

  await page.locator("textarea#activity-beforeInfo").fill("x".repeat(10_001));
  await viewSwitch.getByRole("button", { name: "Markdown" }).click();
  await page.getByRole("button", { name: "保存并开放" }).click();
  await expect(
    viewSwitch.getByRole("button", { name: "分栏" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("textarea#activity-beforeInfo")).toBeFocused();
});

test("表单离开取消保留输入，确认后返回只恢复浏览设置", async ({ page }) => {
  await mockSession(page, liteUser);
  await page.goto("/account");
  await page.getByRole("link", { name: "发起活动", exact: true }).click();
  await page.locator("#activity-title").fill("未保存标题");
  await page.locator("summary", { hasText: "更多设置" }).click();
  await page
    .getByRole("group", { name: "说明预览模式" })
    .getByRole("button", { name: "原文", exact: true })
    .click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(/\/activities\/new$/);
  await expect(page.locator("#activity-title")).toHaveValue("未保存标题");
  page.once("dialog", (dialog) => dialog.accept());
  await page.goBack();
  await expect(page).toHaveURL(/\/account$/);
  await page.goForward();
  await expect(page.locator("#activity-title")).toHaveValue("");
  await expect(
    page
      .getByRole("group", { name: "说明预览模式" })
      .getByRole("button", { name: "原文", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage })),
  ).not.toContain("未保存标题");
});

test("表单集中展示锁定说明，奖励方式帮助完整且口令删除不随手机或错误文本错位", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockSession(page, {
    ...liteUser,
    accountTier: "standard",
    loginProvider: "connect",
    canUseLdc: true,
  });
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(request.url());
  });
  await page.goto("/activities/new");
  await expect(
    page.getByRole("heading", { name: "活动与奖励", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator(".work-reward-kind-row .work-field-note"),
  ).toHaveText("奖励类型开放后不可修改");
  await expect(page.locator("#activity-forceDedicated")).toBeEnabled();
  await expect(page.locator("#activity-forceDedicated")).toHaveAccessibleName(
    "开启口令尝试统计（口令仅在活动页兑换）",
  );
  await expect(
    page.locator("#activity-forceDedicated"),
  ).toHaveAccessibleDescription(
    "开启后，口令无法在首页兑换。请务必分享活动页链接，让参与者进入活动页兑换或报名。 开放后不可修改。",
  );

  const help = page.getByRole("button", { name: "奖励方式说明", exact: true });
  const plans = page.getByRole("group", { name: "奖励方式", exact: true });
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await help.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "奖励方式说明",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("p strong")).toHaveText([
      "固定均分：",
      "即时随机：",
      "自定义金额：",
      "限时开奖：",
    ]);
    await expect(dialog.locator("hr")).toHaveCount(3);
    await expect(
      plans.getByRole("button", { name: "固定均分", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const bounds = await dialog.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(help).toBeFocused();
  }

  await page
    .getByRole("group", { name: "奖励类型", exact: true })
    .getByRole("button", { name: "文本 / CDK", exact: true })
    .click();
  await page.getByRole("button", { name: "添加口令", exact: true }).click();
  await page.getByLabel("口令 1", { exact: true }).fill("Valid123");
  await page.getByLabel("口令 2", { exact: true }).fill("bad!xx");
  await page.getByLabel("口令 2", { exact: true }).blur();
  await expect(page.getByLabel("口令 2", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  const row = page.locator(".work-password-row").nth(1);
  await expect(row.locator(".pw-input__error")).not.toBeEmpty();
  for (const viewport of [
    { width: 1440, textScale: 1 },
    { width: 768, textScale: 1 },
    { width: 375, textScale: 1 },
    { width: 375, textScale: 2 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    if (viewport.textScale === 2) {
      await page.evaluate(() => {
        const sizes = Array.from(
          document.querySelectorAll<HTMLElement>(".work-create-layout *"),
          (element) => ({
            element,
            size: Number.parseFloat(getComputedStyle(element).fontSize),
          }),
        );
        document.documentElement.style.fontSize = "200%";
        for (const { element, size } of sizes)
          if (Number.isFinite(size)) element.style.fontSize = `${size * 2}px`;
      });
    }
    await row.scrollIntoViewIfNeeded();
    const field = await row.locator(".pw-input__field").boundingBox();
    const button = await row
      .getByRole("button", { name: "删除口令 2" })
      .boundingBox();
    const icon = await row.locator(".work-remove-password svg").boundingBox();
    expect(field).not.toBeNull();
    expect(button).not.toBeNull();
    expect(icon).not.toBeNull();
    if (field && button && icon) {
      expect(button.x).toBeGreaterThan(field.x + field.width);
      expect(Math.abs(button.y - field.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(button.height - field.height)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(icon.x + icon.width / 2 - (button.x + button.width / 2)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(icon.y + icon.height / 2 - (button.y + button.height / 2)),
      ).toBeLessThanOrEqual(1);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await row.getByRole("button", { name: "删除口令 2" }).click();
  await expect(page.getByLabel("口令 2", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("口令 1", { exact: true })).toHaveValue(
    "Valid123",
  );
  expect(writes).toEqual([]);
});
