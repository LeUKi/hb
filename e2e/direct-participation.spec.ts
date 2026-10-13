import { expect, type Page, test } from "@playwright/test";

const activityId = "d1111111-1111-4111-8111-111111111111";
const drawActivityId = "d2222222-2222-4222-8222-222222222222";
const title = "直接参与活动";
const viewer = {
  id: "direct-viewer",
  username: "directviewer",
  displayName: "直接参与者",
  avatarUrl: null,
  accountTier: "standard" as const,
  loginProvider: "connect" as const,
  canUseLdc: true,
  isAdmin: false,
};
const author = { ...viewer, id: "direct-author", username: "directauthor" };

type ApiState = {
  user: typeof viewer | null;
  csrfToken: string | null;
  cooldown: null | {
    revision: number;
    serverTime: number;
    nextAllowedAt: number;
  };
  claimPosts: unknown[];
  discoveries: unknown[];
  solves: unknown[];
  passwordReads: number;
  writes: string[];
  unexpected: string[];
  claimStatus: number;
  claimJson: unknown;
};

function directActivity(id = activityId, draw = false) {
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
  return {
    id,
    title: draw ? "直接报名开奖活动" : title,
    participationMode: "direct",
    rewardType: "ldc",
    status: "active",
    author,
    forceDedicated: false,
    topicUrl: null,
    openedAt: new Date(Date.now() - 60_000).toISOString(),
    deadlineAt,
    quantity: { mode: "exact", total: 3, claimed: 0, remaining: 3 },
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
    beforeInfo: "无需口令，进入活动页后主动参与。",
    reward: draw
      ? { mode: "timed_draw", totalAmount: "0.30", count: 2 }
      : { mode: "fixed", unitAmount: "1.00", totalAmount: "3.00" },
    ...(draw
      ? {
          draw: {
            state: "waiting",
            registeredCount: 0,
            winnerCount: null,
            deadlineAt,
            closedAt: null,
            reason: null,
          },
        }
      : {}),
  };
}

async function mockDirectApp(page: Page) {
  const state: ApiState = {
    user: viewer,
    csrfToken: "csrf-direct",
    cooldown: null,
    claimPosts: [],
    discoveries: [],
    solves: [],
    passwordReads: 0,
    writes: [],
    unexpected: [],
    claimStatus: 200,
    claimJson: {
      result: "claimed",
      passwordMatched: null,
      participationMode: "direct",
      claim: {
        id: "direct-claim",
        activity: { id: activityId, title, status: "active" },
        rewardType: "ldc",
        amount: "1.00",
        payment: {
          id: "direct-payment",
          mode: "simulation",
          status: "confirmed",
          reason: null,
          confirmedAt: new Date().toISOString(),
        },
        claimedAt: new Date().toISOString(),
        afterClaimInfo: "",
        source: "直接领取",
      },
      attemptCooldown: {
        revision: 1,
        serverTime: Date.now(),
        nextAllowedAt: Date.now() + 2_000,
      },
    },
  };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          document.documentElement.dataset.directShared = value;
        },
      },
    });
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      state.unexpected.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() !== "GET")
      state.writes.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({
        json: {
          user: state.user,
          csrfToken: state.csrfToken,
          attemptCooldown: state.cooldown,
          loginOptions: { liteauthEnabled: true },
        },
      });
    if (url.pathname === `/api/activities/${activityId}`)
      return route.fulfill({ json: { activity: directActivity() } });
    if (url.pathname === `/api/activities/${drawActivityId}`)
      return route.fulfill({
        json: { activity: directActivity(drawActivityId, true) },
      });
    if (url.pathname === `/api/activities/${activityId}/participation`)
      return route.fulfill({ json: { claim: null, registration: null } });
    if (url.pathname === `/api/activities/${drawActivityId}/participation`)
      return route.fulfill({ json: { claim: null, registration: null } });
    if (url.pathname.endsWith("/passwords")) {
      state.passwordReads++;
      return route.fulfill({
        json: { passwords: [], hiddenCount: 0, canSolve: false },
      });
    }
    if (url.pathname === `/api/activities/${activityId}/claim`) {
      const body = request.postDataJSON();
      state.claimPosts.push(body);
      return route.fulfill({
        status: state.claimStatus,
        json: state.claimJson,
      });
    }
    if (url.pathname === `/api/activities/${drawActivityId}/claim`) {
      const body = request.postDataJSON();
      state.claimPosts.push(body);
      const successJson = {
        result: "registered",
        passwordMatched: null,
        participationMode: "direct",
        registration: {
          id: "direct-registration",
          activity: {
            id: drawActivityId,
            title: "直接报名开奖活动",
            status: "active",
          },
          status: "registered",
          registeredAt: new Date().toISOString(),
          source: "直接报名",
        },
      };
      return route.fulfill({
        status: state.claimStatus,
        json: state.claimStatus === 200 ? successJson : state.claimJson,
      });
    }
    if (url.pathname === "/api/redemptions/discover") {
      state.discoveries.push(request.postDataJSON());
      return route.fulfill({ json: { result: "none", items: [], total: 0 } });
    }
    if (url.pathname.endsWith("/password-solves")) {
      state.solves.push(request.postDataJSON());
      return route.fulfill({ json: { result: "incorrect" } });
    }
    state.unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({
      status: 404,
      json: { error: { code: "TEST_ROUTE_MISSING", message: url.pathname } },
    });
  });
  return state;
}

async function mockCreateForm(page: Page) {
  const state = {
    saved: [] as unknown[],
    opened: false,
    user: { ...viewer, id: "direct-author", isAdmin: true },
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({
        json: { user: state.user, csrfToken: "csrf-direct-author" },
      });
    if (url.pathname.startsWith("/api/me/merchants")) {
      const now = new Date().toISOString();
      const merchant = {
        id: "11111111-1111-4111-8111-111111111111",
        label: "本地测试商户",
        clientId: "local_merchant",
        mode: "simulation",
        scenario: "normal",
        version: 1,
        credentialVersion: 1,
        usageStatus: "current",
        publicationEligibility: {
          allowed: true,
          reason: null,
          credentialVersion: 1,
        },
        credentialVerification: {
          status: "unverified",
          credentialVersion: 1,
          checkedAt: null,
          nextCheckAt: null,
          reason: null,
        },
        capabilities: {
          canExecutePayments: true,
          canSimulate: true,
        },
        pausedReason: null,
        createdAt: now,
        updatedAt: now,
      };
      if (url.pathname === `/api/me/merchants/${merchant.id}`) {
        return route.fulfill({ json: { merchant } });
      }
      return route.fulfill({
        json: {
          items: [merchant],
          currentMerchantId: merchant.id,
          canCreate: false,
          canSimulate: true,
          nextCursor: null,
        },
      });
    }
    if (url.pathname === "/api/activities" && request.method() === "POST") {
      const body = request.postDataJSON();
      state.saved.push(body);
      return route.fulfill({
        json: {
          activity: {
            id: activityId,
            title: body.activity.title,
            participationMode: body.activity.participationMode,
            rewardType: "ldc",
            status: "draft",
            author: state.user,
            forceDedicated: body.activity.forceDedicated,
            topicUrl: null,
            openedAt: null,
            deadlineAt: null,
            quantity: { mode: "exact", total: 1, claimed: 0, remaining: 1 },
            showRecipientList: false,
            showRecipientUsername: false,
            showRecipientTime: false,
            beforeInfo: "",
            reward: { mode: "fixed", unitAmount: "1.00", totalAmount: "1.00" },
            createdAt: new Date().toISOString(),
            totalCount: 1,
            claimedCount: 0,
            version: 1,
            config: body.activity,
          },
        },
      });
    }
    if (
      url.pathname === `/api/me/activities/${activityId}/open` &&
      request.method() === "POST"
    ) {
      state.opened = true;
      return route.fulfill({
        json: {
          activity: {
            id: activityId,
            title: "已开放 direct",
            participationMode: "direct",
            status: "active",
            version: 2,
            config: {
              participationMode: "direct",
              passwords: [],
              forceDedicated: false,
            },
          },
        },
      });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  return state;
}

async function chooseDirectMode(page: Page) {
  await page
    .getByRole("group", { name: /参与方式|兑换方式|参与模式/ })
    .getByRole("button", { name: /直接参与|直接领取|无需口令/ })
    .click();
}

async function choosePasswordMode(page: Page) {
  await page
    .getByRole("group", { name: /参与方式|兑换方式|参与模式/ })
    .getByRole("button", { name: /口令参与|兑换口令|使用口令/ })
    .click();
}

test("发起表单默认口令模式，direct 草稿切换暂存口令，保存后清口令并锁定开放模式", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const state = await mockCreateForm(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 900 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/activities/new");
    await expect(
      page
        .getByRole("group", { name: /参与方式|兑换方式|参与模式/ })
        .getByRole("button", { name: /口令参与|兑换口令|使用口令/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("口令 1", { exact: true })).toBeVisible();
    await page.locator("#activity-title").fill(`direct 表单 ${viewport.width}`);
    await page.getByLabel("口令 1", { exact: true }).fill("KeepPass123");
    await chooseDirectMode(page);
    await expect(page.getByLabel("口令 1", { exact: true })).toHaveCount(0);
    await expect(page.locator("#activity-forceDedicated")).toHaveCount(0);
    await choosePasswordMode(page);
    await expect(page.getByLabel("口令 1", { exact: true })).toHaveValue(
      "KeepPass123",
    );
    await chooseDirectMode(page);
    await page.locator("#ldc-total").fill("1.00");
    await page.getByLabel("奖励份数", { exact: true }).fill("1");
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect
      .poll(() => state.saved.length, { message: "direct 草稿应完成保存" })
      .toBeGreaterThan(0);
    const saved = state.saved.at(-1) as {
      activity: {
        participationMode?: string;
        passwords?: string[];
        forceDedicated?: boolean;
        rewardType?: string;
        reward?: unknown;
      };
    };
    expect(saved.activity).toMatchObject({
      participationMode: "direct",
      passwords: [],
      forceDedicated: false,
      rewardType: "ldc",
    });
  }
  expect(state.opened).toBe(false);
});

test("direct 活动页刷新、定位和登录返回不自动参与；点击后只发送 direct claim", async ({
  page,
}) => {
  const state = await mockDirectApp(page);
  await page.goto(`/activities/${activityId}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.reload();
  await page.goto("/");
  await page.goto(`/activities/${activityId}?fromMatching=1`);
  await expect(state.claimPosts).toEqual([]);
  await expect(state.discoveries).toEqual([]);
  await expect(state.solves).toEqual([]);

  await page.getByRole("button", { name: "分享活动", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /复制口令/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const claimButton = page.getByRole("button", { name: /领取奖励|直接领取/ });
  await claimButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".slip-amount")).toContainText("+1.00");
  expect(state.claimPosts).toHaveLength(1);
  expect(state.claimPosts[0]).toMatchObject({
    participationMode: "direct",
  });
  expect(JSON.stringify(state.claimPosts[0])).not.toContain("password");
  expect(JSON.stringify(state.claimPosts[0])).not.toContain("discoveryId");
  expect(state.discoveries).toEqual([]);
  expect(state.solves).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("direct 未知结果按原 submissionId 重试，429 只显示冷却且不写本地口令历史", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockDirectApp(page);
  state.claimStatus = 503;
  state.claimJson = { error: { code: "UNKNOWN_RESULT", message: "结果未知" } };
  await page.goto(`/activities/${activityId}`);
  await page.getByRole("button", { name: /领取奖励|直接领取/ }).click();
  await expect(page.getByText(/尚未确认|结果未知/)).toBeVisible();
  expect(state.claimPosts).toHaveLength(1);
  const first = state.claimPosts[0] as { submissionId: string };
  state.claimStatus = 200;
  state.claimJson = {
    result: "claimed",
    passwordMatched: null,
    participationMode: "direct",
    claim: {
      id: "direct-claim-retry",
      activity: { id: activityId, title, status: "active" },
      rewardType: "ldc",
      amount: "1.00",
      payment: {
        id: "direct-payment-retry",
        mode: "simulation",
        status: "confirmed",
        reason: null,
        confirmedAt: new Date().toISOString(),
      },
      claimedAt: new Date().toISOString(),
      afterClaimInfo: "",
      source: "直接领取",
    },
  };
  await page.getByRole("button", { name: /重试原提交|再次确认/ }).click();
  expect(state.claimPosts).toHaveLength(2);
  expect(state.claimPosts[1]).toMatchObject({
    participationMode: "direct",
    submissionId: first.submissionId,
  });

  state.claimStatus = 429;
  state.claimJson = {
    error: { code: "CLAIM_RATE_LIMITED", message: "提交过于频繁，请稍后重试" },
    attemptCooldown: {
      revision: 2,
      serverTime: Date.now(),
      nextAllowedAt: Date.now() + 2_000,
    },
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/activities/${drawActivityId}`);
  await page.getByRole("button", { name: "立即报名", exact: true }).click();
  await expect(page.locator("p.form-message[role=timer]")).toContainText(
    "秒后可重试",
  );
  const storageDump = await page.evaluate(async () => {
    const databases =
      "databases" in indexedDB ? await indexedDB.databases() : [];
    return JSON.stringify({
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
      databases,
    });
  });
  expect(storageDump).not.toContain("KeepPass123");
});
