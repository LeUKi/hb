import { expect, type Locator, test } from "@playwright/test";

const feedbackLabel = (button: Locator) =>
  button.locator('[aria-live="polite"]').last();

const activityId = "20000000-0000-4000-8000-000000000007";

test("管理员六入口、分页和详情在 URL 中恢复", async ({ page }) => {
  await page.goto("/#admin?section=activities");
  await expect(
    page.getByRole("navigation", { name: "管理模块" }).getByRole("link"),
  ).toHaveCount(6);
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(20);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(5);
  await page.getByRole("button", { name: "活动样例 21", exact: true }).click();
  await expect(page).toHaveURL(/detail=/);
  await expect(
    page.getByRole("complementary", { name: "记录详情" }),
  ).toContainText("库存");
  await expect(
    page.getByRole("complementary", { name: "记录详情" }),
  ).not.toContainText("奖励类型");
  await expect(
    page.getByRole("complementary", { name: "记录详情" }),
  ).toContainText("生命周期");
  await expect(
    page.getByRole("complementary", { name: "记录详情" }),
  ).toContainText("关联付款");
  await page.reload();
  await expect(
    page.getByRole("complementary", { name: "记录详情" }),
  ).toContainText("活动样例 21");
  await page.getByRole("button", { name: "关闭详情" }).click();
  await expect(
    page.getByRole("textbox", { name: "搜索", exact: true }),
  ).toBeFocused();
  await page.goBack();
  await expect(
    page.getByRole("complementary", { name: "记录详情" }),
  ).toBeVisible();
});

test("活动检索支持 UUID、Emoji、本站活动链接和帖子定位", async ({ page }) => {
  await page.goto("/#admin?section=activities");
  const search = page.getByRole("textbox", { name: "搜索", exact: true });
  const emojiCode = await page.evaluate(async (id) => {
    const links = await import(
      "/@fs/Users/lafish/Documents/ChatGPT/hb/apps/web/src/lib/emoji-links.ts"
    );
    return links.encodeActivityEmoji(id);
  }, activityId);

  await search.fill(activityId);
  await search.press("Enter");
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "活动样例 7" })).toBeVisible();

  await search.fill(emojiCode);
  await search.press("Enter");
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "活动样例 7" })).toBeVisible();

  await search.fill(
    `${await page.evaluate(() => location.origin)}/activities/${activityId}`,
  );
  await search.press("Enter");
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "活动样例 7" })).toBeVisible();

  await search.fill("https://linux.do/t/topic/12345/7");
  await search.press("Enter");
  await expect(page).toHaveURL(
    /q=https%3A%2F%2Flinux\.do%2Ft%2Ftopic%2F12345%2F7/,
  );
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(6);
});

test("付款关联筛选、异常筛选和精确订单检索", async ({ page }) => {
  await page.goto("/#admin?section=payments");
  await page
    .getByRole("combobox", { name: "商户", exact: true })
    .selectOption("demo-merchant-1");
  await page
    .getByRole("combobox", { name: "收款人", exact: true })
    .selectOption("demo-user-0");
  await page
    .getByRole("combobox", { name: "付款异常", exact: true })
    .selectOption("未投递超过十分钟");
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(3);

  await page
    .getByRole("textbox", { name: "活动标识", exact: true })
    .fill("20000000-0000-4000-8000-000000000001");
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "订单 DEMO-20261012-00000000" }),
  ).toBeVisible();

  const search = page.getByRole("textbox", { name: "搜索", exact: true });
  await search.fill("DEMO-EXTERNAL-00000000000000000000");
  await search.press("Enter");
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(1);
});

test("用户详情可跳转关联活动和付款筛选", async ({ page }) => {
  await page.goto("/#admin?section=users");
  await page.getByRole("button", { name: "示例用户 1", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "记录详情" }),
  ).toContainText("注册时间");
  await expect(
    page.getByRole("complementary", { name: "记录详情" }),
  ).toContainText("账号状态");
  await page.getByRole("button", { name: "查看该用户活动" }).click();
  await expect(page).toHaveURL(/section=activities/);
  await expect(page).toHaveURL(/q=demo0/);
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(5);

  await page.goto("/#admin?section=users&detail=demo-user-1");
  await page.getByRole("button", { name: "查看该用户付款" }).click();
  await expect(page).toHaveURL(/section=payments/);
  await expect(page).toHaveURL(/recipient=demo-user-1/);
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(4);
});

test("管理员读取失败保留列表和详情旧内容", async ({ page }) => {
  await page.goto("/#admin?section=activities");
  await page.getByRole("button", { name: "活动样例 1", exact: true }).click();
  const detail = page.getByRole("complementary", { name: "记录详情" });
  await expect(detail).toContainText("活动样例 1");
  await expect(detail).toContainText("关联付款");

  await page.getByRole("combobox", { name: "读取演示" }).selectOption("error");
  const refresh = page.getByRole("button", { name: /^刷新(?:，|$)/ });
  await refresh.click();
  await expect(feedbackLabel(refresh)).toHaveText("刷新失败");
  await expect(refresh).toHaveAccessibleName("刷新，刷新失败");
  await expect(refresh).toHaveAttribute("title", "读取失败，请重试。");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText(/上次成功读取：.*读取失败，请重试。当前内容已保留。/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "活动样例 1", exact: true }),
  ).toBeVisible();
  await expect(detail).toContainText("活动样例 1");

  const detailRefresh = detail.getByRole("button", { name: "刷新详情" });
  await detailRefresh.click();
  await expect(feedbackLabel(detailRefresh)).toHaveText("刷新失败");
  await expect(detailRefresh).toHaveAccessibleName("刷新详情，刷新失败");
  await expect(detailRefresh).toHaveAttribute(
    "title",
    "详情读取失败，请重试。",
  );
  await expect(detail.getByRole("alert")).toHaveCount(0);
  await expect(
    detail.getByText(
      /详情上次成功读取：.*详情读取失败，请重试。当前内容已保留。/,
    ),
  ).toBeVisible();
  await expect(detail).toContainText("活动样例 1");
  await expect(detail).toContainText("关联付款");

  await page.getByRole("combobox", { name: "读取演示" }).selectOption("ready");
  await detailRefresh.click();
  await expect(feedbackLabel(detailRefresh)).toHaveText("已刷新");
  await expect(
    detail.getByText(/详情读取失败，请重试。当前内容已保留。/),
  ).toHaveCount(0);
  await refresh.click();
  await expect(feedbackLabel(refresh)).toHaveText("已刷新");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("操作记录支持操作者和日期筛选", async ({ page }) => {
  await page.goto("/#admin?section=audit");
  const today = new Date().toISOString().slice(0, 10);
  await page.getByLabel("操作者", { exact: true }).fill("运营");
  await page.getByLabel("开始日期", { exact: true }).fill(today);
  await page.getByLabel("结束日期", { exact: true }).fill(today);
  await expect(page).toHaveURL(/operator=/);
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(16);
});

test("手机详情是模态，搜索需显式执行，页面不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#admin?section=payments");
  await page
    .getByRole("textbox", { name: "搜索", exact: true })
    .fill("DEMO-20261012-00000023");
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(20);
  await page.getByRole("textbox", { name: "搜索", exact: true }).press("Enter");
  await expect(page.locator(".prototype-admin tbody tr")).toHaveCount(1);
  const opener = page.getByRole("button", {
    name: "订单 DEMO-20261012-00000023",
    exact: true,
  });
  await opener.click();
  await expect(page.getByRole("dialog", { name: "记录详情" })).toContainText(
    "订单用户名快照",
  );
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await page
        .getByRole("dialog")
        .evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("网站设置保存反馈留在原按钮且不显示外置状态", async ({ page }) => {
  await page.clock.install();
  await page.goto("/#admin?section=settings");
  await page.getByRole("checkbox", { name: /允许 LiteAUTH 登录/ }).uncheck();
  const loginSave = page
    .getByRole("button", { name: /^保存配置(?:，|$)/ })
    .first();
  await page.clock.pauseAt(Date.now() + 1_000);
  await loginSave.click();
  await expect(feedbackLabel(loginSave)).toHaveText("已保存");
  await expect(loginSave).toHaveAccessibleName("保存配置，已保存");
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.clock.runFor(2_999);
  await expect(feedbackLabel(loginSave)).toHaveText("已保存");
  await page.clock.runFor(1);
  await expect(feedbackLabel(loginSave)).toHaveText("保存配置");

  const home = page.getByRole("spinbutton", {
    name: "首页尝试间隔（秒）",
    exact: true,
  });
  await home.fill("0");
  const rateSave = page
    .getByRole("button", { name: /^保存配置(?:，|$)/ })
    .nth(1);
  await rateSave.click();
  await expect(feedbackLabel(rateSave)).toHaveText("校验失败");
  await expect(rateSave).toHaveAccessibleName("保存配置，校验失败");
  await expect(rateSave).toHaveAttribute("title", "请填写 1–3600 秒的整数。");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(home).toHaveValue("0");
});

test("网站设置刷新确认保留或重置本地输入", async ({ page }) => {
  await page.goto("/#admin?section=settings");
  const input = page.getByRole("spinbutton", {
    name: "首页尝试间隔（秒）",
    exact: true,
  });
  const initial = await input.inputValue();
  await input.fill("30");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("刷新会放弃未保存的修改，是否继续？");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: /^刷新(?:，|$)/ }).click();
  await expect(input).toHaveValue("30");
  page.once("dialog", (dialog) => dialog.accept());
  const refresh = page.getByRole("button", { name: /^刷新(?:，|$)/ });
  await refresh.click();
  await expect(input).toHaveValue(initial);
  await expect(feedbackLabel(refresh)).toHaveText("已刷新");
  await expect(page.getByRole("status")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "管理模块" })
    .getByRole("link", { name: "概览", exact: true })
    .click();
  await expect(page.getByText("未接入", { exact: true })).toBeVisible();
});
