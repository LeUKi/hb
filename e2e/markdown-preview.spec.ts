import { expect, type Page, test } from "@playwright/test";

const user = {
  id: "markdown-user",
  username: "markdowner",
  displayName: "Markdown 作者",
  avatarUrl: null,
  email: null,
};

async function mockFormSession(page: Page) {
  await page.route(/\/api\/(?:session|me)$/, (route) =>
    route.fulfill({ json: { user, csrfToken: "csrf-markdown" } }),
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

async function openNotesEditor(page: Page) {
  await mockFormSession(page);
  await page.goto("/activities/new");
  await expect(page.getByRole("heading", { name: "发起活动" })).toBeVisible();
  await page.locator("summary", { hasText: "更多设置" }).click();
  await expect(page.getByRole("group", { name: "说明预览模式" })).toBeVisible();
}

function beforePreview(page: Page) {
  return page
    .locator("section.work-note-editor", { hasText: "活动说明" })
    .locator(".work-note-preview")
    .first();
}

test("Markdown 预览支持层级、列表、GFM、引用、代码和安全链接", async ({
  page,
}) => {
  await openNotesEditor(page);
  const markdown = `# 一级标题\n## 二级标题\n### 三级标题\n#### 四级标题\n##### 五级标题\n###### 六级标题\n\n- 外层项目\n  - 内层项目\n1. 第一项\n   1. 子序号\n\n| 列 A | 列 B |\n| --- | ---: |\n| 左侧 | 42 |\n\n~~删除内容~~\n- [x] 已完成\n- [ ] 未完成\n\n> 引用内容\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n\n[外部安全链接](https://example.com/path?q=1)\n[内部安全链接](/square)\n<script>alert('xss')</script>\n![图片说明](https://example.com/image.png)\n[javascript 链接](javascript:alert(1))`;
  await page.locator("#activity-beforeInfo").fill(markdown);
  await page
    .getByRole("group", { name: "说明预览模式" })
    .getByRole("button", { name: "Markdown" })
    .click();

  const preview = beforePreview(page);
  for (const [level, name] of [
    [1, "一级标题"],
    [2, "二级标题"],
    [3, "三级标题"],
    [4, "四级标题"],
    [5, "五级标题"],
    [6, "六级标题"],
  ] as const) {
    await expect(preview.getByRole("heading", { level, name })).toBeVisible();
  }
  await expect(preview.locator("ul li", { hasText: "外层项目" })).toBeVisible();
  await expect(
    preview.locator("ul ul li", { hasText: "内层项目" }),
  ).toBeVisible();
  await expect(
    preview.locator("ol li", { hasText: "第一项" }).first(),
  ).toBeVisible();
  await expect(
    preview.locator("ol ol li", { hasText: "子序号" }),
  ).toBeVisible();
  await expect(
    preview
      .locator("ul")
      .first()
      .evaluate((node) => getComputedStyle(node).listStyleType),
  ).resolves.toBe("disc");
  await expect(
    preview
      .locator("ol")
      .first()
      .evaluate((node) => getComputedStyle(node).listStyleType),
  ).resolves.toBe("decimal");
  const headingSizes = await Promise.all(
    [1, 2, 3].map((level) =>
      preview
        .getByRole("heading", { level })
        .first()
        .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    ),
  );
  const [h1Size, h2Size, h3Size] = headingSizes;
  if (h1Size === undefined || h2Size === undefined || h3Size === undefined)
    throw new Error("Missing markdown heading preview size");
  expect(h1Size).toBeGreaterThan(h2Size);
  expect(h2Size).toBeGreaterThan(h3Size);
  await expect(preview.getByRole("table")).toBeVisible();
  await expect(preview.locator("th", { hasText: "列 A" })).toBeVisible();
  const numericCell = preview.locator("td", { hasText: "42" });
  await expect(numericCell).toBeVisible();
  await expect(
    numericCell.evaluate((node) => getComputedStyle(node).textAlign),
  ).resolves.toBe("right");
  await expect(preview.locator("del", { hasText: "删除内容" })).toBeVisible();
  const checkedTask = preview.locator('input[type="checkbox"][checked]');
  const uncheckedTask = preview.locator(
    'input[type="checkbox"]:not([checked])',
  );
  await expect(checkedTask).toHaveCount(1);
  await expect(uncheckedTask).toHaveCount(1);
  const taskBox = await checkedTask.first().boundingBox();
  expect(taskBox).not.toBeNull();
  expect(taskBox?.width ?? 0).toBeGreaterThanOrEqual(10);
  expect(taskBox?.width ?? 0).toBeLessThanOrEqual(24);
  expect(taskBox?.height ?? 0).toBeGreaterThanOrEqual(10);
  expect(taskBox?.height ?? 0).toBeLessThanOrEqual(24);
  await expect(
    preview.locator("blockquote", { hasText: "引用内容" }),
  ).toBeVisible();
  await expect(
    preview.locator("pre code", { hasText: "const answer = 42;" }),
  ).toBeVisible();

  const external = preview.getByRole("link", { name: "外部安全链接" });
  await expect(external).toHaveAttribute(
    "href",
    "https://example.com/path?q=1",
  );
  await expect(external).toHaveAttribute("target", "_blank");
  await expect(external).toHaveAttribute("rel", /noopener/);
  await expect(
    preview.getByRole("link", { name: "内部安全链接" }),
  ).toHaveAttribute("href", "/square");
  await expect(preview.locator("script")).toHaveCount(0);
  await expect(preview.locator("img")).toHaveCount(0);
  await expect(preview.getByText("alert('xss')")).toHaveCount(0);
  await expect(
    preview.getByRole("link", { name: "javascript 链接" }),
  ).toHaveCount(0);
});

test("窄屏下长表格和代码块不撑宽页面", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openNotesEditor(page);
  const longToken = "LONG_MARKDOWN_TOKEN_".repeat(12);
  await page
    .locator("#activity-beforeInfo")
    .fill(
      `| 很长的列名 | 另一列 |\n| --- | --- |\n| ${longToken} | ${longToken} |\n\n\`\`\`text\n${longToken}${longToken}\n\`\`\``,
    );
  await page
    .getByRole("group", { name: "说明预览模式" })
    .getByRole("button", { name: "Markdown" })
    .click();

  const preview = beforePreview(page);
  await expect(preview.getByRole("table")).toBeVisible();
  await expect(preview.locator("pre code")).toContainText(longToken);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
});

test("说明模式切换保留三个字段的原始值和预览内容", async ({ page }) => {
  await openNotesEditor(page);
  const values = {
    "#activity-beforeInfo": "活动说明 **加粗**",
    "#activity-afterClaimInfo": "奖励附言 `CODE`",
    "#activity-afterEndInfo": "结束说明\n\n> 引用",
  };
  for (const [selector, value] of Object.entries(values))
    await page.locator(selector).fill(value);

  const switcher = page.getByRole("group", { name: "说明预览模式" });
  await switcher.getByRole("button", { name: "原文" }).click();
  for (const [selector, value] of Object.entries(values))
    await expect(page.locator(selector)).toHaveValue(value);
  await expect(page.locator(".work-note-preview")).toHaveCount(0);

  await switcher.getByRole("button", { name: "Markdown" }).click();
  for (const selector of Object.keys(values))
    await expect(page.locator(selector)).toHaveCount(0);
  await expect(page.getByText("活动说明 加粗")).toBeVisible();
  await expect(page.locator("code", { hasText: "CODE" })).toBeVisible();
  await expect(page.locator("blockquote", { hasText: "引用" })).toBeVisible();

  await switcher.getByRole("button", { name: "分栏" }).click();
  for (const [selector, value] of Object.entries(values))
    await expect(page.locator(selector)).toHaveValue(value);
});
