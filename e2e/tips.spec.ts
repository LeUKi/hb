import { expect, type Page, test } from "@playwright/test";
import type {
  PublicTipCard,
  Tip,
  TipCard,
  TipViewer,
} from "../packages/contracts/src";
import { csrfToken, mockSession, openApp, viewer } from "./support/app";

// 打赏 (docs/tip-design.md) against a mocked API: a card on its ☕ page
// tipped from 🐟额 to done, a Credit 站 link with its manual check, a guest
// who only gets Credit 站, and 我的打赏 with the PLUS tag and its cards.

const owner = { username: "lafish", displayName: "lafish", avatarUrl: null };

function card(extra: Partial<PublicTipCard> = {}): PublicTipCard {
  return {
    code: "k7Q2mX",
    version: 3,
    active: true,
    owner,
    style: "standard",
    palette: "lake",
    prompt: "觉得有用的话，请我喝杯咖啡",
    amounts: [1, 5, 10, 20].map((n) => ({ amountMinor: n * 100, label: "" })),
    defaultIndex: 2,
    allowOther: true,
    goal: null,
    tipperCount: 2,
    recent: null,
    top: null,
    ...extra,
  };
}

function signedInViewer(extra: Partial<TipViewer> = {}): TipViewer {
  return {
    signedIn: true,
    own: false,
    methods: {
      checkout: { available: true, reason: null },
      merchant: null,
      balance: { availableMinor: 3230 },
    },
    passwordFree: true,
    paused: false,
    capEndpoint: null,
    ...extra,
  };
}

function tip(extra: Partial<Tip> = {}): Tip {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    card: { code: "k7Q2mX", name: null },
    direction: "out",
    counterpart: owner,
    amountMinor: 1000,
    method: "balance",
    message: null,
    messageHidden: false,
    status: "done",
    notSentReason: null,
    via: "web",
    createdAt: Date.now(),
    doneAt: Date.now(),
    ...extra,
  };
}

async function mockCard(
  page: Page,
  view: { card: PublicTipCard; viewer: TipViewer },
) {
  await page.route("**/api/tip/k7Q2mX", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: view })
      : route.fallback(),
  );
}

const tipCard = (page: Page) => page.locator(".tip-card");

test.describe("打赏", () => {
  test("☕ 页面：选数额，选🐟额，确认后打赏完成；请求带着卡的版本和数额", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockCard(page, { card: card(), viewer: signedInViewer() });
    const bodies: unknown[] = [];
    await page.route("**/api/tip/k7Q2mX", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
      bodies.push(route.request().postDataJSON());
      return route.fulfill({
        json: { tip: tip({ amountMinor: 2000 }), payUrl: null },
      });
    });
    await openApp(page, "/☕/k7Q2mX");
    await expect(
      page.getByRole("heading", { name: "打赏 lafish" }),
    ).toBeVisible();
    await expect(tipCard(page)).toContainText("打赏 10 LDC");
    await tipCard(page).getByRole("button", { name: /^20/ }).click();
    await expect(tipCard(page)).toContainText("打赏 20 LDC");
    await tipCard(page)
      .getByRole("button", { name: /打赏 20 LDC/ })
      .click();
    await expect(tipCard(page)).toContainText("20 LDC 打赏给 @lafish");
    await tipCard(page).getByRole("button", { name: /🐟额/ }).click();
    const confirm = tipCard(page).getByRole("button", { name: "确认打赏" });
    await expect(tipCard(page)).toContainText("从你的🐟额转出，不能撤回");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(tipCard(page)).toContainText("已打赏 20 🐟");
    expect(bodies[0]).toMatchObject({
      cardVersion: 3,
      amount: "20.00",
      method: "balance",
    });
  });

  test("Credit 站：生成链接在新页面打开，查了还没付就倒数 5 秒", async ({
    page,
    context,
  }) => {
    await mockSession(page, viewer);
    await mockCard(page, { card: card(), viewer: signedInViewer() });
    await page.route("**/api/tip/k7Q2mX", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            json: {
              tip: tip({ method: "checkout", status: "pending", doneAt: null }),
              payUrl: "https://credit.example.test/paying?order_no=1",
            },
          })
        : route.fallback(),
    );
    await page.route("**/api/tip/k7Q2mX/tips/*/check", (route) =>
      route.fulfill({
        json: {
          tip: tip({ method: "checkout", status: "pending", doneAt: null }),
          payUrl: null,
        },
      }),
    );
    await context.route("https://credit.example.test/**", (route) =>
      route.fulfill({ body: "<title>Credit</title>" }),
    );
    await openApp(page, "/☕/k7Q2mX");
    await tipCard(page)
      .getByRole("button", { name: /打赏 10 LDC/ })
      .click();
    await tipCard(page)
      .getByRole("button", { name: /Credit 站/ })
      .click();
    const open = tipCard(page).getByRole("button", {
      name: "去 Credit 站付款 ↗",
    });
    await expect(open).toBeVisible();
    const popup = page.waitForEvent("popup");
    await open.click();
    expect((await popup).url()).toContain("credit.example.test");
    await expect(tipCard(page)).toContainText("等你在新页面付款…");
    await tipCard(page)
      .getByRole("button", { name: "我付好了，查一下" })
      .click();
    await expect(tipCard(page)).toContainText("还没查到这笔付款");
    await expect(
      tipCard(page).getByRole("button", { name: /再查一下（/ }),
    ).toBeDisabled();
  });

  test("没登录的人只能去 Credit 站付", async ({ page }) => {
    await mockSession(page, null);
    await mockCard(page, {
      card: card(),
      viewer: signedInViewer({
        signedIn: false,
        methods: {
          checkout: { available: true, reason: null },
          merchant: null,
          balance: null,
        },
        capEndpoint: "https://cap.example.test/hb/scope/tip:k7Q2mX/",
      }),
    });
    await openApp(page, "/☕/k7Q2mX");
    await tipCard(page)
      .getByRole("button", { name: /打赏 10 LDC/ })
      .click();
    await expect(
      tipCard(page).getByRole("button", { name: /去 Credit 站付/ }),
    ).toBeVisible();
    await expect(
      tipCard(page).getByRole("button", { name: /🐟额/ }),
    ).toHaveCount(0);
  });

  test("我的打赏：标题旁是 PLUS 标签，只写用了几张；卡片的预览放在最后", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const mine: TipCard = {
      ...card(),
      name: "个人页",
      showRecent: false,
      showTop: false,
      link: { kind: "profile" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stoppedAt: null,
      stoppedByAdmin: false,
      stopReason: null,
      week: { count: 6, amountMinor: 5800 },
    };
    const {
      owner: _o,
      recent: _r,
      top: _t,
      ...rest
    } = mine as TipCard & PublicTipCard;
    await page.route("**/api/me/tips", (route) =>
      route.fulfill({
        json: {
          cards: [rest],
          used: 1,
          limit: 3,
          enabled: true,
          plus: {
            plus: false,
            owner: false,
            invitedBy: null,
            since: null,
            features: null,
            featureCount: 7,
          },
        },
      }),
    );
    await page.route("**/api/me/tips/list/**", (route) =>
      route.fulfill({
        json: {
          tips: [],
          stats: { count: 0, people: 0, amountMinor: 0 },
          cursor: null,
        },
      }),
    );
    await openApp(page, "/tips");
    await expect(page.getByRole("heading", { name: /我的打赏/ })).toBeVisible();
    await expect(page.getByText("用了 1 张，最多 3 张")).toBeVisible();
    await expect(page.getByText("开通🐟额 PLUS 能有")).toHaveCount(0);
    const panel = page
      .locator("li, section")
      .filter({ hasText: "个人页" })
      .first();
    await expect(panel).toBeVisible();
    // The preview comes after the name and the buttons.
    const order = await page.evaluate(() => {
      const preview = document.querySelector(".tip-card");
      const edit = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "编辑",
      );
      return preview && edit
        ? edit.compareDocumentPosition(preview) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0;
    });
    expect(order).toBeTruthy();
  });
});
