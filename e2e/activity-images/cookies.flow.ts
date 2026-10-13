import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  activityImageUrl,
  emptyActivityInput,
  type ManagedActivity,
} from "../../packages/contracts/src";
import { fullAppMerchant } from "../full-app/ldc-fixture";

const origin = "https://localhost:4199";
async function localOnly(context: BrowserContext) {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["localhost", "127.0.0.1"].includes(url.hostname)
      ? route.continue()
      : route.abort("blockedbyclient");
  });
}
async function login(page: Page, role: string) {
  await page.goto(`/__local/full-app/login?role=${role}&returnTo=%2Faccount`);
  await expect(page).toHaveURL(`${origin}/account`);
  await expect(page.getByRole("heading", { name: "账号信息" })).toBeVisible();
  const response = await page.context().request.get("/api/session");
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ csrfToken: string }>;
}

test("跨站 HTTPS 图片验证真实 Cookie 策略、公开降级、撤销和请求记录", async ({
  browser,
  page,
  request,
}, testInfo) => {
  await localOnly(page.context());
  const authorContext = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  await localOnly(authorContext);
  try {
    const authorPage = await authorContext.newPage();
    const author = await login(authorPage, "author");
    const merchant = await fullAppMerchant(
      authorContext,
      author.csrfToken,
      origin,
    );
    const created = await authorContext.request.post("/api/activities", {
      headers: { Origin: origin, "X-CSRF-Token": author.csrfToken },
      data: {
        requestId: randomUUID(),
        activity: {
          ...emptyActivityInput(),
          title: `动态图片 ${testInfo.project.name}`,
          participationMode: "direct",
          passwords: [],
          merchantId: merchant.id,
          money: { mode: "fixed", totalAmount: "0.02", count: 2 },
          deadline: { mode: "duration", value: 1, unit: "hours" },
        },
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    const activity = ((await created.json()) as { activity: ManagedActivity })
      .activity;
    const opened = await authorContext.request.post(
      `/api/me/activities/${activity.id}/open`,
      {
        headers: { Origin: origin, "X-CSRF-Token": author.csrfToken },
        data: {
          version: activity.version,
          merchantId: merchant.id,
          credentialVersion: merchant.credentialVersion,
        },
      },
    );
    expect(opened.status(), await opened.text()).toBe(200);
    const viewer = await login(page, "recipient");
    const cookies = await page.context().cookies(origin);
    expect(
      cookies.find((cookie) => cookie.name === "hb_session"),
    ).toMatchObject({ secure: true, httpOnly: true, sameSite: "Lax" });
    expect(
      cookies.find((cookie) => cookie.name === "__Host-hb_image_session"),
    ).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "None",
      path: "/",
    });
    await page.goto(`/activities/${activity.id}`);
    await page.getByRole("button", { name: "领取奖励", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await (
              await page
                .context()
                .request.get(`/api/activities/${activity.id}/participation`)
            ).json()
          ).claim?.payment?.status,
        { timeout: 20_000 },
      )
      .toBe("confirmed");
    const before = await (
      await request.get("http://127.0.0.1:4194/state")
    ).json();
    const imagePath = new URL(activityImageUrl(activity.id, origin)).pathname;
    await page.goto("about:blank");
    const responsePromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === imagePath,
    );
    await page.goto(`https://127.0.0.1:4200/?id=${activity.id}`);
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const headers = await response.request().allHeaders();
    expect(headers.cookie ?? "").not.toContain("hb_session=");
    if (headers["sec-fetch-site"])
      expect(headers["sec-fetch-site"]).toBe("cross-site");
    const cookieAllowed = (headers.cookie ?? "").includes(
      "__Host-hb_image_session=",
    );
    const svg = await response.text();
    if (cookieAllowed) {
      expect(svg).toContain("0.01 LDC");
      expect(svg).toContain("已发放");
    } else {
      expect(svg).not.toContain("0.01 LDC");
      expect(svg).toContain("查看");
    }
    if (testInfo.project.name === "image-firefox-blocked")
      expect(cookieAllowed).toBe(false);
    if (testInfo.project.name === "image-firefox")
      expect(cookieAllowed).toBe(true);
    expect(svg).not.toMatch(
      /full-app-merchant-secret|recipient-private|csrf|token_hash/,
    );
    expect(response.headers()["cache-control"]).toContain("no-store");
    await expect(page.locator("img")).toBeVisible();
    expect(
      await page
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBe(420);
    const after = await (
      await request.get("http://127.0.0.1:4194/state")
    ).json();
    for (const key of [
      "claims",
      "registrations",
      "drawPlans",
      "attempts",
      "payments",
      "outbox",
    ])
      expect(after[key]).toEqual(before[key]);
    // First-party image request makes the browser-global record readable regardless of third-party policy.
    const firstParty = await page.context().request.get(imagePath);
    expect(await firstParty.text()).toContain("0.01 LDC");
    const record = await (
      await page.context().request.get("/api/me/activity-images")
    ).json();
    expect(record.recentRequest.activityId).toBe(activity.id);
    const fallback = await page
      .context()
      .request.get(`${imagePath}?fallback=public`);
    expect(await fallback.text()).not.toMatch(/0\.01 LDC|领取于|剩余/);
    await page.goto(imagePath);
    await expect(page).toHaveURL(`${origin}/activities/${activity.id}`);
    const logout = await page.context().request.post("/api/auth/logout", {
      headers: { Origin: origin, "X-CSRF-Token": viewer.csrfToken },
    });
    expect(logout.status()).toBe(200);
    // Replaying a revoked, correctly encrypted image credential cannot restore the old identity.
    const oldImage = cookies.find(
      (cookie) => cookie.name === "__Host-hb_image_session",
    );
    const replay = await page.context().request.get(imagePath, {
      headers: { Cookie: `${oldImage?.name}=${oldImage?.value}` },
    });
    expect(await replay.text()).not.toContain("0.01 LDC");
    await login(page, "recipient2");
    const retained = await (
      await page.context().request.get("/api/me/activity-images")
    ).json();
    expect(retained.recentRequest.activityId).toBe(activity.id);
    testInfo.annotations.push({
      type: "cookie-policy",
      description: `${testInfo.project.name}: cross-site image credential ${cookieAllowed ? "sent" : "blocked"}`,
    });
  } finally {
    await authorContext.close();
  }
});
