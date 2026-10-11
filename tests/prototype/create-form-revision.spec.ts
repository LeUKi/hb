import { test as base, expect } from "@playwright/test";
import { inspectTopicLink } from "../../apps/web/prototype/components/topic-link-input";

const origin = "http://127.0.0.1:4177";

const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const forbidden = new Set<string>();
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
          forbidden.add(url.href);
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect([...forbidden], "Create form tests stay local").toEqual([]);
    },
    { auto: true },
  ],
});

test("new activity form starts empty without pristine validation noise", async ({
  page,
}) => {
  await page.goto("/#create");

  await expect(page.locator("#work-title")).toHaveValue("");
  await expect(page.locator("#work-fixed-amount")).toHaveValue("");
  await expect(page.locator("#work-fixed-count")).toHaveValue("");
  await expect(page.locator("#work-password-1")).toHaveValue("");
  await page.locator(".work-more-settings > summary").click();
  await expect(page.locator("#work-duration")).toHaveValue("24");
  await expect(page.getByLabel("开放时长单位")).toContainText("小时");
  await expect(page.locator(".work-form-field-error")).toHaveCount(0);
  await expect(page.locator(".pw-input__error")).toBeEmpty();

  await page.getByRole("button", { name: "限时开奖", exact: true }).click();
  await expect(page.locator("#work-draw-amount")).toHaveValue("");
  await expect(page.locator("#work-draw-winners")).toHaveValue("");
  await expect(page.locator("#work-draw-seconds")).toHaveValue("600");
});

test("fields validate on edited blur, then clear live while typing", async ({
  page,
}) => {
  await page.goto("/#create");

  await page.locator("#work-title").focus();
  await page.locator("#work-fixed-amount").focus();
  await expect(page.getByText("请填写活动名称。")).toHaveCount(0);

  await page.locator("#work-title").fill("临时活动");
  await page.locator("#work-title").fill("");
  await page.locator("#work-fixed-amount").focus();
  await expect(page.getByText("请填写活动名称。")).toBeVisible();
  await page.locator("#work-title").fill("临时活动");
  await expect(page.getByText("请填写活动名称。")).toHaveCount(0);

  await page.locator("#work-fixed-amount").fill("abc");
  await page.locator("#work-fixed-count").focus();
  await expect(page.getByText("请填写有效的每份 LDC 金额。")).toBeVisible();
  await page.locator("#work-fixed-amount").fill("0.88");
  await expect(page.getByText("请填写有效的每份 LDC 金额。")).toHaveCount(0);
});

test("title validation does not truncate unicode text and pauses during composition", async ({
  page,
}) => {
  await page.goto("/#create");
  const title = page.locator("#work-title");
  const longTitle = "题".repeat(101);

  await title.dispatchEvent("compositionstart", { data: "题" });
  await title.fill(longTitle);
  await expect(title).toHaveValue(longTitle);
  await title.blur();
  await expect(page.getByText("活动名称不能超过 100 个字符。")).toHaveCount(0);

  await title.dispatchEvent("compositionend", { data: "题" });
  await title.focus();
  await title.blur();
  await expect(page.getByText("活动名称不能超过 100 个字符。")).toBeVisible();
  await title.fill("有效活动标题");
  await expect(page.getByText("活动名称不能超过 100 个字符。")).toHaveCount(0);
});

test("duplicate valid passwords surface through the password input and clear live", async ({
  page,
}) => {
  await page.goto("/#create");
  await page.locator("#work-password-1").fill("重复口令A1");
  await page.getByRole("button", { name: "添加口令", exact: true }).click();
  await page.locator("#work-password-2").fill("重复口令A1");
  await page.locator("#work-title").focus();

  await expect(page.getByText("口令重复，请移除重复项。")).toHaveCount(2);
  await page.locator("#work-password-2").fill("重复口令B2");
  await expect(page.getByText("口令重复，请移除重复项。")).toHaveCount(0);
});

test("topic link highlights redundant text, optimizes explicitly, and rejects invalid destinations", async ({
  page,
}) => {
  await page.goto("/#create");
  const topic = page.locator("#work-topic");

  await topic.fill(
    " https://linux.do/t/topic-title/2964597/1216?utm=demo#reply ",
  );
  await expect(
    page.getByRole("button", { name: "一键优化", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "一键优化", exact: true }).click();
  await expect(topic).toHaveValue("https://linux.do/t/topic/2964597/1216");

  await topic.fill("https://example.com/t/2964597/1216");
  await page.locator("#work-title").focus();
  await expect(
    page.getByText("请填写有效的 Linux DO 主题或回复链接。"),
  ).toBeVisible();
});

test("topic link inspection catches whitespace, trailing slash, chinese slug and invalid variants", async ({
  page,
}) => {
  expect(inspectTopicLink("https://linux.do/t/2964597/1216")).toMatchObject({
    valid: true,
    canonical: "https://linux.do/t/topic/2964597/1216",
    canOptimize: true,
    redundantRanges: [],
  });
  expect(
    inspectTopicLink("https://linux.do/t/topic/2964597/1216"),
  ).toMatchObject({
    valid: true,
    canonical: "https://linux.do/t/topic/2964597/1216",
    canOptimize: false,
    redundantRanges: [],
  });
  expect(inspectTopicLink("https://linux.do/t/topic/2964597")).toMatchObject({
    valid: true,
    canonical: "https://linux.do/t/topic/2964597/1",
    canOptimize: true,
    redundantRanges: [],
  });
  expect(inspectTopicLink("https://linux.do/t/topic/2964597/1/")).toMatchObject(
    {
      valid: true,
      canonical: "https://linux.do/t/topic/2964597/1",
      canOptimize: true,
      redundantRanges: [[34, 35]],
    },
  );
  expect(inspectTopicLink(" https://linux.do/t/2964597/1216 ")).toMatchObject({
    valid: true,
    canOptimize: true,
    redundantRanges: [
      [0, 1],
      [32, 33],
    ],
  });
  expect(inspectTopicLink("https://linux.do/t/2964597/1216/")).toMatchObject({
    valid: true,
    canOptimize: true,
    redundantRanges: [[31, 32]],
  });
  const chinese = inspectTopicLink(
    "https://linux.do/t/中文标题/2964597/1216?utm=demo#reply",
  );
  expect(chinese).toMatchObject({
    valid: true,
    canonical: "https://linux.do/t/topic/2964597/1216",
    canOptimize: true,
  });
  expect(
    chinese.redundantRanges.map(([start, end]) =>
      "https://linux.do/t/中文标题/2964597/1216?utm=demo#reply".slice(
        start,
        end,
      ),
    ),
  ).toEqual(["中文标题", "?utm=demo", "#reply"]);
  expect(inspectTopicLink("https://example.com/t/2964597/1216")).toMatchObject({
    valid: false,
    canOptimize: false,
  });

  await page.goto("/#create");
  const topic = page.locator("#work-topic");
  await topic.fill("https://linux.do/t/中文标题/2964597/1216/");
  await expect(page.locator(".topic-input__marked")).toHaveText([
    "中文标题",
    "/",
  ]);
  await expect(page.locator(".topic-input__mirror")).toHaveCSS(
    "color",
    "rgb(244, 246, 248)",
  );
  await expect(topic).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("duration unit selector keeps the number and validates near the field", async ({
  page,
}) => {
  await page.goto("/#create");
  await page.locator(".work-more-settings > summary").click();

  await page.getByRole("button", { name: "开放时长单位" }).click();
  await page.locator(".action-menu-item", { hasText: "天" }).click();
  await expect(page.locator("#work-duration")).toHaveValue("24");
  await expect(page.locator(".work-summary-details")).toContainText("24 天");
  await page.getByRole("button", { name: "开放时长单位" }).click();
  await expect(page.getByRole("menu", { name: "开放时长单位" })).toHaveCSS(
    "background-color",
    "rgb(37, 40, 45)",
  );
  await page.keyboard.press("Escape");

  await page.locator("#work-duration").fill("");
  await page.locator("#work-title").focus();
  await expect(page.getByText("开放时长需要填写正整数。")).toBeVisible();
  await page.locator("#work-duration").fill("5");
  await expect(page.getByText("开放时长需要填写正整数。")).toHaveCount(0);
});

test("amount and count relation errors appear when the related edited field changes", async ({
  page,
}) => {
  await page.goto("/#create");
  const plans = page.getByRole("group", { name: "LDC 奖励方式" });

  await plans.getByRole("button", { name: "即时随机", exact: true }).click();
  await page.locator("#work-random-amount").fill("0.01");
  await page.locator("#work-random-count").fill("20");
  await page.locator("#work-title").focus();
  await expect(
    page.getByText("总金额不足，每份至少需要 0.01 LDC。"),
  ).toBeVisible();
  await page.locator("#work-random-count").fill("1");
  await expect(
    page.getByText("总金额不足，每份至少需要 0.01 LDC。"),
  ).toHaveCount(0);

  await plans.getByRole("button", { name: "限时开奖", exact: true }).click();
  await page.locator("#work-draw-amount").fill("0.01");
  await page.locator("#work-draw-winners").fill("20");
  await page.locator("#work-title").focus();
  await expect(
    page.getByText("总奖池不足，每个获奖名额至少需要 0.01 LDC。"),
  ).toBeVisible();
  await page.locator("#work-draw-winners").fill("1");
  await expect(
    page.getByText("总奖池不足，每个获奖名额至少需要 0.01 LDC。"),
  ).toHaveCount(0);
});

test("reward type switching keeps the exiting panel inert while the new fields appear", async ({
  page,
}) => {
  await page.goto("/#create");
  await page
    .getByRole("group", { name: "奖励类型" })
    .getByRole("button", { name: "文本 / CDK", exact: true })
    .click();

  await expect(page.locator("#work-text-rewards")).toBeVisible();
  const exitingFixed = page.locator('[aria-hidden="true"] #work-fixed-amount');
  await expect(exitingFixed).toHaveCount(1);
  await expect(exitingFixed).toHaveCount(0);
  await expect(page.locator(".work-reward-panel")).toHaveCount(1);
});

test("draft save uses canonical topic, and frozen edits disable duration", async ({
  page,
}) => {
  await page.goto("/#create");
  await page.locator("#work-title").fill("规范链接保存活动");
  await page.locator("#work-fixed-amount").fill("0.88");
  await page.locator("#work-fixed-count").fill("2");
  await page.locator("#work-password-1").fill("规范保存口令");
  await page
    .locator("#work-topic")
    .fill("https://linux.do/t/topic-title/2964597/1216?utm=demo#reply");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page
    .getByRole("dialog", { name: "演示草稿已保存" })
    .getByRole("button", { name: "查看我的活动", exact: true })
    .click();

  const saved = page.getByTestId("managed-activity").first();
  await expect(saved).toContainText("规范链接保存活动");
  await saved
    .getByRole("button", { name: "规范链接保存活动：编辑草稿" })
    .click();
  await expect(page.locator("#work-topic")).toHaveValue(
    "https://linux.do/t/topic/2964597/1216",
  );

  await page.goto("/#manage");
  await page
    .getByTestId("managed-activity")
    .filter({ hasText: "周末红包 · 20 份" })
    .first()
    .getByRole("button", { name: /编辑配置/u })
    .click();
  await page.locator(".work-more-settings > summary").click();
  await expect(page.locator("#work-duration")).toBeDisabled();
  await expect(page.getByLabel("开放时长单位")).toBeDisabled();
});
