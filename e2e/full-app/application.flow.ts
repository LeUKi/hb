import { createHash } from "node:crypto";
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type {
  RegistrationDetail,
  TimedDrawMoney,
} from "../../packages/contracts/src";

const origin = "http://127.0.0.1:4193";
const authorizer = /^https:\/\/connect\.linux\.do\/oauth2\/authorize\?/;
const accounts = {
  author: {
    externalId: "730001",
    username: "FullAppAuthor",
    displayName: "完整应用作者",
    email: "author-private@example.test",
    avatarUrl: "https://avatars.example.test/author.png",
  },
  recipient: {
    externalId: "730002",
    username: "FullAppRecipient",
    displayName: "完整应用领取者",
    email: "recipient-private@example.test",
    avatarUrl: "https://avatars.example.test/recipient.png",
  },
  recipient2: {
    externalId: "730003",
    username: "FullAppSecond",
    displayName: "完整应用第二参与者",
    email: "second-private@example.test",
    avatarUrl: "https://avatars.example.test/second.png",
  },
  recipient3: {
    externalId: "730004",
    username: "FullAppThird",
    displayName: "完整应用第三参与者",
    email: "third-private@example.test",
    avatarUrl: "https://avatars.example.test/third.png",
  },
  recipientRenamed: {
    externalId: "730002",
    username: "FullAppRenamed",
    displayName: "完整应用改名参与者",
    email: "recipient-private@example.test",
    avatarUrl: "https://avatars.example.test/recipient.png",
  },
};
type Session = {
  user: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    email: string | null;
  };
  csrfToken: string;
};
type RuntimeState = {
  migrations: number;
  users: Array<{
    id: string;
    external_id: string;
    username: string;
    provider: string;
    avatar_url: string | null;
    has_email_ciphertext: number;
    email_ciphertext_contains_plaintext: number;
  }>;
  sessions: Array<{ user_id: string; token_hash: string }>;
  activities: Array<{
    id: string;
    reward_type: "text" | "ldc";
    payment_mode: "real" | null;
    deadline: number | null;
    claimed_count: number;
    total_count: number;
    registered_count: number;
    draw_state: "waiting" | "settling" | "completed" | "empty" | null;
    draw_closed_at: number | null;
    draw_reason: "full" | "deadline" | "manual" | null;
    draw_published_at: number | null;
  }>;
  registrations: Array<{
    id: string;
    activity_id: string;
    user_id: string;
    password_id: string;
    ordinal: number;
    recipient_id: string;
    registered_at: number;
  }>;
  drawPlans: Array<{
    activity_id: string;
    participant_count: number;
    payload: string;
    created_at: number;
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
      clientId: string;
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
    if (
      url.origin !== origin &&
      !authorizer.test(url.href) &&
      url.origin !== "https://avatars.example.test"
    )
      unexpected.push(`${url.origin}${url.pathname}`);
  });
  await context.route("https://avatars.example.test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#ddd"/></svg>',
    }),
  );
  await context.route(/^https?:\/\/(?!127\.0\.0\.1:4193(?:\/|$))/, (route) =>
    route.request().url().startsWith("https://avatars.example.test/")
      ? route.fallback()
      : route.abort("blockedbyclient"),
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
    avatarUrl: accounts[role].avatarUrl,
    email: accounts[role].email,
  });
  await expect(
    page.locator(`img[src="${accounts[role].avatarUrl}"]`).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: accounts[role].displayName, exact: true })
    .hover();
  await expect(page.getByRole("dialog")).toContainText(
    `@${accounts[role].username}`,
  );
  const profileHref = await page
    .getByRole("link", { name: /查看 Linux DO 主页/ })
    .getAttribute("href");
  expect(profileHref).toBe(
    `https://linux.do/u/${encodeURIComponent(accounts[role].username)}`,
  );
  await page.mouse.move(1, 1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: accounts[role].displayName, exact: true })
    .focus();
  await expect(page.getByRole("dialog")).toContainText(
    `@${accounts[role].username}`,
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
    timedDraw?: TimedDrawMoney;
    extraPassword?: string;
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
    if (settings.timedDraw) {
      const money = settings.timedDraw;
      await page.locator("#activity-money").selectOption("timed_draw");
      await expect(page.locator("#timed-participant-limit")).toHaveValue(
        await page.locator("#timed-count").inputValue(),
      );
      await page.locator("#timed-total").fill(money.totalAmount);
      await page.locator("#timed-count").fill(String(money.count));
      await page
        .locator("#timed-participant-limit")
        .fill(
          money.participantLimit === null ? "" : String(money.participantLimit),
        );
      await page
        .locator("#timed-countdown")
        .fill(String(money.countdownSeconds));
      await page.locator("#timed-algorithm").selectOption(money.algorithm);
      await page
        .getByLabel(/人数不足时发完奖池/)
        .setChecked(money.distributeFullPool);
      if (settings.extraPassword) {
        await page
          .getByRole("button", { name: "添加口令", exact: true })
          .click();
        await page
          .getByLabel("口令 2", { exact: true })
          .fill(settings.extraPassword);
      }
    } else {
      await page.getByLabel("每份金额（LDC）", { exact: true }).fill("0.10");
      await page.getByLabel("奖励份数", { exact: true }).fill("5");
    }
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
  if (settings.timedDraw)
    await expect(
      page.getByRole("heading", { name: "管理活动", exact: true }),
    ).toBeVisible();
  else
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

type ParticipantRole = "recipient" | "recipient2" | "recipient3";
type DrawActor = {
  role: "author" | ParticipantRole;
  context: BrowserContext;
  page: Page;
  session: Session;
  externalRequests: string[];
};

async function ensureFullAppMerchant(page: Page) {
  const response = await page.context().request.get("/api/me/merchants");
  expect(response.status()).toBe(200);
  const merchants = await response.json();
  if (merchants.currentMerchantId) return merchants.currentMerchantId as string;
  await page.goto("/my/merchants");
  await page.getByLabel("商户名称", { exact: true }).fill("完整应用商户");
  await page
    .getByLabel("Client ID", { exact: true })
    .fill("hb_full_app_merchant");
  await page
    .getByLabel("商户密钥", { exact: true })
    .fill("full-app-merchant-secret");
  await page.getByRole("button", { name: "保存商户", exact: true }).click();
  await expect(page).toHaveURL(/\/my\/merchants\/[0-9a-f-]{36}$/);
  await expect(page.getByText("凭证通过", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  return new URL(page.url()).pathname.split("/").at(-1) as string;
}

async function createDrawActors(browser: Browser, roles: ParticipantRole[]) {
  const contexts: BrowserContext[] = [];
  try {
    const actors = await Promise.all(
      (["author", ...roles] as DrawActor["role"][]).map(async (role) => {
        const context = await browser.newContext({ baseURL: origin });
        contexts.push(context);
        const externalRequests = await guardExternalBrowserRequests(context);
        const page = await context.newPage();
        const { session } = await signIn(page, role);
        return { role, context, page, session, externalRequests };
      }),
    );
    const author = actors[0];
    if (!author) throw new Error("FULL_APP_AUTHOR_MISSING");
    await ensureFullAppMerchant(author.page);
    return {
      author,
      participants: actors.slice(1),
      assertOutbound: () =>
        expect(actors.flatMap((actor) => actor.externalRequests)).toEqual([]),
      close: () =>
        Promise.allSettled(contexts.map((context) => context.close())),
    };
  } catch (error) {
    await Promise.allSettled(contexts.map((context) => context.close()));
    throw error;
  }
}

async function registerForDraw(actor: DrawActor, id: string, password: string) {
  await actor.page.goto(`/activities/${id}`);
  await actor.page.getByLabel("兑换口令", { exact: true }).fill(password);
  const [response] = await Promise.all([
    actor.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() === `${origin}/api/activities/${id}/claim`,
    ),
    actor.page.getByRole("button", { name: "报名", exact: true }).click(),
  ]);
  expect(response.status()).toBe(200);
  const result = (await response.json()) as {
    result: string;
    registration: RegistrationDetail;
  };
  expect(["registered", "already_registered"]).toContain(result.result);
  expect(result.registration.activity.id).toBe(id);
  return {
    registration: result.registration,
    submission: response.request().postDataJSON() as {
      submissionId: string;
      password: string;
    },
  };
}

async function readRegistration(actor: DrawActor, id: string) {
  const response = await actor.context.request.get(
    `/api/activities/${id}/registration`,
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  return (await response.json()).registration as RegistrationDetail;
}

function activityPayments(state: RuntimeState, id: string) {
  const claimIds = new Set(
    state.claims
      .filter((claim) => claim.activity_id === id)
      .map((claim) => claim.id),
  );
  return state.payments.filter((payment) => claimIds.has(payment.claim_id));
}

function assertDrawWaiting(
  state: RuntimeState,
  before: RuntimeState,
  id: string,
  count: number,
) {
  expect(state.activities.find((activity) => activity.id === id)).toMatchObject(
    {
      registered_count: count,
      claimed_count: 0,
      draw_state: "waiting",
      draw_closed_at: null,
      draw_published_at: null,
    },
  );
  expect(
    state.registrations.filter(
      (registration) => registration.activity_id === id,
    ),
  ).toHaveLength(count);
  expect(state.claims.filter((claim) => claim.activity_id === id)).toEqual([]);
  expect(state.drawPlans.filter((plan) => plan.activity_id === id)).toEqual([]);
  expect(state.payments).toEqual(before.payments);
  expect(state.outbox).toEqual(before.outbox);
  expect(state.upstream.distributeRequests).toBe(
    before.upstream.distributeRequests,
  );
}

async function waitForCompletedDraw(
  request: APIRequestContext,
  id: string,
  winners: number,
) {
  // Observation only: expiry must fire the real ActivityDO alarm without a
  // business-page read or a test-only settlement hook.
  await expect
    .poll(
      async () => {
        const state = await readState(request);
        const payments = activityPayments(state, id);
        return {
          state: state.activities.find((activity) => activity.id === id)
            ?.draw_state,
          claims: state.claims.filter((claim) => claim.activity_id === id)
            .length,
          confirmed: payments.filter(
            (payment) => payment.status === "confirmed",
          ).length,
          delivered: state.outbox.filter(
            (item) =>
              payments.some((payment) => payment.id === item.task_id) &&
              item.delivered_at !== null,
          ).length,
        };
      },
      { timeout: 45_000, intervals: [100, 250, 500, 1_000] },
    )
    .toEqual({
      state: "completed",
      claims: winners,
      confirmed: winners,
      delivered: winners,
    });
  return readState(request);
}

function assertDrawPayments(
  state: RuntimeState,
  before: RuntimeState,
  id: string,
  expected: {
    entrants: number;
    winners: number;
    reason: "full" | "deadline";
    totalAmount: string;
    fullPool: boolean;
  },
) {
  const activity = state.activities.find((item) => item.id === id);
  expect(activity).toMatchObject({
    registered_count: expected.entrants,
    claimed_count: expected.winners,
    draw_state: "completed",
    draw_reason: expected.reason,
    draw_closed_at: expect.any(Number),
    draw_published_at: expect.any(Number),
  });
  const registrations = state.registrations.filter(
    (item) => item.activity_id === id,
  );
  expect(registrations).toHaveLength(expected.entrants);
  expect(new Set(registrations.map((item) => item.user_id)).size).toBe(
    expected.entrants,
  );
  const plans = state.drawPlans.filter((item) => item.activity_id === id);
  expect(plans).toHaveLength(1);
  expect(plans[0]?.participant_count).toBe(expected.entrants);
  const payments = activityPayments(state, id);
  expect(payments).toHaveLength(expected.winners);
  expect(new Set(payments.map((payment) => payment.business_no)).size).toBe(
    expected.winners,
  );
  expect(new Set(payments.map((payment) => payment.recipient_id)).size).toBe(
    expected.winners,
  );
  for (const payment of payments) {
    expect(payment).toMatchObject({
      source: "claim",
      mode: "real",
      status: "confirmed",
      recovery_policy: "claim_same_order_v1",
      attempt_count: 1,
    });
    expect(payment.amount_minor).toBeGreaterThanOrEqual(1);
    expect(payment.recipient_id).not.toBe(accounts.author.externalId);
    expect(
      registrations.some((item) => item.recipient_id === payment.recipient_id),
    ).toBe(true);
    expect(payment.recipient_username).toBe(
      state.users.find((user) => user.external_id === payment.recipient_id)
        ?.username,
    );
    expect(state.upstream.orders).toContainEqual({
      clientId: "hb_full_app_merchant",
      businessNo: payment.business_no,
      recipientId: payment.recipient_id,
      recipientUsername: payment.recipient_username,
      amount: (payment.amount_minor / 100).toFixed(2),
      externalOrderId: payment.external_order_id,
    });
  }
  const paid = payments.reduce((sum, payment) => sum + payment.amount_minor, 0);
  const pool = Math.round(Number(expected.totalAmount) * 100);
  if (expected.fullPool) expect(paid).toBe(pool);
  else expect(paid).toBeLessThan(pool);
  expect(
    state.upstream.distributeRequests - before.upstream.distributeRequests,
  ).toBe(expected.winners);
  expect(state.upstream.blockedRequests).toBe(0);
}

async function assertParticipation(
  actor: DrawActor,
  id: string,
  title: string,
  status: RegistrationDetail["status"],
) {
  const response = await actor.context.request.get("/api/me/participations");
  expect(response.status()).toBe(200);
  const history = await response.json();
  const participation = history.items.filter(
    (item: {
      kind: string;
      registration?: RegistrationDetail;
      claim?: { activity: { id: string } };
    }) => (item.registration ?? item.claim)?.activity.id === id,
  );
  expect(participation).toHaveLength(1);
  expect(participation[0]).toMatchObject({
    kind: "registration",
    registration: { status },
  });
  await actor.page.getByRole("link", { name: "我的参与", exact: true }).click();
  const card = actor.page.getByRole("article").filter({ hasText: title });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(
    status === "registered" ? "已报名" : status === "won" ? "已中奖" : "未中奖",
  );
  await actor.page.reload();
  await expect(
    actor.page.getByRole("article").filter({ hasText: title }),
  ).toHaveCount(1);
}

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
    avatar_url: accounts.author.avatarUrl,
    has_email_ciphertext: 1,
    email_ciphertext_contains_plaintext: 0,
  });
  await expect(
    page.getByText(accounts.author.email, { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(`img[src="${accounts.author.avatarUrl}"]`).first(),
  ).toBeVisible();
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
    expect(JSON.stringify(publicActivity)).not.toContain(accounts.author.email);
    expect(publicActivity.author.avatarUrl).toBe(accounts.author.avatarUrl);
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
    const recipients = await visitor.request.get(
      `/api/activities/${id}/recipients`,
    );
    const recipientsJson = await recipients.json();
    expect(recipientsJson.items[0]).toMatchObject({
      username: accounts.recipient.username,
      displayName: accounts.recipient.displayName,
      avatarUrl: accounts.recipient.avatarUrl,
    });
    expect(JSON.stringify(recipientsJson)).not.toContain(
      accounts.recipient.email,
    );
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
    const creatorClaimItems = (await creatorClaims.json()).items;
    expect(creatorClaimItems).toHaveLength(1);
    expect(creatorClaimItems[0].claimant.avatarUrl).toBe(
      accounts.recipient.avatarUrl,
    );
    expect(JSON.stringify(creatorClaimItems)).not.toContain(
      accounts.recipient.email,
    );
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
      .getByRole("link", { name: "我的参与", exact: true })
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
    const paymentDetail = await author.request.get(
      `/api/me/merchants/${merchantId}/payments/${task?.id}`,
    );
    const paymentJson = await paymentDetail.json();
    expect(paymentJson.payment.recipientProfile).toMatchObject({
      username: accounts.recipient.username,
      displayName: accounts.recipient.displayName,
      avatarUrl: accounts.recipient.avatarUrl,
    });
    expect(JSON.stringify(paymentJson)).not.toContain(accounts.recipient.email);
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

test("定时抽奖 M>N：只报名、继续解题与重放不加机会；满员抽签后保留输赢历史", async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const fixture = await createDrawActors(browser, [
    "recipient",
    "recipient2",
    "recipient3",
  ]);
  try {
    const [first, second, third] = fixture.participants;
    if (!first || !second || !third)
      throw new Error("FULL_APP_PARTICIPANT_MISSING");
    const title = "完整应用定时抽奖 M 大于 N";
    const money: TimedDrawMoney = {
      mode: "timed_draw",
      algorithm: "double_mean_v1",
      totalAmount: "0.10",
      count: 2,
      participantLimit: 3,
      countdownSeconds: 3_600,
      distributeFullPool: true,
    };
    const id = await createActivity(fixture.author.page, {
      title,
      type: "ldc",
      password: "DrawAnswer123",
      extraPassword: "DrawOther123",
      timedDraw: money,
      openAfter: true,
    });
    const selfRegistration = await fixture.author.context.request.post(
      `/api/activities/${id}/claim`,
      {
        headers: {
          Origin: origin,
          "X-CSRF-Token": fixture.author.session.csrfToken,
        },
        data: { submissionId: crypto.randomUUID(), password: "DrawAnswer123" },
      },
    );
    expect(selfRegistration.status()).toBe(403);
    const before = await readState(request);
    const registered = await registerForDraw(first, id, "DrawAnswer123");
    expect(registered.registration).toMatchObject({
      status: "registered",
      claim: null,
    });
    await expect(
      first.page.getByText("已报名，等待开奖", { exact: true }),
    ).toBeVisible();
    await expect(
      first.page.getByText("我的报名口令", { exact: true }),
    ).toBeVisible();
    const passwords = await first.context.request.get(
      `/api/activities/${id}/passwords`,
    );
    expect(await passwords.json()).toMatchObject({
      passwords: [
        {
          text: "DrawAnswer123",
          isRegistrationPassword: true,
          isSolved: false,
        },
      ],
      hiddenCount: 1,
      canSolve: true,
    });
    await assertParticipation(first, id, title, "registered");
    await first.page.goto(`/activities/${id}`);
    await first.page.locator("#solve-password").fill("DrawOther123");
    const [solved] = await Promise.all([
      first.page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url() === `${origin}/api/activities/${id}/password-solves`,
      ),
      first.page.getByRole("button", { name: "解锁口令", exact: true }).click(),
    ]);
    expect(solved.status()).toBe(200);
    expect(await solved.json()).toEqual({ outcome: "solved" });
    const solveSubmission = solved.request().postDataJSON();
    await expect(
      first.page.getByText("DrawOther123", { exact: true }),
    ).toBeVisible();
    await expect(
      first.page.getByText("我已解出", { exact: true }),
    ).toBeVisible();
    const writeHeaders = {
      Origin: origin,
      "X-CSRF-Token": first.session.csrfToken,
    };
    const replaySolve = await first.context.request.post(
      `/api/activities/${id}/password-solves`,
      {
        headers: writeHeaders,
        data: solveSubmission,
      },
    );
    expect(replaySolve.status()).toBe(200);
    expect(await replaySolve.json()).toEqual({ outcome: "solved" });
    const solveAsSignup = await first.context.request.post(
      `/api/activities/${id}/claim`,
      { headers: writeHeaders, data: solveSubmission },
    );
    expect(solveAsSignup.status()).toBe(409);
    const replaySignup = await first.context.request.post(
      `/api/activities/${id}/claim`,
      {
        headers: writeHeaders,
        data: registered.submission,
      },
    );
    expect(replaySignup.status()).toBe(200);
    expect((await replaySignup.json()).registration.id).toBe(
      registered.registration.id,
    );
    const freshSignup = await first.context.request.post(
      `/api/activities/${id}/claim`,
      {
        headers: writeHeaders,
        data: { submissionId: crypto.randomUUID(), password: "DrawOther123" },
      },
    );
    expect(freshSignup.status()).toBe(200);
    expect(await freshSignup.json()).toMatchObject({
      result: "already_registered",
      registration: { id: registered.registration.id },
    });
    const afterSolving = await readState(request);
    assertDrawWaiting(afterSolving, before, id, 1);
    expect(
      afterSolving.registrations.find((item) => item.activity_id === id),
    ).toMatchObject({
      user_id: first.session.user.id,
      recipient_id: accounts.recipient.externalId,
    });
    await assertDenied(
      first.context,
      `/api/me/activities/${id}/registrations`,
      404,
    );
    const ownerList = await fixture.author.context.request.get(
      `/api/me/activities/${id}/registrations`,
    );
    expect(ownerList.status()).toBe(200);
    const ownerHistory = await ownerList.json();
    expect(ownerHistory.items).toHaveLength(1);
    expect(ownerHistory.items[0]).toMatchObject({
      id: registered.registration.id,
      status: "registered",
      participant: { username: accounts.recipient.username },
    });
    expect(JSON.stringify(ownerHistory)).not.toContain(
      accounts.recipient.email,
    );

    // Same Connect account signs in under a new profile before settlement. Its
    // qualification stays bound to external ID, while the payment uses the
    // latest synchronized username at task creation.
    await first.page.getByRole("button", { name: "退出", exact: true }).click();
    const renamed = await signIn(
      first.page,
      "recipientRenamed",
      `/activities/${id}`,
    );
    expect(renamed.session.user.id).toBe(first.session.user.id);
    first.session = renamed.session;
    expect((await readRegistration(first, id)).id).toBe(
      registered.registration.id,
    );
    await expect(
      first.page.getByText("DrawOther123", { exact: true }),
    ).toBeVisible();
    await registerForDraw(second, id, "DrawAnswer123");
    assertDrawWaiting(await readState(request), before, id, 2);
    await registerForDraw(third, id, "DrawAnswer123");
    const settled = await waitForCompletedDraw(request, id, 2);
    assertDrawPayments(settled, before, id, {
      entrants: 3,
      winners: 2,
      reason: "full",
      totalAmount: money.totalAmount,
      fullPool: true,
    });
    const results = await Promise.all(
      fixture.participants.map((actor) => readRegistration(actor, id)),
    );
    expect(results.filter((result) => result.status === "won")).toHaveLength(2);
    expect(
      results.filter((result) => result.status === "not_won"),
    ).toHaveLength(1);
    for (const [index, actor] of fixture.participants.entries()) {
      const result = results[index];
      if (!result) throw new Error("FULL_APP_DRAW_RESULT_MISSING");
      expect(result.drawAt).not.toBeNull();
      await assertParticipation(actor, id, title, result.status);
      const card = actor.page.getByRole("article").filter({ hasText: title });
      if (result.status === "won") {
        expect(result.claim?.rewardType).toBe("ldc");
        await card.getByRole("link", { name: "查看奖励", exact: true }).click();
        await expect(actor.page).toHaveURL(`/my/claims/${result.claim?.id}`);
        await expect(
          actor.page.getByText("LDC 已确认发放，实际可用时间以 LDC 为准", {
            exact: true,
          }),
        ).toBeVisible();
        await actor.page.reload();
        await expect(
          actor.page.getByRole("heading", { name: "完整应用领取后说明" }),
        ).toBeVisible();
      } else {
        expect(result.claim).toBeNull();
        await expect(
          card.getByRole("link", { name: "查看奖励", exact: true }),
        ).toHaveCount(0);
        await card.getByRole("link", { name: "查看活动", exact: true }).click();
        await expect(
          actor.page.getByText("未中奖", { exact: true }),
        ).toBeVisible();
        await expect(
          actor.page.getByRole("heading", { name: "完整应用领取后说明" }),
        ).toHaveCount(0);
        await actor.page.reload();
        await expect(
          actor.page.getByText("未中奖", { exact: true }),
        ).toBeVisible();
      }
    }
    const originalReplay = await first.context.request.post(
      `/api/activities/${id}/claim`,
      {
        headers: { Origin: origin, "X-CSRF-Token": first.session.csrfToken },
        data: registered.submission,
      },
    );
    expect(originalReplay.status()).toBe(200);
    expect((await originalReplay.json()).registration.id).toBe(
      registered.registration.id,
    );
    const afterReplay = await readState(request);
    expect(afterReplay.registrations).toEqual(settled.registrations);
    expect(afterReplay.claims).toEqual(settled.claims);
    expect(activityPayments(afterReplay, id)).toEqual(
      activityPayments(settled, id),
    );
    expect(afterReplay.drawPlans).toEqual(settled.drawPlans);
    expect(afterReplay.upstream.orders).toEqual(settled.upstream.orders);
    expect(afterReplay.upstream.distributeRequests).toBe(
      settled.upstream.distributeRequests,
    );
    fixture.assertOutbound();
  } finally {
    await fixture.close();
  }
});

for (const scenario of [
  { label: "M=N", slots: 2, fullPool: true, algorithm: "double_mean_v1" },
  {
    label: "M<N，全额分配",
    slots: 3,
    fullPool: true,
    algorithm: "bounded_mean_v1",
  },
  {
    label: "M<N，保留未中签份额",
    slots: 3,
    fullPool: false,
    algorithm: "double_mean_v1",
  },
] as const) {
  test(`定时抽奖 ${scenario.label}：两人满员后只产生两份正常付款`, async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const fixture = await createDrawActors(browser, [
      "recipient",
      "recipient2",
    ]);
    try {
      const [first, second] = fixture.participants;
      if (!first || !second) throw new Error("FULL_APP_PARTICIPANT_MISSING");
      const title = `完整应用定时抽奖 ${scenario.label}`;
      const money: TimedDrawMoney = {
        mode: "timed_draw",
        algorithm: scenario.algorithm,
        totalAmount: "0.12",
        count: scenario.slots,
        participantLimit: 2,
        countdownSeconds: 3_600,
        distributeFullPool: scenario.fullPool,
      };
      const id = await createActivity(fixture.author.page, {
        title,
        type: "ldc",
        password: "CappedDraw123",
        timedDraw: money,
        openAfter: true,
      });
      const before = await readState(request);
      await registerForDraw(first, id, "CappedDraw123");
      assertDrawWaiting(await readState(request), before, id, 1);
      if (scenario.label === "M=N") {
        const originalId = first.session.user.id;
        await first.page
          .getByRole("button", { name: "退出", exact: true })
          .click();
        const renamed = await signIn(
          first.page,
          "recipientRenamed",
          `/activities/${id}`,
        );
        expect(renamed.session.user.id).toBe(originalId);
        first.session = renamed.session;
      }
      await registerForDraw(second, id, "CappedDraw123");
      const settled = await waitForCompletedDraw(request, id, 2);
      assertDrawPayments(settled, before, id, {
        entrants: 2,
        winners: 2,
        reason: "full",
        totalAmount: money.totalAmount,
        fullPool: scenario.fullPool,
      });
      if (scenario.label === "M=N") {
        expect(
          activityPayments(settled, id).find(
            (payment) => payment.recipient_id === accounts.recipient.externalId,
          )?.recipient_username,
        ).toBe(accounts.recipientRenamed.username);
      }
      for (const actor of fixture.participants) {
        expect(await readRegistration(actor, id)).toMatchObject({
          status: "won",
          claim: { rewardType: "ldc" },
        });
        await assertParticipation(actor, id, title, "won");
      }
      fixture.assertOutbound();
    } finally {
      await fixture.close();
    }
  });
}

test("不限报名人数时，仅真实 DO 倒计时开奖；人数不足 N 仍分完奖池", async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const fixture = await createDrawActors(browser, ["recipient"]);
  try {
    const first = fixture.participants[0];
    if (!first) throw new Error("FULL_APP_PARTICIPANT_MISSING");
    const title = "完整应用无人数上限定时抽奖";
    const money: TimedDrawMoney = {
      mode: "timed_draw",
      algorithm: "bounded_mean_v1",
      totalAmount: "0.09",
      count: 3,
      participantLimit: null,
      countdownSeconds: 20,
      distributeFullPool: true,
    };
    const id = await createActivity(fixture.author.page, {
      title,
      type: "ldc",
      password: "DeadlineDraw123",
      timedDraw: money,
      openAfter: true,
    });
    const before = await readState(request);
    await registerForDraw(first, id, "DeadlineDraw123");
    const waiting = await readState(request);
    assertDrawWaiting(waiting, before, id, 1);
    expect(
      waiting.activities.find((activity) => activity.id === id)?.deadline,
    ).toBeGreaterThan(Date.now());
    await Promise.all([
      fixture.author.page.goto("/account"),
      first.page.goto("/account"),
    ]);
    const settled = await waitForCompletedDraw(request, id, 1);
    assertDrawPayments(settled, before, id, {
      entrants: 1,
      winners: 1,
      reason: "deadline",
      totalAmount: money.totalAmount,
      fullPool: true,
    });
    expect(activityPayments(settled, id)[0]?.amount_minor).toBe(9);
    expect(await readRegistration(first, id)).toMatchObject({
      status: "won",
      claim: { amount: "0.09" },
    });
    await assertParticipation(first, id, title, "won");
    fixture.assertOutbound();
  } finally {
    await fixture.close();
  }
});

test("无人报名的倒计时开奖进入 empty，保持零领取与零付款", async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const fixture = await createDrawActors(browser, []);
  try {
    const id = await createActivity(fixture.author.page, {
      title: "完整应用无人报名定时抽奖",
      type: "ldc",
      password: "EmptyDraw123",
      timedDraw: {
        mode: "timed_draw",
        algorithm: "double_mean_v1",
        totalAmount: "0.02",
        count: 2,
        participantLimit: null,
        countdownSeconds: 1,
        distributeFullPool: true,
      },
      openAfter: true,
    });
    const before = await readState(request);
    await fixture.author.page.goto("/account");
    await expect
      .poll(
        async () =>
          (await readState(request)).activities.find(
            (activity) => activity.id === id,
          )?.draw_state,
        { timeout: 15_000, intervals: [100, 250, 500] },
      )
      .toBe("empty");
    const after = await readState(request);
    expect(
      after.activities.find((activity) => activity.id === id),
    ).toMatchObject({
      draw_state: "empty",
      draw_reason: "deadline",
      registered_count: 0,
      claimed_count: 0,
    });
    expect(
      after.registrations.filter(
        (registration) => registration.activity_id === id,
      ),
    ).toEqual([]);
    expect(after.claims.filter((claim) => claim.activity_id === id)).toEqual(
      [],
    );
    expect(after.payments).toEqual(before.payments);
    expect(after.outbox).toEqual(before.outbox);
    expect(after.upstream.distributeRequests).toBe(
      before.upstream.distributeRequests,
    );
    fixture.assertOutbound();
  } finally {
    await fixture.close();
  }
});
