import { encodeActivityEmoji } from "@hb/contracts";
import { expect, type Page, test } from "@playwright/test";
import { mockSession, openApp, viewer } from "./support/app";

// 领取范围 (docs/claim-scope-design.md §5): its tag on the 红包皮 and the
// card, and what someone outside is told when they press the seal.

const id = "55555555-6666-4777-8888-999999999999";
const path = `/🧧/${encodeActivityEmoji(id)}`;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const author = {
  id: "author-e2e",
  username: "xiaoman",
  displayName: "小满",
  avatarUrl: null,
};
const scope = {
  levels: { min: 2, max: 4 },
  users: [
    { username: "XiaoHong", displayName: "小红", avatarUrl: null },
    { username: "viewer" },
  ],
};
const activity = {
  id,
  title: "老朋友的红包",
  rewardType: "ldc",
  participationMode: "direct",
  status: "active",
  author,
  forceDedicated: false,
  topicUrl: null,
  openedAt: iso(now - 600_000),
  deadlineAt: iso(now + 3_600_000),
  quantity: { mode: "exact", total: 5, claimed: 1, remaining: 4 },
  reward: { mode: "fixed", totalAmount: "0.50", unitAmount: "0.10", count: 5 },
  beforeInfo: "",
  paymentMode: "simulation",
  scope,
  rosterPreview: [],
};

/** The 红包 and its parts; claims answer `claim` and are counted. */
async function mock(
  page: Page,
  claim: { status: number; json: unknown } = {
    status: 403,
    json: {
      error: { code: "NOT_IN_SCOPE", message: "这个红包只有部分人能领" },
    },
  },
) {
  const claims: unknown[] = [];
  await page.route(`**/api/activities/${id}**`, (route) => {
    const rest = new URL(route.request().url()).pathname.slice(
      `/api/activities/${id}`.length,
    );
    if (rest === "/claim" && route.request().method() === "POST") {
      claims.push(route.request().postDataJSON());
      return route.fulfill(claim);
    }
    if (rest === "") return route.fulfill({ json: { activity } });
    if (rest.startsWith("/participation") || rest === "/claim")
      return route.fulfill({ json: { claim: null, registration: null } });
    if (rest === "/passwords")
      return route.fulfill({
        json: { passwords: [], hiddenCount: 0, canSolve: false },
      });
    return route.fulfill({
      json: {
        items: [],
        nextCursor: null,
        titles: { highestClaimIds: [], lowestClaimIds: [] },
      },
    });
  });
  return claims;
}

test.describe("领取范围", () => {
  test("红包皮上写明仅限谁；范围外的人点印章，说清谁能领，不发请求", async ({
    page,
  }) => {
    await mockSession(page, {
      ...viewer,
      username: "outsider",
      trustLevel: 1,
      profileSeenAt: new Date(2026, 9, 20, 9, 30).getTime(),
    });
    const claims = await mock(page);
    await openApp(page, path);
    await expect(
      page.getByRole("button", { name: "仅限 Lv2 及以上或指定的 2 人" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "领取红包" }).click();
    const dialog = page.getByRole("dialog", {
      name: "这个红包只有部分人能领",
    });
    await expect(dialog).toContainText(
      "Lv2 及以上的人，或指定的 2 位，都能领。",
    );
    await expect(dialog).toContainText("信任等级Lv2 及以上");
    await expect(dialog).toContainText("@XiaoHong");
    await expect(dialog).toContainText("@viewer");
    await expect(dialog).toContainText(
      "本站记的是你 10月20日登录时的等级：Lv1。等级变了的话，重新登录一次就能更新。",
    );
    await expect(
      dialog.getByRole("button", { name: "重新登录" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "知道了" }).click();
    await expect(dialog).toBeHidden();
    expect(claims).toHaveLength(0);
  });

  test("等级还不知道：提示重新登录一次", async ({ page }) => {
    await mockSession(page, {
      ...viewer,
      username: "outsider",
      trustLevel: null,
    });
    await mock(page);
    await openApp(page, path);
    await page.getByRole("button", { name: "领取红包" }).click();
    await expect(
      page.getByRole("dialog", { name: "这个红包只有部分人能领" }),
    ).toContainText("还不知道你的等级，重新登录一次就能更新。");
  });

  test("指定的人照常领取；服务器说不在范围里，也弹同一个说明", async ({
    page,
  }) => {
    // Named, so the page lets it through; the server (here) turns it away.
    await mockSession(page, { ...viewer, trustLevel: 0 });
    const claims = await mock(page);
    await openApp(page, path);
    await page.getByRole("button", { name: "领取红包" }).click();
    await expect(
      page.getByRole("dialog", { name: "这个红包只有部分人能领" }),
    ).toBeVisible();
    expect(claims).toHaveLength(1);
  });

  test("红包广场的卡片带同样的标签", async ({ page }) => {
    await mockSession(page, null);
    await page.route("**/api/discovery/activities?**", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              ...activity,
              scope: { levels: { min: 1, max: 3 } },
              myClaim: null,
            },
          ],
          nextCursor: null,
          total: 1,
        },
      }),
    );
    await openApp(page, "/square");
    await expect(
      page.getByRole("button", { name: /老朋友的红包/ }),
    ).toContainText("仅限 Lv1–3");
  });
});
