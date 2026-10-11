import { expect, type Page, test } from "@playwright/test";
import type { PublicActivity } from "../packages/contracts/src";

const id = "cecef876-ddbb-4ed5-93ce-9b311e3df3ea";
const emoji = "🚷🎼📯😨😸🎺🐵🦄🪁🚍🤽📄🥘☕";
const shortPath = `/e/${emoji}`;
const longPath = `/activities/${id}`;
const sourceId = "21111111-1111-4111-8111-111111111111";
const title = "表情地址的原始活动";

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

function activity(activityId = id): PublicActivity {
  return {
    id: activityId,
    title: activityId === id ? title : "站内链接说明",
    rewardType: "text",
    status: "active",
    author: {
      id: "emoji-author",
      username: "emojimaker",
      displayName: "表情地址作者",
      avatarUrl: null,
      accountTier: "standard",
    },
    forceDedicated: true,
    topicUrl: null,
    openedAt: new Date(Date.now() - 60_000).toISOString(),
    deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
    quantity: { mode: "exact", total: 1, claimed: 0, remaining: 1 },
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
    beforeInfo:
      activityId === sourceId
        ? `[表情活动链接](${shortPath})\n\n[原始活动链接](${longPath})`
        : "活动的公开说明。",
    reward: { mode: "text" },
  };
}

async function mockEmojiLinks(
  page: Page,
  pending?: {
    session: ReturnType<typeof gate>;
    detail: ReturnType<typeof gate>;
  },
) {
  const state = {
    api: [] as string[],
    documents: [] as string[],
    unexpected: [] as string[],
    mutations: [] as string[],
    detailReads: 0,
    passwordReads: 0,
    rosterReads: 0,
  };
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
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      state.unexpected.push(url.href);
      return route.abort();
    }
    if (request.resourceType() === "document") {
      try {
        state.documents.push(decodeURIComponent(url.pathname));
      } catch {
        state.documents.push(url.pathname);
      }
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    state.api.push(path);
    if (request.method() !== "GET") state.mutations.push(path);
    if (path === "/api/session" || path === "/api/me") {
      await pending?.session.wait();
      return route.fulfill({
        json: {
          user: null,
          csrfToken: null,
          attemptCooldown: null,
          loginOptions: { liteauthEnabled: false },
        },
      });
    }
    if (path === `/api/activities/${id}`) {
      state.detailReads++;
      await pending?.detail.wait();
      return route.fulfill({ json: { activity: activity() } });
    }
    if (path === `/api/activities/${sourceId}`)
      return route.fulfill({ json: { activity: activity(sourceId) } });
    if (
      path === `/api/activities/${id}/passwords` ||
      path === `/api/activities/${sourceId}/passwords`
    ) {
      state.passwordReads++;
      return route.fulfill({
        json: { passwords: [], hiddenCount: 1, canSolve: false },
      });
    }
    if (path === `/api/activities/${id}/recipients`) {
      state.rosterReads++;
      return route.fulfill({
        json: {
          enabled: true,
          items: [
            {
              id: "emoji-recipient",
              username: "emojiviewer",
              displayName: "公开名单参与者",
              avatarUrl: null,
              accountTier: "standard",
              claimedAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
        },
      });
    }
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "测试未定义此请求" } },
    });
  });
  return state;
}

function expectReadOnly(state: Awaited<ReturnType<typeof mockEmojiLinks>>) {
  expect(state.unexpected).toEqual([]);
  expect(state.mutations).toEqual([]);
  expect(state.api.filter((path) => path.startsWith("/api/e/"))).toEqual([]);
  expect(
    state.api.filter(
      (path) =>
        path.startsWith("/api/activities/") &&
        !path.startsWith(`/api/activities/${id}`) &&
        !path.startsWith(`/api/activities/${sourceId}`),
    ),
  ).toEqual([]);
}

for (const width of [1440, 768, 375]) {
  test(`${width}px 原始及编码表情地址仅替换为 UUID，分享保留可见表情`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install();
    const state = await mockEmojiLinks(page);
    for (const path of [shortPath, `/e/${encodeURIComponent(emoji)}`]) {
      const beforeDocuments = state.documents.length;
      const beforeReads = state.detailReads;
      await page.goto(path);
      await expect(page).toHaveURL(longPath);
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
      await page.getByRole("button", { name: "分享活动", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "复制链接", exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.dataset.activityShared),
        )
        .toBe(`${new URL(page.url()).origin}${shortPath}`);
      expect(state.detailReads - beforeReads).toBe(1);
      expect(state.documents.slice(beforeDocuments)).toEqual([shortPath]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.clock.resume();
    }
    expectReadOnly(state);
  });
}

test("畸形百分号及双重编码短地址显示本地错误且不读取活动", async ({ page }) => {
  const state = await mockEmojiLinks(page);
  for (const path of [
    "/e/%",
    "/e/%F0%9F",
    "/e/%ZZ",
    `/e/${encodeURIComponent(encodeURIComponent(emoji))}`,
  ]) {
    await page.goto(path);
    await expect(page.getByRole("alert")).toHaveText(
      "表情短地址无效，请检查链接是否完整。",
    );
  }
  expect(
    state.api.filter((path) => path.startsWith("/api/activities/")),
  ).toEqual([]);
  expectReadOnly(state);
});

for (const invalid of [
  "not-an-emoji",
  Array.from(emoji).slice(0, -1).join(""),
  `${Array.from(emoji).slice(0, -1).join("")}😀`,
]) {
  test(`无效表情地址不解析、不读取活动：${invalid}`, async ({ page }) => {
    const state = await mockEmojiLinks(page);
    await page.goto(`/e/${encodeURIComponent(invalid)}`);
    await expect(page.getByRole("alert")).toHaveText(
      "表情短地址无效，请检查链接是否完整。",
    );
    await expect(page.getByRole("button", { name: "分享活动" })).toHaveCount(0);
    expect(
      state.api.filter((path) => path.startsWith("/api/activities/")),
    ).toEqual([]);
    expectReadOnly(state);
  });
}

test("活动定位兼容表情地址、编码地址、原始 UUID 和旧链接", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const state = await mockEmojiLinks(page);
  const origin = "http://127.0.0.1:5173";
  for (const input of [
    emoji,
    `${origin}${shortPath}`,
    `${origin}/e/${encodeURIComponent(emoji)}`,
    id,
    `${origin}${longPath}`,
  ]) {
    await page.goto("/");
    await page.getByLabel("口令", { exact: true }).fill(input);
    await page.getByRole("button", { name: "跳转活动", exact: true }).click();
    await expect(page).toHaveURL(longPath);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  for (const invalid of [
    `${origin}/e/not-an-emoji`,
    `https://example.test${shortPath}`,
    `http://user:pass@127.0.0.1:5173${shortPath}`,
  ]) {
    await page.goto("/");
    await page.getByLabel("口令", { exact: true }).fill(invalid);
    const previousReads = state.detailReads;
    await expect(
      page.getByRole("button", { name: "跳转活动", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "兑奖", exact: true }).click();
    await expect(page.locator(".pw-input__error")).toBeVisible();
    await expect(page).toHaveURL("/");
    expect(state.detailReads).toBe(previousReads);
  }
  expectReadOnly(state);
});

test("Markdown 表情链接保留原生 UUID href，普通点击和新标签均可用", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const state = await mockEmojiLinks(page);
  await page.goto(`/activities/${sourceId}`);
  const link = page.getByRole("link", { name: "表情活动链接", exact: true });
  await expect(link).toHaveAttribute("href", longPath);
  await expect(
    page.getByRole("link", { name: "原始活动链接", exact: true }),
  ).toHaveAttribute("href", longPath);
  await expect(link).toBeVisible();
  const popupPromise = page.context().waitForEvent("page", { timeout: 5_000 });
  await link.click({ button: "middle", timeout: 5_000 });
  const popup = await popupPromise;
  await expect(popup).toHaveURL(longPath);
  await expect(popup.getByRole("heading", { name: title })).toBeVisible();
  await popup.close();
  await link.click();
  await expect(page).toHaveURL(longPath);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(`/activities/${sourceId}`);
  await page.goForward();
  await expect(page).toHaveURL(longPath);
  expectReadOnly(state);
});

test("短入口替换历史，名单后退关闭、前进及刷新恢复均保持 UUID", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const state = await mockEmojiLinks(page);
  await page.goto("/");
  await page.goto(shortPath);
  await expect(page).toHaveURL(longPath);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/");
  await page.goForward();
  await expect(page).toHaveURL(longPath);
  const opener = page.getByRole("button", {
    name: "查看领取名单",
    exact: true,
  });
  await opener.click();
  const roster = page.getByRole("dialog", { name: title, exact: true });
  await expect(
    roster.getByText("公开名单参与者", { exact: true }),
  ).toBeVisible();
  const previousReads = state.rosterReads;
  await page.goBack();
  await expect(roster).toHaveCount(0);
  await expect(page).toHaveURL(longPath);
  await page.goForward();
  await expect(
    roster.getByText("公开名单参与者", { exact: true }),
  ).toBeVisible();
  expect(state.rosterReads).toBe(previousReads);
  await page.reload();
  await expect(
    roster.getByText("公开名单参与者", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(longPath);
  await page.keyboard.press("Escape");
  await expect(roster).toHaveCount(0);
  expectReadOnly(state);
});

for (const reducedMotion of [false, true]) {
  test(`表情冷入口慢响应保留同一红包外框（减少动态效果 ${reducedMotion}）`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: reducedMotion ? 375 : 1440,
      height: 900,
    });
    await page.emulateMedia({
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    const session = gate();
    const detail = gate();
    const state = await mockEmojiLinks(page, { session, detail });
    try {
      await page.goto(shortPath);
      await session.opened;
      await expect(page).toHaveURL(longPath);
      await expect(page.locator(".home-page")).toHaveCount(0);
      await expect(page.locator(".redemption-envelope")).toHaveCount(1);
      const shell = await page.locator(".redemption-envelope").elementHandle();
      session.release();
      await detail.opened;
      await expect(page.locator(".claim-art")).toBeVisible();
      await expect(page.locator(".claim-copy")).toBeVisible();
      detail.release();
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      await expect(page.locator(".redemption-envelope")).toHaveCount(1);
      expect(
        await shell?.evaluate(
          (node) => document.querySelector(".redemption-envelope") === node,
        ),
      ).toBe(true);
      expect(state.documents).toEqual([shortPath]);
      expect(state.detailReads).toBe(1);
      expectReadOnly(state);
    } finally {
      session.release();
      detail.release();
    }
  });
}
