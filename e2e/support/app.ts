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
  /** 🐟额 PLUS: 转入 and 转账 (an invite, or the 站长). */
  balancePlus?: boolean;
  /** The 站长's: payments stuck past every automatic try. */
  stuckPayments?: number;
  /** The 站长's: 三方积分 to look at (review, words changed, no known result). */
  pointsAttention?: number;
  /** 信任等级 as of the last sign-in (领取范围); null: not read yet. */
  trustLevel?: number | null;
  /** When that level was read (ms). */
  profileSeenAt?: number | null;
  /** Their LINUX DO 数字 ID, shown to them only. */
  linuxDoId?: string;
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

/**
 * 代码判定 on /new: from ② 判定器, picked, on through ③ 发多少 to ④ 参数
 * (docs/judge-square-design.md §6: the params after the pool).
 */
export async function toParams(page: Page) {
  const next = page.getByRole("button", { name: "下一步" }).first();
  await next.click();
  await expect(page.locator("#hb-code-total")).toBeVisible();
  await next.click();
  await expect(
    page.getByRole("heading", { name: /^第 4 步，共 5 步/ }),
  ).toBeVisible();
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

/**
 * 震动反馈: stands in for the phone's motor, keeping each rhythm asked for
 * (docs/haptics-design.md). Reads them back as they are now.
 */
export async function recordHaptics(page: Page) {
  await page.addInitScript(() => {
    const felt: unknown[] = [];
    (window as unknown as { hbFelt: unknown[] }).hbFelt = felt;
    Object.defineProperty(Navigator.prototype, "vibrate", {
      configurable: true,
      value: (pattern: number | number[]) => {
        felt.push(pattern);
        return true;
      },
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { hbFelt: unknown[] }).hbFelt);
}

/** The five rhythms, as docs/haptics-design.md §2 sets them. */
export const haptics = {
  selection: 10,
  light: 15,
  success: [14, 60, 22],
  warning: [24, 80, 24],
  error: [18, 45, 18, 45, 28],
} as const;
