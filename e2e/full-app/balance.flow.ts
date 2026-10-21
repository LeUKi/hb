import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { localOnly, origin, signIn, waitForBoot } from "./session";

// 🐟额, step one, on the real stack: the harness's LDC substitute takes
// the EPay order and plays Credit's cashier (e2e/full-app/upstream.mjs).

const control = "http://127.0.0.1:4194";

/** On 网站设置: the platform app, made by this admin if there is none yet. */
async function ensurePlatformApp(admin: Page) {
  const app = admin.getByRole("region", { name: "平台应用" });
  if (await admin.getByRole("button", { name: "新建平台应用" }).count()) {
    await admin
      .getByLabel("Client ID")
      .fill(`hb_full_app_merchant_${randomBytes(4).toString("hex")}`);
    await admin.getByLabel("密钥").fill("full-app-merchant-secret");
    await admin.getByRole("button", { name: "新建平台应用" }).click();
  }
  await expect(app.getByText("凭证通过")).toBeVisible({ timeout: 20_000 });
  return app;
}

test("🐟额：管理员配好平台应用、邀请领取者，领取者接受后转入、确认后到账，扣回写着原因，再转出到 Credit", async ({
  browser,
}) => {
  // 网站设置: the platform app, then 转入 and 转出 on.
  const adminContext = await browser.newContext({ baseURL: origin });
  await localOnly(adminContext);
  const admin = await adminContext.newPage();
  await signIn(admin, "author");
  await admin.goto("/admin/settings");
  await waitForBoot(admin);
  await ensurePlatformApp(admin);
  const fishSettings = admin.getByRole("region", { name: "🐟额" });
  for (const name of ["转入", "转出"]) {
    const toggle = fishSettings.getByRole("switch", { name });
    if ((await toggle.getAttribute("aria-checked")) !== "true")
      await toggle.click();
  }
  if (await fishSettings.getByRole("button", { name: "撤销修改" }).count()) {
    await fishSettings.getByRole("button", { name: "保存🐟额设置" }).click();
    await expect(fishSettings.getByText("已保存，立即生效")).toBeVisible();
  }

  // 邀请: the admin invites the recipient (once: a later run finds them in).
  await admin.goto("/balance");
  await waitForBoot(admin);
  // 邀请 is in PLUS's bubble: the 站长 has PLUS (balance-design §13).
  await admin
    .locator("header")
    .getByRole("button", { name: "🐟额 PLUS", exact: true })
    .click();
  await admin
    .getByRole("dialog", { name: "🐟额 PLUS" })
    .getByRole("button", { name: /邀请别人开通/ })
    .click();
  const inviteDialog = admin.getByRole("dialog", { name: "邀请开通🐟额 PLUS" });
  await inviteDialog.getByLabel("对方的用户名").fill("FullAppRecipient");
  await expect(
    inviteDialog.getByText(
      /完整应用领取者 @FullAppRecipient|已经开通|还没来过本站/,
    ),
  ).toBeVisible();
  let inviteUrl: string | null = null;
  if (!(await inviteDialog.getByText("已经开通").count())) {
    await inviteDialog.getByRole("button", { name: "生成链接" }).click();
    inviteUrl = await inviteDialog
      .getByRole("textbox", { name: "邀请链接" })
      .inputValue();
    expect(inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  }

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
  if (inviteUrl) {
    await page.goto(new URL(inviteUrl).pathname);
    await waitForBoot(page);
    await expect(
      page.getByText(/流转费（\d+%）全部由 Credit 收取，本站没有任何收益/),
    ).toBeVisible();
    await page.getByRole("button", { name: "接受邀请" }).click();
    await page.waitForURL(/\/balance$/);
    await page.goto("/");
    await waitForBoot(page);
  }
  await page.locator("#identity-button").click();
  await page.getByRole("link", { name: /🐟额/ }).click();
  await expect(page.getByRole("heading", { name: "🐟额" })).toBeVisible();
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

  // 转出: back to the recipient's own Credit account, sent by the queue.
  await page
    .locator("header")
    .getByRole("button", { name: "转出", exact: true })
    .click();
  const out = page.getByRole("dialog", { name: "转出🐟额" });
  await out.getByLabel("转出数量").fill("5");
  await out.getByRole("button", { name: "转出", exact: true }).click();
  await page.waitForURL(/\/balance\/out\/[0-9a-f-]{36}$/);
  await expect(page.getByText("已发放", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.goto("/balance");
  await waitForBoot(page);
  await expect(figure).toContainText((before + 5).toFixed(2));
});

test("🐟额通用链接：管理员生成、自己打开看到提示，停用后别人打开写着已停用", async ({
  browser,
}) => {
  const adminContext = await browser.newContext({ baseURL: origin });
  await localOnly(adminContext);
  const admin = await adminContext.newPage();
  await signIn(admin, "author");
  await admin.goto("/admin/balance");
  await waitForBoot(admin);
  await admin.getByRole("button", { name: "邀请", exact: true }).click();
  const dialog = admin.getByRole("dialog", { name: "邀请" });
  await dialog.getByRole("button", { name: "通用链接", exact: true }).click();
  await dialog.getByLabel("最多几个人用").fill("1");
  await dialog.getByRole("button", { name: "生成链接" }).click();
  const url = await dialog
    .getByRole("textbox", { name: "通用链接" })
    .inputValue();
  expect(url).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  const newest = dialog.getByRole("listitem").first();
  await expect(newest).toContainText("已用 0 / 1 人");
  await expect(newest).toContainText("有效");

  // Its maker cannot use it.
  const own = await adminContext.newPage();
  await own.goto(new URL(url).pathname);
  await waitForBoot(own);
  await expect(
    own.getByText("这是以你的名义生成的通用链接，发给要邀请的人就好。"),
  ).toBeVisible();
  await own.close();

  // 停用, over the modal: then no one more.
  await newest.getByRole("button", { name: "停用" }).click();
  const confirm = admin.getByRole("dialog", { name: "停用这条链接？" });
  await confirm.getByRole("button", { name: "停用" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(newest).toContainText("已停用");
  await expect(dialog).toBeVisible();

  const context = await browser.newContext({ baseURL: origin });
  await localOnly(context);
  const page = await context.newPage();
  await signIn(page, "latecomer");
  await page.goto(new URL(url).pathname);
  await waitForBoot(page);
  await expect(page.getByText("这条邀请链接已经停用。")).toBeVisible();
  await expect(page.getByRole("button", { name: "接受邀请" })).toHaveCount(0);
});

test("🐟额通用链接：永久、不限人数、以别人的名义带附言，邀请页写着他和附言", async ({
  browser,
}) => {
  // The one it is in the name of has been here.
  const namedContext = await browser.newContext({ baseURL: origin });
  await localOnly(namedContext);
  const named = await namedContext.newPage();
  await signIn(named, "recipient2");

  const adminContext = await browser.newContext({ baseURL: origin });
  await localOnly(adminContext);
  const admin = await adminContext.newPage();
  await signIn(admin, "author");
  await admin.goto("/admin/balance");
  await waitForBoot(admin);
  await admin.getByRole("button", { name: "邀请", exact: true }).click();
  const dialog = admin.getByRole("dialog", { name: "邀请" });
  await dialog.getByRole("button", { name: "通用链接", exact: true }).click();
  await dialog.getByRole("button", { name: "永久", exact: true }).click();
  await dialog.getByLabel("以谁的名义").fill("nobody-was-here");
  await expect(dialog.getByText("这个人还没来过本站")).toBeVisible();
  await dialog.getByLabel("以谁的名义").fill("@FullAppSecond");
  await expect(
    dialog.locator("p").filter({ hasText: "@FullAppSecond" }),
  ).toBeVisible();
  await dialog.getByLabel("附言").fill("example.com 的用户\n在这里开通");
  await dialog.getByRole("button", { name: "生成链接" }).click();
  await expect(
    dialog.getByText(
      "通用链接（不限人数，永久有效，以 @FullAppSecond 的名义）：",
    ),
  ).toBeVisible();
  const url = await dialog
    .getByRole("textbox", { name: "通用链接" })
    .inputValue();
  const newest = dialog.getByRole("listitem").first();
  await expect(newest).toContainText("已用 0 人");
  await expect(newest).toContainText("邀请人 @FullAppSecond");
  await expect(newest).toContainText("永久有效");
  await expect(newest).toContainText("附言：example.com 的用户 在这里开通");

  // In his name: his to hand out.
  await named.goto(new URL(url).pathname);
  await waitForBoot(named);
  await expect(
    named.getByRole("heading", { name: /@FullAppSecond）邀请你开通🐟额 PLUS/ }),
  ).toBeVisible();
  await expect(
    named.getByText(/example\.com 的用户\s*在这里开通/),
  ).toBeVisible();
  await expect(
    named.getByText("这是以你的名义生成的通用链接，发给要邀请的人就好。"),
  ).toBeVisible();

  // Anyone else may take it, the 附言 under the title.
  const context = await browser.newContext({ baseURL: origin });
  await localOnly(context);
  const page = await context.newPage();
  await signIn(page, "latecomer");
  await page.goto(new URL(url).pathname);
  await waitForBoot(page);
  await expect(
    page.getByText(/example\.com 的用户\s*在这里开通/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "接受邀请" })).toBeVisible();

  // Left stopped, so no later test finds it open.
  await newest.getByRole("button", { name: "停用" }).click();
  await admin
    .getByRole("dialog", { name: "停用这条链接？" })
    .getByRole("button", { name: "停用" })
    .click();
  await expect(newest).toContainText("已停用");
});

test("站长：🐟额页补加和扣回自己的🐟，扣回不超过可用；换 Client ID 时提醒先扣回", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: origin });
  await localOnly(context);
  const page = await context.newPage();
  await signIn(page, "author");
  await page.goto("/admin/settings");
  await waitForBoot(page);
  await ensurePlatformApp(page);

  // The one who set up the platform app: 补加 and 扣回 for 转入 and 转出.
  await page.goto("/balance");
  await waitForBoot(page);
  const header = page.locator("header");
  await expect(
    header.getByRole("button", { name: "补加", exact: true }),
  ).toBeVisible();
  await expect(header.getByRole("button", { name: "转入" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "转出" })).toHaveCount(0);

  await header.getByRole("button", { name: "补加", exact: true }).click();
  const add = page.getByRole("dialog", { name: "补加🐟额" });
  await expect(add).toContainText("不付款，只在账上给你记🐟");
  await add.getByLabel("补加数量").fill("2000.01");
  await expect(add.getByText("一次最多 2000.00 🐟。")).toBeVisible();
  await add.getByLabel("补加数量").fill("5");
  await add.getByRole("button", { name: "补加", exact: true }).click();
  await expect(add).toBeHidden();
  const first = page.getByRole("listitem").first();
  await expect(first).toContainText("站长补加");
  await expect(first).toContainText("给自己补加");

  await header.getByRole("button", { name: "扣回", exact: true }).click();
  const back = page.getByRole("dialog", { name: "扣回🐟额" });
  await back.getByLabel("扣回数量").fill("1999999");
  await expect(
    back.getByText(/^可用只有 .+ 🐟，最多扣回这么多。$/),
  ).toBeVisible();
  await back.getByLabel("扣回数量").fill("2");
  await back.getByRole("button", { name: "扣回", exact: true }).click();
  await expect(back).toBeHidden();
  await expect(page.getByRole("listitem").first()).toContainText("给自己扣回");

  // 网站设置: another Client ID would stand behind what the 站长 holds.
  await page.goto("/admin/settings");
  await waitForBoot(page);
  const app = await ensurePlatformApp(page);
  const clientId = app.getByLabel("Client ID");
  await clientId.click();
  await clientId.press("End");
  await clientId.pressSequentially("_other");
  await expect(app.getByText(/^站长账上还有 .+ 🐟。/)).toBeVisible();
  await context.close();
});
