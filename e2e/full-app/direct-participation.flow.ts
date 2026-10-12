import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  emptyActivityInput,
  type LdcActivityInput,
  type ManagedActivity,
  type TextActivityInput,
} from "../../packages/contracts/src";

const origin = "http://127.0.0.1:4193";
const authorizer = /^https:\/\/connect\.linux\.do\/oauth2\/authorize\?/;

type Session = {
  user: {
    id: string;
    username: string;
    displayName: string;
    isAdmin?: boolean;
  };
  csrfToken: string;
};

type RuntimeState = {
  activities: Array<{
    id: string;
    claimed_count: number;
    registered_count: number;
    draw_state: "waiting" | "settling" | "completed" | "empty" | null;
  }>;
  claims: Array<{ id: string; activity_id: string; user_id: string }>;
  registrations: Array<{
    id: string;
    activity_id: string;
    user_id: string;
    password_id: string | null;
  }>;
  attempts: Array<{ activity_id: string; count: number }>;
  payments: Array<{ claim_id: string; amount_minor: number }>;
  outbox: Array<{ task_id: string; delivered_at: number | null }>;
  upstream: {
    blockedRequests: number;
    distributeRequests: number;
    orders: unknown[];
  };
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

async function signIn(
  page: Page,
  role:
    | "directAuthor"
    | "directDrawAuthor"
    | "recipient"
    | "recipient2"
    | "recipient3",
) {
  const context = page.context();
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
    return route.fulfill({ status: 302, headers: { Location: callback.href } });
  });
  const login = await context.request.get("/api/auth/login?returnTo=%2F", {
    maxRedirects: 0,
  });
  expect(login.status()).toBe(302);
  const location = login.headers().location;
  if (!location) throw new Error("登录未返回授权地址");
  await page.goto(location);
  await expect(
    page.getByRole("textbox", { name: "口令", exact: true }),
  ).toBeVisible();
  const session = await context.request.get("/api/session");
  expect(session.status()).toBe(200);
  const json = (await session.json()) as Session;
  expect(json.user.id).toBeTruthy();
  expect(json.csrfToken).toBeTruthy();
  return json;
}

async function readState(request: {
  get: (
    url: string,
  ) => Promise<{ status: () => number; json: () => Promise<unknown> }>;
}) {
  const response = await request.get("http://127.0.0.1:4194/state");
  expect(response.status()).toBe(200);
  return (await response.json()) as RuntimeState;
}

async function createAndOpen(
  context: BrowserContext,
  session: Session,
  activity: Record<string, unknown>,
  merchant?: { id: string; credentialVersion: number },
) {
  const headers = { "X-CSRF-Token": session.csrfToken, Origin: origin };
  const saved = await context.request.post("/api/activities", {
    headers,
    data: { requestId: randomUUID(), activity },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const managed = ((await saved.json()) as { activity: ManagedActivity })
    .activity;
  expect(managed.config).toMatchObject({
    participationMode: "direct",
    passwords: [],
    forceDedicated: false,
  });
  const opened = await context.request.post(
    `/api/me/activities/${managed.id}/open`,
    {
      headers,
      data: {
        version: managed.version,
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
  return managed.id;
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

async function createMerchant(
  context: BrowserContext,
  session: Session,
  mode: "simulation" | "real" = "real",
) {
  const headers = { "X-CSRF-Token": session.csrfToken, Origin: origin };
  const created = await context.request.post("/api/me/merchants", {
    headers,
    data: {
      requestId: randomUUID(),
      label: `direct 本地商户 ${randomUUID().slice(0, 8)}`,
      clientId: `hb_full_app_merchant_${randomUUID().slice(0, 8)}`,
      secret: "full-app-merchant-secret",
      mode,
    },
  });
  let merchant: { id: string; credentialVersion: number };
  if (created.status() === 409) {
    const list = await context.request.get("/api/me/merchants");
    expect(list.status(), await list.text()).toBe(200);
    const body = (await list.json()) as {
      currentMerchantId: string | null;
      items: Array<{ id: string; credentialVersion: number }>;
    };
    const current = body.items.find(
      (item) => item.id === body.currentMerchantId,
    );
    if (!current) throw new Error("已有当前商户但列表未返回该商户");
    merchant = current;
  } else {
    expect(created.status(), await created.text()).toBe(200);
    merchant = (await created.json()).merchant as {
      id: string;
      credentialVersion: number;
    };
  }
  await expect
    .poll(
      async () => {
        const response = await context.request.get(
          `/api/me/merchants/${merchant.id}`,
        );
        expect(response.status()).toBe(200);
        return (await response.json()).merchant.publicationEligibility.allowed;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return merchant;
}

test("direct 表单保存后重新编辑清空口令，开放后参与方式锁定", async ({
  browser,
}) => {
  const authorContext = await browser.newContext({
    baseURL: origin,
    reducedMotion: "reduce",
  });
  const external = await guardExternal(authorContext);
  try {
    const page = await authorContext.newPage();
    const author = await signIn(page, "directAuthor");
    const title = `direct 表单完整 ${randomUUID().slice(0, 8)}`;
    await page.goto("/activities/new");
    await page.locator("#activity-title").fill(title);
    await page
      .getByRole("group", { name: "奖励类型", exact: true })
      .getByRole("button", { name: "文本 / CDK", exact: true })
      .click();
    await page.getByLabel("口令 1", { exact: true }).fill("KeepFullPass123");
    await page.locator("#activity-text-rewards").fill("DIRECT-FORM-FULL");
    await chooseDirectMode(page);
    await expect(page.getByLabel("口令 1", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await page.waitForURL(/\/my\/activities\/[0-9a-f-]+(?:\?.*)?$/);
    const activityId = new URL(page.url()).pathname.split("/").at(-1);
    if (!activityId) throw new Error("保存后未进入活动管理页");

    await page.goto(`/my/activities/${activityId}?edit=true`);
    await expect(page.getByRole("heading", { name: "编辑活动" })).toBeVisible();
    await expect(
      page
        .getByRole("group", { name: /参与方式|兑换方式|参与模式/ })
        .getByRole("button", { name: /直接参与|直接领取|无需口令/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("口令 1", { exact: true })).toHaveCount(0);

    await choosePasswordMode(page);
    await expect(page.getByLabel("口令 1", { exact: true })).toHaveValue("");
    await expect(page.locator("#activity-forceDedicated")).not.toBeChecked();

    const managed = await authorContext.request.get(
      `/api/me/activities/${activityId}`,
    );
    expect(managed.status(), await managed.text()).toBe(200);
    const current = (await managed.json()) as { activity: ManagedActivity };
    const opened = await authorContext.request.post(
      `/api/me/activities/${activityId}/open`,
      {
        headers: { "X-CSRF-Token": author.csrfToken, Origin: origin },
        data: { version: current.activity.version },
      },
    );
    expect(opened.status(), await opened.text()).toBe(200);

    const openedPage = await authorContext.newPage();
    await openedPage.goto(`/my/activities/${activityId}?edit=true`);
    await expect(
      openedPage
        .getByRole("group", { name: /参与方式|兑换方式|参与模式/ })
        .getByRole("button", { name: /直接参与|直接领取|无需口令/ }),
    ).toBeDisabled();
    await expect(
      openedPage
        .getByRole("group", { name: /参与方式|兑换方式|参与模式/ })
        .getByRole("button", { name: /口令参与|兑换口令|使用口令/ }),
    ).toBeDisabled();
    expect(external).toEqual([]);
  } finally {
    await authorContext.close();
  }
});

test("direct 文本和本地模拟 LDC 只在活动页主动点击后参与，登录返回与刷新不自动提交", async ({
  browser,
  request,
}) => {
  const authorContext = await browser.newContext({ baseURL: origin });
  const viewerContext = await browser.newContext({ baseURL: origin });
  const external = await Promise.all([
    guardExternal(authorContext),
    guardExternal(viewerContext),
  ]);
  try {
    const authorPage = await authorContext.newPage();
    const viewerPage = await viewerContext.newPage();
    const author = await signIn(authorPage, "directAuthor");
    const textInput: TextActivityInput & {
      participationMode: "direct";
      forceDedicated: false;
      passwords: [];
    } = {
      ...emptyActivityInput(),
      title: `direct 文本 ${randomUUID().slice(0, 8)}`,
      participationMode: "direct",
      passwords: [],
      forceDedicated: false,
      rewards: [{ id: randomUUID(), text: "DIRECT-FULL-TEXT" }],
    };
    const textId = await createAndOpen(authorContext, author, textInput);
    await viewerPage.goto(`/activities/${textId}`);
    await expect(
      viewerPage.getByRole("heading", { name: textInput.title }),
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("link", { name: "登录领取", exact: true }),
    ).toBeVisible();
    const beforeLogin = await readState(request);
    expect(
      beforeLogin.claims.filter((row) => row.activity_id === textId),
    ).toEqual([]);
    await signIn(viewerPage, "recipient");
    await viewerPage.goto(`/activities/${textId}`);
    await viewerPage.reload();
    const afterReturn = await readState(request);
    expect(
      afterReturn.claims.filter((row) => row.activity_id === textId),
    ).toEqual([]);
    await expect(
      viewerPage.getByRole("button", { name: /领取奖励|直接领取/ }),
    ).toBeEnabled();
    await viewerPage.getByRole("button", { name: /领取奖励|直接领取/ }).click();
    await expect(
      viewerPage.locator("pre").filter({ hasText: "DIRECT-FULL-TEXT" }),
    ).toBeVisible();
    const afterClaim = await readState(request);
    expect(
      afterClaim.claims.filter((row) => row.activity_id === textId),
    ).toHaveLength(1);
    expect(
      afterClaim.attempts.find((row) => row.activity_id === textId)?.count,
    ).toBeUndefined();
    expect(afterClaim.payments).toEqual(beforeLogin.payments);
    expect(afterClaim.outbox).toEqual(beforeLogin.outbox);

    const simulationMerchant = await createMerchant(authorContext, author);
    const {
      rewards: _ldcRewards,
      rewardType: _ldcRewardType,
      ...ldcBase
    } = emptyActivityInput();
    const ldcInput: LdcActivityInput & {
      participationMode: "direct";
      forceDedicated: false;
      passwords: [];
    } = {
      ...ldcBase,
      title: `direct 模拟LDC ${randomUUID().slice(0, 8)}`,
      participationMode: "direct",
      passwords: [],
      forceDedicated: false,
      rewardType: "ldc",
      merchantId: simulationMerchant.id,
      money: {
        mode: "fixed",
        totalAmount: "0.01",
        count: 1,
      },
    };
    const ldcId = await createAndOpen(
      authorContext,
      author,
      ldcInput,
      simulationMerchant,
    );
    await viewerPage.goto(`/activities/${ldcId}`);
    await viewerPage.getByRole("button", { name: /领取奖励|直接领取/ }).click();
    await expect(viewerPage.getByText("LDC", { exact: true })).toBeVisible();
    const afterLdc = await readState(request);
    expect(
      afterLdc.claims.filter((row) => row.activity_id === ldcId),
    ).toHaveLength(1);
    expect(afterLdc.upstream.distributeRequests).toBe(
      afterClaim.upstream.distributeRequests + 1,
    );
    expect(external.flat()).toEqual([]);
  } finally {
    await authorContext.close();
    await viewerContext.close();
  }
});

test("direct 限时开奖报名可无 password_id，开奖发布和付款链路保持一次性结果", async ({
  browser,
  request,
}) => {
  const ownerContext = await browser.newContext({ baseURL: origin });
  const firstContext = await browser.newContext({ baseURL: origin });
  const secondContext = await browser.newContext({ baseURL: origin });
  const external = await Promise.all(
    [ownerContext, firstContext, secondContext].map(guardExternal),
  );
  try {
    const ownerPage = await ownerContext.newPage();
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();
    const owner = await signIn(ownerPage, "directDrawAuthor");
    const first = await signIn(firstPage, "recipient");
    const second = await signIn(secondPage, "recipient2");
    expect(first.user.id).not.toBe(second.user.id);
    const merchant = await createMerchant(ownerContext, owner);
    const {
      rewards: _drawRewards,
      rewardType: _drawRewardType,
      ...drawBase
    } = emptyActivityInput();
    const drawInput: LdcActivityInput & {
      participationMode: "direct";
      forceDedicated: false;
      passwords: [];
    } = {
      ...drawBase,
      title: `direct 开奖 ${randomUUID().slice(0, 8)}`,
      participationMode: "direct",
      passwords: [],
      forceDedicated: false,
      rewardType: "ldc",
      merchantId: merchant.id,
      allocation: "random",
      money: {
        mode: "timed_draw",
        algorithm: "double_mean_v1",
        totalAmount: "0.02",
        count: 1,
        participantLimit: 2,
        countdownSeconds: 3_600,
        distributeFullPool: true,
      },
    };
    const drawId = await createAndOpen(
      ownerContext,
      owner,
      drawInput,
      merchant,
    );
    for (const page of [firstPage, secondPage]) {
      await page.goto(`/activities/${drawId}`);
      await page.getByRole("button", { name: "立即报名", exact: true }).click();
      await expect(
        page.getByText(/报名已确认|已中奖|本次未中奖|未中奖/),
      ).toBeVisible();
    }
    await expect
      .poll(async () => {
        const state = await readState(request);
        return {
          draw: state.activities.find((row) => row.id === drawId)?.draw_state,
          registrations: state.registrations.filter(
            (row) => row.activity_id === drawId,
          ).length,
          claims: state.claims.filter((row) => row.activity_id === drawId)
            .length,
        };
      })
      .toMatchObject({ draw: "completed", registrations: 2, claims: 1 });
    const settled = await readState(request);
    const registrations = settled.registrations.filter(
      (row) => row.activity_id === drawId,
    );
    expect(registrations).toHaveLength(2);
    expect(registrations.map((row) => row.password_id)).toEqual([null, null]);
    const claims = settled.claims.filter((row) => row.activity_id === drawId);
    expect(claims).toHaveLength(1);
    const payments = settled.payments.filter((payment) =>
      claims.some((claim) => claim.id === payment.claim_id),
    );
    expect(payments).toHaveLength(1);
    expect(settled.upstream.distributeRequests).toBeGreaterThanOrEqual(1);
    expect(settled.upstream.blockedRequests).toBe(0);
    expect(external.flat()).toEqual([]);
  } finally {
    await ownerContext.close();
    await firstContext.close();
    await secondContext.close();
  }
});
