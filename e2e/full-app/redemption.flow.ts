import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, test } from "@playwright/test";
import {
  activityImageUrl,
  emptyActivityInput,
  encodeActivityEmoji,
  type ManagedActivity,
} from "../../packages/contracts/src";
import { fullAppMerchant } from "./ldc-fixture";
import {
  localOnly,
  origin,
  signIn,
  waitForBoot,
  waitOutCooldown,
} from "./session";

// The new shell on the real stack: sign-in through the actual Connect
// callback, 口令 lookups (phase 1) and claiming on the 红包 page (phase 2)
// against the real API, D1, ActivityDO and payments. Activities are created
// through the normal API.

async function createOpenActivity(
  context: BrowserContext,
  csrfToken: string,
  title: string,
  passwords: string[],
) {
  const merchant = await fullAppMerchant(context, csrfToken, origin);
  const headers = { Origin: origin, "X-CSRF-Token": csrfToken };
  const created = await context.request.post("/api/activities", {
    headers,
    data: {
      requestId: randomUUID(),
      activity: {
        ...emptyActivityInput(),
        title,
        passwords,
        merchantId: merchant.id,
        deadline: { mode: "duration", value: 1, unit: "days" },
        money: { mode: "fixed", totalAmount: "0.30", count: 3 },
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const activity = ((await created.json()) as { activity: ManagedActivity })
    .activity;
  const opened = await context.request.post(
    `/api/me/activities/${activity.id}/open`,
    { headers, data: { version: activity.version } },
  );
  expect(opened.status(), await opened.text()).toBe(200);
  return activity.id;
}

test("真实登录后在起始页查找口令：未匹配、多个匹配和单个匹配", async ({
  browser,
}) => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const shared = `共享${suffix}`;
  const single = `单独${suffix}`;

  const authorContext = await browser.newContext({ baseURL: origin });
  await localOnly(authorContext);
  const author = await authorContext.newPage();
  const authorCsrf = await signIn(author, "author");
  const firstId = await createOpenActivity(
    authorContext,
    authorCsrf,
    "完整应用共享甲",
    [shared],
  );
  const secondId = await createOpenActivity(
    authorContext,
    authorCsrf,
    "完整应用共享乙",
    [shared],
  );
  const singleId = await createOpenActivity(
    authorContext,
    authorCsrf,
    "完整应用单独",
    [single],
  );
  await authorContext.close();

  const context = await browser.newContext({ baseURL: origin });
  await localOnly(context);
  const page = await context.newPage();
  await signIn(page, "recipient");
  const input = page.getByRole("textbox", { name: "口令、红包链接或命令" });

  await input.fill(`无此口令${suffix}`);
  await page.keyboard.press("Enter");
  await expect(
    page.locator("#view").getByText(/^未匹配到红包，/),
  ).toBeVisible();
  await waitOutCooldown(page);

  await input.fill(shared);
  await page.keyboard.press("Enter");
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toMatch(/^\/🔑\/[0-9a-f-]{36}$/);
  await expect(page.getByText(`口令 ${shared} 匹配到 2 个红包`)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /完整应用共享甲/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /完整应用共享乙/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /完整应用共享乙/ }).click();
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe(`/🧧/${encodeActivityEmoji(secondId)}`);
  expect(firstId).not.toBe(secondId);

  await page.goto("/");
  await waitForBoot(page);
  // 最近输入 lists this browser's lookups for the account.
  await expect(
    page.getByRole("button", { name: `填入 ${shared}，已匹配` }),
  ).toBeVisible();
  await waitOutCooldown(page);
  await input.fill(single);
  await page.keyboard.press("Enter");
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe(`/🧧/${encodeActivityEmoji(singleId)}`);
  await context.close();
});

test("在红包页用口令领取：到账、名单和内嵌图", async ({ browser }) => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const password = `红包页${suffix}`;

  const authorContext = await browser.newContext({ baseURL: origin });
  await localOnly(authorContext);
  const author = await authorContext.newPage();
  const authorCsrf = await signIn(author, "author");
  const id = await createOpenActivity(
    authorContext,
    authorCsrf,
    "完整应用红包页",
    [password],
  );
  await authorContext.close();

  const context = await browser.newContext({ baseURL: origin });
  await localOnly(context);
  const page = await context.newPage();
  await signIn(page, "recipient2");
  await page.goto(`/🧧/${encodeActivityEmoji(id)}`);
  await waitForBoot(page);
  await expect(
    page.getByRole("heading", { name: "完整应用红包页", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "输入口令领取" }).click();
  const input = page.getByRole("textbox", { name: "口令、红包链接或命令" });
  await expect(input).toBeFocused();
  await input.fill(password);
  await page.keyboard.press("Enter");

  await expect(
    page.getByRole("status").filter({ hasText: "已领取 0.10 LDC。" }),
  ).toHaveCount(1);
  await expect(page.getByText("1 / 3 份")).toBeVisible();
  // The simulated upstream confirms the payment; the page follows it.
  await expect(page.getByText("已发放")).toBeVisible({ timeout: 30_000 });
  await page.locator("#roster-entry").click();
  const roster = page.getByRole("dialog", { name: /领取名单/ });
  await expect(roster.getByText("完整应用第二参与者")).toBeVisible();
  await page.keyboard.press("Escape");

  // The forum image answers this viewer with their own result.
  const image = await context.request.get(
    new URL(activityImageUrl(id, origin)).pathname,
  );
  expect(image.headers()["content-type"]).toContain("image/svg+xml");
  const svg = await image.text();
  expect(svg).toContain("你已领取");
  expect(svg).toContain("0.10 LDC");
  expect(svg).toContain("已发放");
  await context.close();
});
