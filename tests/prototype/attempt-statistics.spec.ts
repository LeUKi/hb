import { test as base, expect } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const dedicatedId = "20000000-0000-4000-8000-000000000001";

const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const forbidden: string[] = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
          forbidden.push(url.href);
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect(forbidden).toEqual([]);
    },
    { auto: true },
  ],
});

test("dedicated author activity exposes local attempt statistics", async ({
  page,
}) => {
  await page.goto("/#manage");
  const row = page.locator(`[data-activity-id="${dedicatedId}"]`);
  await expect(row).toContainText("尝试统计");
  await row.getByRole("button", { name: /尝试统计/u }).click();
  await expect(page).toHaveURL(
    new RegExp(`statistics\\?activity=${dedicatedId}$`, "u"),
  );
  await expect(
    page.getByRole("heading", { name: "兑换尝试统计" }),
  ).toBeVisible();
  await expect(page.getByText("总尝试次数")).toBeVisible();
  await expect(page.getByText("错误口令2026")).toBeVisible();
  await expect(page.getByText("暂无兑换尝试。", { exact: true })).toHaveCount(
    0,
  );
});

test("ordinary and draft activities do not expose statistics", async ({
  page,
}) => {
  await page.goto("/#manage");
  await expect(
    page
      .locator("[data-testid=managed-activity]")
      .filter({ hasText: "CDK 兑换码 · 12 份" })
      .getByText("尝试统计"),
  ).toHaveCount(0);
  await expect(
    page
      .locator("[data-testid=managed-activity]")
      .filter({ hasText: "准备中" })
      .getByText("尝试统计"),
  ).toHaveCount(0);
});

test("author management menu links to the same statistics view", async ({
  page,
}) => {
  await page.goto(`/#activity?sample=${dedicatedId}`);
  await page.getByRole("button", { name: "复制领取文案" }).click();
  const copyMenu = page.getByRole("menu", { name: "复制领取文案" });
  await expect(copyMenu.getByRole("menuitem")).toHaveText([
    "不含口令",
    "包含全部口令",
  ]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "管理活动" }).click();
  await page
    .getByRole("menu", { name: "管理活动" })
    .getByRole("menuitem", { name: "兑换尝试统计" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`statistics\\?activity=${dedicatedId}$`, "u"),
  );
  await expect(
    page.getByRole("heading", { name: "兑换尝试统计" }),
  ).toBeVisible();
});

test("author management menu exposes edit and payment routes", async ({
  page,
}) => {
  await page.goto(`/#activity?sample=${dedicatedId}`);
  await page.getByRole("button", { name: "管理活动" }).click();
  const menu = page.getByRole("menu", { name: "管理活动" });
  await expect(menu.getByRole("menuitem", { name: "编辑配置" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "付款记录" })).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "兑换尝试统计" }),
  ).toBeVisible();

  await menu.getByRole("menuitem", { name: "付款记录" }).click();
  await expect(page).toHaveURL(
    new RegExp(`payment\\?activity=${dedicatedId}$`, "u"),
  );

  await page.goto(`/#activity?sample=${dedicatedId}`);
  await page.getByRole("button", { name: "管理活动" }).click();
  await page
    .getByRole("menu", { name: "管理活动" })
    .getByRole("menuitem", { name: "编辑配置" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`create\\?edit=${dedicatedId}$`, "u"),
  );
});

test("management actions follow reward type and remain available after ending", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [suffix, expected] of [
    ["003", ["编辑配置", "付款记录"]],
    ["004", ["编辑配置"]],
    ["009", ["编辑配置", "付款记录"]],
  ] as const) {
    await page.goto(
      `/#activity?sample=20000000-0000-4000-8000-000000000${suffix}`,
    );
    await page.getByRole("button", { name: "管理活动" }).click();
    await expect(
      page.getByRole("menu", { name: "管理活动" }).getByRole("menuitem"),
    ).toHaveText([...expected]);
  }
  await page.goto(`/#activity?sample=${dedicatedId}`);
  for (const lifecycle of ["ended", "archived"] as const) {
    await page.evaluate(
      async ({ id, lifecycle }) => {
        const moduleUrl = performance
          .getEntriesByType("resource")
          .find(
            (resource) =>
              new URL(resource.name).pathname === "/pages/workbench-store.ts",
          )?.name;
        if (!moduleUrl) throw new Error("Author store module not loaded");
        const { findWorkbenchActivity } = await import(moduleUrl);
        const activity = findWorkbenchActivity("standard", id);
        activity.status = lifecycle;
        window.location.hash = "home";
      },
      { id: dedicatedId, lifecycle },
    );
    await expect(page).toHaveURL(/#home$/u);
    await page.evaluate((id) => {
      window.location.hash = `activity?sample=${id}`;
    }, dedicatedId);
    await expect(page.locator(".activity-page")).toHaveAttribute(
      "data-lifecycle",
      lifecycle,
    );
    await page.getByRole("button", { name: "管理活动" }).click();
    await expect(
      page.getByRole("menuitem", { name: "兑换尝试统计" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  }
});

test("management requires the current account record and excludes drafts", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#activity?sample=20000000-0000-4000-8000-000000000002");
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-lifecycle",
    "draft",
  );
  await expect(page.getByRole("button", { name: "管理活动" })).toHaveCount(0);

  await page.goto(`/#activity?sample=${dedicatedId}`);
  const identity = page.getByRole("button", { name: "场景与身份" });
  await identity.click();
  await page.getByRole("combobox", { name: "体验身份" }).selectOption("lite");
  await identity.click();
  await expect(page.locator(".activity-page")).toBeVisible();
  await expect(page.getByRole("button", { name: "管理活动" })).toHaveCount(0);
  await page.evaluate(() => {
    window.location.hash =
      "activity?sample=21000000-0000-4000-8000-000000000001";
  });
  await page.getByRole("button", { name: "管理活动" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["编辑配置"]);
  await page.keyboard.press("Escape");

  await page.evaluate(async () => {
    const moduleUrl = performance
      .getEntriesByType("resource")
      .find(
        (resource) =>
          new URL(resource.name).pathname === "/pages/workbench-store.ts",
      )?.name;
    if (!moduleUrl) throw new Error("Author store module not loaded");
    const { exportWorkbenchStoresSnapshot, importWorkbenchStoresSnapshot } =
      await import(moduleUrl);
    const stores = exportWorkbenchStoresSnapshot();
    for (const [identity, store] of stores) {
      if (identity === "lite") store.activities = [];
    }
    importWorkbenchStoresSnapshot(stores);
  });
  await expect(page.getByRole("button", { name: "管理活动" })).toHaveCount(0);
});
