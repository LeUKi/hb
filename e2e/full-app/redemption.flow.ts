import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  emptyActivityInput,
  encodeActivityEmoji,
  type ManagedActivity,
} from "../../packages/contracts/src";
import { fullAppMerchant } from "./ldc-fixture";

// Migration phase 1 on the real stack: sign-in through the actual Connect
// callback, then 口令 lookups through the new shell against the real API,
// D1 and ActivityDO. Activities are created through the normal API.

const origin = "http://127.0.0.1:4193";
const authorizer = /^https:\/\/connect\.linux\.do\/oauth2\/authorize\?/;

async function localOnly(context: BrowserContext) {
  await context.route("https://avatars.example.test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#ddd"/></svg>',
    }),
  );
}

async function waitForBoot(page: Page) {
  await page.waitForFunction(
    () =>
      (window as unknown as { hbBoot?: { done: boolean } }).hbBoot?.done ===
      true,
  );
}

/**
 * Signs in through the 用户卡片: only LINUX DO's authorize page is
 * simulated; callback, state, token/profile exchange and session are real.
 */
async function signIn(page: Page, role: string) {
  const context = page.context();
  await context.unroute(authorizer);
  await context.route(authorizer, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("client_id")).toBe("hb_full_app_connect");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback`,
    );
    const callback = new URL(`${origin}/api/auth/callback`);
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    callback.searchParams.set("code", `full-app-code-${role}`);
    await route.fulfill({ status: 302, headers: { Location: callback.href } });
  });
  await page.goto("/");
  await waitForBoot(page);
  await page.locator("#identity-button").click();
  // The login button navigates to /api/auth/login, whose redirect to the
  // authorize page is only intercepted on a fresh navigation.
  const login = await context.request.get("/api/auth/login?returnTo=%2F", {
    maxRedirects: 0,
  });
  expect(login.status()).toBe(302);
  await page.goto(login.headers().location ?? "");
  await waitForBoot(page);
  const session = await context.request.get("/api/session");
  const body = (await session.json()) as {
    user: { displayName: string } | null;
    csrfToken: string;
  };
  expect(body.user).not.toBeNull();
  await expect(page.locator("#identity-button")).toHaveAccessibleName(
    `${body.user?.displayName}，打开用户卡片`,
  );
  return body.csrfToken;
}

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

/** The account's attempt cooldown is the server's: wait until it is over. */
async function waitOutCooldown(page: Page) {
  await expect
    .poll(
      async () => {
        const response = await page.context().request.get("/api/session");
        const { attemptCooldown } = (await response.json()) as {
          attemptCooldown: { nextAllowedAt: number; serverTime: number } | null;
        };
        return (
          !attemptCooldown ||
          attemptCooldown.nextAllowedAt <= attemptCooldown.serverTime
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: /还需等待/ })).toHaveCount(0, {
    timeout: 5_000,
  });
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
  await expect(page.locator("#view").getByText("未匹配到红包。")).toBeVisible();
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
