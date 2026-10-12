import { expect, type Page, test } from "@playwright/test";
import type {
  AccountTier,
  ClaimActivityInput,
  ClaimDetail,
  CreateActivityInput,
  ManagedActivity,
  PublicActivity,
} from "../packages/contracts/src";

const activityId = "40b880e4-fb90-451b-a731-4a4a12b5dcc3";
const claimId = "0adf5526-bf82-4f47-a9c3-425bdf27b657";
const resultId = "82e185b3-2a69-4a2c-b720-2bf8e62d39c3";
const merchantId = "3837e3f5-8d5c-40aa-8b61-c6496df6ca18";

async function expectPathname(page: Page, pathname: string) {
  await expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
}

async function refreshIdentity(page: Page) {
  await page.clock.fastForward(31_000);
  await page.evaluate(() => {
    const previous = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    window.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    window.dispatchEvent(new Event("visibilitychange"));
    if (previous) Object.defineProperty(document, "visibilityState", previous);
    else Reflect.deleteProperty(document, "visibilityState");
  });
}

function merchantFixture() {
  const now = new Date().toISOString();
  return {
    id: merchantId,
    label: "青春测试商户",
    clientId: "lite_merchant",
    mode: "simulation" as const,
    scenario: "normal" as const,
    version: 1,
    credentialVersion: 1,
    usageStatus: "current" as const,
    publicationEligibility: {
      allowed: true,
      reason: null,
      credentialVersion: 1,
    },
    credentialVerification: {
      status: "unverified" as const,
      credentialVersion: 1,
      checkedAt: null,
      nextCheckAt: null,
      reason: null,
    },
    capabilities: {
      canExecutePayments: true,
      canCheck: true,
      canSimulate: true,
      canVerify: false,
    },
    pausedReason: null,
    paymentCheckNextAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function mockLite(
  page: Page,
  options: {
    tier?: AccountTier;
    draw?: boolean;
    email?: string | null;
    authorTier?: AccountTier;
  } = {},
) {
  const now = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + 600_000).toISOString();
  const activity: PublicActivity = {
    id: activityId,
    title: "青春版参与测试",
    author: {
      id: "activity-author",
      username: "Maker",
      displayName: "活动作者",
      avatarUrl: null,
      accountTier: options.authorTier ?? "standard",
    },
    rewardType: "ldc",
    status: "active",
    forceDedicated: false,
    topicUrl: null,
    openedAt: now,
    deadlineAt,
    quantity: { mode: "exact", total: 3, claimed: 0, remaining: 3 },
    showRecipientList: false,
    showRecipientUsername: true,
    showRecipientTime: true,
    beforeInfo: "参与规则",
    paymentMode: "simulation",
    reward: options.draw
      ? { mode: "timed_draw", totalAmount: "3.00", count: 3 }
      : { mode: "fixed", unitAmount: "1.00", totalAmount: "3.00" },
    ...(options.draw
      ? {
          draw: {
            state: "waiting" as const,
            deadlineAt,
            closedAt: null,
            reason: null,
            registeredCount: 0,
            winnerCount: null,
            participantLimit: null,
          },
        }
      : {}),
  };
  const state = {
    tier: options.tier ?? ("lite" as AccountTier),
    loginProvider: "liteauth" as "connect" | "liteauth",
    signedIn: true,
    userId: "same-stable-user",
    meReads: 0,
    merchantRequests: 0,
    claims: [] as ClaimActivityInput[],
    solves: [] as ClaimActivityInput[],
    creates: [] as CreateActivityInput[],
    opens: 0,
    redemptions: [] as ClaimActivityInput[],
    claim: null as ClaimDetail | null,
    saved: null as ManagedActivity | null,
    solved: false,
    delayCreate: false,
    delayOpen: false,
    releaseCreate: undefined as (() => void) | undefined,
    releaseOpen: undefined as (() => void) | undefined,
  };
  const merchant = merchantFixture();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session" || path === "/api/me") {
      state.meReads++;
      return route.fulfill({
        json: state.signedIn
          ? {
              user: {
                id: state.userId,
                username: "LiteUser",
                displayName: "青春用户",
                avatarUrl: null,
                email: options.email ?? null,
                accountTier: state.tier,
                canUseLdc: state.tier === "standard",
                loginProvider: state.loginProvider,
                isAdmin: false,
              },
              csrfToken: "lite-csrf",
              loginOptions: { liteauthEnabled: true },
            }
          : {
              user: null,
              csrfToken: null,
              loginOptions: { liteauthEnabled: true },
            },
      });
    }
    if (path === "/api/auth/logout") {
      state.signedIn = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path.startsWith("/api/me/merchants")) {
      state.merchantRequests++;
      if (path === `/api/me/merchants/${merchant.id}`) {
        return route.fulfill({ json: { merchant } });
      }
      return route.fulfill({
        json: {
          items: [merchant],
          currentMerchantId: merchant.id,
          nextCursor: null,
          canCreate: false,
          canSimulate: true,
        },
      });
    }
    if (path === `/api/activities/${activityId}`)
      return route.fulfill({ json: { activity } });
    if (path.endsWith("/participation"))
      return route.fulfill({
        json: { claim: state.claim, registration: null },
      });
    if (path.endsWith("/registration"))
      return route.fulfill({ json: { registration: null } });
    if (path.endsWith("/recipients") || path.endsWith("/claims"))
      return route.fulfill({
        json: { enabled: false, items: [], nextCursor: null },
      });
    if (path.endsWith("/passwords"))
      return route.fulfill({
        json: {
          passwords: state.claim
            ? [
                { text: "Answer123", isClaimPassword: true, isSolved: false },
                ...(state.solved
                  ? [
                      {
                        text: "Another123",
                        isClaimPassword: false,
                        isSolved: true,
                      },
                    ]
                  : []),
              ]
            : [],
          hiddenCount: state.claim ? (state.solved ? 0 : 1) : 2,
          canSolve: Boolean(state.claim) && state.signedIn,
        },
      });
    if (path.endsWith("/password-solves")) {
      state.solves.push(request.postDataJSON());
      state.solved = true;
      return route.fulfill({ json: { outcome: "solved" } });
    }
    if (path.endsWith("/claim")) {
      if (request.method() === "GET")
        return route.fulfill({ json: { claim: state.claim } });
      state.claims.push(request.postDataJSON());
      state.claim = {
        id: claimId,
        activity: { id: activityId, title: activity.title, status: "active" },
        rewardType: "ldc",
        claimedAt: now,
        amount: "1.00",
        payment: {
          id: "lite-payment",
          mode: "simulation",
          status: "confirmed",
          reason: null,
          confirmedAt: now,
        },
        afterClaimInfo: "LDC 领取完成",
      };
      return route.fulfill({ json: { result: "claimed", claim: state.claim } });
    }
    if (path === "/api/activities" && request.method() === "POST") {
      const input = request.postDataJSON() as CreateActivityInput;
      state.creates.push(input);
      state.saved ??= {
        id: activityId,
        author: { ...activity.author, id: state.userId },
        title: input.activity.title,
        rewardType: "ldc",
        reward: { mode: "fixed", unitAmount: "1.00", totalAmount: "1.00" },
        paymentMode: "simulation",
        forceDedicated: input.activity.forceDedicated,
        config: input.activity,
        status: "draft",
        version: 1,
        createdAt: now,
        openedAt: null,
        deadlineAt: null,
        topicUrl: input.activity.topicUrl,
        totalCount: 1,
        claimedCount: 0,
      };
      if (state.delayCreate && state.creates.length === 1)
        await new Promise<void>((resolve) => {
          state.releaseCreate = resolve;
        });
      return route.fulfill({ json: { activity: state.saved } });
    }
    if (path === `/api/me/activities/${activityId}`) {
      if (request.method() === "PATCH" && state.saved) {
        const input = request.postDataJSON() as {
          activity: CreateActivityInput["activity"];
        };
        state.saved = {
          ...state.saved,
          config: input.activity,
          title: input.activity.title,
          version: state.saved.version + 1,
        };
      }
      return route.fulfill({ json: { activity: state.saved } });
    }
    if (path === `/api/me/activities/${activityId}/open`) {
      state.opens++;
      if (state.delayOpen)
        await new Promise<void>((resolve) => {
          state.releaseOpen = resolve;
        });
      if (!state.saved) throw new Error("The draft fixture is missing");
      state.saved = {
        ...state.saved,
        status: "active",
        version: state.saved.version + 1,
        openedAt: now,
        deadlineAt,
      };
      return route.fulfill({ json: { activity: state.saved } });
    }
    if (path === "/api/me/activities")
      return route.fulfill({
        json: { items: state.saved ? [state.saved] : [], nextCursor: null },
      });
    if (path === "/api/redemptions" || path === "/api/redemptions/discover") {
      state.redemptions.push(request.postDataJSON());
      return route.fulfill({
        json: {
          id: resultId,
          claimSubmissionId: "70c3bf9d-efdd-4d16-8efc-9f8a9bd522a3",
          result: "multiple",
          items: [{ ...activity, title: "升级后匹配结果", myClaim: null }],
          nextCursor: null,
        },
      });
    }
    if (path === `/api/redemptions/${resultId}`)
      return route.fulfill({
        json: {
          id: resultId,
          claimSubmissionId: "70c3bf9d-efdd-4d16-8efc-9f8a9bd522a3",
          result: "multiple",
          items: [{ ...activity, title: "升级后匹配结果", myClaim: null }],
          nextCursor: null,
        },
      });
    if (path === "/api/discovery/activities")
      return route.fulfill({
        json: { items: [{ ...activity, myClaim: null }], nextCursor: null },
      });
    return route.fulfill({ json: { ok: true } });
  });
  return state;
}

async function fillMinimalLdcActivity(page: Page, title: string) {
  await page.locator("#activity-title").fill(title);
  await page.getByLabel("口令 1", { exact: true }).fill("Answer123");
  await page.getByLabel("每份金额（LDC）", { exact: true }).fill("1.00");
  await page.getByLabel("奖励份数", { exact: true }).fill("1");
}

test("青春版账号展示资格和登录来源，顶栏直接进入账号信息", async ({ page }) => {
  await mockLite(page);
  await page.goto("/account");
  const header = page.locator("header").first();
  const ownLink = header.getByRole("link", { name: "我的账号" });
  await expect(ownLink).toHaveAttribute("href", "/account");
  await expect(ownLink).toContainText("青春用户");
  await expect(header.getByText("青春版", { exact: true })).toBeVisible();
  await ownLink.hover();
  await ownLink.focus();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    header.getByRole("link", { name: "商户配置", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("main").getByText("LiteAuth 尚未提供邮箱"),
  ).toBeVisible();
  const upgrade = page.getByRole("button", {
    name: "通过官方 Connect 升级",
  });
  await expect(upgrade).toBeVisible();
  await upgrade.click();
  await expect(
    page.getByRole("dialog", { name: "升级为普通账号" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog", { name: "升级为普通账号" })
      .getByRole("button", { name: "通过官方 Connect 升级" }),
  ).toBeVisible();
});

test("已取得官方资格的账号用LiteAuth登录仍保留LDC能力与Connect邮箱", async ({
  page,
}) => {
  await mockLite(page, {
    tier: "standard",
    email: "connect-private@example.test",
  });
  await page.goto("/account");
  await expect(
    page.getByRole("definition").getByText("普通账号", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("definition").getByText("LiteAuth 青春版", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("connect-private@example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("header").first().getByText("青春版", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "使用官方 Connect 升级" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "刷新资料" })).toBeVisible();
});

test("青春版创建页只显示升级入口，升级后才显示LDC表单且不会自动提交", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockLite(page);
  await page.goto("/activities/new");
  await expect(
    page.getByRole("link", { name: "使用官方 Connect 升级" }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "奖励类型" })).toHaveCount(0);
  await expect(page.locator("#activity-text-rewards")).toHaveCount(0);
  await expect(page.locator("#activity-title")).toHaveCount(0);
  expect(state.creates).toHaveLength(0);

  state.tier = "standard";
  state.loginProvider = "connect";
  await refreshIdentity(page);
  await expect(page.locator("#activity-title")).toBeVisible();
  await expect(page.getByRole("group", { name: "奖励类型" })).toHaveCount(0);
  await fillMinimalLdcActivity(page, "升级后 LDC 草稿");
  expect(state.creates).toHaveLength(0);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect.poll(() => state.creates.length).toBe(1);
  const createRequest = state.creates[0];
  if (!createRequest) throw new Error("missing create request");
  expect(createRequest.activity.rewardType).toBe("ldc");
});

test("青春版直接访问商户页面只得到升级提示，不读取或写入商户", async ({
  page,
}) => {
  const state = await mockLite(page);
  for (const path of [
    "/my/merchants",
    `/my/merchants/${merchantId}`,
    `/my/merchants/${merchantId}/payments/${claimId}`,
  ]) {
    await page.goto(path);
    await expect(
      page.getByText("青春版暂不支持商户配置。", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "使用官方 Connect 升级" }),
    ).toBeVisible();
  }
  expect(state.merchantRequests).toBe(0);
});

for (const draw of [false, true]) {
  test(`青春版可浏览LDC${draw ? "开奖" : "即时"}活动，主动升级不保留口令或自动参与`, async ({
    page,
  }) => {
    const state = await mockLite(page, { draw });
    await page.goto("/square");
    await expect(
      page.getByRole("row", { name: /青春版参与测试/ }),
    ).toBeVisible();
    await page.goto(`/activities/${activityId}`);
    await expect(
      page.getByRole("heading", { name: "青春版参与测试" }),
    ).toBeVisible();
    await expect(page.getByLabel("兑换口令", { exact: true })).toHaveCount(0);
    const upgrade = page.getByRole("link", {
      name: "使用官方 Connect 升级",
    });
    await expect(upgrade).toHaveAttribute(
      "href",
      `/api/auth/login?intent=upgrade&returnTo=%2Factivities%2F${activityId}`,
    );
    expect(state.claims).toHaveLength(0);
    expect(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      ),
    ).not.toMatch(/Answer123|password/);
  });
}

test("青春版只能浏览LDC活动和作者资料，不能提交口令或解锁私有口令", async ({
  page,
}) => {
  const state = await mockLite(page, { authorTier: "lite" });
  await page.goto(`/activities/${activityId}`);
  const author = page
    .getByTestId("envelope")
    .getByRole("button", { name: "活动作者 青春版" });
  await expect(author.getByText("青春版", { exact: true })).toBeVisible();
  await author.hover();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).not.toContainText("邮箱");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("兑换口令", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("验证其他口令", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "使用官方 Connect 升级" }),
  ).toBeVisible();
  expect(state.claims).toHaveLength(0);
  expect(state.solves).toHaveLength(0);
});

test("全站普通口令在青春版下只提示升级，升级后仍需主动重新提交", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockLite(page);
  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "使用官方 Connect 升级" }),
  ).toHaveAttribute("href", "/api/auth/login?intent=upgrade&returnTo=%2F");
  expect(state.redemptions).toHaveLength(0);

  state.tier = "standard";
  state.loginProvider = "connect";
  await refreshIdentity(page);
  expect(state.redemptions).toHaveLength(0);
  await page.getByLabel("口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "选择要兑奖的活动" }),
  ).toBeVisible();
  expect(state.redemptions).toHaveLength(1);
});

test("同ID资格升级清除全站口令，旧青春版状态不能恢复匹配缓存", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockLite(page);
  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill("PrivateUpgrade123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "使用官方 Connect 升级" }),
  ).toBeVisible();
  state.tier = "standard";
  state.loginProvider = "connect";
  await refreshIdentity(page);
  await expect(
    page.locator("header").first().getByText("青春版", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("口令", { exact: true })).toHaveValue("");
  await expect(page.getByText("升级后匹配结果", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("region", { name: "匹配活动" })).toHaveCount(0);
  expect(state.redemptions).toHaveLength(0);
});

test("已升级账号保存期间身份刷新保留原LDC创建意图，完成前不重复提交", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockLite(page, { tier: "standard" });
  state.delayCreate = true;
  await page.goto("/activities/new");
  await fillMinimalLdcActivity(page, "升级期间同一个 LDC 草稿");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect.poll(() => Boolean(state.releaseCreate)).toBe(true);
  state.loginProvider = "connect";
  await refreshIdentity(page);
  expect(state.creates).toHaveLength(1);
  state.releaseCreate?.();
  await expectPathname(page, `/my/activities/${activityId}`);
  expect(state.creates).toHaveLength(1);
  const [create] = state.creates;
  expect(create?.activity).toMatchObject({
    rewardType: "ldc",
    title: "升级期间同一个 LDC 草稿",
    passwords: ["Answer123"],
  });
});

test("同ID升级后不会自动领取，用户主动提交后才发送LDC领取", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockLite(page);
  await page.goto(`/activities/${activityId}`);
  await expect(page.getByLabel("兑换口令", { exact: true })).toHaveCount(0);
  state.tier = "standard";
  state.loginProvider = "connect";
  await refreshIdentity(page);
  await expect(
    page.locator("header").first().getByText("青春版", { exact: true }),
  ).toHaveCount(0);
  expect(state.claims).toHaveLength(0);
  await page.getByLabel("兑换口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: /领取奖励|领取红包/ }).click();
  await expect(page.locator(".slip-amount")).toContainText("+1.00");
  expect(state.claims).toHaveLength(1);
});

test("开放续接后恢复按钮，已发出开放请求的事实通过刷新读取", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockLite(page, { tier: "standard" });
  await page.goto("/activities/new");
  await fillMinimalLdcActivity(page, "开放续接升级测试");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expectPathname(page, `/my/activities/${activityId}`);
  state.delayOpen = true;
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await expect.poll(() => Boolean(state.releaseOpen)).toBe(true);
  state.loginProvider = "connect";
  await refreshIdentity(page);
  await expect(
    page.locator("header").first().getByText("青春版", { exact: true }),
  ).toHaveCount(0);
  state.releaseOpen?.();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存修改", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  expect(state.opens).toBe(1);
});
