import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  type AttemptRateLimitsResponse,
  emptyActivityInput,
} from "../../packages/contracts/src";
import { fullAppMerchant } from "./ldc-fixture";
import { localOnly, origin, signIn, waitForBoot } from "./session";

// Migration phase 4 on the real stack: the harness's author is on the
// deployment's admin list (ADMIN_LINUX_DO_IDS), so it can open 网站管理.

test("网站管理：全站的红包和用户，改尝试间隔记进操作记录", async ({
  browser,
}) => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const title = `管理页草稿 ${suffix}`;
  const context = await browser.newContext({ baseURL: origin });
  await localOnly(context);
  const page = await context.newPage();
  const csrf = await signIn(page, "author");
  const headers = { Origin: origin, "X-CSRF-Token": csrf };
  const merchant = await fullAppMerchant(context, csrf, origin);
  // A draft with two 口令: only its sender, and admins, know it exists.
  const created = await context.request.post("/api/activities", {
    headers,
    data: {
      requestId: randomUUID(),
      activity: {
        ...emptyActivityInput(),
        title,
        passwords: [`管理甲${suffix}`, `管理乙${suffix}`],
        forceDedicated: true,
        // 仅能在红包页输入口令 comes with 红包广场.
        joinSquare: true,
        merchantId: merchant.id,
        deadline: { mode: "duration", value: 1, unit: "days" },
        money: { mode: "fixed", totalAmount: "0.30", count: 3 },
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  // A tab, once the page before has finished leaving (both have tabs).
  const tab = async (name: string) => {
    const tabs = page.getByRole("navigation", { name: "管理入口" });
    await expect(tabs).toHaveCount(1);
    await tabs.getByRole("link", { name }).click();
  };

  await page.goto("/admin");
  await waitForBoot(page);
  await expect(page.getByText(/每 30 秒自动刷新$/)).toBeVisible();
  await expect(page.getByText("真实红包开放")).toBeVisible();

  // The draft, found by its title; its detail counts the 口令 it has.
  await tab("红包");
  await page.getByRole("searchbox", { name: "搜索红包" }).fill(title);
  const row = page.getByRole("button", { name: new RegExp(title) });
  await expect(row).toContainText("草稿");
  await row.click();
  const pane = page.getByRole("complementary", { name: "详情" });
  await expect(pane.getByText("口令 2 个 · 仅限红包页")).toBeVisible();
  await expect(pane.getByText("0 笔 · 未确认 0 · 异常待处理 0")).toBeVisible();

  // The author is on the admin list, shown and not switchable.
  await tab("用户");
  await page.getByRole("searchbox", { name: "搜索用户" }).fill("FullAppAuthor");
  await expect(
    page.getByRole("button", { name: /完整应用作者.*管理员/ }),
  ).toBeVisible();

  // 网站设置: a save is in 操作记录 at once. Put back afterwards: the other
  // flows count on the usual intervals.
  const read = async () =>
    (await (
      await context.request.get("/api/admin/rate-limits")
    ).json()) as AttemptRateLimitsResponse;
  const before = (await read()).config;
  const next = before.homeIntervalSeconds + 1;
  try {
    await tab("网站设置");
    await page.getByRole("textbox", { name: "起始页" }).fill(String(next));
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(page.getByText("已保存，立即生效")).toBeVisible();
    await expect(
      page.getByText(/^第 \d+ 版 · .* 由 完整应用作者 修改/),
    ).toBeVisible();
    await tab("操作记录");
    await expect(
      page
        .getByText(`起始页 ${before.homeIntervalSeconds} 秒 → ${next} 秒`)
        .first(),
    ).toBeVisible();
  } finally {
    const current = (await read()).config;
    const restored = await context.request.patch("/api/admin/rate-limits", {
      headers,
      data: {
        expectedVersion: current.version,
        homeIntervalSeconds: before.homeIntervalSeconds,
        activityIntervalSeconds: before.activityIntervalSeconds,
      },
    });
    expect(restored.status(), await restored.text()).toBe(200);
  }
  await context.close();
});
