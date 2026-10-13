import { expect, type Page, test } from "@playwright/test";
import {
  type ActivityPasswords,
  activityImageUrl,
  createActivityImageEmbed,
  emptyActivityInput,
  type ManagedActivity,
  type PublicActivity,
  renderActivityImage,
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
    type PendingClipboardWrite = {
      reject: (error: Error) => void;
      resolve: () => void;
      value: string;
    };
    const globals = window as typeof window & {
      __hbClipboardHold?: boolean;
      __hbClipboardPending?: PendingClipboardWrite[];
      __hbClipboardReject?: boolean;
      __hbClipboardPendingCount?: () => number;
      __hbClipboardRelease?: (succeed?: boolean) => void;
    };
    globals.__hbClipboardHold = false;
    globals.__hbClipboardPending = [];
    globals.__hbClipboardReject = false;
    globals.__hbClipboardPendingCount = () =>
      globals.__hbClipboardPending?.length ?? 0;
    globals.__hbClipboardRelease = (succeed = true) => {
      const pending = globals.__hbClipboardPending?.shift();
      if (!pending) return;
      if (!succeed) {
        pending.reject(new Error("clipboard release failed"));
        return;
      }
      document.documentElement.dataset.activityShared = pending.value;
      pending.resolve();
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (globals.__hbClipboardReject) {
            throw new Error("clipboard write failed");
          }
          if (globals.__hbClipboardHold) {
            return new Promise<void>((resolve, reject) => {
              globals.__hbClipboardPending?.push({ reject, resolve, value });
            });
          }
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
      rewardType: "ldc",
      paymentMode: "simulation",
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
        : { mode: "fixed", unitAmount: "0.10", count: 3 },
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

const shareMenu = (page: Page) => page.getByRole("menu", { name: "分享活动" });

const copyMenuItem = (page: Page, name: RegExp | string) =>
  page.getByRole("menuitem", { name });

type LocatorBox = NonNullable<
  Awaited<ReturnType<ReturnType<typeof share>["boundingBox"]>>
>;

async function expectStableBox(
  actualBox: LocatorBox | null,
  expectedBox: LocatorBox,
) {
  if (!actualBox) {
    throw new Error("Expected element to have a stable bounding box.");
  }
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actualBox[key] - expectedBox[key])).toBeLessThan(1);
  }
}

async function freezeClock(page: Page) {
  await page.clock.pauseAt(Date.now() + 1_000);
}

test("复制项在菜单内显示三秒反馈且不移动布局", async ({ page }) => {
  await page.clock.install();
  await mockShare(page);
  await page.goto(`/activities/${id}`);

  await share(page).click();
  const menu = shareMenu(page);
  const linkItem = copyMenuItem(page, /^复制链接/);
  await expect(menu).toBeVisible();
  await expect(linkItem).toHaveAccessibleName("复制链接");
  const menuBefore = await menu.boundingBox();
  const itemBefore = await linkItem.boundingBox();
  if (!menuBefore || !itemBefore) {
    throw new Error("Expected share menu and copy item to have layout boxes.");
  }
  await freezeClock(page);

  await linkItem.click();

  await expect(menu).toBeVisible();
  await expect(linkItem).toHaveText("已复制");
  await expect(linkItem).toHaveAccessibleName("复制链接，已复制");
  await expect.poll(() => copied(page)).toBe(link(page));
  await expectStableBox(await menu.boundingBox(), menuBefore);
  await expectStableBox(await linkItem.boundingBox(), itemBefore);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.clock.runFor(1_500);
  await linkItem.click();
  await expect(linkItem).toHaveText("已复制");
  await page.clock.runFor(2_999);
  await expect(linkItem).toHaveText("已复制");
  await page.clock.runFor(1);
  await expect(linkItem).toHaveText("复制链接");
  await expect(linkItem).toHaveAccessibleName("复制链接");
});

test("复制失败在原菜单项内反馈且可重试成功", async ({ page }) => {
  await page.clock.install();
  await mockShare(page);
  await page.goto(`/activities/${id}`);

  await openShareMenu(page);
  const linkItem = copyMenuItem(page, /^复制链接/);
  await freezeClock(page);
  await setClipboardReject(page, true);
  await linkItem.click();

  await expect(shareMenu(page)).toBeVisible();
  await expect(linkItem).toHaveText("复制失败");
  await expect(linkItem).toHaveAccessibleName("复制链接，复制失败");
  await expect.poll(() => copied(page)).toBeUndefined();

  await setClipboardReject(page, false);
  await linkItem.click();
  await expect(linkItem).toHaveText("已复制");
  await expect(linkItem).toHaveAccessibleName("复制链接，已复制");
  await expect.poll(() => copied(page)).toBe(link(page));

  await page.clock.runFor(2_999);
  await expect(linkItem).toHaveText("已复制");
  await page.clock.runFor(1);
  await expect(linkItem).toHaveText("复制链接");
});

test("迟到的复制结果不会在账号切换后的菜单显示", async ({ page }) => {
  const state = await mockShare(page);
  state.user = owner;
  await page.goto(`/activities/${id}`);
  await holdClipboardWrites(page, true);

  await openShareMenu(page);
  const linkItem = copyMenuItem(page, /^复制链接/);
  await linkItem.click();
  await expect.poll(() => pendingClipboardWrites(page)).toBe(1);

  state.user = viewer;
  await restoreFocus(page);
  await expect(shareMenu(page)).toHaveCount(0);
  await releaseClipboardWrite(page);
  await expect.poll(() => copied(page)).toBe(link(page));

  await openShareMenu(page);
  await expect(copyMenuItem(page, /^复制链接/)).toHaveText("复制链接");
  await expect(page.getByText("已复制", { exact: true })).toHaveCount(0);
  await expect(page.getByText("复制失败", { exact: true })).toHaveCount(0);
});

test("图片内嵌代码使用公开后备图，后退关闭并恢复焦点", async ({ page }) => {
  await page.clock.install();
  const state = await mockShare(page);
  await page.goto(`/activities/${id}`);
  await share(page).click();
  await page.getByRole("menuitem", { name: "内嵌代码", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "内嵌代码", exact: true });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  if (!bounds || !viewport)
    throw new Error("Missing dialog or viewport bounds");
  expect(
    Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2),
  ).toBeLessThan(1);
  expect(
    Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2),
  ).toBeLessThan(1);
  await expect(dialog.locator("p.muted")).toHaveCount(0);
  const code = await dialog
    .getByLabel("内嵌代码", { exact: true })
    .inputValue();
  expect(code).toMatch(/^<center>\n {2}<picture>/);
  expect(code).toMatch(/<\/picture>\n<\/center>$/);
  expect(code).not.toMatch(/<\/?a(?:\s|>)/);
  expect(code).not.toContain("prefers-reduced-motion");
  expect(code).not.toContain("motion=reduced");
  expect(code.match(/<source /g)).toHaveLength(1);
  expect(code).toContain(`/e/${emoji}/live.svg`);
  expect(code).not.toContain(encodeURIComponent(emoji));
  expect(code).toMatch(/<img[^>]+src="[^"]+fallback=public/);
  expect(code).not.toMatch(/ManagedOnlyNeverShared|csrf|image_session/);
  const copyEmbed = dialog
    .locator(".activity-image-copy-actions button")
    .first();
  await expect(copyEmbed).toHaveAccessibleName("复制内嵌代码");
  await copyEmbed.click();
  await expect.poll(() => copied(page)).toBe(code);
  await expect(copyEmbed).toHaveText("已复制");
  await expect(copyEmbed).toHaveAccessibleName("复制内嵌代码，已复制");
  await page.clock.runFor(3_000);
  await expect(copyEmbed).toHaveText("复制内嵌代码");
  await page.goBack();
  await expect(dialog).not.toBeVisible();
  await expect(share(page)).toBeFocused();
  await page.goForward();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(state.writes).toEqual([]);
});
for (const variant of ["normal", "reduced", "fallback"] as const) {
  test(`内嵌图片 ${variant} 只请求一个候选地址`, async ({ page, baseURL }) => {
    if (!baseURL) throw new Error("Missing test origin");
    const origin = baseURL;
    const normal = activityImageUrl(id, origin);
    const fallback = activityImageUrl(id, origin, { fallback: true });
    let code = createActivityImageEmbed({
      imageHref: normal,
      fallbackImageHref: fallback,
      title: "图片候选验证",
      sender: "本地测试",
    });
    if (variant === "fallback") code = code.replace(/<source[^>]+>/g, "");
    await page.emulateMedia({
      reducedMotion: variant === "reduced" ? "reduce" : "no-preference",
    });
    const requested: string[] = [];
    await page.route("**/live.svg*", async (route) => {
      requested.push(route.request().url());
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="560"><rect width="420" height="560" fill="red"/></svg>',
      });
    });
    await page.route("**/__embed-selection", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${code}</body></html>`,
      }),
    );
    await page.goto("/__embed-selection");
    await page.waitForLoadState("networkidle");
    const expected = new URL(variant === "fallback" ? fallback : normal).href;
    expect(requested).toEqual([expected]);
    await expect(page.locator("center > picture")).toHaveCount(1);
    await expect(page.locator("a")).toHaveCount(0);
    await expect(page.locator("img")).toHaveJSProperty("currentSrc", expected);
    await expect(page.locator("img")).toHaveJSProperty("naturalWidth", 420);
  });
}

for (const state of ["active", "claimed"] as const) {
  test(`系统减少动态效果不会关闭 ${state} SVG 的默认动画`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/__svg-motion", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: renderActivityImage({
          title: "图片动画验证",
          sender: "本地测试",
          state,
          sealLabel: "查看",
          amount: state === "claimed" ? "1.00 LDC" : null,
          updatedAt: new Date(),
          instanceId: "motion-test",
        }),
      }),
    );
    await page.goto("/__svg-motion");
    const animated = page.locator(
      state === "claimed" ? ".open-upper" : ".packet",
    );
    await expect(animated).toHaveCSS(
      "animation-name",
      state === "claimed"
        ? "rp-motion-test-upper-open"
        : "rp-motion-test-fade-in",
    );
  });
}

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

async function openShareMenu(page: Page) {
  const menu = shareMenu(page);
  if ((await menu.count()) === 0 || !(await menu.isVisible())) {
    await share(page).click();
  }
  await expect(menu).toBeVisible();
}

async function copyOption(page: Page, name: string) {
  await openShareMenu(page);
  const item = copyMenuItem(page, new RegExp(`^${name}`));
  await item.click();
  return item;
}

async function setClipboardReject(page: Page, reject: boolean) {
  await page.evaluate((value) => {
    (
      window as typeof window & { __hbClipboardReject?: boolean }
    ).__hbClipboardReject = value;
  }, reject);
}

async function holdClipboardWrites(page: Page, hold: boolean) {
  await page.evaluate((value) => {
    (
      window as typeof window & { __hbClipboardHold?: boolean }
    ).__hbClipboardHold = value;
  }, hold);
}

async function releaseClipboardWrite(page: Page, succeed = true) {
  await page.evaluate((value) => {
    (
      window as typeof window & {
        __hbClipboardRelease?: (succeed?: boolean) => void;
      }
    ).__hbClipboardRelease?.(value);
  }, succeed);
}

async function pendingClipboardWrites(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __hbClipboardPendingCount?: () => number;
        }
      ).__hbClipboardPendingCount?.() ?? 0,
  );
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
    "内嵌代码",
  ]);
  const linkItem = copyMenuItem(page, /^复制链接/);
  await linkItem.click();
  await expect.poll(() => copied(page)).toBe(link(page));
  await expect(linkItem).toHaveText("已复制");
  const textItem = await copyOption(page, "复制分享文案");
  await expect
    .poll(() => copied(page))
    .toBe(`【周末红包】\n活动链接：${link(page)}`);
  await expect(textItem).toHaveText("已复制");
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
    "内嵌代码",
    "复制口令1",
    "复制口令2",
  ]);
  const managedReadsBeforeCopy = state.managedReads;
  await expect(page.getByRole("menu")).not.toContainText("FirstCase123");
  await expect(page.getByRole("menu")).not.toContainText("SecondCase456");
  const passwordItem = copyMenuItem(page, /^复制口令2/);
  await passwordItem.click();
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
  const passwordReadsBeforePoll = state.passwordReads;
  state.passwordStatus = 403;
  await page.clock.runFor(15_001);
  await expect(
    page.getByText("口令暂不可读取。", { exact: true }),
  ).toBeVisible();
  await openShareMenu(page);
  await expect(page.getByRole("menuitem")).toHaveText([
    "复制链接",
    "复制分享文案",
    "内嵌代码",
  ]);
  await copyMenuItem(page, /^复制链接/).click();
  await expect.poll(() => copied(page)).toBe(link(page));
  expect(state.passwordReads).toBe(passwordReadsBeforePoll + 1);
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
    "内嵌代码",
  ]);
  pending.release();
  await expect(page.getByRole("menuitem", { name: "复制口令1" })).toHaveCount(
    0,
  );
  await copyMenuItem(page, /^复制分享文案/).click();
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
  await expect(copyMenuItem(page, /^复制口令1/)).toBeFocused();
  await expect(copyMenuItem(page, /^复制口令1/)).toHaveText("已复制");
  await page.keyboard.press("Escape");
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
  await copyMenuItem(page, /^复制链接/).click();
  await expect.poll(() => copied(page)).toBe(link(page));

  await share(page).click();
  await main.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(menu).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.external).toEqual([]);
});
