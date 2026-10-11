import { expect, type Page, test } from "@playwright/test";
import type {
  PublicActivity,
  PublicRecipient,
} from "../packages/contracts/src";

const activityId = "41111111-1111-4111-8111-111111111111";
const recipient: PublicRecipient = {
  id: "recipient-1",
  username: "ada",
  displayName: "公开领取者 Ada",
  avatarUrl: null,
  accountTier: "standard",
  claimedAt: "2026-10-07T00:00:00.000Z",
};
const activity: PublicActivity = {
  id: activityId,
  title: "模态名单的资料浮层",
  rewardType: "text",
  status: "ended",
  author: {
    id: "author-1",
    username: "maker",
    displayName: "活动作者",
    avatarUrl: null,
    accountTier: "standard",
  },
  forceDedicated: false,
  topicUrl: null,
  openedAt: "2026-10-01T00:00:00.000Z",
  deadlineAt: "2026-10-02T00:00:00.000Z",
  quantity: { mode: "exact", total: 1, claimed: 1, remaining: 0 },
  showRecipientList: true,
  showRecipientUsername: true,
  showRecipientTime: true,
  beforeInfo: "",
};

async function mockRoster(page: Page) {
  const externalRequests: string[] = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      externalRequests.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({ json: { user: null, csrfToken: null } });
    if (url.pathname === `/api/activities/${activityId}`)
      return route.fulfill({ json: { activity } });
    if (url.pathname === `/api/activities/${activityId}/recipients`)
      return route.fulfill({
        json: { enabled: true, items: [recipient], nextCursor: null },
      });
    if (url.pathname === `/api/activities/${activityId}/passwords`)
      return route.fulfill({
        json: { passwords: [], hiddenCount: 0, canSolve: false },
      });
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "未找到" } },
    });
  });
  return externalRequests;
}

test("公开名单内的资料浮层可键盘访问，Esc 先关闭浮层再关闭名单并恢复焦点", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const externalRequests = await mockRoster(page);
  await page.goto(`/activities/${activityId}`);

  const opener = page.getByRole("button", {
    name: "查看领取名单",
    exact: true,
  });
  await opener.click();
  const roster = page.getByRole("dialog", {
    name: activity.title,
    exact: true,
  });
  await expect(roster).toBeVisible();
  await expect(roster).toHaveJSProperty("open", true);

  const trigger = roster.getByRole("button", {
    name: recipient.displayName,
    exact: true,
  });
  await trigger.click();
  const profile = roster.getByRole("dialog", {
    name: "公开领取者 Ada的资料",
    exact: true,
  });
  await expect(profile).toBeVisible();
  await expect(profile).toHaveCSS("background-color", "rgb(37, 40, 45)");
  await expect(profile.locator("p").first()).toHaveCSS(
    "color",
    "rgb(245, 246, 248)",
  );
  await expect(profile).toContainText("@ada");
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Tab");
  const closeProfile = profile.getByRole("button", { name: "关闭资料" });
  await expect(closeProfile).toBeFocused();

  await page.keyboard.press("Tab");
  const profileLink = profile.getByRole("link", { name: "查看 Linux DO 主页" });
  await expect(profileLink).toBeFocused();
  await expect(profileLink).toHaveAttribute("href", "https://linux.do/u/ada");
  await expect(profileLink).toHaveAttribute("target", "_blank");

  await page.keyboard.press("Escape");
  await expect(profile).toHaveCount(0);
  await expect(roster).toBeVisible();
  await expect(roster).toHaveJSProperty("open", true);
  await expect(trigger).toBeFocused();
  await page.waitForTimeout(180);
  await expect(profile).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(roster).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(externalRequests).toEqual([]);
});

test("名单历史返回关闭、前进及刷新恢复，缓存复用不重复读取", async ({
  page,
}) => {
  const external = await mockRoster(page);
  let reads = 0;
  page.on("request", (request) => {
    if (request.url().includes(`/${activityId}/recipients`)) reads++;
  });
  await page.goto(`/activities/${activityId}`);
  const opener = page.getByRole("button", {
    name: "查看领取名单",
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog", {
    name: activity.title,
    exact: true,
  });
  await expect(
    dialog.getByText(recipient.displayName, { exact: true }),
  ).toBeVisible();
  const initialReads = reads;
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.goForward();
  await expect(
    dialog.getByText(recipient.displayName, { exact: true }),
  ).toBeVisible();
  expect(reads).toBe(initialReads);
  await page.reload();
  await expect(
    dialog.getByText(recipient.displayName, { exact: true }),
  ).toBeVisible();
  expect(reads).toBeGreaterThan(initialReads);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(external).toEqual([]);
});
