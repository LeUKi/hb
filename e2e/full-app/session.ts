import { type BrowserContext, expect, type Page } from "@playwright/test";

// Signing in on the real stack, shared by the full-app flows.

export const origin = "http://127.0.0.1:4193";
const authorizer = /^https:\/\/connect\.linux\.do\/oauth2\/authorize\?/;

export async function localOnly(context: BrowserContext) {
  await context.route("https://avatars.example.test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#ddd"/></svg>',
    }),
  );
}

export async function waitForBoot(page: Page) {
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
export async function signIn(page: Page, role: string) {
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

/** The account's attempt cooldown is the server's: wait until it is over. */
export async function waitOutCooldown(page: Page) {
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
