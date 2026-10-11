import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  emptyActivityInput,
  type ManagedActivity,
} from "../../packages/contracts/src";

const origin = "http://127.0.0.1:4193";
const authorizer = /^https:\/\/connect\.linux\.do\/oauth2\/authorize\?/;

type RuntimeState = {
  claims: Array<{ activity_id: string }>;
  registrations: Array<{ activity_id: string }>;
  attempts: Array<{ activity_id: string }>;
  payments: unknown[];
  outbox: unknown[];
  upstream: { oauthTokenRequests: number; oauthProfileRequests: number };
};

async function protectLocalContext(context: BrowserContext) {
  const unexpected: string[] = [];
  await context.route(/^https?:\/\/(?!127\.0\.0\.1:4193(?:\/|$))/, (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "https://avatars.example.test")
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#ddd"/></svg>',
      });
    unexpected.push(`${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          document.documentElement.dataset.activityShared = value;
        },
      },
    });
  });
  return unexpected;
}

async function installOAuthFixture(
  context: BrowserContext,
  role: "author" | "recipient",
) {
  await context.route(authorizer, async (route) => {
    const authorize = new URL(route.request().url());
    expect(authorize.searchParams.get("client_id")).toBe("hb_full_app_connect");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback`,
    );
    const state = authorize.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    const callback = new URL("/api/auth/callback", origin);
    callback.searchParams.set("state", state ?? "");
    callback.searchParams.set("code", `full-app-code-${role}`);
    return route.fulfill({ status: 302, headers: { Location: callback.href } });
  });
}

async function finishOAuth(page: Page, loginHref: string) {
  // Redirect-chain interception is unreliable; the real login endpoint sets
  // state cookies, then a fresh navigation opens only the fixture authorize UI.
  const login = await page
    .context()
    .request.get(loginHref, { maxRedirects: 0 });
  expect(login.status()).toBe(302);
  expect(login.headers().location).toMatch(authorizer);
  await page.goto(login.headers().location ?? "");
}

async function copyLink(page: Page) {
  await page.getByRole("button", { name: "分享活动", exact: true }).click();
  await page.getByRole("menuitem", { name: "复制链接", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.activityShared),
    )
    .toBeTruthy();
  return (
    (await page.evaluate(
      () => document.documentElement.dataset.activityShared,
    )) ?? ""
  );
}

test("真实应用表情入口经本地 OAuth 回到 UUID 并复制表情链接，零兑奖报名付款", async ({
  browser,
  page,
  request,
}) => {
  const authorContext = await browser.newContext({ baseURL: origin });
  const authorExternal = await protectLocalContext(authorContext);
  const viewerExternal = await protectLocalContext(page.context());
  const mutations: string[] = [];
  const activityReads: string[] = [];
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (url.pathname.startsWith("/api/activities/"))
      activityReads.push(url.pathname);
    if (url.pathname.startsWith("/api/") && browserRequest.method() !== "GET")
      mutations.push(`${browserRequest.method()} ${url.pathname}`);
  });
  try {
    await installOAuthFixture(authorContext, "author");
    const authorPage = await authorContext.newPage();
    await finishOAuth(authorPage, "/api/auth/login?returnTo=%2Faccount");
    const sessionResponse = await authorContext.request.get("/api/me");
    expect(sessionResponse.ok()).toBe(true);
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const headers = { Origin: origin, "X-CSRF-Token": session.csrfToken };
    const title = "完整应用表情链接验收";
    const create = await authorContext.request.post("/api/activities", {
      headers,
      data: {
        requestId: randomUUID(),
        activity: {
          ...emptyActivityInput(),
          title,
          forceDedicated: true,
          deadline: { mode: "duration", value: 1, unit: "hours" },
          passwords: ["EmojiFlowPass123"],
          rewards: [{ id: randomUUID(), text: "PRIVATE-EMOJI-REWARD" }],
        },
      },
    });
    expect(create.ok(), await create.text()).toBe(true);
    const created = (await create.json()) as { activity: ManagedActivity };
    const id = created.activity.id;
    const longPath = `/activities/${id}`;
    const open = await authorContext.request.post(
      `/api/me/activities/${id}/open`,
      {
        headers,
        data: { version: created.activity.version },
      },
    );
    expect(open.ok(), await open.text()).toBe(true);
    await authorPage.goto(longPath);
    await expect(
      authorPage.getByRole("heading", { name: title }),
    ).toBeVisible();
    const shortUrl = await copyLink(authorPage);
    expect(shortUrl).toMatch(new RegExp(`^${origin}/e/`));
    expect(shortUrl).not.toContain("%");
    expect(shortUrl).not.toContain(id);
    const before = (await (
      await request.get("http://127.0.0.1:4194/state")
    ).json()) as RuntimeState;

    await installOAuthFixture(page.context(), "recipient");
    await page.goto(shortUrl);
    await expect(page).toHaveURL(longPath);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    const login = page.getByRole("link", { name: "登录领取", exact: true });
    await login.click();
    await expect(page).toHaveURL(/\/account\?/);
    const loginHref = await page
      .getByRole("link", { name: "通过LINUX DO登录", exact: true })
      .getAttribute("href");
    expect(new URL(loginHref ?? "", origin).searchParams.get("returnTo")).toBe(
      longPath,
    );
    await finishOAuth(page, loginHref ?? "");
    await expect(page).toHaveURL(longPath);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(
      page
        .locator("header")
        .getByRole("link", { name: "我的账号", exact: true }),
    ).toBeVisible();
    expect(await copyLink(page)).toBe(shortUrl);
    await expect(
      page.getByText("PRIVATE-EMOJI-REWARD", { exact: true }),
    ).toHaveCount(0);
    expect(activityReads.length).toBeGreaterThan(0);
    expect(
      activityReads.every(
        (path) =>
          path === `/api/activities/${id}` ||
          path.startsWith(`/api/activities/${id}/`),
      ),
    ).toBe(true);
    expect(mutations).toEqual([]);
    const after = (await (
      await request.get("http://127.0.0.1:4194/state")
    ).json()) as RuntimeState;
    for (const rows of [after.claims, after.registrations, after.attempts])
      expect(rows.filter((row) => row.activity_id === id)).toEqual([]);
    expect(after.payments).toHaveLength(before.payments.length);
    expect(after.outbox).toHaveLength(before.outbox.length);
    expect(after.upstream.oauthTokenRequests).toBe(
      before.upstream.oauthTokenRequests + 1,
    );
    expect(after.upstream.oauthProfileRequests).toBe(
      before.upstream.oauthProfileRequests + 1,
    );
    expect(authorExternal).toEqual([]);
    expect(viewerExternal).toEqual([]);
  } finally {
    await authorContext.close();
  }
});
