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
  AccountHistorySummary,
  ActivityList,
  ActivityPaymentList,
  ActivityPaymentTargetList,
  AttemptCooldown,
  ManagedActivity,
  ParticipationList,
  PublicRecipientList,
  PublicRegistrationList,
  RegistrationDetail,
  TimedDrawMoney,
} from "../../packages/contracts/src";

import { fullAppMerchant } from "./ldc-fixture";

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
  attemptCooldown?: AttemptCooldown | null;
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
  sessions: Array<{
    user_id: string;
    token_hash: string;
  }>;
  activities: Array<{
    id: string;
    reward_type: "text" | "ldc";
    payment_mode: "real" | null;
    opened_at: number | null;
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
  const accountLogin = page
    .getByRole("link", { name: "通过LINUX DO登录", exact: true })
    .first();
  if (!new URL(page.url()).pathname.startsWith("/account")) {
    await page
      .locator("header")
      .getByRole("link", { name: "登录", exact: true })
      .click();
    await expect(page).toHaveURL(/\/account(?:\?|$)/);
  }
  await expect(accountLogin).toBeVisible();
  const loginHref = await page
    .getByRole("link", { name: "通过LINUX DO登录", exact: true })
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
  const selfLink = page
    .locator("header")
    .getByRole("link", { name: "我的账号", exact: true });
  await expect(selfLink).toHaveAttribute("href", "/account");
  await selfLink.hover();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await selfLink.focus();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
  expect(callback).not.toBe("");
  return { session, callback };
}

async function signOut(page: Page) {
  await page.goto("/account");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "登录解meme", exact: true }),
  ).toBeVisible();
}

async function createActivity(
  page: Page,
  settings: {
    title: string;
    count?: number;
    password: string;
    openAfter?: boolean;
    timedDraw?: TimedDrawMoney;
    extraPassword?: string;
    forceDedicated?: boolean;
    durationMinutes?: number;
  },
) {
  await ensureFullAppMerchant(page);
  await page.goto("/activities/new");
  await page.locator("#activity-title").fill(settings.title);
  await page.locator("summary").filter({ hasText: "更多设置" }).click();
  await page
    .locator("#activity-forceDedicated")
    .setChecked(settings.forceDedicated !== false);
  if (settings.durationMinutes !== undefined) {
    await page
      .locator("#activity-duration-value")
      .fill(String(settings.durationMinutes));
    await page
      .getByRole("button", { name: "开放时长单位", exact: true })
      .click();
    await page
      .getByRole("menuitemradio", { name: "分钟", exact: true })
      .click();
  }
  await page.getByLabel("口令 1", { exact: true }).fill(settings.password);
  await expect(page.getByLabel("发放商户", { exact: true })).toHaveValue(
    /当前商户/,
  );
  if (settings.timedDraw) {
    const money = settings.timedDraw;
    await page
      .getByRole("group", { name: "奖励方式", exact: true })
      .getByRole("button", { name: "限时开奖", exact: true })
      .click();
    await expect(page.locator("#timed-participant-limit")).toHaveValue("");
    await expect(page.locator("#timed-countdown")).toHaveValue("600");
    await page.locator("#timed-total").fill(money.totalAmount);
    await page.locator("#timed-count").fill(String(money.count));
    await page
      .locator("#timed-participant-limit")
      .fill(
        money.participantLimit === null ? "" : String(money.participantLimit),
      );
    await page.locator("#timed-countdown").fill(String(money.countdownSeconds));
    await page
      .getByRole("group", { name: "抽奖算法", exact: true })
      .getByRole("button", {
        name:
          money.algorithm === "double_mean_v1" ? "二倍均值法" : "均值上下 50%",
        exact: true,
      })
      .click();
    await page
      .getByLabel(/人数不足时发完奖池/)
      .setChecked(money.distributeFullPool);
  } else {
    await page.getByLabel("每份金额（LDC）", { exact: true }).fill("0.10");
    await page
      .getByLabel("奖励份数", { exact: true })
      .fill(String(settings.count ?? 5));
  }
  if (settings.extraPassword) {
    await page.getByRole("button", { name: "添加口令", exact: true }).click();
    await page
      .getByLabel("口令 2", { exact: true })
      .fill(settings.extraPassword);
  }
  const quantityVisibility = page.getByRole("group", {
    name: "数量展示",
    exact: true,
  });
  await quantityVisibility
    .getByRole("button", { name: "精确", exact: true })
    .click();
  await expect(
    quantityVisibility.getByRole("button", { name: "精确", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.locator("#activity-beforeInfo").fill(beforeInfo);
  await page.locator("#activity-afterClaimInfo").fill(afterClaimInfo);
  await page.locator("#activity-afterEndInfo").fill(afterEndInfo);
  for (const [id, label, heading] of [
    ["beforeInfo", "活动说明", "完整应用活动说明"],
    ["afterClaimInfo", "奖励附言", "完整应用奖励附言"],
    ["afterEndInfo", "结束说明", "完整应用结束说明"],
  ] as const) {
    await expect(page.locator(`#activity-${id}-label`)).toHaveText(label);
    await expect(
      page
        .getByRole("region", { name: label, exact: true })
        .getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  }
  const editorView = page.getByRole("group", {
    name: "说明预览模式",
    exact: true,
  });
  await editorView
    .getByRole("button", { name: "Markdown", exact: true })
    .click();
  await expect(page.locator("#activity-beforeInfo")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "完整应用奖励附言", exact: true }),
  ).toBeVisible();
  await editorView.getByRole("button", { name: "原文", exact: true }).click();
  await expect(page.locator("#activity-afterClaimInfo")).toHaveValue(
    afterClaimInfo,
  );
  await expect(
    page.getByRole("heading", { name: "完整应用奖励附言", exact: true }),
  ).toHaveCount(0);
  await editorView.getByRole("button", { name: "分栏", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "完整应用奖励附言", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: settings.openAfter ? "保存并开放" : "保存草稿",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/my\/activities\/[0-9a-f-]{36}(?:\?|$)/);
  const id = new URL(page.url()).pathname.split("/").at(-1);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  if (settings.timedDraw)
    await expect(
      page.getByRole("heading", { name: "编辑活动", exact: true }),
    ).toBeVisible();
  else
    await expect(
      page.getByText(settings.openAfter ? "进行中" : "准备中", { exact: true }),
    ).toBeVisible();
  return id as string;
}

async function submit(page: Page, password: string) {
  const onActivityPage = new URL(page.url()).pathname.startsWith(
    "/activities/",
  );
  await page
    .getByLabel(onActivityPage ? "兑换口令" : "口令", { exact: true })
    .fill(password);
  await page
    .getByRole("button", {
      name: onActivityPage ? /^(领取奖励|领取红包|报名)$/ : "兑奖",
    })
    .click();
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

async function expectLdcRewardVisible(page: Page) {
  await expect(page.locator(".envelope-svg .prize")).toHaveText("+0.10 LDC");
}

async function expectPrivateRewardHidden(page: Page) {
  await expect(
    page.getByRole("region", { name: "奖励附言", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".envelope-svg .prize")).toHaveCount(0);
}

const beforeInfo = "## 完整应用活动说明\n\n公开说明。";
const afterClaimInfo = "## 完整应用奖励附言\n\n私有说明应在兑奖后解锁。";
const afterEndInfo = "## 完整应用结束说明\n\n活动结束后才公开。";

async function readApi<T>(
  request: APIRequestContext,
  path: string,
): Promise<T> {
  const response = await request.get(path);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  return response.json() as Promise<T>;
}

async function waitForAttemptAllowance(request: APIRequestContext) {
  await expect
    .poll(
      async () => {
        const { attemptCooldown } = await readApi<Session>(
          request,
          "/api/session",
        );
        return (
          !attemptCooldown ||
          attemptCooldown.nextAllowedAt <= attemptCooldown.serverTime
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

type ParticipantRole = "recipient" | "recipient2" | "recipient3";
type DrawActor = {
  role: "author" | ParticipantRole;
  context: BrowserContext;
  page: Page;
  session: Session;
  externalRequests: string[];
};

async function waitForMerchantReady(
  context: BrowserContext,
  merchantId: string,
) {
  await expect
    .poll(
      async () => {
        const response = await context.request.get(
          `/api/me/merchants/${merchantId}`,
        );
        if (response.status() !== 200)
          return { status: response.status(), verified: null, allowed: null };
        const merchant = (await response.json()).merchant;
        return {
          status: response.status(),
          verified: merchant.credentialVerification.status,
          allowed: merchant.publicationEligibility.allowed,
        };
      },
      { timeout: 30_000, intervals: [100, 250, 500, 1_000] },
    )
    .toEqual({ status: 200, verified: "passed", allowed: true });
}

async function ensureFullAppMerchant(page: Page) {
  const session = await readApi<Session>(
    page.context().request,
    "/api/session",
  );
  return (await fullAppMerchant(page.context(), session.csrfToken)).id;
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
  const history = await readApi<ParticipationList>(
    actor.context.request,
    "/api/me/participations?status=all",
  );
  const participation = history.items.filter(
    (item) =>
      (item.kind === "registration" ? item.registration : item.claim).activity
        .id === id,
  );
  expect(participation).toHaveLength(1);
  expect(participation[0]).toMatchObject({
    kind: "registration",
    registration: { status },
  });
  const entry = participation[0];
  if (entry?.kind !== "registration")
    throw new Error("FULL_APP_REGISTRATION_HISTORY_MISSING");
  const summary = await readApi<AccountHistorySummary>(
    actor.context.request,
    "/api/me/history-summary",
  );
  expect(summary.participatedCount).toBe(history.total);
  expect(history.statusCounts?.all).toBe(summary.participatedCount);
  const password = entry.registration.sourcePassword;
  expect(password).toEqual(expect.any(String));
  if (typeof password !== "string")
    throw new Error("FULL_APP_REGISTRATION_PASSWORD_MISSING");
  await actor.page.goto("/my/claims");
  await expect(
    actor.page.getByRole("heading", { name: "活动历史", exact: true }),
  ).toBeVisible();
  const card = actor.page.getByRole("row").filter({ hasText: title });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(
    status === "registered" ? "已报名" : status === "won" ? "已中奖" : "未中奖",
  );
  await expect(card).toContainText(password);
  await expect(card.getByRole("link", { name: /查看活动/ })).toHaveAttribute(
    "href",
    /\/activities\/[0-9a-f-]{36}/,
  );
  await actor.page.reload();
  await expect(
    actor.page.getByRole("row").filter({ hasText: title }),
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
  expect((await request.get("/api/me/history-summary")).status()).toBe(401);
  expect((await request.get("/api/me/payment-activities")).status()).toBe(401);
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
  await signOut(page);
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

test("真实 D1／ActivityDO LDC创建、开放、兑奖、记录与权限", async ({
  browser,
  request,
}) => {
  const author = await browser.newContext({ baseURL: origin });
  const recipient = await browser.newContext({ baseURL: origin });
  const visitor = await browser.newContext({ baseURL: origin });
  const secondRecipient = await browser.newContext({ baseURL: origin });
  const externalRequests = await Promise.all(
    [author, recipient, visitor, secondRecipient].map(
      guardExternalBrowserRequests,
    ),
  );
  try {
    const authorPage = await author.newPage();
    const recipientPage = await recipient.newPage();
    const authorLogin = await signIn(authorPage, "author");
    const recipientLogin = await signIn(recipientPage, "recipient");
    const authorHistoryBefore = await readApi<AccountHistorySummary>(
      author.request,
      "/api/me/history-summary",
    );
    const recipientHistoryBefore = await readApi<AccountHistorySummary>(
      recipient.request,
      "/api/me/history-summary",
    );
    const id = await createActivity(authorPage, {
      title: "完整应用 LDC 闭环",
      password: "FullClaim123",
      count: 2,
      extraPassword: "OtherAnswer123",
    });
    expect(
      await readApi<AccountHistorySummary>(
        author.request,
        "/api/me/history-summary",
      ),
    ).toEqual({
      initiatedCount: authorHistoryBefore.initiatedCount + 1,
      participatedCount: authorHistoryBefore.participatedCount,
    });
    const initiated = await readApi<ActivityList>(
      author.request,
      "/api/me/activities?status=all",
    );
    expect(initiated.total).toBe(authorHistoryBefore.initiatedCount + 1);
    expect(initiated.statusCounts?.all).toBe(initiated.total);
    expect(initiated.items.find((item) => item.id === id)?.status).toBe(
      "draft",
    );
    await assertDenied(visitor, `/api/activities/${id}`, 404);
    await assertDenied(recipient, `/api/activities/${id}`, 404);
    await assertDenied(recipient, `/api/me/activities/${id}`, 404);
    const openButton = authorPage.getByRole("button", {
      name: /^保存(?:并开放|修改)(?:，|$)/u,
    });
    await openButton.click();
    await expect(openButton).toContainText("已开放");
    const publicResponse = await visitor.request.get(`/api/activities/${id}`);
    const publicActivity = (await publicResponse.json()).activity;
    expect(publicActivity.status).toBe("active");
    expect(publicActivity.quantity).toEqual({
      mode: "exact",
      total: 2,
      claimed: 0,
      remaining: 2,
    });
    expect(JSON.stringify(publicActivity)).not.toContain("FullClaim123");
    expect(JSON.stringify(publicActivity)).not.toContain(
      "私有说明应在兑奖后解锁",
    );
    expect(JSON.stringify(publicActivity)).not.toContain(accounts.author.email);
    expect(publicActivity.author.avatarUrl).toBe(accounts.author.avatarUrl);
    expect(publicActivity).not.toHaveProperty("afterClaimInfo");
    expect(publicActivity).not.toHaveProperty("afterEndInfo");
    expect(publicActivity.beforeInfo).toBe(beforeInfo);
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
    const wrongPasswordButton = recipientPage.getByRole("button", {
      name: /^(领取奖励|领取红包|报名|还需等待 \d+ 秒)，口令不正确$/u,
    });
    await expect(wrongPasswordButton).toContainText("口令不正确");
    await expect(wrongPasswordButton).toHaveAttribute(
      "title",
      "口令不正确，请重新尝试。",
    );
    await submit(recipientPage, "  FullClaim123  ");
    await expectLdcRewardVisible(recipientPage);
    await expect(
      recipientPage.getByRole("heading", { name: "完整应用奖励附言" }),
    ).toBeVisible();
    const rewardNote = recipientPage.getByRole("region", {
      name: "奖励附言",
      exact: true,
    });
    const activityNote = recipientPage.getByRole("region", {
      name: "活动说明",
      exact: true,
    });
    await expect(rewardNote.locator("summary")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(activityNote.locator("summary")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(
      activityNote.getByRole("heading", {
        name: "完整应用活动说明",
        exact: true,
      }),
    ).toHaveCount(0);
    await activityNote.locator("summary").click();
    await expect(
      activityNote.getByRole("heading", {
        name: "完整应用活动说明",
        exact: true,
      }),
    ).toBeVisible();
    await expect(recipientPage.locator("main b")).toHaveCount(0);
    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.submissionId).not.toBe(submissions[1]?.submissionId);
    const claimResponse = await recipient.request.get(
      `/api/activities/${id}/claim`,
    );
    expect(claimResponse.headers()["cache-control"]).toBe("no-store");
    const claim = (await claimResponse.json()).claim;
    expect(claim).toMatchObject({ rewardType: "ldc", amount: "0.10" });
    expect(claim.afterClaimInfo).toBe(afterClaimInfo);
    const recipientHistory = await readApi<ParticipationList>(
      recipient.request,
      "/api/me/participations?status=all",
    );
    const claimHistory = recipientHistory.items.filter(
      (item) => item.kind === "claim" && item.claim.activity.id === id,
    );
    expect(claimHistory).toHaveLength(1);
    expect(claimHistory[0]).toMatchObject({
      kind: "claim",
      claim: { id: claim.id, sourcePassword: "FullClaim123" },
    });
    expect(JSON.stringify(claimHistory)).not.toContain(
      "私有说明应在兑奖后解锁",
    );
    expect(JSON.stringify(claimHistory)).not.toContain("afterClaimInfo");
    const recipientSummary = await readApi<AccountHistorySummary>(
      recipient.request,
      "/api/me/history-summary",
    );
    expect(recipientSummary).toEqual({
      initiatedCount: recipientHistoryBefore.initiatedCount,
      participatedCount: recipientHistoryBefore.participatedCount + 1,
    });
    expect(recipientHistory.total).toBe(recipientSummary.participatedCount);
    expect(recipientHistory.statusCounts?.all).toBe(recipientHistory.total);
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
    await expect
      .poll(
        async () =>
          (
            await readApi<{ claim: { payment: { status: string } } }>(
              recipient.request,
              `/api/activities/${id}/claim`,
            )
          ).claim.payment.status,
        { timeout: 45_000, intervals: [100, 250, 500, 1_000] },
      )
      .toBe("confirmed");
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
        { text: "FullClaim123", isClaimPassword: true, isSolved: false },
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
    await waitForAttemptAllowance(recipient.request);
    const solved = await recipient.request.post(
      `/api/activities/${id}/password-solves`,
      { headers: solveHeaders, data: solveInput },
    );
    expect(solved.status()).toBe(200);
    expect(await solved.json()).toMatchObject({ outcome: "solved" });
    const replaySolved = await recipient.request.post(
      `/api/activities/${id}/password-solves`,
      { headers: solveHeaders, data: solveInput },
    );
    expect(await replaySolved.json()).toMatchObject({ outcome: "solved" });
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
      recipientPage.getByText("已用此口令兑换", { exact: true }),
    ).toBeVisible();
    await expect(
      recipientPage.getByText("已解出", { exact: true }),
    ).toBeVisible();
    const afterSolve = await readState(request);
    expect(afterSolve.claims).toEqual(state.claims);
    expect(afterSolve.payments).toEqual(state.payments);
    expect(afterSolve.outbox).toEqual(state.outbox);
    expect(
      afterSolve.attempts.find((value) => value.activity_id === id)?.count,
    ).toBe(3);
    // A second recipient exhausts the pool; authors cannot receive their own LDC.
    const secondLogin = await signIn(
      await secondRecipient.newPage(),
      "recipient2",
    );
    const finalClaim = await secondRecipient.request.post(
      `/api/activities/${id}/claim`,
      {
        headers: {
          Origin: origin,
          "X-CSRF-Token": secondLogin.session.csrfToken,
        },
        data: { submissionId: crypto.randomUUID(), password: "OtherAnswer123" },
      },
    );
    expect(finalClaim.status()).toBe(200);
    const authorSummary = await readApi<AccountHistorySummary>(
      author.request,
      "/api/me/history-summary",
    );
    expect(authorSummary).toEqual({
      initiatedCount: authorHistoryBefore.initiatedCount + 1,
      participatedCount: authorHistoryBefore.participatedCount,
    });
    const endedActivity = await readApi<{ activity: Record<string, unknown> }>(
      visitor.request,
      `/api/activities/${id}`,
    );
    expect(endedActivity.activity.status).toBe("ended");
    expect(endedActivity.activity.afterEndInfo).toBe(afterEndInfo);
    expect(endedActivity.activity).not.toHaveProperty("afterClaimInfo");
    const visitorPage = await visitor.newPage();
    await visitorPage.goto(`/activities/${id}`);
    await expect(
      visitorPage
        .getByRole("region", { name: "结束说明", exact: true })
        .getByRole("heading", { name: "完整应用结束说明", exact: true }),
    ).toBeVisible();
    await expect(
      visitorPage.getByRole("region", { name: "奖励附言", exact: true }),
    ).toHaveCount(0);
    const endedAnswers = await visitor.request.get(
      `/api/activities/${id}/passwords`,
    );
    expect(await endedAnswers.json()).toEqual({
      passwords: [
        { text: "FullClaim123", isClaimPassword: false, isSolved: false },
        { text: "OtherAnswer123", isClaimPassword: false, isSolved: false },
      ],
      hiddenCount: 0,
      canSolve: false,
    });

    await recipientPage.goto("/my/claims");
    const card = recipientPage
      .getByRole("row")
      .filter({ hasText: "完整应用 LDC 闭环" });
    await expect(recipientPage.getByRole("table")).toBeVisible();
    await expect(card).toContainText("FullClaim123");
    await expect(card.getByRole("button", { name: /查看奖励/ })).toHaveCount(0);
    const viewActivity = card.getByRole("link", { name: /查看活动/ });
    await expect(viewActivity).toHaveAttribute("href", `/activities/${id}`);
    await viewActivity.click();
    await expect(recipientPage).toHaveURL(`${origin}/activities/${id}`);
    await expectLdcRewardVisible(recipientPage);
    await recipientPage
      .getByRole("button", { name: "返回上一页", exact: true })
      .click();
    await expect(recipientPage).toHaveURL(/\/my\/claims(?:\?|$)/);
    await expect(card).toContainText("FullClaim123");
    await recipientPage.goto(`/my/claims/${claim.id}`);
    await expect(recipientPage).toHaveURL(`${origin}/activities/${id}`);
    await recipientPage.reload();
    await expectLdcRewardVisible(recipientPage);
    await signOut(recipientPage);
    await expectPrivateRewardHidden(recipientPage);
    const relogin = await signIn(
      recipientPage,
      "recipient",
      `/my/claims/${claim.id}`,
    );
    expect(relogin.session.user.id).toBe(recipientLogin.session.user.id);
    await expectLdcRewardVisible(recipientPage);
    await recipientPage.setViewportSize({ width: 375, height: 844 });
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
      secondRecipient.close(),
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
      .getByLabel("Client ID", { exact: true })
      .fill("hb_full_app_merchant");
    await authorPage
      .getByLabel("商户密钥", { exact: true })
      .fill("full-app-merchant-secret");
    await authorPage
      .getByRole("button", { name: /^保存配置(?:，|$)/u })
      .click();
    await expect(authorPage).toHaveURL(
      (url) =>
        url.pathname === "/my/merchants" && !url.searchParams.has("dialog"),
    );
    const merchantIdResponse = await author.request.get("/api/me/merchants");
    expect(merchantIdResponse.status()).toBe(200);
    const merchantId = ((await merchantIdResponse.json()).currentMerchantId ??
      "") as string;
    expect(merchantId).toMatch(/^[0-9a-f-]{36}$/);
    await waitForMerchantReady(author, merchantId);
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
    const paymentActivitiesBefore = await readApi<ActivityPaymentList>(
      author.request,
      "/api/me/payment-activities?status=all",
    );
    const id = await createActivity(authorPage, {
      title: "完整应用真实模式普通活动",
      password: "LdcAnswer123",
      openAfter: true,
    });
    const zeroTargetId = await createActivity(authorPage, {
      title: "完整应用尚无发放目标",
      password: "ZeroTarget123",
      openAfter: true,
    });
    const draftId = await createActivity(authorPage, {
      title: "完整应用付款列表排除草稿",
      password: "DraftTarget123",
    });
    const paymentActivities = await readApi<ActivityPaymentList>(
      author.request,
      "/api/me/payment-activities?status=all",
    );
    expect(paymentActivities.total).toBe(paymentActivitiesBefore.total + 2);
    expect(paymentActivities.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, merchantId, status: "active" }),
        expect.objectContaining({
          id: zeroTargetId,
          merchantId,
          status: "active",
        }),
      ]),
    );
    expect(
      paymentActivities.items.some((activity) => activity.id === draftId),
    ).toBe(false);
    for (const activity of paymentActivities.items) {
      expect(activity.rewardType).toBe("ldc");
      expect(activity.status).not.toBe("draft");
      expect(activity).not.toHaveProperty("summary");
    }
    const zeroTargets = await readApi<ActivityPaymentTargetList>(
      author.request,
      `/api/me/activities/${zeroTargetId}/payments?status=all`,
    );
    expect(zeroTargets).toEqual({
      activityId: zeroTargetId,
      merchantId,
      items: [],
      total: 0,
      nextCursor: null,
      summary: {
        pendingAmount: "0.00",
        confirmedAmount: "0.00",
        totalAmount: "0.00",
        pendingCount: 0,
        confirmedCount: 0,
        totalCount: 0,
      },
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
    const paymentBaseline = (await readState(request)).upstream;
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
    await expect(recipientPage.locator(".envelope-svg .prize")).toHaveText(
      "+0.10 LDC",
    );
    await expect(
      recipientPage.getByRole("heading", { name: "完整应用奖励附言" }),
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
      recipientPage.getByRole("button", {
        name: "已发放说明",
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
    expect(state.upstream.distributeRequests).toBe(
      paymentBaseline.distributeRequests + 1,
    );
    expect(state.upstream.orders).toHaveLength(
      paymentBaseline.orders.length + 1,
    );
    expect(state.upstream.orderQueries).toBeGreaterThan(
      paymentBaseline.orderQueries,
    );
    expect(state.upstream.blockedRequests).toBe(0);
    expect(
      state.upstream.orders.find(
        (order) => order.businessNo === task?.business_no,
      ),
    ).toMatchObject({
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
    expect((await readState(request)).upstream.distributeRequests).toBe(
      paymentBaseline.distributeRequests + 1,
    );
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
    const fullSummary = {
      pendingAmount: "0.00",
      confirmedAmount: "0.10",
      totalAmount: "0.10",
      pendingCount: 0,
      confirmedCount: 1,
      totalCount: 1,
    };
    const targets = await readApi<ActivityPaymentTargetList>(
      author.request,
      `/api/me/activities/${id}/payments?status=all`,
    );
    expect(targets).toMatchObject({
      activityId: id,
      merchantId,
      total: 1,
      nextCursor: null,
      summary: fullSummary,
    });
    expect(targets.items).toHaveLength(1);
    expect(targets.items[0]).toMatchObject({
      id: task?.id,
      claimId: claim.id,
      activityId: id,
      source: "claim",
      amount: "0.10",
      status: "confirmed",
      confirmedAt: paymentJson.payment.confirmedAt,
      recipientProfile: {
        username: accounts.recipient.username,
        displayName: accounts.recipient.displayName,
        avatarUrl: accounts.recipient.avatarUrl,
      },
    });
    expect(JSON.stringify(targets)).not.toContain(accounts.recipient.email);
    const pendingTargets = await readApi<ActivityPaymentTargetList>(
      author.request,
      `/api/me/activities/${id}/payments?status=pending`,
    );
    expect(pendingTargets.items).toEqual([]);
    expect(pendingTargets.total).toBe(0);
    expect(pendingTargets.summary).toEqual(fullSummary);
    const confirmedTargets = await readApi<ActivityPaymentTargetList>(
      author.request,
      `/api/me/activities/${id}/payments?status=confirmed`,
    );
    expect(confirmedTargets.items).toEqual(targets.items);
    expect(confirmedTargets.summary).toEqual(fullSummary);
    await assertDenied(recipient, `/api/me/activities/${id}/payments`, 404);
    await assertDenied(
      recipient,
      `/api/me/activities/${zeroTargetId}/payments`,
      404,
    );
    expect(
      (await request.get(`/api/me/activities/${id}/payments`)).status(),
    ).toBe(401);
    const afterPaymentQueries = await readState(request);
    expect(afterPaymentQueries.payments).toEqual(state.payments);
    expect(afterPaymentQueries.outbox).toEqual(state.outbox);
    expect(afterPaymentQueries.upstream.orders).toEqual(state.upstream.orders);
    expect(afterPaymentQueries.upstream.distributeRequests).toBe(
      paymentBaseline.distributeRequests + 1,
    );
    await authorPage.goto(`/my/payments?activityId=${id}`);
    await expect(
      authorPage.getByRole("heading", { name: "付款记录", exact: true }),
    ).toBeVisible();
    const activityColumn = authorPage.getByRole("region", {
      name: "红包活动",
      exact: true,
    });
    const targetColumn = authorPage.getByRole("region", {
      name: "发放目标",
      exact: true,
    });
    const detailColumn = authorPage.getByRole("complementary", {
      name: "付款详情",
      exact: true,
    });
    await expect(activityColumn).toBeVisible();
    await expect(targetColumn).toBeVisible();
    await expect(detailColumn).toBeVisible();
    await expect(activityColumn.getByText(/待完成金额|已发放金额/)).toHaveCount(
      0,
    );
    await expect(targetColumn.getByText(/^已发放金额/)).toBeVisible();
    await expect(
      targetColumn.getByText("0.10 LDC", { exact: true }),
    ).toBeVisible();
    await expect(detailColumn).toContainText(
      task?.business_no ?? "FULL_APP_TASK_MISSING",
    );
    await expect(detailColumn).toContainText(
      task?.external_order_id ?? "FULL_APP_ORDER_MISSING",
    );
    const paymentStatus = targetColumn.getByRole("tablist", {
      name: "发放目标状态筛选",
      exact: true,
    });
    await paymentStatus
      .getByRole("tab", { name: "待完成", exact: true })
      .click();
    await expect(
      targetColumn.getByText("当前活动暂无发放目标。", { exact: true }),
    ).toBeVisible();
    await expect(targetColumn.getByText(/^已发放金额/)).toBeVisible();
    await expect(
      targetColumn.getByText("0.10 LDC", { exact: true }),
    ).toBeVisible();
    await activityColumn
      .getByRole("button", { name: /完整应用尚无发放目标/ })
      .click();
    await expect(
      targetColumn.getByText("当前活动暂无发放目标。", { exact: true }),
    ).toBeVisible();
    await expect(targetColumn.getByText(/^已发放金额/)).toBeVisible();
    await expect(
      targetColumn.getByText("0.00 LDC", { exact: true }),
    ).toHaveCount(2);
    await activityColumn
      .getByRole("button", { name: /完整应用真实模式普通活动/ })
      .click();
    const recipientTarget = targetColumn.getByRole("button", {
      name: new RegExp(accounts.recipient.displayName),
    });
    await expect(recipientTarget).toContainText(/0\.10\s*LDC/);
    await authorPage.setViewportSize({ width: 900, height: 844 });
    await expect(detailColumn).toHaveCount(0);
    await recipientTarget.click();
    const paymentDialog = authorPage.getByRole("dialog", {
      name: "付款详情",
      exact: true,
    });
    await expect(paymentDialog).toContainText(
      task?.business_no ?? "FULL_APP_TASK_MISSING",
    );
    const processingSource = authorPage.url();
    await paymentDialog
      .getByRole("link", { name: "查看处理详情", exact: true })
      .click();
    await expect(authorPage).toHaveURL(processingSource);
    await expect(authorPage.getByRole("dialog")).toHaveCount(1);
    await expect(
      paymentDialog.getByRole("table", { name: "付款处理记录", exact: true }),
    ).toBeVisible();
    await authorPage.goBack();
    await expect(paymentDialog).toContainText(
      task?.business_no ?? "FULL_APP_TASK_MISSING",
    );
    await expect(
      paymentDialog.getByRole("link", { name: "查看处理详情", exact: true }),
    ).toBeFocused();
    await authorPage.goForward();
    await expect(authorPage.getByRole("dialog")).toHaveCount(1);
    await expect(
      paymentDialog.getByRole("table", { name: "付款处理记录", exact: true }),
    ).toBeVisible();
    await paymentDialog
      .getByRole("button", { name: "返回付款摘要", exact: true })
      .click();
    await paymentDialog
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await expect(paymentDialog).toHaveCount(0);
    await authorPage.setViewportSize({ width: 390, height: 844 });
    // Resizing alone does not manufacture a mobile history step.
    await authorPage.goto("/my/payments");
    await activityColumn
      .getByRole("button", { name: /完整应用真实模式普通活动/ })
      .click();
    await targetColumn
      .getByRole("button", { name: "返回上一页", exact: true })
      .click();
    await expect(activityColumn).toBeVisible();
    await expect(targetColumn).not.toBeVisible();
    await activityColumn
      .getByRole("button", { name: /完整应用尚无发放目标/ })
      .click();
    await expect(activityColumn).not.toBeVisible();
    await expect(
      targetColumn.getByText("当前活动暂无发放目标。", { exact: true }),
    ).toBeVisible();
    await targetColumn
      .getByRole("button", { name: "返回上一页", exact: true })
      .click();
    await activityColumn
      .getByRole("button", { name: /完整应用真实模式普通活动/ })
      .click();
    await recipientTarget.click();
    await expect(paymentDialog).toContainText(/0\.10\s*LDC/);
    await paymentDialog
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    expect(
      await authorPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await authorPage.setViewportSize({ width: 1280, height: 720 });
    await authorPage.goto(`/my/merchants/${merchantId}/payments/${task?.id}`);
    await expect(authorPage).toHaveURL(
      (url) =>
        url.pathname === "/my/merchants" &&
        url.searchParams.get("merchantId") === merchantId &&
        url.searchParams.get("dialog") === "payment" &&
        url.searchParams.get("taskId") === task?.id,
    );
    const processingDialog = authorPage.getByRole("dialog", {
      name: "付款详情",
      exact: true,
    });
    await expect(
      processingDialog.getByRole("heading", { name: "付款详情", exact: true }),
    ).toBeVisible();
    await expect(
      processingDialog
        .getByText(accounts.recipient.displayName, { exact: true })
        .first(),
    ).toBeVisible();
    await expect(
      processingDialog.getByText("0.10 LDC", { exact: true }),
    ).toBeVisible();
    await expect(
      processingDialog.getByRole("table", {
        name: "付款处理记录",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      processingDialog.getByRole("list", { name: "付款时间线", exact: true }),
    ).toBeVisible();
    await expect(
      processingDialog.getByText(/付款凭证版本|身份更正版本|立即检查恢复条件/),
    ).toHaveCount(0);
    expect(paymentJson.payment.recoveryPolicy).toBe("claim_same_order_v1");
    expect(paymentJson.payment.firstSendAt).toEqual(expect.any(String));
    expect(paymentJson.payment.confirmedAt).toEqual(expect.any(String));
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
      first.page.getByText("报名已确认，等待开奖。", { exact: true }),
    ).toBeVisible();
    await expect(
      first.page.getByText("已用此口令报名", { exact: true }),
    ).toBeVisible();
    const publicRegistrations = await readApi<PublicRegistrationList>(
      request,
      `/api/activities/${id}/registrations`,
    );
    expect(publicRegistrations).toEqual({
      enabled: true,
      items: [
        {
          id: registered.registration.id,
          username: accounts.recipient.username,
          displayName: accounts.recipient.displayName,
          avatarUrl: accounts.recipient.avatarUrl,
          registeredAt: registered.registration.registeredAt,
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(publicRegistrations)).not.toContain(
      accounts.recipient.email,
    );
    expect(JSON.stringify(publicRegistrations)).not.toContain("DrawAnswer123");
    expect(JSON.stringify(publicRegistrations)).not.toContain("DrawOther123");
    const unpublishedRecipients = await readApi<PublicRecipientList>(
      request,
      `/api/activities/${id}/recipients`,
    );
    expect(unpublishedRecipients).toEqual({
      enabled: true,
      items: [],
      nextCursor: null,
      titles: { highestClaimIds: [], lowestClaimIds: [] },
    });
    const [rosterResponse] = await Promise.all([
      first.page.waitForResponse(
        (response) =>
          response.url() === `${origin}/api/activities/${id}/registrations`,
      ),
      first.page
        .getByRole("button", { name: "查看报名名单", exact: true })
        .first()
        .click(),
    ]);
    expect(rosterResponse.status()).toBe(200);
    expect(await rosterResponse.json()).toEqual(publicRegistrations);
    const roster = first.page.getByRole("dialog", { name: title, exact: true });
    await expect(
      roster.getByRole("tab", { name: "报名名单", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      roster.getByText(accounts.recipient.displayName, { exact: true }),
    ).toBeVisible();
    const [winnerRosterResponse] = await Promise.all([
      first.page.waitForResponse(
        (response) =>
          response.url() === `${origin}/api/activities/${id}/recipients`,
      ),
      roster.getByRole("tab", { name: "中奖名单", exact: true }).click(),
    ]);
    expect(winnerRosterResponse.status()).toBe(200);
    expect(await winnerRosterResponse.json()).toEqual(unpublishedRecipients);
    await expect(
      roster.getByText("暂无领取记录。", { exact: true }),
    ).toBeVisible();
    await first.page.keyboard.press("Escape");
    if ((await roster.count()) > 0) await first.page.keyboard.press("Escape");
    await expect(roster).toHaveCount(0);
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
      first.page.getByRole("button", { name: "验证口令", exact: true }).click(),
    ]);
    expect(solved.status()).toBe(200);
    expect(await solved.json()).toMatchObject({ outcome: "solved" });
    const solveSubmission = solved.request().postDataJSON();
    await expect(
      first.page
        .locator(".password-display-list")
        .getByText("DrawOther123", { exact: true }),
    ).toBeVisible();
    await expect(first.page.getByText("已解出", { exact: true })).toBeVisible();
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
    expect(await replaySolve.json()).toMatchObject({ outcome: "solved" });
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
    await signOut(first.page);
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
      first.page
        .locator(".password-display-list")
        .getByText("DrawOther123", { exact: true }),
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
    const completeRegistrations = await readApi<PublicRegistrationList>(
      request,
      `/api/activities/${id}/registrations`,
    );
    expect(completeRegistrations.enabled).toBe(true);
    expect(completeRegistrations.items).toHaveLength(3);
    expect(
      new Set(completeRegistrations.items.map((entry) => entry.id)).size,
    ).toBe(3);
    expect(
      completeRegistrations.items.find(
        (entry) => entry.id === registered.registration.id,
      ),
    ).toMatchObject({
      username: accounts.recipientRenamed.username,
      displayName: accounts.recipientRenamed.displayName,
      registeredAt: registered.registration.registeredAt,
    });
    for (const entry of completeRegistrations.items) {
      expect(Object.keys(entry).sort()).toEqual([
        "avatarUrl",
        "displayName",
        "id",
        "registeredAt",
        "username",
      ]);
    }
    const publishedRecipients = await readApi<PublicRecipientList>(
      request,
      `/api/activities/${id}/recipients`,
    );
    expect(publishedRecipients.items).toHaveLength(2);
    const amountOrder = [...publishedRecipients.items].sort(
      (left, right) => Number(left.amount) - Number(right.amount),
    );
    if (amountOrder[0]?.amount === amountOrder[1]?.amount) {
      expect(publishedRecipients.titles).toEqual({
        highestClaimIds: [],
        lowestClaimIds: [],
      });
      for (const entry of publishedRecipients.items)
        expect(entry).not.toHaveProperty("title");
    } else {
      expect(publishedRecipients.titles).toEqual({
        highestClaimIds: [amountOrder[1]?.id],
        lowestClaimIds: [amountOrder[0]?.id],
      });
      expect(amountOrder[0]?.title).toBe("lowest");
      expect(amountOrder[1]?.title).toBe("highest");
    }
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
      const card = actor.page.getByRole("row").filter({ hasText: title });
      await expect(card.getByRole("button", { name: /查看奖励/ })).toHaveCount(
        0,
      );
      const viewActivity = card.getByRole("link", { name: /查看活动/ });
      await expect(viewActivity).toHaveAttribute("href", `/activities/${id}`);
      const popupPromise = actor.page.waitForEvent("popup", {
        timeout: 1_000,
      });
      await viewActivity.click();
      const activityPage = await popupPromise.catch(() => null);
      const resultPage = activityPage ?? actor.page;
      await expect(resultPage).toHaveURL(`${origin}/activities/${id}`);
      if (result.status === "won") {
        expect(result.claim?.rewardType).toBe("ldc");
        await expect(
          resultPage.getByRole("button", {
            name: "已发放说明",
            exact: true,
          }),
        ).toBeVisible();
        await resultPage.reload();
        await expect(
          resultPage.getByRole("heading", { name: "完整应用奖励附言" }),
        ).toBeVisible();
        if (activityPage) {
          await activityPage.close();
          await expect(actor.page).toHaveURL(/\/my\/claims(?:\?|$)/);
        } else {
          await actor.page.goBack();
          await expect(actor.page).toHaveURL(/\/my\/claims(?:\?|$)/);
        }
      } else {
        expect(result.claim).toBeNull();
        await expect(
          resultPage.getByText("未中奖", { exact: true }),
        ).toBeVisible();
        await expect(
          resultPage.getByRole("heading", { name: "完整应用奖励附言" }),
        ).toHaveCount(0);
        await resultPage.reload();
        await expect(
          resultPage.getByText("未中奖", { exact: true }),
        ).toBeVisible();
        if (activityPage) {
          await activityPage.close();
          await expect(actor.page).toHaveURL(/\/my\/claims(?:\?|$)/);
        } else {
          await actor.page.goBack();
          await expect(actor.page).toHaveURL(/\/my\/claims(?:\?|$)/);
        }
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
        password: "CappedDraw123",
        timedDraw: money,
        openAfter: true,
      });
      const before = await readState(request);
      await registerForDraw(first, id, "CappedDraw123");
      assertDrawWaiting(await readState(request), before, id, 1);
      if (scenario.label === "M=N") {
        const originalId = first.session.user.id;
        await signOut(first.page);
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

for (const timeMode of ["duration", "at"] as const) {
  test(`无人报名的${timeMode === "at" ? "指定时间" : "倒计时"}开奖进入 empty，保持零领取与零付款`, async ({
    browser,
    request,
  }) => {
    test.setTimeout(90_000);
    const fixture = await createDrawActors(browser, []);
    try {
      const id = await createActivity(fixture.author.page, {
        title: "完整应用无人报名定时抽奖",
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
        openAfter: timeMode === "duration",
      });
      if (timeMode === "at") {
        const api = fixture.author.context.request;
        const headers = {
          Origin: origin,
          "X-CSRF-Token": fixture.author.session.csrfToken,
        };
        const read = await api.get(`/api/me/activities/${id}`);
        expect(read.ok()).toBe(true);
        const saved = (await read.json()).activity as ManagedActivity;
        if (
          saved.config.rewardType !== "ldc" ||
          saved.config.money.mode !== "timed_draw"
        )
          throw new Error("Expected timed draft");
        const { countdownSeconds: _seconds, ...money } = saved.config.money;
        const at = new Date(Date.now() + 4_000).toISOString();
        const edited = await api.patch(`/api/me/activities/${id}`, {
          headers,
          data: {
            version: saved.version,
            activity: { ...saved.config, money, deadline: { mode: "at", at } },
          },
        });
        expect(edited.ok(), await edited.text()).toBe(true);
        const updated = (await edited.json()).activity as ManagedActivity;
        const opened = await api.post(`/api/me/activities/${id}/open`, {
          headers,
          data: { version: updated.version },
        });
        expect(opened.ok(), await opened.text()).toBe(true);
        expect((await opened.json()).activity.deadlineAt).toBe(at);
      }
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
}

test("真实应用商户配置：修改前确认未开奖风险，同一商户切换身份并保留已付任务", async ({
  browser,
  request,
}) => {
  const fixture = await createDrawActors(browser, []);
  try {
    const merchantId = await ensureFullAppMerchant(fixture.author.page);
    await createActivity(fixture.author.page, {
      title: "配置影响范围验收",
      password: "Configuration123",
      timedDraw: {
        mode: "timed_draw",
        algorithm: "double_mean_v1",
        totalAmount: "0.02",
        count: 2,
        participantLimit: null,
        countdownSeconds: 600,
        distributeFullPool: true,
      },
      openAfter: true,
    });
    const before = await readState(request);
    const page = fixture.author.page;
    await page.goto(`/my/merchants?merchantId=${merchantId}`);
    const save = page.getByRole("button", { name: /^保存配置(?:，|$)/u });
    await expect(save).toBeDisabled();
    await page
      .locator("#merchant-edit-client-id")
      .fill("full_app_corrected_identity");
    await page
      .locator("#merchant-edit-secret")
      .fill("full-app-corrected-virtual-secret");
    await expect(save).toBeEnabled();
    await save.click();
    const dialog = page.getByRole("dialog", { name: "谨慎更换商户配置" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("未完成开奖");
    await dialog.getByRole("button", { name: "返回修改" }).click();
    expect(
      (
        await (
          await fixture.author.context.request.get(
            `/api/me/merchants/${merchantId}`,
          )
        ).json()
      ).merchant.clientId,
    ).toBe("hb_full_app_merchant");
    await expect(page.locator("#merchant-edit-client-id")).toHaveValue(
      "full_app_corrected_identity",
    );
    await expect(page.locator("#merchant-edit-secret")).toHaveValue(
      "full-app-corrected-virtual-secret",
    );
    await save.click();
    await dialog.getByRole("button", { name: "确认更换" }).click();
    await expect(save).toContainText("已保存");
    await expect(page).toHaveURL(
      `${origin}/my/merchants?merchantId=${merchantId}`,
    );
    await expect(save).toBeDisabled();
    await expect(page.locator("#merchant-edit-secret")).toHaveValue("");
    const saved = await fixture.author.context.request.get(
      `/api/me/merchants/${merchantId}`,
    );
    const merchant = (await saved.json()).merchant;
    expect(merchant.clientId).toBe("full_app_corrected_identity");
    expect(merchant.id).toBe(merchantId);
    expect(saved.headers()["cache-control"]).toBe("no-store");
    expect(JSON.stringify(merchant)).not.toContain(
      "full-app-corrected-virtual-secret",
    );
    const after = await readState(request);
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

test("发布修复：原编辑请求丢失响应后恢复开放，真实历史持续挂载刷新", async ({
  browser,
  request,
}) => {
  const author = await browser.newContext({ baseURL: origin });
  const recipient = await browser.newContext({ baseURL: origin });
  const external = await Promise.all(
    [author, recipient].map(guardExternalBrowserRequests),
  );
  try {
    const authorPage = await author.newPage();
    const recipientPage = await recipient.newPage();
    await signIn(authorPage, "author");
    const { session } = await signIn(recipientPage, "recipient");
    const id = await createActivity(authorPage, {
      title: "发布修复草稿",
      password: "ReleaseSave123",
      durationMinutes: 7,
    });
    const saved = await readApi<{ activity: ManagedActivity }>(
      author.request,
      `/api/me/activities/${id}`,
    );
    expect(saved.activity.config.deadline).toEqual({
      mode: "duration",
      value: 7,
      unit: "minutes",
    });
    await authorPage.goto(`/my/activities/${id}?edit=true`);
    await authorPage.locator("#activity-title").fill("发布修复已保存");
    const requests: unknown[] = [];
    let drop = true;
    await authorPage.route(`**/api/me/activities/${id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      requests.push(route.request().postDataJSON());
      if (!drop) return route.continue();
      drop = false;
      // The real Worker commits the update; only its network response is lost.
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort("connectionreset");
    });
    await authorPage
      .getByRole("button", { name: /^保存并开放(?:，|$)/u })
      .click();
    await expect(
      authorPage.getByRole("button", { name: /^重试原提交(?:，|$)/u }),
    ).toBeVisible();
    const retryButton = authorPage.getByRole("button", {
      name: /^重试原提交(?:，|$)/u,
    });
    await retryButton.click();
    await expect(
      authorPage.getByRole("button", {
        name: /^保存(?:并开放|修改)，已开放$/u,
      }),
    ).toContainText("已开放");
    await expect(
      authorPage.getByRole("heading", { name: "编辑活动", exact: true }),
    ).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    const opened = await readApi<{ activity: ManagedActivity }>(
      author.request,
      `/api/me/activities/${id}`,
    );
    expect(opened.activity.status).toBe("active");
    expect(
      Date.parse(opened.activity.deadlineAt ?? "") -
        Date.parse(opened.activity.openedAt ?? ""),
    ).toBe(7 * 60_000);
    await authorPage.goto("/my/activities?type=all");
    const ownerRow = authorPage
      .getByRole("row")
      .filter({ hasText: "发布修复已保存" });
    await expect(
      ownerRow.getByRole("button", {
        name: "发布修复已保存：尝试统计",
        exact: true,
      }),
    ).toBeVisible();
    await recipientPage.goto("/my/claims?type=all");
    await expect(
      recipientPage.getByRole("heading", { name: "活动历史", exact: true }),
    ).toBeVisible();
    const listUpdate = authorPage.waitForResponse(
      async (response) => {
        if (!response.url().includes("/api/me/activities?") || !response.ok())
          return false;
        const body = (await response.json()) as ActivityList;
        return body.items.some(
          (activity) => activity.id === id && activity.claimedCount === 1,
        );
      },
      { timeout: 22_000 },
    );
    const claim = await recipient.request.post(`/api/activities/${id}/claim`, {
      headers: { Origin: origin, "X-CSRF-Token": session.csrfToken },
      data: { submissionId: crypto.randomUUID(), password: "ReleaseSave123" },
    });
    expect(claim.status()).toBe(200);
    await expect(
      recipientPage.getByRole("row").filter({ hasText: "发布修复已保存" }),
    ).toContainText("ReleaseSave123", { timeout: 22_000 });
    await listUpdate;
    await expect(authorPage).toHaveURL(/\/my\/activities$/);
    await ownerRow
      .getByRole("button", { name: "发布修复已保存：尝试统计", exact: true })
      .click();
    await expect(authorPage).toHaveURL(/\/my\/activities$/);
    const statisticsDialog = authorPage.getByRole("dialog", {
      name: "兑换尝试统计",
      exact: true,
    });
    await expect(
      statisticsDialog.getByRole("heading", {
        name: "兑换尝试统计",
        exact: true,
      }),
    ).toBeVisible();
    expect((await readState(request)).upstream.blockedRequests).toBe(0);
    expect(external.flat()).toEqual([]);
  } finally {
    await Promise.allSettled([author.close(), recipient.close()]);
  }
});

test("发布修复：正式首页先发现后导航，活动页自动兑奖且刷新不重领", async ({
  browser,
  request,
}) => {
  const author = await browser.newContext({ baseURL: origin });
  const recipient = await browser.newContext({ baseURL: origin });
  const external = await Promise.all(
    [author, recipient].map(guardExternalBrowserRequests),
  );
  try {
    const authorPage = await author.newPage();
    const page = await recipient.newPage();
    await signIn(authorPage, "author");
    await signIn(page, "recipient");
    const id = await createActivity(authorPage, {
      title: "发布修复导航兑奖",
      password: "ReleaseNav123",
      forceDedicated: false,
      openAfter: true,
    });
    await page.goto("/");
    const phases: string[] = [];
    page.on("request", (outgoing) => {
      if (outgoing.method() !== "POST") return;
      if (outgoing.url().endsWith("/api/redemptions/discover"))
        phases.push("discover");
      if (outgoing.url().endsWith(`/api/activities/${id}/claim`)) {
        expect(new URL(page.url()).pathname).toBe(`/activities/${id}`);
        phases.push("claim");
      }
    });
    await page.getByLabel("口令", { exact: true }).fill("ReleaseNav123");
    await page.getByRole("button", { name: "兑奖", exact: true }).click();
    await expect(page).toHaveURL(`/activities/${id}`);
    await expectLdcRewardVisible(page);
    expect(phases).toEqual(["discover", "claim"]);
    await page.reload();
    await expectLdcRewardVisible(page);
    expect(phases).toEqual(["discover", "claim"]);
    await page.getByRole("button", { name: "返回上一页", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/`);
    await page.goForward();
    await expectLdcRewardVisible(page);
    expect(phases).toEqual(["discover", "claim"]);
    const state = await readState(request);
    expect(
      state.claims.filter((claim) => claim.activity_id === id),
    ).toHaveLength(1);
    expect(state.upstream.blockedRequests).toBe(0);
    expect(external.flat()).toEqual([]);
  } finally {
    await Promise.allSettled([author.close(), recipient.close()]);
  }
});
