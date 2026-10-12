import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  type ActivityInput,
  emptyActivityInput,
  type LdcActivityInput,
  type ManagedActivity,
  type Merchant,
  type MerchantList,
} from "../../packages/contracts/src";

const origin = "http://127.0.0.1:4193";
const authorizer = /^https:\/\/connect\.linux\.do\/oauth2\/authorize\?/;
type Session = {
  user: { id: string; username: string; displayName: string };
  csrfToken: string;
};

async function guardExternal(context: BrowserContext) {
  const unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin === "https://avatars.example.test")
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#ddd"/></svg>',
      });
    unexpected.push(`${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  return unexpected;
}

async function signIn(page: Page, role: "author" | "recipient" | "recipient2") {
  const context = page.context();
  // Only the upstream authorization page is replaced. The local OAuth
  // callback, token exchange, account persistence and all business APIs run.
  await context.route(authorizer, async (route) => {
    const authorization = new URL(route.request().url());
    expect(authorization.searchParams.get("client_id")).toBe(
      "hb_full_app_connect",
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback`,
    );
    const state = authorization.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    const callback = new URL("/api/auth/callback", origin);
    callback.searchParams.set("state", state ?? "");
    callback.searchParams.set("code", `full-app-code-${role}`);
    await route.fulfill({ status: 302, headers: { Location: callback.href } });
  });
  const login = await context.request.get("/api/auth/login?returnTo=%2F", {
    maxRedirects: 0,
  });
  expect(login.status()).toBe(302);
  const location = login.headers().location;
  if (!location) throw new Error("登录未返回授权地址");
  await page.goto(location);
  await expect(page.getByLabel("口令", { exact: true })).toBeVisible();
  const response = await context.request.get("/api/session");
  expect(response.status()).toBe(200);
  const session = (await response.json()) as Session;
  expect(session.user.id).toBeTruthy();
  expect(session.csrfToken).toBeTruthy();
  return session;
}

async function createAndOpen(
  context: BrowserContext,
  session: Session,
  input: ActivityInput,
  merchant?: { id: string; credentialVersion: number },
) {
  const headers = { "X-CSRF-Token": session.csrfToken, Origin: origin };
  const saved = await context.request.post("/api/activities", {
    headers,
    data: { requestId: randomUUID(), activity: input },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const activity = ((await saved.json()) as { activity: ManagedActivity })
    .activity;
  const opened = await context.request.post(
    `/api/me/activities/${activity.id}/open`,
    {
      headers,
      data: {
        version: activity.version,
        ...(merchant
          ? {
              merchantId: merchant.id,
              credentialVersion: merchant.credentialVersion,
            }
          : {}),
      },
    },
  );
  expect(opened.status(), await opened.text()).toBe(200);
  expect(await opened.json()).toMatchObject({
    activity: { id: activity.id, status: "active" },
  });
  return activity.id;
}

test("真实本地报名与领取后，已挂载公共人数/名单及作者记录同步刷新且不产生重复事实", async ({
  browser,
  request,
}) => {
  const contexts = await Promise.all(
    Array.from({ length: 3 }, () =>
      browser.newContext({ baseURL: origin, reducedMotion: "reduce" }),
    ),
  );
  const [owner, registrant, recipient] = contexts;
  if (!owner || !registrant || !recipient)
    throw new Error("缺少隔离浏览器上下文");
  const external = await Promise.all(contexts.map(guardExternal));
  try {
    const ownerPage = await owner.newPage();
    const signupPage = await registrant.newPage();
    const claimPage = await recipient.newPage();
    const [authorSession, signupSession, claimSession] = await Promise.all([
      signIn(ownerPage, "author"),
      signIn(signupPage, "recipient"),
      signIn(claimPage, "recipient2"),
    ]);
    const headers = { "X-CSRF-Token": authorSession.csrfToken, Origin: origin };
    const merchantsResponse = await owner.request.get("/api/me/merchants");
    expect(merchantsResponse.status()).toBe(200);
    const merchants = (await merchantsResponse.json()) as MerchantList;
    let merchant = merchants.items.find(
      (item) => item.id === merchants.currentMerchantId,
    );
    if (!merchant) {
      const merchantResponse = await owner.request.post("/api/me/merchants", {
        headers,
        data: {
          requestId: randomUUID(),
          label: "本地名单刷新商户",
          clientId: "hb_full_app_merchant",
          secret: "full-app-merchant-secret",
          mode: "real",
        },
      });
      expect(merchantResponse.status(), await merchantResponse.text()).toBe(
        200,
      );
      merchant = ((await merchantResponse.json()) as { merchant: Merchant })
        .merchant;
    } else if (
      merchant.clientId !== "hb_full_app_merchant" ||
      !merchant.publicationEligibility.allowed
    ) {
      const impactResponse = await owner.request.get(
        `/api/me/merchants/${merchant.id}/change-impact`,
      );
      expect(impactResponse.status()).toBe(200);
      const { confirmationToken } = (await impactResponse.json()) as {
        confirmationToken: string;
      };
      const restored = await owner.request.patch(
        `/api/me/merchants/${merchant.id}`,
        {
          headers,
          data: {
            requestId: randomUUID(),
            version: merchant.version,
            label: merchant.label,
            clientId: "hb_full_app_merchant",
            secret: "full-app-merchant-secret",
            confirmationToken,
          },
        },
      );
      expect(restored.status(), await restored.text()).toBe(200);
      merchant = ((await restored.json()) as { merchant: Merchant }).merchant;
    }
    expect(merchant.mode).toBe("real");
    const merchantId = merchant.id;
    await expect
      .poll(
        async () => {
          const response = await owner.request.get(
            `/api/me/merchants/${merchantId}`,
          );
          expect(response.status()).toBe(200);
          return (await response.json()).merchant.publicationEligibility
            .allowed;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const beforeResponse = await request.get("http://127.0.0.1:4194/state");
    expect(beforeResponse.status()).toBe(200);
    const before = await beforeResponse.json();
    const base = emptyActivityInput();
    const drawInput: LdcActivityInput = {
      ...base,
      rewardType: "ldc",
      title: `本地报名同步刷新 ${randomUUID().slice(0, 8)}`,
      passwords: ["RosterSignup123"],
      allocation: "random",
      merchantId: merchant.id,
      money: {
        mode: "timed_draw",
        algorithm: "double_mean_v1",
        totalAmount: "0.30",
        count: 3,
        participantLimit: 10,
        countdownSeconds: 3_600,
        distributeFullPool: true,
      },
    };
    const drawId = await createAndOpen(
      owner,
      authorSession,
      drawInput,
      merchant,
    );
    const claimTitle = `本地领取同步刷新 ${randomUUID().slice(0, 8)}`;
    const claimId = await createAndOpen(
      owner,
      authorSession,
      {
        ...emptyActivityInput(),
        title: claimTitle,
        passwords: ["RosterClaim123"],
        merchantId: merchant.id,
        money: { mode: "fixed", totalAmount: "0.02", count: 2 },
      },
      merchant,
    );
    const authorDraw = await owner.newPage();
    await authorDraw.goto(`/activities/${drawId}`);
    await authorDraw
      .getByRole("button", { name: "查看报名名单", exact: true })
      .click();
    const authorRegistrations = authorDraw.getByRole("dialog", {
      name: drawInput.title,
      exact: true,
    });
    const registrationCount = authorRegistrations.locator(
      ".public-roster__summary",
    );
    await expect(registrationCount).toContainText("报名 0 人");
    await expect(
      authorRegistrations.getByText("暂无报名记录。", { exact: true }),
    ).toBeVisible();
    const publicDraw = await recipient.newPage();
    await publicDraw.goto(`/activities/${drawId}`);
    await publicDraw
      .getByRole("button", { name: "查看报名名单", exact: true })
      .click();
    const publicRegistrations = publicDraw.getByRole("dialog", {
      name: drawInput.title,
      exact: true,
    });
    await expect(
      publicRegistrations.getByText("报名 0 人", { exact: true }),
    ).toBeVisible();
    await expect(
      publicRegistrations.getByText("暂无报名记录。", { exact: true }),
    ).toBeVisible();
    const drawEnvelope = publicDraw.locator('[data-testid="envelope"]');
    const drawOpeningCount =
      await drawEnvelope.getAttribute("data-opening-count");

    const businessPosts: string[] = [];
    for (const page of [signupPage, claimPage])
      page.on("request", (outgoing) => {
        const path = new URL(outgoing.url()).pathname;
        if (outgoing.method() === "POST" && path.endsWith("/claim"))
          businessPosts.push(path);
      });
    await signupPage.goto(`/activities/${drawId}`);
    await signupPage
      .getByLabel("兑换口令", { exact: true })
      .fill("RosterSignup123");
    const signupResponse = signupPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/activities/${drawId}/claim`,
    );
    await signupPage.getByRole("button", { name: "报名", exact: true }).click();
    const signup = await signupResponse;
    expect(signup.status()).toBe(200);
    expect(await signup.json()).toMatchObject({
      result: "registered",
      registration: { activity: { id: drawId }, status: "registered" },
    });
    await authorDraw.bringToFront();
    await expect(registrationCount).toContainText("报名 1 人", {
      timeout: 7_000,
    });
    await expect(
      authorRegistrations.getByText(signupSession.user.displayName, {
        exact: true,
      }),
    ).toBeVisible();
    await publicDraw.bringToFront();
    await expect(
      publicRegistrations.getByText("报名 1 人", { exact: true }),
    ).toBeVisible({ timeout: 7_000 });
    await expect(
      publicRegistrations.getByText(signupSession.user.displayName, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(drawEnvelope).toHaveAttribute(
      "data-opening-count",
      drawOpeningCount ?? "0",
    );

    const authorClaim = await owner.newPage();
    await authorClaim.goto(`/activities/${claimId}`);
    await authorClaim
      .getByRole("button", { name: "查看领取名单", exact: true })
      .click();
    const authorClaims = authorClaim.getByRole("dialog", {
      name: claimTitle,
      exact: true,
    });
    await expect(
      authorClaims.getByText("暂无领取记录。", { exact: true }),
    ).toBeVisible();
    const publicClaim = await registrant.newPage();
    await publicClaim.goto(`/activities/${claimId}`);
    await expect(
      publicClaim.getByText("已领取 0 / 2 份", { exact: true }),
    ).toBeVisible();
    await publicClaim
      .getByRole("button", { name: "查看领取名单", exact: true })
      .click();
    const publicClaims = publicClaim.getByRole("dialog", {
      name: claimTitle,
      exact: true,
    });
    await expect(
      publicClaims.getByText("暂无领取记录。", { exact: true }),
    ).toBeVisible();
    await claimPage.goto(`/activities/${claimId}`);
    await claimPage
      .getByLabel("兑换口令", { exact: true })
      .fill("RosterClaim123");
    const claimResponse = claimPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/activities/${claimId}/claim`,
    );
    await claimPage
      .getByRole("button", { name: /^(领取奖励|领取红包)$/ })
      .click();
    const claimed = await claimResponse;
    expect(claimed.status()).toBe(200);
    expect(await claimed.json()).toMatchObject({
      result: "claimed",
      claim: { activity: { id: claimId }, rewardType: "ldc", amount: "0.01" },
    });
    await authorClaim.bringToFront();
    await expect(
      authorClaims.getByText(claimSession.user.displayName, { exact: true }),
    ).toBeVisible({ timeout: 7_000 });
    await expect(authorClaims).toContainText("0.01");
    await expect(authorClaims).toContainText(/已发放|等待|发送/);
    await publicClaim.bringToFront();
    await expect(
      publicClaims.getByText(claimSession.user.displayName, { exact: true }),
    ).toBeVisible({ timeout: 7_000 });
    await expect(publicClaims).toContainText("0.01 LDC");
    await expect(publicClaims).not.toContainText(/已发放|等待发放|正在发送/);
    const publicRosterResponse = await registrant.request.get(
      `/api/activities/${claimId}/recipients`,
    );
    expect(publicRosterResponse.status()).toBe(200);
    const publicRoster = await publicRosterResponse.json();
    expect(publicRoster.items).toHaveLength(1);
    expect(publicRoster.items[0]).not.toHaveProperty("payment");
    expect(publicRoster.items[0]).not.toHaveProperty("afterClaimInfo");
    expect(publicRoster.items[0]).not.toHaveProperty("sourcePassword");
    await expect(
      publicClaim.getByText("已领取 1 / 2 份", { exact: true }),
    ).toBeVisible();
    expect(businessPosts).toEqual([
      `/api/activities/${drawId}/claim`,
      `/api/activities/${claimId}/claim`,
    ]);
    const stateResponse = await request.get("http://127.0.0.1:4194/state");
    expect(stateResponse.status()).toBe(200);
    const state = await stateResponse.json();
    expect(
      state.activities.find(
        (activity: { id: string }) => activity.id === drawId,
      ),
    ).toMatchObject({
      registered_count: 1,
      claimed_count: 0,
      draw_state: "waiting",
    });
    expect(
      state.activities.find(
        (activity: { id: string }) => activity.id === claimId,
      ),
    ).toMatchObject({ claimed_count: 1 });
    expect(
      state.registrations.filter(
        (entry: { activity_id: string }) => entry.activity_id === drawId,
      ),
    ).toHaveLength(1);
    expect(
      state.claims.filter(
        (entry: { activity_id: string }) => entry.activity_id === claimId,
      ),
    ).toHaveLength(1);
    const claimIds = new Set(
      state.claims
        .filter(
          (entry: { activity_id: string }) => entry.activity_id === claimId,
        )
        .map((entry: { id: string }) => entry.id),
    );
    const tasks = state.payments.filter((payment: { claim_id: string }) =>
      claimIds.has(payment.claim_id),
    );
    expect(tasks).toHaveLength(1);
    expect(state.payments.map((payment: { id: string }) => payment.id)).toEqual(
      expect.arrayContaining(
        before.payments.map((payment: { id: string }) => payment.id),
      ),
    );
    expect(
      state.outbox.map((entry: { task_id: string }) => entry.task_id),
    ).toContain(tasks[0].id);
    expect(state.upstream.blockedRequests).toBe(0);
    expect(state.upstream.credentialChecks).toBeGreaterThan(0);
    expect(external.flat()).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
