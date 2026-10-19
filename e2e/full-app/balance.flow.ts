import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { localOnly, origin, signIn, waitForBoot } from "./session";

// 站内🐟额, step one, on the real stack: the harness's LDC substitute takes
// the EPay order and plays Credit's cashier (e2e/full-app/upstream.mjs).

const control = "http://127.0.0.1:4194";

test("站内🐟额：管理员配好平台应用和白名单，领取者转入、确认后到账，扣回写着原因", async ({
  browser,
}) => {
  // 网站设置: the platform app, then 转入 on for the recipient alone.
  const adminContext = await browser.newContext({ baseURL: origin });
  await localOnly(adminContext);
  const admin = await adminContext.newPage();
  await signIn(admin, "author");
  await admin.goto("/admin/settings");
  await waitForBoot(admin);
  const app = admin.getByRole("region", { name: "平台应用" });
  if (await admin.getByRole("button", { name: "新建平台应用" }).count()) {
    await admin
      .getByLabel("Client ID")
      .fill(`hb_full_app_merchant_${randomBytes(4).toString("hex")}`);
    await admin.getByLabel("密钥").fill("full-app-merchant-secret");
    await admin.getByRole("button", { name: "新建平台应用" }).click();
  }
  await expect(app.getByText("凭证通过")).toBeVisible({ timeout: 20_000 });
  const fishSettings = admin.getByRole("region", { name: "站内🐟额" });
  const topups = fishSettings.getByRole("switch", { name: "转入" });
  if ((await topups.getAttribute("aria-checked")) !== "true")
    await topups.click();
  await fishSettings.getByLabel("名单", { exact: true }).fill("730002");
  await fishSettings.getByRole("button", { name: "保存🐟额设置" }).click();
  await expect(fishSettings.getByText("已保存，立即生效")).toBeVisible();

  // The recipient: the entry, a 转入, Credit's cashier, back here.
  const context = await browser.newContext({ baseURL: origin });
  await localOnly(context);
  await context.route("https://credit.linux.do/paying**", async (route) => {
    const orderNo = new URL(route.request().url()).searchParams.get("order_no");
    const paid = (await (
      await fetch(
        `${control}/upstream/pay?order_no=${encodeURIComponent(orderNo ?? "")}`,
        { method: "POST" },
      )
    ).json()) as { returnUrl: string | null };
    expect(paid.returnUrl).toMatch(/\/balance\/[0-9a-f-]{36}$/);
    await route.fulfill({
      status: 302,
      headers: { Location: paid.returnUrl ?? "/" },
    });
  });
  const page = await context.newPage();
  await signIn(page, "recipient");
  await page.locator("#identity-button").click();
  await page.getByRole("link", { name: /站内🐟额/ }).click();
  await expect(page.getByRole("heading", { name: "站内🐟额" })).toBeVisible();
  // 可用, as it reads once its figures stop rolling.
  const figure = page.locator("dl dd").first();
  await expect(figure).toContainText(/\d+\.\d{2}/);
  const before = Number(
    /(\d+\.\d{2})/.exec((await figure.textContent()) ?? "")?.[1],
  );
  await page
    .locator("header")
    .getByRole("button", { name: "转入", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "转入🐟额" });
  await dialog.getByLabel("到账").fill("12");
  await expect(dialog.getByLabel("Credit 扣除")).toHaveValue("13.64");
  await expect(dialog.getByText(/流转费 1\.64 LDC/)).toBeVisible();
  await dialog.getByRole("button", { name: "去 Credit 确认" }).click();
  await page.waitForURL(/\/balance\/[0-9a-f-]{36}$/);
  await expect(page.getByText("已到账", { exact: true }).first()).toBeVisible();
  await page.goto("/balance");
  await waitForBoot(page);
  await expect(figure).toContainText((before + 12).toFixed(2));

  // 网站管理: the 转入 is listed; a 扣回 with a reason the person reads.
  await admin.goto("/admin/balance?status=all");
  await waitForBoot(admin);
  await expect(admin.getByText("完整应用领取者").first()).toBeVisible();
  await admin.goto("/admin/users?q=FullAppRecipient");
  await waitForBoot(admin);
  await admin
    .getByRole("button", { name: /完整应用领取者/ })
    .first()
    .click();
  await admin.getByRole("button", { name: "调整🐟额" }).click();
  const adjust = admin.getByRole("dialog", { name: "调整🐟额" });
  await adjust.getByRole("button", { name: "扣回" }).first().click();
  await adjust.getByLabel("数量").fill("2");
  await adjust.getByLabel("原因").fill("完整应用测试扣回");
  await adjust.getByRole("button", { name: "扣回" }).last().click();
  await expect(adjust).toHaveCount(0);

  await page.reload();

  await waitForBoot(page);
  await expect(figure).toContainText((before + 10).toFixed(2));
  await expect(page.getByText("完整应用测试扣回")).toBeVisible();
  await expect(page.getByText("站长扣回").first()).toBeVisible();
});
