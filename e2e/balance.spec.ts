import { expect, type Page, test } from "@playwright/test";
import type {
  BalanceTopup,
  BalanceWithdrawal,
} from "../packages/contracts/src";
import {
  expectPath,
  mockSession,
  omniboxInput,
  openApp,
  viewer,
} from "./support/app";

// 🐟额 (docs/balance-design.md) against a mocked API: who sees it, the
// page, the 转入 and 转出 dialogs' two boxes, and a 转出 as it is sent.

const topupId = "11111111-2222-4333-8444-555555555555";
const withdrawalId = "66666666-7777-4888-8999-aaaaaaaaaaaa";

function withdrawal(extra: Partial<BalanceWithdrawal> = {}): BalanceWithdrawal {
  return {
    id: withdrawalId,
    businessNo: "hb.lafi.sh_out_0123456789abcdef0123456789abcdef",
    externalOrderId: null,
    status: "sending",
    debitMinor: 1000,
    feeMinor: 120,
    creditMinor: 880,
    feePercent: 12,
    recipientUsername: viewer.username,
    createdAt: Date.now() - 30_000,
    sentAt: null,
    failedAt: null,
    failure: null,
    wait: "queued",
    resumeAt: null,
    ...extra,
  };
}

function topup(extra: Partial<BalanceTopup> = {}): BalanceTopup {
  const now = Date.now();
  return {
    id: topupId,
    businessNo: "hb.lafi.sh_in_0123456789abcdef0123456789abcdef",
    externalOrderId: null,
    status: "pending",
    flag: null,
    debitMinor: 11_364,
    feeMinor: 1364,
    creditMinor: 10_000,
    feePercent: 12,
    createdAt: now - 60_000,
    payableUntil: now + 9 * 60_000,
    creditedAt: null,
    creditedBy: null,
    lastCheckedAt: null,
    ...extra,
  };
}

const plusFeatures = [
  { name: "转入", text: "把 Credit 的 LDC 转进🐟额" },
  { name: "转账", text: "转给别人的🐟额或 Credit 账户" },
  { name: "开放接口", text: "接入网站或程序" },
  { name: "邀请", text: "请别人也开通" },
];

async function mockBalance(
  page: Page,
  options: { withdraw?: boolean; invited?: boolean; hongbao?: boolean } = {},
) {
  const sent: unknown[] = [];
  const invited = options.invited ?? true;
  await page.route("**/api/me/balance/api-keys", (route) =>
    route.fulfill({ json: { items: [], max: 10 } }),
  );
  await page.route("**/api/me/balance?**", (route) =>
    route.fulfill({
      json: {
        settings: {
          version: 3,
          topupEnabled: true,
          withdrawEnabled: options.withdraw ?? false,
          topupFeePercent: 12,
          withdrawFeePercent: 12,
          withdrawMaxMinor: 100_000,
          topupMinMinor: 100,
          topupMaxMinor: 200_000,
          topupDailyHintMinor: 80_000,
          withdrawMinMinor: 100,
          hongbaoEnabled: options.hongbao ?? false,
          transferEnabled: true,
          transferToCreditBlock: options.withdraw ? null : "WITHDRAW_DISABLED",
        },
        account: { availableMinor: 1234, lockedMinor: 0 },
        access: {
          topup: invited,
          invite: invited,
          owner: false,
          transfer: invited,
        },
        plus: {
          plus: invited,
          owner: false,
          invitedBy: invited
            ? { username: "lafish", displayName: "Lafish", avatarUrl: null }
            : null,
          since: invited ? Date.now() - 86_400_000 : null,
          features: invited ? plusFeatures : null,
          featureCount: 4,
        },
        openTopups: 1,
        items: [
          { type: "topup", createdAt: Date.now() - 60_000, topup: topup() },
          {
            type: "adjustment",
            createdAt: Date.now() - 120_000,
            adjustment: {
              id: "adj-e2e-1",
              direction: "deduct",
              amountMinor: 200,
              reason: "Credit 退款后扣回",
              createdAt: Date.now() - 120_000,
            },
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/me/balance/topups/check-open", (route) =>
    route.fulfill({ json: { credited: 0 } }),
  );
  await page.route("**/api/me/balance/topups", (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { topup: topup(), cashierUrl: null } });
  });
  await page.route(`**/api/me/balance/topups/${topupId}/check`, (route) =>
    route.fulfill({ json: { topup: topup() } }),
  );
  return sent;
}

test.describe("🐟额", () => {
  test("没受邀、也没有记录的人：用户卡片和命令里都没有，直接打开说仅对受邀用户开放", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await page.route("**/api/me/balance?**", (route) =>
      route.fulfill({
        status: 404,
        json: {
          error: {
            code: "BALANCE_NOT_OPEN",
            message: "本功能仅对受邀用户开放。",
          },
        },
      }),
    );
    await openApp(page);
    await omniboxInput(page).click();
    await omniboxInput(page).fill("/余额");
    await expect(page.getByRole("option", { name: /🐟额/ })).toHaveCount(0);
    await openApp(page, "/balance");
    await expect(
      page.getByText(
        "还没有🐟额。受邀开通🐟额 PLUS，或者领到🐟额红包、收到转账后就有了。",
      ),
    ).toBeVisible();
  });

  test("有记录、没开通 PLUS 的人：能转出，没有转入和转账；灰色 PLUS 里多出的是乱码", async ({
    page,
  }) => {
    await mockSession(page, { ...viewer, balance: true });
    await mockBalance(page, { withdraw: true, invited: false });
    await openApp(page, "/balance");
    await expect(page.getByRole("heading", { name: /🐟额/ })).toBeVisible();
    const header = page.locator("header");
    await expect(
      header.getByRole("button", { name: "转出", exact: true }),
    ).toBeVisible();
    for (const name of ["转入", "转账", "邀请"])
      await expect(
        header.getByRole("button", { name, exact: true }),
      ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "开放接口密钥" }),
    ).toHaveCount(0);
    await header
      .getByRole("button", { name: "🐟额 PLUS，还没开通", exact: true })
      .click();
    const bubble = page.getByRole("dialog", { name: "🐟额 PLUS，还没开通" });
    await expect(bubble.getByText("你现在能")).toBeVisible();
    await expect(bubble.getByText("开通后多出")).toBeVisible();
    await expect(bubble.getByText("要已开通的人邀请才能开通。")).toBeVisible();
    await expect(bubble.getByText("接入网站或程序")).toHaveCount(0);
    await expect(
      bubble.getByRole("button", { name: /邀请别人开通/ }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(bubble).toHaveCount(0);
  });

  test("邀请：输入用户名看到是谁，自己和已受邀的不给链接，生成后能复制，下面列着最近的邀请", async ({
    page,
  }) => {
    await mockSession(page, { ...viewer, balance: true });
    await mockBalance(page);
    await page.route("**/api/me/balance/invites/preview?**", (route) => {
      const username = new URL(route.request().url()).searchParams.get(
        "username",
      );
      return route.fulfill({
        json:
          username === "viewer"
            ? { user: null, self: true, member: true }
            : username === "taken"
              ? {
                  user: {
                    username: "Taken",
                    displayName: "老朋友",
                    avatarUrl: null,
                  },
                  self: false,
                  member: true,
                }
              : username === "friend"
                ? {
                    user: {
                      username: "Friend",
                      displayName: "新朋友",
                      avatarUrl: null,
                    },
                    self: false,
                    member: false,
                  }
                : { user: null, self: false, member: false },
      });
    });
    const made: unknown[] = [];
    await page.route("**/api/me/balance/invites", (route) => {
      if (route.request().method() === "POST") {
        made.push(route.request().postDataJSON());
        return route.fulfill({
          json: {
            url: "https://hb.lafi.sh/invite/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd",
            invite: {
              id: "inv-1",
              username: "friend",
              status: "pending",
              createdAt: Date.now(),
              expiresAt: Date.now() + 86_400_000,
              acceptedAt: null,
              acceptedBy: null,
            },
          },
        });
      }
      return route.fulfill({
        json: {
          items: [
            {
              id: "inv-0",
              username: "oldfriend",
              status: "accepted",
              createdAt: Date.now() - 3_600_000,
              expiresAt: Date.now() + 82_800_000,
              acceptedAt: Date.now() - 3_000_000,
              acceptedBy: {
                username: "OldFriend",
                displayName: "旧朋友",
                avatarUrl: null,
              },
            },
          ],
        },
      });
    });
    await openApp(page, "/balance");
    // 邀请 lives in PLUS's bubble now (balance-design §13).
    await page
      .locator("header")
      .getByRole("button", { name: "🐟额 PLUS", exact: true })
      .click();
    const bubble = page.getByRole("dialog", { name: "🐟额 PLUS" });
    await expect(
      bubble.getByText("由 @lafish 邀请", { exact: false }),
    ).toBeVisible();
    await expect(bubble.getByText("接入网站或程序")).toBeVisible();
    await bubble.getByRole("button", { name: /邀请别人开通/ }).click();
    const dialog = page.getByRole("dialog", { name: "邀请开通🐟额 PLUS" });
    await expect(dialog.getByText("对方接受后开通🐟额 PLUS。")).toBeVisible();
    await expect(dialog.getByText("@OldFriend")).toBeVisible();
    await expect(dialog.getByText("已接受")).toBeVisible();
    const input = dialog.getByLabel("对方的用户名");
    await input.fill("viewer");
    await expect(dialog.getByText("不能邀请自己")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "生成链接" }),
    ).toHaveAttribute("aria-disabled", "true");
    // Pasted with its @: the box keeps one, in front.
    await input.fill("@taken");
    await expect(input).toHaveValue("taken");
    await expect(dialog.getByText("@Taken 已经开通")).toBeVisible();
    await input.fill("stranger");
    await expect(
      dialog.getByText("这个人还没来过本站，确认用户名没拼错就行。"),
    ).toBeVisible();
    await input.fill("friend");
    await expect(dialog.getByText("新朋友 @Friend")).toBeVisible();
    await dialog.getByRole("button", { name: "生成链接" }).click();
    await expect(dialog.getByRole("textbox", { name: "邀请链接" })).toHaveValue(
      /\/invite\/AbCdEf/,
    );
    await expect(dialog.getByText("1 天内有效，只能用一次。")).toBeVisible();
    expect(made).toEqual([{ username: "friend" }]);
    await dialog.getByRole("button", { name: "再邀请一个" }).click();
    await expect(dialog.getByLabel("对方的用户名")).toHaveValue("");
  });

  test("接受页：写明谁邀请、Credit 收全部流转费，接受后去🐟额；账号不对时说清楚", async ({
    page,
  }) => {
    const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd";
    let matches = false;
    const accepted: unknown[] = [];
    await mockSession(page, { ...viewer, balance: false });
    await mockBalance(page);
    await page.route(`**/api/invites/${token}`, (route) =>
      route.fulfill({
        json: {
          invite: {
            inviter: {
              username: "lafish",
              displayName: "Lafish",
              avatarUrl: null,
            },
            username: "viewer",
            status: "pending",
            expiresAt: Date.now() + 3_600_000,
          },
          topupFeePercent: 12,
          hongbaoEnabled: true,
          features: plusFeatures,
          viewer: {
            username: matches ? "viewer" : "someone",
            matches,
            isInviter: false,
            member: false,
            acceptedThis: false,
          },
        },
      }),
    );
    await page.route(`**/api/invites/${token}/accept`, (route) => {
      accepted.push(true);
      return route.fulfill({ json: { accepted: true } });
    });
    await openApp(page, `/invite/${token}`);
    const heading = page.getByRole("heading", {
      name: /Lafish（@lafish）邀请你开通🐟额 PLUS/,
    });
    await expect(heading).toBeVisible();
    // Its PLUS is the gold tag, as beside 🐟额's title.
    await expect(heading.getByText("PLUS", { exact: true })).toHaveClass(
      /bg-gold-soft/,
    );
    await expect(
      page.getByText("🐟额是由本站托管的 LDC，1 🐟 = 1 LDC，可用于发红包。"),
    ).toBeVisible();
    // What PLUS adds, in plain words for one holding an invitation.
    await expect(page.getByText("接入网站或程序")).toBeVisible();
    await expect(
      page.getByText(/流转费（12%）全部由 Credit 收取，本站没有任何收益/),
    ).toBeVisible();
    await expect(
      page.getByText(
        "这个邀请是给 @viewer 的，你现在登录的是 @someone。用那个账号登录后再打开这个链接。",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "接受邀请" })).toHaveCount(0);

    matches = true;
    await page.reload();
    await page.getByRole("button", { name: "接受邀请" }).click();
    await expectPath(page, "/balance");
    expect(accepted).toHaveLength(1);
  });

  test("通用链接的接受页：不核对用户名，谁登录都能接受；用完了写清楚", async ({
    page,
  }) => {
    const token = "LinkLinkLinkLinkLinkLinkLinkLinkLinkLink123";
    let status = "pending";
    await mockSession(page, { ...viewer, balance: false });
    await mockBalance(page);
    await page.route(`**/api/invites/${token}`, (route) =>
      route.fulfill({
        json: {
          invite: {
            inviter: {
              username: "lafish",
              displayName: "Lafish",
              avatarUrl: null,
            },
            username: null,
            status,
            expiresAt: null,
            note: "example.com 的用户\n在这里开通",
          },
          topupFeePercent: 12,
          features: plusFeatures,
          viewer: {
            username: "someone",
            matches: true,
            isInviter: false,
            member: false,
            acceptedThis: false,
          },
        },
      }),
    );
    await openApp(page, `/invite/${token}`);
    await expect(
      page.getByRole("heading", {
        name: /Lafish（@lafish）邀请你开通🐟额 PLUS/,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "接受邀请" })).toBeVisible();
    await expect(page.getByText(/这个邀请是给/)).toHaveCount(0);
    // Its 附言 under the title, line breaks kept.
    await expect(
      page.getByText("example.com 的用户\n在这里开通", { exact: true }),
    ).toBeVisible();
    // 🐟额红包 off: nothing said about sending 红包.
    await expect(
      page.getByText("🐟额是由本站托管的 LDC，1 🐟 = 1 LDC。", { exact: true }),
    ).toBeVisible();

    status = "used_up";
    await page.reload();
    await expect(
      page.getByText("这条邀请链接的名额已经用完了。"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "接受邀请" })).toHaveCount(0);
  });

  test("名单里的人：能搜到；页面写着可用和明细；转入两个框互算，越界不能确认", async ({
    page,
  }) => {
    await mockSession(page, { ...viewer, balance: true });
    const sent = await mockBalance(page);
    await openApp(page);
    await omniboxInput(page).click();
    await omniboxInput(page).fill("/余额");
    await expect(page.getByRole("option", { name: /🐟额/ })).toBeVisible();

    await openApp(page, "/balance");
    await expect(page.getByRole("heading", { name: /🐟额/ })).toBeVisible();
    await expect(page.locator("dl dd").first()).toHaveText(/12\.34\s*🐟/);
    await expect(page.getByText("1 🐟 = 1 LDC，由本站托管。")).toBeVisible();
    await expect(
      page.getByText("有 1 笔转入还没到账", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Credit 退款后扣回")).toBeVisible();
    await expect(page.getByText("站长扣回")).toBeVisible();

    await page
      .locator("header")
      .getByRole("button", { name: "转入", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "转入🐟额" });
    await dialog.getByLabel("到账").fill("100");
    await expect(dialog.getByLabel("Credit 扣除")).toHaveValue("113.64");
    await dialog.getByLabel("Credit 扣除").fill("100");
    await expect(dialog.getByLabel("到账")).toHaveValue("88.00");
    await dialog.getByLabel("Credit 扣除").fill("900");
    await expect(dialog.getByText(/每天最多能花出 800–2000 LDC/)).toBeVisible();
    // The bounds show only once an amount is past one, and say which.
    await expect(dialog.getByText(/一笔转入/)).toHaveCount(0);
    await dialog.getByLabel("Credit 扣除").fill("2000.01");
    await expect(dialog.getByText("一笔转入最多 2000.00 LDC。")).toBeVisible();
    await expect(dialog.getByText(/每天最多能花出/)).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "去 Credit 确认" }),
    ).toHaveAttribute("aria-disabled", "true");
    await dialog.getByLabel("到账").fill("0.5");
    await expect(dialog.getByText("一笔转入至少 1.00 LDC。")).toBeVisible();

    await dialog.getByLabel("到账").fill("100");
    await dialog.getByRole("button", { name: "去 Credit 确认" }).click();
    // No cashier this time: the 转入 itself, waiting to be confirmed.
    await expectPath(page, `/balance/${topupId}`);
    await expect(page.getByText("等你在 Credit 确认。")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "去 Credit 确认" }),
    ).toBeVisible();
    expect(sent).toEqual([
      expect.objectContaining({
        settingsVersion: 3,
        by: "credit",
        amount: "100",
      }),
    ]);
  });

  test("🐟额红包开着时，说明写上可用于发红包", async ({ page }) => {
    await mockSession(page, { ...viewer, balance: true });
    await mockBalance(page, { hongbao: true });
    await openApp(page, "/balance");
    await expect(
      page.getByText("1 🐟 = 1 LDC，由本站托管，可用于发红包。"),
    ).toBeVisible();
  });

  test("转出：只填🐟，说明 Credit 可能收分发费，越界说是哪一头，申请后跟着它发出去", async ({
    page,
  }) => {
    await mockSession(page, { ...viewer, balance: true });
    await mockBalance(page, { withdraw: true });
    const asked: unknown[] = [];
    await page.route("**/api/me/balance/withdrawals", (route) => {
      asked.push(route.request().postDataJSON());
      return route.fulfill({ json: { withdrawal: withdrawal() } });
    });
    // The queue moves it: held by the daily limit, then 已发放.
    let reads = 0;
    await page.route(
      `**/api/me/balance/withdrawals/${withdrawalId}`,
      (route) => {
        reads += 1;
        return route.fulfill({
          json: {
            withdrawal:
              reads === 1
                ? withdrawal({
                    wait: "quota",
                    resumeAt: Date.now() + 3_600_000,
                  })
                : withdrawal({
                    status: "sent",
                    wait: null,
                    sentAt: Date.now(),
                    externalOrderId: "credit_9",
                  }),
          },
        });
      },
    );
    await openApp(page, "/balance");
    await page
      .locator("header")
      .getByRole("button", { name: "转出", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "转出🐟额" });
    await expect(
      dialog.getByText(`@${viewer.username}`, { exact: false }),
    ).toBeVisible();
    // One box, in 🐟: what arrives is Credit's to say, after its 分发费.
    await expect(dialog.getByText(/Credit 可能会收取分发费/)).toBeVisible();
    await expect(dialog.getByLabel("预计到账")).toHaveCount(0);
    await dialog.getByLabel("转出数量").fill("10");
    // 可用 is 12.34: more is refused, and so is less than 1.
    await expect(dialog.getByText(/一笔转出|可用只有/)).toHaveCount(0);
    await dialog.getByLabel("转出数量").fill("20");
    await expect(dialog.getByText("可用只有 12.34 🐟。")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "转出", exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
    await dialog.getByLabel("转出数量").fill("0.5");
    await expect(dialog.getByText("一笔转出至少 1.00 🐟。")).toBeVisible();
    await dialog.getByLabel("转出数量").fill("10");
    await dialog.getByRole("button", { name: "转出", exact: true }).click();

    await expectPath(page, `/balance/out/${withdrawalId}`);
    await expect(page.getByText(/平台今天的额度用完了/).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("已发放", { exact: true }).first()).toBeVisible(
      { timeout: 10_000 },
    );
    await expect(
      page.getByText(`已发到你的 Credit 账户 @${viewer.username}。`),
    ).toBeVisible();
    await expect(page.getByText("credit_9")).toBeVisible();
    expect(asked).toEqual([
      expect.objectContaining({
        settingsVersion: 3,
        by: "debit",
        amount: "10",
      }),
    ]);
  });
  test("转账：找到人才能转，选到哪，确认后说转给了谁；发到 Credit 有它的限制", async ({
    page,
  }) => {
    await mockSession(page, { ...viewer, balance: true, balancePlus: true });
    await mockBalance(page, { withdraw: true });
    await page.route("**/api/me/balance/recipients?**", (route) => {
      const username = new URL(route.request().url()).searchParams.get(
        "username",
      );
      return route.fulfill({
        json:
          username === "friend"
            ? {
                user: {
                  userId: "12345",
                  username: "Friend",
                  displayName: "新朋友",
                  avatarUrl: null,
                },
                self: false,
                owner: false,
              }
            : username === "lafish"
              ? {
                  user: {
                    userId: "1",
                    username: "lafish",
                    displayName: "站长",
                    avatarUrl: null,
                  },
                  self: false,
                  owner: true,
                }
              : { user: null, self: false, owner: false },
      });
    });
    const sent: Record<string, unknown>[] = [];
    await page.route("**/api/me/balance/transfers", (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      sent.push(body);
      return route.fulfill({
        json: {
          transfer: {
            id: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
            direction: "out",
            destination: body.destination,
            amountMinor: 250,
            remark: body.remark ?? null,
            counterpart: {
              userId: "12345",
              username: "Friend",
              displayName: "新朋友",
              avatarUrl: null,
            },
            apiKeyName: null,
            outTransferNo: null,
            status: "sent",
            withdrawal: null,
            createdAt: Date.now(),
          },
        },
      });
    });
    await openApp(page, "/balance");
    await page
      .locator("header")
      .getByRole("button", { name: "转账", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "转账" });
    const name = dialog.getByLabel("收款人");
    await name.fill("stranger");
    await expect(
      dialog.getByText("这个人还没来过本站，来过才能收🐟。"),
    ).toBeVisible();
    await name.fill("lafish");
    await expect(
      dialog.getByText(
        "不能发到 Credit：站长的 Credit 账户收不了平台应用的发放",
      ),
    ).toBeVisible();
    await name.fill("@friend");
    await expect(dialog.getByText("新朋友 @Friend")).toBeVisible();
    await expect(dialog.getByText("数字 ID 12345")).toBeVisible();
    await dialog.getByRole("button", { name: /对方的 Credit 账户/ }).click();
    await dialog.getByLabel("数量").fill("0.5");
    await expect(dialog.getByText("发到 Credit 至少 1.00 🐟。")).toBeVisible();
    await dialog.getByRole("button", { name: /对方的🐟额/ }).click();
    await dialog.getByLabel("数量").fill("20");
    await expect(dialog.getByText("可用只有 12.34 🐟。")).toBeVisible();
    await dialog.getByLabel("数量").fill("2.5");
    await dialog.getByLabel("备注").fill("午饭钱");
    await dialog.getByRole("button", { name: "转账", exact: true }).click();
    const confirm = page.getByRole("dialog", {
      name: "转给 @Friend 2.50 🐟？",
    });
    await expect(confirm.getByText("转出去不能撤回。")).toBeVisible();
    await confirm.getByRole("button", { name: "确认转账" }).click();
    await expect(dialog.getByText("已转给 @Friend 2.50 🐟。")).toBeVisible();
    expect(sent).toEqual([
      expect.objectContaining({
        toUserId: "12345",
        toUsername: "Friend",
        destination: "balance",
        amount: "2.5",
        remark: "午饭钱",
      }),
    ]);
  });

  test("开放接口密钥：名称和上限，生成后只显示一次，说清拿到它能做什么", async ({
    page,
  }) => {
    await mockSession(page, { ...viewer, balance: true, balancePlus: true });
    await mockBalance(page);
    const made: unknown[] = [];
    await page.route("**/api/me/balance/api-keys", (route) => {
      if (route.request().method() === "POST") {
        made.push(route.request().postDataJSON());
        return route.fulfill({
          json: {
            token: "hbk_abcdefghijklmnopqrstuvwxyz012345",
            key: {
              id: "key-1",
              name: "我的小站",
              lastFour: "2345",
              status: "active",
              dailyLimitMinor: 10_000,
              usedTodayMinor: 0,
              createdAt: Date.now(),
              lastTransferAt: null,
              lastTransferIp: null,
              transferCount: 0,
              transferTotalMinor: 0,
              revokedAt: null,
              revokeReason: null,
            },
          },
        });
      }
      return route.fulfill({ json: { items: [], max: 10 } });
    });
    await openApp(page, "/balance");
    await expect(
      page.getByRole("heading", { name: "开放接口密钥" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "接口说明" })).toHaveAttribute(
      "href",
      "/help/api",
    );
    await page.getByRole("button", { name: "新建", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建开放接口密钥" });
    await dialog.getByLabel("名称").fill("我的小站");
    await dialog.getByLabel("每日上限").fill("100");
    await dialog.getByRole("button", { name: "生成" }).click();
    await expect(dialog.getByLabel("密钥", { exact: true })).toHaveValue(
      "hbk_abcdefghijklmnopqrstuvwxyz012345",
    );
    await expect(
      dialog.getByText("只显示这一次。丢了就停用它，再新建一个。"),
    ).toBeVisible();
    await expect(
      dialog.getByText("拿到密钥的人能用它转走你的🐟，也能看到你收到的转账。"),
    ).toBeVisible();
    expect(made).toEqual([{ name: "我的小站", dailyLimit: "100" }]);
  });
});
