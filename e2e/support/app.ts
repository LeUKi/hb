import { expect, type Page, type Route } from "@playwright/test";

// Shared by the mocked-API specs. Every page starts behind the boot loader
// (index.html): the app is inert until it hands over, so tests wait for that
// before they type or click.

export type MockUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  /** 🐟额's allowlist lets this account in. */
  balance?: boolean;
};

export const viewer: MockUser = {
  id: "viewer-e2e",
  username: "viewer",
  displayName: "测试领取者",
  avatarUrl: null,
  isAdmin: false,
};

export const csrfToken = "csrf-e2e-token";

/** Opens a path and waits until the boot loader has handed over. */
export async function openApp(page: Page, path = "/") {
  await page.goto(path);
  await page.waitForFunction(
    () =>
      (window as unknown as { hbBoot?: { done: boolean } }).hbBoot?.done ===
      true,
  );
}

/** Answers /api/session for a guest or one account. */
export async function mockSession(
  page: Page,
  user: MockUser | null,
  options: { status?: number } = {},
) {
  await page.route("**/api/session", (route) =>
    options.status && options.status !== 200
      ? route.fulfill({ status: options.status, json: { error: {} } })
      : route.fulfill({
          json: user
            ? {
                user,
                csrfToken,
                attemptCooldown: {
                  revision: 0,
                  serverTime: Date.now(),
                  nextAllowedAt: 0,
                },
              }
            : { user: null, csrfToken: null, attemptCooldown: null },
        }),
  );
}

/** Sign-in leaves for LINUX DO: answer it here instead of following it. */
export async function stubLogin(page: Page) {
  const visits: string[] = [];
  await page.route("**/api/auth/login**", (route: Route) => {
    visits.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>login</title>",
    });
  });
  return visits;
}

/** The 指令框 on the start page (or the expanded one). */
export function omniboxInput(page: Page) {
  return page.getByRole("textbox", { name: "口令、红包链接或命令" });
}

/** The 顶栏's account button, whatever it currently says. */
export function identityButton(page: Page) {
  return page.locator("#identity-button");
}

export async function expectPath(page: Page, path: string) {
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe(path);
}

/** A line of text as shown (not its copy in a screen-reader live region). */
export function shown(page: Page, text: string | RegExp) {
  return page
    .getByText(text, { exact: true })
    .and(page.locator(":not(.sr-only)"));
}
