import { createHash } from "node:crypto";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

const origin = "http://127.0.0.1:4193";
const authorizer = /^https:\/\/connect\.linux\.do\/oauth2\/authorize\?/;
const accounts = {
  author: {
    externalId: "730001",
    username: "FullAppAuthor",
    displayName: "完整应用作者",
  },
  recipient: {
    externalId: "730002",
    username: "FullAppRecipient",
    displayName: "完整应用领取者",
  },
};
type Session = {
  user: { id: string; username: string; displayName: string };
  csrfToken: string;
};
type RuntimeState = {
  migrations: number;
  users: Array<{ id: string; external_id: string; username: string }>;
  sessions: Array<{ user_id: string; token_hash: string }>;
  activities: Array<{
    id: string;
    reward_type: "text" | "ldc";
    payment_mode: "real" | null;
    claimed_count: number;
    total_count: number;
  }>;
  claims: Array<{
    id: string;
    activity_id: string;
    user_id: string;
    inventory_id: string;
  }>;
  attempts: Array<{ activity_id: string; count: number }>;
  payments: Array<{
    id: string;
    claim_id: string;
    source: "claim";
    mode: "real";
    status: string;
    business_no: string;
    recipient_id: string;
    recipient_username: string;
    amount_minor: number;
    recovery_policy: string;
    first_send_at: number | null;
    attempt_count: number;
    reconciliation_count: number;
    external_order_id: string | null;
  }>;
  outbox: Array<{ task_id: string; delivered_at: number | null }>;
  upstream: {
    oauthTokenRequests: number;
    oauthProfileRequests: number;
    credentialChecks: number;
    distributeRequests: number;
    orderQueries: number;
    blockedRequests: number;
    orders: Array<{
      businessNo: string;
      recipientId: string;
      recipientUsername: string;
      amount: string;
      externalOrderId: string;
    }>;
  };
};

async function readState(request: APIRequestContext): Promise<RuntimeState> {
  const response = await request.get("http://127.0.0.1:4194/state");
  expect(response.ok()).toBe(true);
  return response.json();
}

async function guardExternalBrowserRequests(context: BrowserContext) {
  const unexpected: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin && !authorizer.test(url.href))
      unexpected.push(`${url.origin}${url.pathname}`);
  });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1:4193(?:\/|$))/, (route) =>
    route.abort("blockedbyclient"),
  );
  return unexpected;
}

async function signIn(page: Page, role: keyof typeof accounts, returnTo = "/") {
  let callback = "";
  await page.context().unroute(authorizer);
  // Only the external authorization page is simulated. Callback, token/profile
  // exchange, state consumption, user persistence and session are real app code.
  await page.context().route(authorizer, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("client_id")).toBe("hb_full_app_connect");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback`,
    );
    const state = url.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    const target = new URL(`${origin}/api/auth/callback`);
    target.searchParams.set("state", state ?? "");
    target.searchParams.set("code", `full-app-code-${role}`);
    callback = target.toString();
    await route.fulfill({ status: 302, headers: { Location: callback } });
  });
  await page.goto(returnTo);
  const loginHref = await page
    .getByRole("link", { name: "登录", exact: true })
    .getAttribute("href");
  expect(loginHref).toMatch(/^\/api\/auth\/login\?/);
  // Playwright routes do not intercept a later hop in a redirect chain. Obtain
  // the actual login redirect without following it, then start the simulated
  // external page as a fresh browser navigation. The normal endpoint sets the
  // real state cookie in this browser context; no session/cookie is injected.
  const login = await page.context().request.get(loginHref ?? "", {
    maxRedirects: 0,
  });
  expect(login.status()).toBe(302);
  expect(login.headers().location).toMatch(authorizer);
  await page.goto(login.headers().location ?? "");
  await expect(
    page.getByRole("button", { name: "退出", exact: true }),
  ).toBeVisible();
  const response = await page.context().request.get("/api/me");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const session = (await response.json()) as Session;
  expect(session.user).toMatchObject({
    username: accounts[role].username,
    displayName: accounts[role].displayName,
  });
  expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
  expect(callback).not.toBe("");
  return { session, callback };
}

async function createActivity(
  page: Page,
  settings: {
    title: string;
    type: "text" | "ldc";
    password: string;
    openAfter?: boolean;
  },
) {
  await page.goto("/activities/new");
  await page.locator("#activity-rewardType").selectOption(settings.type);
  await page.locator("#activity-title").fill(settings.title);
  await page.locator("summary").filter({ hasText: "更多设置" }).click();
  await page.locator("#activity-forceDedicated").check();
  await page.getByLabel("口令 1", { exact: true }).fill(settings.password);
  if (settings.type === "text") {
    await page.getByRole("button", { name: "添加口令", exact: true }).click();
    await page.getByLabel("口令 2", { exact: true }).fill("OtherAnswer123");
    await page.getByLabel("奖励 1", { exact: true }).fill(textReward);
    await page.locator("summary").filter({ hasText: "批量添加奖励" }).click();
    await page.getByLabel("批量添加：每行一份").fill("未分配的另一份文本");
    await page.getByRole("button", { name: "添加这些奖励" }).click();
  } else {
    await expect(page.getByLabel("发放商户", { exact: true })).toHaveValue(
      /完整应用商户.*当前商户/,
    );
    await page.getByLabel("每份金额（LDC）", { exact: true }).fill("0.10");
    await page.getByLabel("奖励份数", { exact: true }).fill("5");
  }
  await page.locator("#activity-quantityVisibility").selectOption("exact");
  await page.getByLabel("领取前说明", { exact: true }).fill("公开说明");
  await page.getByLabel("领取后说明", { exact: true }).fill(afterClaimInfo);
  await page
    .getByRole("button", {
      name: settings.openAfter ? "保存并开放" : "保存草稿",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/my\/activities\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await expect(
    page.getByText(settings.openAfter ? "进行中" : "准备中", { exact: true }),
  ).toBeVisible();
  return id as string;
}

async function submit(page: Page, password: string) {
  await page.getByLabel("兑换口令", { exact: true }).fill(password);
  await page.getByRole("button", { name: "领取", exact: true }).click();
}

async function assertDenied(
  context: BrowserContext,
  path: string,
  status: number,
) {
  const response = await context.request.get(path);
  expect(response.status()).toBe(status);
  expect(response.headers()["content-type"]).toContain("application/json");
}

const textReward = "<b>FULL-APP-PRIVATE-TEXT</b>\n**保留原文**\n第二行";
const afterClaimInfo = "## 完整应用领取后说明\n\n私有说明应在领取后解锁。";

test("真实网关登录、会话与 CSRF；OAuth 只模拟外部授权页和上游", async ({
  page,
  request,
}) => {
  const externalRequests = await guardExternalBrowserRequests(page.context());
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  const missing = await request.get("/api/not-a-route");
  expect(missing.status()).toBe(404);
  expect(missing.headers()["content-type"]).toContain("application/json");
  const before = await readState(request);
  const { session, callback } = await signIn(page, "author", "/account");
  await expect(page).toHaveURL("/account");
  const cookie = (await page.context().cookies(origin)).find(
    (value) => value.name === "hb_session",
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  expect(cookie?.path).toBe("/");
  const digest = createHash("sha256")
    .update(`hb.session-token.v1:${cookie?.value}`)
    .digest("hex");
  const state = await readState(request);
  expect(state.migrations).toBeGreaterThanOrEqual(18);
  expect(state.users).toContainEqual({
    id: session.user.id,
    external_id: accounts.author.externalId,
    username: accounts.author.username,
    provider: "linux_do",
  });
  expect(state.sessions).toContainEqual({
    user_id: session.user.id,
    token_hash: digest,
  });
  expect(
    state.upstream.oauthTokenRequests - before.upstream.oauthTokenRequests,
  ).toBe(1);
  expect(
    state.upstream.oauthProfileRequests - before.upstream.oauthProfileRequests,
  ).toBe(1);
  const replay = await page
    .context()
    .request.get(callback, { maxRedirects: 0 });
  expect(replay.status()).toBe(302);
  expect(replay.headers().location).toContain("authError=invalid_state");
  const afterReplay = await readState(request);
  expect(afterReplay.upstream.oauthTokenRequests).toBe(
    state.upstream.oauthTokenRequests,
  );
  const missingCsrf = await page.context().request.post("/api/auth/logout", {
    headers: { Origin: origin },
  });
  expect(missingCsrf.status()).toBe(403);
  const invalidOrigin = await page.context().request.post("/api/auth/logout", {
    headers: {
      Origin: "https://untrusted.example",
      "X-CSRF-Token": session.csrfToken,
    },
  });
  expect(invalidOrigin.status()).toBe(403);
  expect(
    (await (await page.context().request.get("/api/me")).json()).user.id,
  ).toBe(session.user.id);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "登录", exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.context().request.get("/api/me")).json()).user,
  ).toBeNull();
  expect(
    (await readState(request)).sessions.some(
      (value) => value.token_hash === digest,
    ),
  ).toBe(false);
  expect(externalRequests).toEqual([]);
});

test("真实 D1／ActivityDO 文本创建、开放、兑奖、记录与权限", async ({
  browser,
  request,
}) => {
  const author = await browser.newContext({ baseURL: origin });
  const recipient = await browser.newContext({ baseURL: origin });
  const visitor = await browser.newContext({ baseURL: origin });
  const externalRequests = await Promise.all(
    [author, recipient, visitor].map(guardExternalBrowserRequests),
  );
  try {
    const authorPage = await author.newPage();
    const recipientPage = await recipient.newPage();
    const authorLogin = await signIn(authorPage, "author");
    const recipientLogin = await signIn(recipientPage, "recipient");
    const id = await createActivity(authorPage, {
      title: "完整应用文本闭环",
      type: "text",
      password: "TextAnswer123",
    });
    await assertDenied(visitor, `/api/activities/${id}`, 404);
    await assertDenied(recipient, `/api/activities/${id}`, 404);
    await assertDenied(recipient, `/api/me/activities/${id}`, 404);
    await authorPage
      .getByRole("button", { name: "开放领取", exact: true })
      .click();
    await expect(
      authorPage.getByText("活动已开放。", { exact: true }),
    ).toBeVisible();
    const publicResponse = await visitor.request.get(`/api/activities/${id}`);
    const publicActivity = (await publicResponse.json()).activity;
    expect(publicActivity.status).toBe("active");
    expect(publicActivity.quantity).toEqual({
      mode: "exact",
      total: 2,
      claimed: 0,
      remaining: 2,
    });
    expect(JSON.stringify(publicActivity)).not.toContain("TextAnswer123");
    expect(JSON.stringify(publicActivity)).not.toContain(
      "FULL-APP-PRIVATE-TEXT",
    );
    expect(publicActivity).not.toHaveProperty("afterClaimInfo");
    const submissions: Array<{ submissionId: string; password: string }> = [];
    recipientPage.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST" &&
        outgoing.url().endsWith(`/api/activities/${id}/claim`)
      )
        submissions.push(outgoing.postDataJSON());
    });
    await recipientPage.goto(`/activities/${id}`);
    await submit(recipientPage, "WrongAnswer123");
    await expect(
      recipientPage.getByText("口令不正确，请重新尝试。", { exact: true }),
    ).toBeVisible();
    await submit(recipientPage, "  TextAnswer123  ");
    await expect(
      recipientPage.getByText(textReward, { exact: true }),
    ).toBeVisible();
    await expect(
      recipientPage.getByRole("heading", { name: "完整应用领取后说明" }),
    ).toBeVisible();
    await expect(recipientPage.locator("main b")).toHaveCount(0);
    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.submissionId).not.toBe(submissions[1]?.submissionId);
    const claimResponse = await recipient.request.get(
      `/api/activities/${id}/claim`,
    );
    expect(claimResponse.headers()["cache-control"]).toBe("no-store");
    const claim = (await claimResponse.json()).claim;
    expect(claim.text).toBe(textReward);
    const duplicate = await recipient.request.post(
      `/api/activities/${id}/claim`,
      {
        headers: {
          Origin: origin,
          "X-CSRF-Token": recipientLogin.session.csrfToken,
        },
        data: submissions[1],
      },
    );
    expect(duplicate.status()).toBe(200);
    expect((await duplicate.json()).claim.id).toBe(claim.id);
    await assertDenied(author, `/api/me/claims/${claim.id}`, 404);
    const creatorClaims = await author.request.get(
      `/api/me/activities/${id}/claims`,
    );
    expect((await creatorClaims.json()).items).toHaveLength(1);
    const state = await readState(request);
    expect(
      state.claims.filter((value) => value.activity_id === id),
    ).toHaveLength(1);
    expect(
      state.attempts.find((value) => value.activity_id === id)?.count,
    ).toBe(2);
    expect(
      state.activities.find((value) => value.id === id)?.claimed_count,
    ).toBe(1);
    expect(
      state.users.find(
        (value) => value.external_id === accounts.author.externalId,
      )?.id,
    ).toBe(authorLogin.session.user.id);
    const passwordBefore = await recipient.request.get(
      `/api/activities/${id}/passwords`,
    );
    expect(passwordBefore.headers()["cache-control"]).toBe("no-store");
    expect(await passwordBefore.json()).toMatchObject({
      passwords: [
        { text: "TextAnswer123", isClaimPassword: true, isSolved: false },
      ],
      hiddenCount: 1,
      canSolve: true,
    });
    const anonymousAnswers = await visitor.request.get(
      `/api/activities/${id}/passwords`,
    );
    expect(await anonymousAnswers.json()).toEqual({
      passwords: [],
      hiddenCount: 2,
      canSolve: false,
    });
    const solveInput = {
      submissionId: crypto.randomUUID(),
      password: "OtherAnswer123",
    };
    const solveHeaders = {
      Origin: origin,
      "X-CSRF-Token": recipientLogin.session.csrfToken,
    };
    const solved = await recipient.request.post(
      `/api/activities/${id}/password-solves`,
      { headers: solveHeaders, data: solveInput },
    );
    expect(solved.status()).toBe(200);
    expect(await solved.json()).toEqual({ outcome: "solved" });
    const replaySolved = await recipient.request.post(
      `/api/activities/${id}/password-solves`,
      { headers: solveHeaders, data: solveInput },
    );
    expect(await replaySolved.json()).toEqual({ outcome: "solved" });
    const crossPurpose = await recipient.request.post(
      `/api/activities/${id}/claim`,
      { headers: solveHeaders, data: solveInput },
    );
    expect(crossPurpose.status()).toBe(409);
    await recipientPage.reload();
    await expect(
      recipientPage.getByText("OtherAnswer123", { exact: true }),
    ).toBeVisible();
    await expect(
      recipientPage.getByText("我的领奖口令", { exact: true }),
    ).toBeVisible();
    await expect(
      recipientPage.getByText("我已解出", { exact: true }),
    ).toBeVisible();
    const afterSolve = await readState(request);
    expect(afterSolve.claims).toEqual(state.claims);
    expect(afterSolve.payments).toEqual(state.payments);
    expect(afterSolve.outbox).toEqual(state.outbox);
    expect(
      afterSolve.attempts.find((value) => value.activity_id === id)?.count,
    ).toBe(3);
    // Exhaust the remaining text item through a real claim; answers become public immediately.
    const finalClaim = await author.request.post(
      `/api/activities/${id}/claim`,
      {
        headers: {
          Origin: origin,
          "X-CSRF-Token": authorLogin.session.csrfToken,
        },
        data: { submissionId: crypto.randomUUID(), password: "OtherAnswer123" },
      },
    );
    expect(finalClaim.status()).toBe(200);
    const endedAnswers = await visitor.request.get(
      `/api/activities/${id}/passwords`,
    );
    expect(await endedAnswers.json()).toEqual({
      passwords: [
        { text: "TextAnswer123", isClaimPassword: false, isSolved: false },
        { text: "OtherAnswer123", isClaimPassword: false, isSolved: false },
      ],
      hiddenCount: 0,
      canSolve: false,
    });

    await recipientPage
      .getByRole("link", { name: "我的领取", exact: true })
      .click();
    const card = recipientPage
      .getByRole("article")
      .filter({ hasText: "完整应用文本闭环" });
    await card.getByRole("link", { name: "查看奖励", exact: true }).click();
    await expect(recipientPage).toHaveURL(`/my/claims/${claim.id}`);
    await recipientPage.reload();
    await expect(
      recipientPage.getByText(textReward, { exact: true }),
    ).toBeVisible();
    await recipientPage
      .getByRole("button", { name: "退出", exact: true })
      .click();
    await expect(
      recipientPage.getByText(textReward, { exact: true }),
    ).toHaveCount(0);
    const relogin = await signIn(
      recipientPage,
      "recipient",
      `/my/claims/${claim.id}`,
    );
    expect(relogin.session.user.id).toBe(recipientLogin.session.user.id);
    await expect(
      recipientPage.getByText(textReward, { exact: true }),
    ).toBeVisible();
    await recipientPage.setViewportSize({ width: 390, height: 844 });
    expect(
      await recipientPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(externalRequests.flat()).toEqual([]);
  } finally {
    await Promise.allSettled([
      author.close(),
      recipient.close(),
      visitor.close(),
    ]);
  }
});

test("普通真实模式活动走正常领取、Outbox、Queue 与 MerchantDO；仅模拟上游 HTTP", async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const author = await browser.newContext({ baseURL: origin });
  const recipient = await browser.newContext({ baseURL: origin });
  const externalRequests = await Promise.all(
    [author, recipient].map(guardExternalBrowserRequests),
  );
  try {
    const authorPage = await author.newPage();
    const recipientPage = await recipient.newPage();
    const authorLogin = await signIn(authorPage, "author");
    const recipientLogin = await signIn(recipientPage, "recipient");
    await authorPage.goto("/my/merchants");
    await expect(
      authorPage.locator("#merchant-mode option[value=simulation]"),
    ).toHaveCount(0);
    await authorPage
      .getByLabel("商户名称", { exact: true })
      .fill("完整应用商户");
    await authorPage
      .getByLabel("Client ID", { exact: true })
      .fill("hb_full_app_merchant");
    await authorPage
      .getByLabel("商户密钥", { exact: true })
      .fill("full-app-merchant-secret");
    await authorPage
      .getByRole("button", { name: "保存商户", exact: true })
      .click();
    await expect(authorPage).toHaveURL(/\/my\/merchants\/[0-9a-f-]{36}$/);
    const merchantId = new URL(authorPage.url()).pathname
      .split("/")
      .at(-1) as string;
    await expect(authorPage.getByText("凭证通过", { exact: true })).toBeVisible(
      { timeout: 30_000 },
    );
    await expect(
      authorPage.getByLabel("模拟情形", { exact: true }),
    ).toHaveCount(0);
    const merchantResponse = await author.request.get(
      `/api/me/merchants/${merchantId}`,
    );
    const merchant = (await merchantResponse.json()).merchant;
    expect(merchant.mode).toBe("real");
    expect(merchant.publicationEligibility.allowed).toBe(true);
    expect(merchant.credentialVerification.status).toBe("passed");
    expect(JSON.stringify(merchant)).not.toContain("full-app-merchant-secret");
    const id = await createActivity(authorPage, {
      title: "完整应用真实模式普通活动",
      type: "ldc",
      password: "LdcAnswer123",
      openAfter: true,
    });
    await authorPage.goto(`/activities/${id}`);
    await expect(
      authorPage.getByText("作者不能领取自己创建的 LDC 活动。", {
        exact: true,
      }),
    ).toBeVisible();
    const selfClaim = await author.request.post(`/api/activities/${id}/claim`, {
      headers: {
        Origin: origin,
        "X-CSRF-Token": authorLogin.session.csrfToken,
      },
      data: { submissionId: crypto.randomUUID(), password: "LdcAnswer123" },
    });
    expect(selfClaim.status()).toBe(403);
    const submissions: Array<{ submissionId: string; password: string }> = [];
    recipientPage.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST" &&
        outgoing.url().endsWith(`/api/activities/${id}/claim`)
      )
        submissions.push(outgoing.postDataJSON());
    });
    await recipientPage.goto(`/activities/${id}`);
    await submit(recipientPage, "LdcAnswer123");
    await expect(
      recipientPage.getByText("0.10 LDC", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      recipientPage.getByRole("heading", { name: "完整应用领取后说明" }),
    ).toBeVisible();
    expect(submissions).toHaveLength(1);
    await expect
      .poll(
        async () => {
          const result = await recipient.request.get(
            `/api/activities/${id}/claim`,
          );
          return (await result.json()).claim?.payment.status;
        },
        { timeout: 45_000, intervals: [100, 250, 500, 1_000] },
      )
      .toBe("confirmed");
    await recipientPage.reload();
    await expect(
      recipientPage.getByText("LDC 已确认发放，实际可用时间以 LDC 为准", {
        exact: true,
      }),
    ).toBeVisible();
    const claim = (
      await (await recipient.request.get(`/api/activities/${id}/claim`)).json()
    ).claim;
    const state = await readState(request);
    const task = state.payments.find((value) => value.claim_id === claim.id);
    expect(task).toMatchObject({
      source: "claim",
      mode: "real",
      status: "confirmed",
      recipient_id: accounts.recipient.externalId,
      recipient_username: accounts.recipient.username,
      amount_minor: 10,
      recovery_policy: "claim_same_order_v1",
      attempt_count: 1,
    });
    expect(task?.first_send_at).toEqual(expect.any(Number));
    expect(task?.reconciliation_count).toBeGreaterThanOrEqual(1);
    expect(state.upstream.distributeRequests).toBe(1);
    expect(state.upstream.orders).toHaveLength(1);
    expect(state.upstream.orderQueries).toBeGreaterThanOrEqual(1);
    expect(state.upstream.blockedRequests).toBe(0);
    expect(state.upstream.orders[0]).toMatchObject({
      businessNo: task?.business_no,
      recipientId: accounts.recipient.externalId,
      recipientUsername: accounts.recipient.username,
      amount: "0.10",
      externalOrderId: task?.external_order_id,
    });
    expect(
      state.claims.filter((value) => value.activity_id === id),
    ).toHaveLength(1);
    expect(
      state.outbox.find((value) => value.task_id === task?.id)?.delivered_at,
    ).toEqual(expect.any(Number));
    const duplicate = await recipient.request.post(
      `/api/activities/${id}/claim`,
      {
        headers: {
          Origin: origin,
          "X-CSRF-Token": recipientLogin.session.csrfToken,
        },
        data: submissions[0],
      },
    );
    expect(duplicate.status()).toBe(200);
    expect((await duplicate.json()).claim.id).toBe(claim.id);
    expect((await readState(request)).upstream.distributeRequests).toBe(1);
    await authorPage.goto(`/my/merchants/${merchantId}/payments/${task?.id}`);
    await expect(
      authorPage.getByRole("heading", { name: "付款详情", exact: true }),
    ).toBeVisible();
    await expect(
      authorPage.getByText("活动领取", { exact: true }),
    ).toBeVisible();
    await expect(
      authorPage.getByRole("heading", { name: "自动付款恢复", exact: true }),
    ).toBeVisible();
    await expect(authorPage.getByText("接入验收", { exact: true })).toHaveCount(
      0,
    );
    await assertDenied(
      recipient,
      `/api/me/merchants/${merchantId}/payments/${task?.id}`,
      404,
    );
    await assertDenied(author, `/api/me/claims/${claim.id}`, 404);
    await authorPage.setViewportSize({ width: 390, height: 844 });
    expect(
      await authorPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(externalRequests.flat()).toEqual([]);
  } finally {
    await Promise.allSettled([author.close(), recipient.close()]);
  }
});
