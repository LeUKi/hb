import { expect, type Page, test } from "@playwright/test";
import {
  type ActivityPasswords,
  emptyActivityInput,
  type ManagedActivity,
  type PublicActivity,
} from "../packages/contracts/src";

const id = "cecef876-ddbb-4ed5-93ce-9b311e3df3ea";
const emoji = "🚷🎼📯😨😸🎺🐵🦄🪁🚍🤽📄🥘☕";
const owner = {
  id: "share-author",
  username: "shareauthor",
  displayName: "分享作者",
  avatarUrl: null,
  accountTier: "standard" as const,
  loginProvider: "connect" as const,
  canUseLdc: true,
  isAdmin: false,
};
const viewer = {
  ...owner,
  id: "share-viewer",
  username: "shareviewer",
  displayName: "分享参与者",
};

function gate() {
  let release = () => {};
  let started = () => {};
  const opened = new Promise<void>((resolve) => {
    started = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    opened,
    wait: () => {
      started();
      return closed;
    },
  };
}

function password(text: string, used = false) {
  return { text, isClaimPassword: used, isSolved: !used };
}

async function mockShare(page: Page) {
  const state = {
    user: null as typeof owner | null,
    title: "周末红包",
    beforeInfo: "活动的公开说明。",
    ended: false,
    draw: false,
    passwords: [] as ActivityPasswords["passwords"],
    passwordStatus: 200,
    passwordGate: null as ReturnType<typeof gate> | null,
    managedGate: null as ReturnType<typeof gate> | null,
    passwordReads: 0,
    managedReads: 0,
    writes: [] as string[],
    external: [] as string[],
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          document.documentElement.dataset.activityShared = value;
        },
      },
    });
  });
  function activity(): PublicActivity {
    const deadlineAt = new Date(Date.now() + 86_400_000).toISOString();
    return {
      id,
      title: state.title,
      rewardType: state.draw ? "ldc" : "text",
      status: state.ended ? "ended" : "active",
      author: owner,
      forceDedicated: true,
      topicUrl: null,
      openedAt: new Date(Date.now() - 3_600_000).toISOString(),
      deadlineAt,
      quantity: { mode: "exact", total: 3, claimed: 0, remaining: 3 },
      showRecipientList: false,
      showRecipientUsername: false,
      showRecipientTime: false,
      beforeInfo: state.beforeInfo,
      reward: state.draw
        ? { mode: "timed_draw", totalAmount: "0.30", count: 3 }
        : { mode: "text" },
      ...(state.draw
        ? {
            draw: {
              state: state.ended
                ? ("completed" as const)
                : ("waiting" as const),
              registeredCount: 3,
              winnerCount: 3,
              deadlineAt,
              closedAt: state.ended ? new Date().toISOString() : null,
              reason: null,
            },
          }
        : {}),
    };
  }
  function managed(): ManagedActivity {
    const publicActivity = activity();
    return {
      ...publicActivity,
      author: owner,
      createdAt: publicActivity.openedAt ?? new Date().toISOString(),
      totalCount: 3,
      claimedCount: 0,
      version: 2,
      config: {
        ...emptyActivityInput(),
        title: state.title,
        passwords: ["ManagedOnlyNeverShared"],
        forceDedicated: true,
      },
    };
  }
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      state.external.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    if (request.method() !== "GET") state.writes.push(path);
    if (path === "/api/session" || path === "/api/me")
      return route.fulfill({
        json: {
          user: state.user,
          csrfToken: state.user ? "csrf" : null,
          attemptCooldown: null,
          loginOptions: { liteauthEnabled: true },
        },
      });
    if (path === `/api/activities/${id}`)
      return route.fulfill({ json: { activity: activity() } });
    if (path === `/api/activities/${id}/participation`)
      return route.fulfill({ json: { claim: null, registration: null } });
    if (path === `/api/activities/${id}/passwords`) {
      state.passwordReads += 1;
      const passwords = structuredClone(state.passwords);
      const status = state.passwordStatus;
      const pending = state.passwordGate;
      state.passwordGate = null;
      await pending?.wait();
      return status === 200
        ? route.fulfill({
            json: {
              passwords,
              hiddenCount: 3 - passwords.length,
              canSolve: false,
            },
          })
        : route.fulfill({
            status,
            json: {
              error: {
                code: "PASSWORDS_DENIED",
                message: "口令暂不可读取。",
              },
            },
          });
    }
    if (path === `/api/me/activities/${id}`) {
      state.managedReads += 1;
      await state.managedGate?.wait();
      return route.fulfill({ json: { activity: managed() } });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  return state;
}

const share = (page: Page) =>
  page.getByRole("button", { name: "分享活动", exact: true });
const copied = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.activityShared);
const link = (page: Page) => `${new URL(page.url()).origin}/e/${emoji}`;

async function restoreFocus(page: Page) {
  await page.evaluate(() => {
    const previous = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    if (previous) Object.defineProperty(document, "visibilityState", previous);
    else Reflect.deleteProperty(document, "visibilityState");
  });
}

async function copyOption(page: Page, name: string) {
  await share(page).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("游客分享可见表情链接和文案，口令未确认时不暴露选项", async ({ page }) => {
  const state = await mockShare(page);
  const pending = gate();
  state.passwordGate = pending;
  await page.goto(`/activities/${id}?source=example#section`);
  await share(page).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "复制链接",
    "复制分享文案",
  ]);
  await page.getByRole("menuitem", { name: "复制链接", exact: true }).click();
  await expect.poll(() => copied(page)).toBe(link(page));
  await copyOption(page, "复制分享文案");
  await expect
    .poll(() => copied(page))
    .toBe(`【周末红包】\n活动链接：${link(page)}`);
  await expect(
    page.getByText("分享文案已复制。", { exact: true }),
  ).toBeVisible();
  pending.release();
  await expect(page.locator(".password-list")).toBeVisible();
  expect(state.passwordReads).toBe(1);
  expect(state.managedReads).toBe(0);
  expect(state.writes).toEqual([]);
  expect(state.external).toEqual([]);
});

test("作者逐条分享可见口令，管理慢响应不阻塞分享且无重复口令读取", async ({
  page,
}) => {
  const state = await mockShare(page);
  state.user = owner;
  state.passwords = [password("FirstCase123"), password("SecondCase456")];
  const pending = gate();
  state.managedGate = pending;
  await page.goto(`/activities/${id}`);
  await share(page).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "复制链接",
    "复制分享文案",
    "复制口令1",
    "复制口令2",
  ]);
  const managedReadsBeforeCopy = state.managedReads;
  await expect(page.getByRole("menu")).not.toContainText("FirstCase123");
  await expect(page.getByRole("menu")).not.toContainText("SecondCase456");
  await page.getByRole("menuitem", { name: "复制口令2", exact: true }).click();
  await expect
    .poll(() => copied(page))
    .toBe(`【周末红包】\n活动链接：${link(page)}\n兑换口令：SecondCase456`);
  pending.release();
  await expect(page.getByRole("button", { name: "管理活动" })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制领取文案" })).toHaveCount(
    0,
  );
  expect(state.passwordReads).toBe(1);
  expect(state.managedReads).toBe(managedReadsBeforeCopy);
  expect(state.writes).toEqual([]);
});

test("参与者仅分享其可见口令，权限失败撤下旧选项而保留链接分享", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockShare(page);
  state.user = viewer;
  state.passwords = [password("MyVisiblePass123", true)];
  await page.goto(`/activities/${id}`);
  await copyOption(page, "复制口令1");
  await expect
    .poll(() => copied(page))
    .toBe(`【周末红包】\n活动链接：${link(page)}\n兑换口令：MyVisiblePass123`);
  expect(state.managedReads).toBe(0);
  state.passwordStatus = 403;
  await page.clock.runFor(15_001);
  await expect(
    page.getByText("口令暂不可读取。", { exact: true }),
  ).toBeVisible();
  await share(page).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "复制链接",
    "复制分享文案",
  ]);
  await page.getByRole("menuitem", { name: "复制链接", exact: true }).click();
  await expect.poll(() => copied(page)).toBe(link(page));
  expect(state.passwordReads).toBe(2);
  expect(state.writes).toEqual([]);
});

test("账号切换关闭旧菜单，旧账号迟到口令不能恢复分享选项", async ({ page }) => {
  await page.clock.install();
  const state = await mockShare(page);
  state.user = owner;
  state.passwords = [password("PreviousAccount123")];
  await page.goto(`/activities/${id}`);
  await share(page).click();
  await expect(page.getByRole("menuitem", { name: "复制口令1" })).toBeVisible();
  const pending = gate();
  state.passwordGate = pending;
  await page.clock.runFor(15_001);
  await pending.opened;
  state.user = viewer;
  state.passwords = [];
  await restoreFocus(page);
  await expect(page.getByRole("menu", { name: "分享活动" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "管理活动" })).toHaveCount(0);
  await share(page).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "复制链接",
    "复制分享文案",
  ]);
  pending.release();
  await expect(page.getByRole("menuitem", { name: "复制口令1" })).toHaveCount(
    0,
  );
  await page
    .getByRole("menuitem", { name: "复制分享文案", exact: true })
    .click();
  await expect
    .poll(() => copied(page))
    .toBe(`【周末红包】\n活动链接：${link(page)}`);
  expect(state.writes).toEqual([]);
});

test("已结束开奖活动支持游客分享，手机键盘菜单使用报名口令并保持布局", async ({
  page,
}) => {
  const state = await mockShare(page);
  state.ended = true;
  state.draw = true;
  state.title = "";
  state.passwords = [password("DrawPass123")];
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: "未命名活动", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".password-list")).toBeVisible();
  await share(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "复制链接" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "复制口令1" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => copied(page))
    .toBe(`【未命名活动】\n活动链接：${link(page)}\n报名口令：DrawPass123`);
  await expect(share(page)).toBeFocused();
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await share(page).click();
    const bounds = await page
      .getByRole("menu", { name: "分享活动" })
      .boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(share(page)).toBeFocused();
  }
  expect(state.managedReads).toBe(0);
  expect(state.writes).toEqual([]);
  expect(state.external).toEqual([]);
});

test("主区域轻微滚动后分享菜单仍可点击，触发入口离开视口后关闭", async ({
  page,
}) => {
  const state = await mockShare(page);
  state.beforeInfo = Array.from(
    { length: 30 },
    (_, index) => `公开说明第 ${index + 1} 段。`,
  ).join("\n\n");
  await page.setViewportSize({ width: 375, height: 650 });
  await page.goto(`/activities/${id}`);
  await expect(page.locator(".password-list")).toBeVisible();
  const main = page.locator(".site-main");
  await main.evaluate((element) => {
    element.scrollTop = 0;
  });
  await share(page).click();
  const menu = page.getByRole("menu", { name: "分享活动" });
  const previous = await main.evaluate((element) => element.scrollTop);
  await main.evaluate((element) => {
    element.scrollTop += 24;
  });
  await expect
    .poll(() => main.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(previous);
  await expect(menu).toBeVisible();
  await expect
    .poll(async () => {
      const trigger = await share(page).boundingBox();
      const panel = await menu.boundingBox();
      return Boolean(
        trigger &&
          panel &&
          Math.abs(panel.y - (trigger.y + trigger.height + 6)) < 1,
      );
    })
    .toBe(true);
  await page.getByRole("menuitem", { name: "复制链接", exact: true }).click();
  await expect.poll(() => copied(page)).toBe(link(page));

  await share(page).click();
  await main.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(menu).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.external).toEqual([]);
});
