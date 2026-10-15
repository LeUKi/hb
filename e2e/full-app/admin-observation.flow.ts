import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  emptyActivityInput,
  type ManagedActivity,
} from "../../packages/contracts/src";
import { fullAppMerchant } from "./ldc-fixture";

const origin = "http://127.0.0.1:4193";
async function login(page: Page, role: "author" | "recipient") {
  const context = page.context();
  await context.route(
    "https://connect.linux.do/oauth2/authorize?**",
    async (route) => {
      const authorization = new URL(route.request().url());
      const callback = new URL("/api/auth/callback", origin);
      callback.searchParams.set(
        "state",
        authorization.searchParams.get("state") ?? "",
      );
      callback.searchParams.set("code", `full-app-code-${role}`);
      return route.fulfill({
        status: 302,
        headers: { Location: callback.href },
      });
    },
  );
  const begin = await context.request.get("/api/auth/login?returnTo=%2Fadmin", {
    maxRedirects: 0,
  });
  expect(begin.status()).toBe(302);
  await page.goto(begin.headers().location ?? "");
  const session = await context.request.get("/api/session");
  return (await session.json()) as {
    user: { id: string; isAdmin: boolean };
    csrfToken: string;
  };
}
async function externalGuard(context: BrowserContext) {
  const failures: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname === "avatars.example.test")
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      });
    failures.push(url.origin);
    return route.abort();
  });
  return failures;
}

test("真实本地后台：管理员观察无业务副作用，草稿与软删除隔离，URL恢复及旧入口兼容", async ({
  browser,
  request,
}) => {
  const contexts = await Promise.all([
    browser.newContext({ baseURL: origin }),
    browser.newContext({ baseURL: origin }),
    browser.newContext({ baseURL: origin }),
  ]);
  const [owner, other, guest] = contexts;
  if (!owner || !other || !guest) throw new Error("缺少测试上下文");
  try {
    const failures = await Promise.all(contexts.map(externalGuard));
    const adminPage = await owner.newPage();
    const admin = await login(adminPage, "author");
    expect(admin.user.isAdmin).toBe(true);
    const otherPage = await other.newPage();
    await login(otherPage, "recipient");
    const title = `后台检索草稿-${randomUUID()}`;
    const merchant = await fullAppMerchant(owner, admin.csrfToken);
    const activity = {
      ...emptyActivityInput(),
      title,
      passwords: ["admin123"],
      merchantId: merchant.id,
      money: { mode: "fixed" as const, totalAmount: "0.01", count: 1 },
      beforeInfo: "SENSITIVE-ADMIN-NOTE",
      afterClaimInfo: "SENSITIVE-ADMIN-REWARD-NOTE",
      topicUrl: "https://linux.do/t/topic/992342/2",
    };
    const saved = await owner.request.post("/api/activities", {
      headers: { Origin: origin, "X-CSRF-Token": admin.csrfToken },
      data: { requestId: randomUUID(), activity },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const managed = ((await saved.json()) as { activity: ManagedActivity })
      .activity;
    const snapshot = async () =>
      await (await request.get("http://127.0.0.1:4194/state")).json();
    const before = await snapshot();
    for (const endpoint of [
      "overview",
      "activities",
      `activities/${managed.id}`,
      "users",
      `users/${admin.user.id}`,
      "payments",
      "audit",
    ]) {
      const response = await owner.request.get(`/api/admin/${endpoint}`);
      expect(response.status(), `${endpoint}: ${await response.text()}`).toBe(
        200,
      );
      expect(response.headers()["cache-control"]).toBe("no-store");
      const body = await response.text();
      for (const sentinel of [
        "admin123",
        "SENSITIVE-ADMIN-REWARD-NOTE",
        "SENSITIVE-ADMIN-NOTE",
        "author-private@example.test",
        "full-app-connect-secret",
      ])
        expect(body).not.toContain(sentinel);
      expect((await guest.request.get(`/api/admin/${endpoint}`)).status()).toBe(
        401,
      );
      expect((await other.request.get(`/api/admin/${endpoint}`)).status()).toBe(
        403,
      );
    }
    const after = await snapshot();
    for (const key of [
      "activities",
      "registrations",
      "drawPlans",
      "claims",
      "attempts",
      "payments",
      "outbox",
      "upstream",
    ])
      expect(after[key]).toEqual(before[key]);
    await adminPage.goto(
      `/admin/activities?q=${encodeURIComponent(managed.id)}&detail=${managed.id}`,
    );
    await expect(
      adminPage.getByText(title, { exact: true }).first(),
    ).toBeVisible();
    await adminPage.reload();
    await expect(
      adminPage.getByText(title, { exact: true }).first(),
    ).toBeVisible();
    await adminPage.setViewportSize({ width: 375, height: 812 });
    await expect(adminPage.getByRole("dialog")).toBeVisible();
    expect(
      await adminPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await adminPage.keyboard.press("Escape");
    await expect(adminPage.getByRole("dialog")).toHaveCount(0);
    await adminPage.goto("/admin/rate-limits");
    await expect(adminPage).toHaveURL(`${origin}/admin/settings`);
    await expect(
      adminPage.getByRole("region", { name: "参与尝试限流", exact: true }),
    ).toBeVisible();
    const deleted = await owner.request.delete(
      `/api/me/activities/${managed.id}`,
      {
        headers: { Origin: origin, "X-CSRF-Token": admin.csrfToken },
        data: { version: managed.version },
      },
    );
    expect(deleted.status(), await deleted.text()).toBe(200);
    expect(
      (await owner.request.get(`/api/admin/activities/${managed.id}`)).status(),
    ).toBe(404);
    const filtered = await owner.request.get(
      `/api/admin/activities?q=${managed.id}`,
    );
    expect(await filtered.json()).toMatchObject({ items: [] });
    for (const list of failures) expect(list).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
