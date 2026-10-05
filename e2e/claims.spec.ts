import { expect, type Page, test } from "@playwright/test";
import {
  type ClaimActivityInput,
  type ClaimDetail,
  emptyActivityInput,
  type ManagedActivity,
  type PublicActivity,
  type PublicRecipientList,
  type RegistrationDetail,
} from "../packages/contracts/src";

const activityId = "aa638a03-2050-4a18-9f83-802407d9e0b2";
const claimId = "f081c139-b839-4a1d-8a78-4648994977a4";
const inventoryId = "52261908-ab47-4c8a-9e27-c2881bf03579";
const user = {
  id: "claimant-1",
  username: "ada",
  displayName: "Ada",
  avatarUrl: null,
};
const reward = "<b>PRIVATE-REWARD</b>\n**必须原样显示**\n第二行";

async function mockClaims(page: Page) {
  const activity: ManagedActivity = {
    id: activityId,
    author: user,
    title: "文本领取测试",
    rewardType: "text",
    status: "active",
    version: 2,
    createdAt: new Date().toISOString(),
    openedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 86400000).toISOString(),
    topicUrl: null,
    totalCount: 2,
    claimedCount: 0,
    config: {
      ...emptyActivityInput(),
      title: "文本领取测试",
      forceDedicated: true,
      passwords: ["Answer123"],
      rewards: [{ id: inventoryId, text: reward }],
      beforeInfo: "领取前公开信息",
      afterClaimInfo: "## 领取后内容\n\n[后续活动](/activities/next)",
      afterEndInfo: "活动结束说明",
    },
  };
  const state = {
    activity,
    signedIn: true,
    claim: null as ClaimDetail | null,
    requests: [] as ClaimActivityInput[],
    csrf: [] as (string | undefined)[],
    failFirstResponse: false,
    lookupFailure: false,
    throttle: false,
    privateReads: 0,
    endRequests: 0,
    viewerIsAuthor: false,
    solved: [] as string[],
    solveRequests: [] as ClaimActivityInput[],
    failFirstSolveResponse: false,
    delayPasswords: false,
    releasePasswords: undefined as (() => void) | undefined,
    delayClaim: false,
    releaseClaim: undefined as (() => void) | undefined,
    recipients: {
      enabled: false,
      items: [],
      nextCursor: null,
    } as PublicRecipientList,
  };
  function detail(): Extract<ClaimDetail, { rewardType: "text" }> {
    return {
      id: claimId,
      activity: {
        id: activityId,
        title: state.activity.title,
        status: state.activity.status,
      },
      rewardType: "text",
      claimedAt: new Date().toISOString(),
      text: reward,
      afterClaimInfo: state.activity.config.afterClaimInfo,
    };
  }
  const unavailable = {
    error: { code: "UNAVAILABLE", message: "暂时无法读取领取记录" },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me")
      return route.fulfill({
        json: state.signedIn
          ? { user, csrfToken: "claim-csrf" }
          : { user: null, csrfToken: null },
      });
    if (path === "/api/auth/logout") {
      state.signedIn = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === `/api/activities/${activityId}`) {
      const publicActivity: PublicActivity = {
        id: activityId,
        author: user,
        title: state.activity.title,
        rewardType: "text",
        status: state.activity.status,
        forceDedicated: state.activity.config.forceDedicated,
        topicUrl: null,
        openedAt: state.activity.openedAt,
        deadlineAt: state.activity.deadlineAt,
        quantity: { mode: "fuzzy", level: "limited" },
        showRecipientList: state.recipients.enabled,
        showRecipientUsername: false,
        showRecipientTime: false,
        beforeInfo: state.activity.config.beforeInfo,
        ...(state.activity.status === "ended" ||
        state.activity.status === "archived"
          ? { afterEndInfo: state.activity.config.afterEndInfo }
          : {}),
      };
      return route.fulfill({ json: { activity: publicActivity } });
    }
    if (path.endsWith("/recipients"))
      return route.fulfill({ json: state.recipients });
    if (path === `/api/activities/${activityId}/passwords`) {
      const ended =
        state.activity.status === "ended" ||
        state.activity.status === "archived";
      const all = ended || (state.signedIn && state.viewerIsAuthor);
      const passwords = state.activity.config.passwords
        .filter(
          (text) =>
            all ||
            (state.signedIn &&
              state.claim &&
              (text === "Answer123" || state.solved.includes(text))),
        )
        .map((text) => ({
          text,
          isClaimPassword:
            state.signedIn && Boolean(state.claim) && text === "Answer123",
          isSolved: state.signedIn && state.solved.includes(text),
        }));
      const json = {
        passwords,
        hiddenCount: state.activity.config.passwords.length - passwords.length,
        canSolve: state.signedIn && Boolean(state.claim) && !ended,
      };
      if (state.delayPasswords)
        await new Promise<void>((resolve) => {
          state.releasePasswords = resolve;
        });
      try {
        return await route.fulfill({ json });
      } catch {
        return;
      }
    }
    if (!state.signedIn)
      return route.fulfill({
        status: 401,
        json: { error: { code: "HTTP_401", message: "请先登录" } },
      });
    if (path === `/api/activities/${activityId}/password-solves`) {
      const body = request.postDataJSON() as ClaimActivityInput;
      state.solveRequests.push(body);
      state.csrf.push(request.headers()["x-csrf-token"]);
      const correct = state.activity.config.passwords.includes(body.password);
      if (correct && !state.solved.includes(body.password))
        state.solved.push(body.password);
      if (state.failFirstSolveResponse && state.solveRequests.length === 1)
        return route.abort("failed");
      return route.fulfill({
        json: { outcome: correct ? "solved" : "incorrect" },
      });
    }
    if (path === `/api/activities/${activityId}/claim`) {
      if (request.method() === "GET") {
        state.privateReads++;
        if (state.lookupFailure)
          return route.fulfill({ status: 503, json: unavailable });
        return route.fulfill({ json: { claim: state.claim } });
      }
      const body = request.postDataJSON() as ClaimActivityInput;
      state.requests.push(body);
      state.csrf.push(request.headers()["x-csrf-token"]);
      if (state.throttle)
        return route.fulfill({
          status: 429,
          headers: { "Retry-After": "2" },
          json: {
            error: {
              code: "RATE_LIMITED",
              message: "提交过于频繁，请稍后重试",
            },
          },
        });
      if (body.password !== "Answer123")
        return route.fulfill({ json: { result: "incorrect" } });
      const existed = state.claim !== null;
      state.claim ??= detail();
      state.activity.claimedCount = 1;
      if (state.failFirstResponse && state.requests.length === 1)
        return route.abort("failed");
      if (state.delayClaim)
        await new Promise<void>((resolve) => {
          state.releaseClaim = resolve;
        });
      try {
        return await route.fulfill({
          json: {
            result: existed ? "already_claimed" : "claimed",
            claim: state.claim,
          },
        });
      } catch {
        return;
      }
    }
    if (path === "/api/me/claims") {
      state.privateReads++;
      return route.fulfill({
        json: {
          items: state.claim
            ? [
                {
                  id: claimId,
                  activity: state.claim.activity,
                  claimedAt: state.claim.claimedAt,
                  rewardType: "text",
                },
              ]
            : [],
          nextCursor: null,
        },
      });
    }
    if (path === "/api/me/participations") {
      state.privateReads++;
      return route.fulfill({
        json: {
          items: state.claim
            ? [
                {
                  kind: "claim",
                  claim: {
                    id: claimId,
                    activity: state.claim.activity,
                    claimedAt: state.claim.claimedAt,
                    rewardType: "text",
                  },
                },
              ]
            : [],
          nextCursor: null,
        },
      });
    }
    if (path === `/api/me/claims/${claimId}`) {
      state.privateReads++;
      return route.fulfill({ json: { claim: state.claim } });
    }
    if (path === `/api/me/activities/${activityId}/claims`) {
      return route.fulfill({
        json: {
          items: state.claim ? [{ ...state.claim, claimant: user }] : [],
          nextCursor: null,
        },
      });
    }
    if (path === `/api/me/activities/${activityId}/end`) {
      state.endRequests++;
      state.csrf.push(request.headers()["x-csrf-token"]);
      state.activity.status = "ended";
      state.activity.version++;
      return route.fulfill({ json: { activity: state.activity } });
    }
    if (path === `/api/me/activities/${activityId}`)
      return route.fulfill({ json: { activity: state.activity } });
    return route.fallback();
  });
  return { state, detail };
}

async function submit(page: Page, password = "Answer123") {
  await page.getByLabel("兑换口令", { exact: true }).fill(password);
  await page.getByRole("button", { name: "领取", exact: true }).click();
}

test("匿名专属页要求登录，不读取本人奖励；普通活动不显示统计告知", async ({
  page,
}) => {
  const { state } = await mockClaims(page);
  state.signedIn = false;
  state.activity.config.forceDedicated = false;
  await page.goto(`/activities/${activityId}`);
  await expect(page.getByRole("link", { name: /登录 Linux DO/ })).toBeVisible();
  await expect(page.getByLabel("兑换口令", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/提交的口令将供活动作者查看/)).toHaveCount(0);
  expect(state.privateReads).toBe(0);
});

test("错误后主动重试生成新提交，成功展示原文并可从历史再次查看", async ({
  page,
}) => {
  const { state } = await mockClaims(page);
  await page.goto(`/activities/${activityId}`);
  await expect(page.getByText(/提交的口令将供活动作者查看/)).toBeVisible();
  await submit(page, "Wrong123");
  await expect(page.getByText(/口令不正确|口令错误|口令未匹配/)).toBeVisible();
  await submit(page, "  Answer123  ");
  await expect(page.getByText(reward, { exact: true })).toBeVisible();
  await expect(page.locator("main b")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "领取后内容" })).toBeVisible();
  expect(state.requests).toHaveLength(2);
  expect(state.requests[0]?.submissionId).not.toBe(
    state.requests[1]?.submissionId,
  );
  expect(state.requests[1]?.password).toBe("Answer123");
  expect(state.csrf).toEqual(["claim-csrf", "claim-csrf"]);
  await page.reload();
  await expect(page.getByText(reward, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "领取", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "我的参与", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL("/my/claims");
  await page
    .getByRole("link", { name: /文本领取测试|查看奖励/ })
    .first()
    .click();
  await expect(page).toHaveURL(`/my/claims/${claimId}`);
  await expect(page.getByText(reward, { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(2);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toMatch(/Answer123|PRIVATE-REWARD/);
});

test("响应丢失后重试原提交，不生成新标识或丢失原奖励", async ({ page }) => {
  const { state } = await mockClaims(page);
  state.failFirstResponse = true;
  await page.goto(`/activities/${activityId}`);
  await submit(page);
  await expect(
    page.getByRole("button", { name: "重试原提交", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重试原提交", exact: true }).click();
  await expect(page.getByText(reward, { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(2);
  expect(state.requests[1]).toEqual(state.requests[0]);
});

test("领取查询失败时不能盲目提交，恢复查询后才能领取", async ({ page }) => {
  const { state } = await mockClaims(page);
  state.lookupFailure = true;
  await page.goto(`/activities/${activityId}`);
  await expect(page.getByText(/暂时无法读取领取记录/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "领取", exact: true }),
  ).toHaveCount(0);
  state.lookupFailure = false;
  await page
    .getByRole("button", { name: /重试|重新/ })
    .last()
    .click();
  await expect(page.getByLabel("兑换口令", { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(0);
});

test("限流显示等待，倒计时结束后允许再次主动提交", async ({ page }) => {
  const { state } = await mockClaims(page);
  state.throttle = true;
  await page.goto(`/activities/${activityId}`);
  await submit(page);
  await expect(page.getByText(/尝试过于频繁|提交过于频繁/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /领取|等待|秒/ }).last(),
  ).toBeDisabled();
  state.throttle = false;
  await expect(
    page.getByRole("button", { name: "领取", exact: true }),
  ).toBeEnabled({ timeout: 6000 });
  await submit(page);
  await expect(page.getByText(reward, { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(2);
  expect(state.requests[0]?.submissionId).not.toBe(
    state.requests[1]?.submissionId,
  );
});

test("结束和归档后仍能读取本人奖励，未领取者不能领取", async ({ page }) => {
  const { state, detail } = await mockClaims(page);
  state.activity.status = "archived";
  state.claim = detail();
  await page.goto(`/activities/${activityId}`);
  await expect(page.getByText("已归档", { exact: true })).toBeVisible();
  await expect(page.getByText(reward, { exact: true })).toBeVisible();
  await expect(page.getByText("活动结束说明", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "领取", exact: true }),
  ).toHaveCount(0);
  state.claim = null;
  state.activity.status = "ended";
  await page.reload();
  await expect(page.getByText("已结束", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("兑换口令", { exact: true })).toHaveCount(0);
  await expect(page.getByText(reward, { exact: true })).toHaveCount(0);
});

test("作者提前结束需明确确认，已领取活动不显示此操作", async ({ page }) => {
  const { state, detail } = await mockClaims(page);
  await page.goto(`/my/activities/${activityId}`);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "提前结束", exact: true }).click();
  expect(state.endRequests).toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "提前结束", exact: true }).click();
  await expect(page.getByText("已结束", { exact: true }).first()).toBeVisible();
  expect(state.endRequests).toBe(1);
  expect(state.csrf).toEqual(["claim-csrf"]);
  state.activity.status = "active";
  state.activity.claimedCount = 1;
  state.claim = detail();
  await page.reload();
  await page.getByText("查看已分配文本", { exact: true }).click();
  await expect(page.getByText(reward, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "提前结束", exact: true }),
  ).toHaveCount(0);
});

test("公共名单开启后展示领取者资料", async ({ page }) => {
  const { state } = await mockClaims(page);
  state.signedIn = false;
  state.recipients = {
    enabled: true,
    items: [
      {
        id: claimId,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        claimedAt: new Date().toISOString(),
      },
    ],
    nextCursor: null,
  };
  await page.goto(`/activities/${activityId}`);
  await expect(
    page.getByRole("heading", { name: /领取名单|领取记录/ }),
  ).toBeVisible();
  await expect(page.getByText("Ada", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(reward, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/共.*份|剩余.*份/)).toHaveCount(0);
  expect(state.privateReads).toBe(0);
});

test("退出时隐藏私有奖励，晚到的领取响应不能重新展示", async ({ page }) => {
  const { state } = await mockClaims(page);
  state.delayClaim = true;
  await page.goto(`/activities/${activityId}`);
  await submit(page);
  await expect.poll(() => Boolean(state.releaseClaim)).toBe(true);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByRole("link", { name: /登录 Linux DO/ })).toBeVisible();
  state.releaseClaim?.();
  await expect(page.getByText(reward, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "领取后内容" })).toHaveCount(
    0,
  );
});

test("窄屏长奖励不溢出，复制按钮交付原始文本", async ({ page }) => {
  const { state, detail } = await mockClaims(page);
  const longText = `${"LONG-CODE".repeat(100)}\n**literal**`;
  state.claim = { ...detail(), text: longText };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          document.documentElement.dataset.copiedReward = value;
        },
      },
    });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/activities/${activityId}`);
  await expect(page.getByText(longText, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制奖励", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.copiedReward),
    )
    .toBe(longText);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("未领取仅返回未解锁数量，领取后只显示我的口令，解新口令不再分配奖励", async ({
  page,
}) => {
  const { state } = await mockClaims(page);
  state.activity.config.passwords.push("Second456");
  await page.goto(`/activities/${activityId}`);
  const panel = page.getByRole("region", { name: "活动口令" });
  await expect(
    panel.getByText("还有 2 个口令未解锁。", { exact: true }),
  ).toBeVisible();
  await expect(panel.locator("code")).toHaveCount(0);
  await page.getByLabel("兑换口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "领取", exact: true }).click();
  await expect(panel.getByText("我的领奖口令", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("还有 1 个口令未解锁。", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("继续解口令", { exact: true }).fill("Second456");
  await page.getByRole("button", { name: "解锁口令", exact: true }).click();
  await expect(panel.getByText("我已解出", { exact: true })).toBeVisible();
  await expect(panel.getByText("Second456", { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(1);
  expect(state.solveRequests).toHaveLength(1);
  await page.reload();
  await expect(panel.getByText("我的领奖口令", { exact: true })).toBeVisible();
  await expect(panel.getByText("我已解出", { exact: true })).toBeVisible();
});

test("解口令响应丢失时只重试原UUID和原输入，不重复领取", async ({ page }) => {
  const { state, detail } = await mockClaims(page);
  state.claim = detail();
  state.activity.config.passwords.push("Second456");
  state.failFirstSolveResponse = true;
  await page.goto(`/activities/${activityId}`);
  await page.getByLabel("继续解口令", { exact: true }).fill("Second456");
  await page.getByRole("button", { name: "解锁口令", exact: true }).click();
  await expect(
    page.getByText("尚未确认解锁结果，请重试原提交。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("继续解口令", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "重试原提交", exact: true }).click();
  await expect(page.getByText("我已解出", { exact: true })).toBeVisible();
  expect(state.solveRequests).toHaveLength(2);
  expect(state.solveRequests[1]).toEqual(state.solveRequests[0]);
  expect(state.requests).toHaveLength(0);
});

for (const status of ["ended", "archived"] as const) {
  test(`${status}匿名可查看并复制全部口令，无个人标记及解锁操作`, async ({
    page,
    context,
  }) => {
    const { state } = await mockClaims(page);
    state.signedIn = false;
    state.activity.status = status;
    state.activity.config.passwords.push("Second456");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/activities/${activityId}`);
    const panel = page.getByRole("region", { name: "活动口令" });
    await expect(panel.getByText("Answer123", { exact: true })).toBeVisible();
    await expect(panel.getByText("Second456", { exact: true })).toBeVisible();
    await expect(panel.getByText(/未解锁|我的领奖口令|我已解出/)).toHaveCount(
      0,
    );
    await expect(panel.getByLabel("继续解口令", { exact: true })).toHaveCount(
      0,
    );
    await panel
      .getByRole("button", { name: "复制口令 Second456", exact: true })
      .click();
    await expect(
      panel.getByText("口令已复制。", { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "Second456",
    );
  });
}

test("作者可看活动全部口令，退出后迟到的私有口令响应不得恢复显示", async ({
  page,
}) => {
  const { state } = await mockClaims(page);
  state.viewerIsAuthor = true;
  state.activity.config.passwords.push("Second456");
  await page.goto(`/activities/${activityId}`);
  const panel = page.getByRole("region", { name: "活动口令" });
  await expect(panel.getByText("Second456", { exact: true })).toBeVisible();
  state.delayPasswords = true;
  await page.reload();
  await expect.poll(() => Boolean(state.releasePasswords)).toBe(true);
  const release = state.releasePasswords;
  state.delayPasswords = false;
  await page.getByRole("button", { name: "退出", exact: true }).click();
  release?.();
  await expect(
    panel.getByText("还有 2 个口令未解锁。", { exact: true }),
  ).toBeVisible();
  await expect(panel.locator("code")).toHaveCount(0);
});

test("限时开奖 public 已完成时仍轮询本人非终态报名直到未中奖终态", async ({
  page,
}) => {
  await page.clock.install();
  const drawActivityId = "2e0fda0c-12ad-4d8b-9d72-e4f096595d64";
  const registrationId = "a3c6e5dc-2227-4d1a-9cf7-a39fdab22f6c";
  const drawAt = new Date(Date.now() - 5_000).toISOString();
  const activity: PublicActivity = {
    id: drawActivityId,
    author: {
      id: "author-1",
      username: "author",
      displayName: "作者",
      avatarUrl: null,
    },
    title: "已开奖但私有结果延迟",
    rewardType: "ldc",
    status: "active",
    forceDedicated: true,
    topicUrl: null,
    openedAt: new Date(Date.now() - 60_000).toISOString(),
    deadlineAt: drawAt,
    quantity: { mode: "exact", total: 5, claimed: 0, remaining: 5 },
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
    showRecipientAmount: true,
    beforeInfo: "等待私有开奖结果",
    paymentMode: "simulation",
    draw: {
      state: "completed",
      deadlineAt: drawAt,
      closedAt: drawAt,
      reason: "deadline",
      registeredCount: 1,
      winnerCount: 0,
      participantLimit: 3,
    },
  };
  let registrationReads = 0;
  let releaseFinalRegistration = false;
  const baseRegistration = {
    id: registrationId,
    activity: { id: drawActivityId, title: activity.title, status: "active" },
    registeredAt: new Date(Date.now() - 45_000).toISOString(),
    drawAt,
    claim: null,
  } satisfies Omit<RegistrationDetail, "status">;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "draw-csrf" } });
    if (path === `/api/activities/${drawActivityId}`)
      return route.fulfill({ json: { activity } });
    if (path === `/api/activities/${drawActivityId}/claim`)
      return route.fulfill({ json: { claim: null } });
    if (path === `/api/activities/${drawActivityId}/registration`) {
      registrationReads += 1;
      return route.fulfill({
        json: {
          registration: {
            ...baseRegistration,
            status: releaseFinalRegistration ? "not_won" : "registered",
          },
        },
      });
    }
    if (path === `/api/activities/${drawActivityId}/passwords`)
      return route.fulfill({
        json: { passwords: [], hiddenCount: 0, canSolve: false },
      });
    if (path === `/api/activities/${drawActivityId}/recipients`)
      return route.fulfill({
        json: { enabled: true, items: [], nextCursor: null },
      });
    return route.fallback();
  });

  await page.goto(`/activities/${drawActivityId}`);
  await expect(
    page.getByText("已报名，等待开奖", { exact: true }),
  ).toBeVisible();
  const readsAfterInitial = registrationReads;
  releaseFinalRegistration = true;
  await page.clock.runFor(15_100);
  await expect(page.getByText("未中奖", { exact: true })).toBeVisible();
  expect(registrationReads).toBeGreaterThan(readsAfterInitial);
  const readsAfterFinal = registrationReads;
  await page.clock.runFor(31_000);
  expect(registrationReads).toBe(readsAfterFinal);
});

test("限时开奖报名、报名口令、继续解口令与我的参与列表", async ({ page }) => {
  const drawActivityId = "f4d9d4d1-d7fb-4c67-a3b3-45fe78a70122";
  const registrationId = "6a7fe2f6-7afe-41d5-9ef9-854657bb1adc";
  const drawAt = new Date(Date.now() + 90_000).toISOString();
  const activity = {
    id: drawActivityId,
    author: {
      id: "author-1",
      username: "author",
      displayName: "作者",
      avatarUrl: null,
    },
    title: "限时开奖活动",
    rewardType: "ldc" as const,
    status: "active" as const,
    forceDedicated: true,
    topicUrl: null,
    openedAt: new Date().toISOString(),
    deadlineAt: drawAt,
    quantity: { mode: "exact" as const, total: 5, claimed: 0, remaining: 5 },
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
    showRecipientAmount: true,
    beforeInfo: "输入口令报名抽奖",
    paymentMode: "simulation" as const,
    draw: {
      state: "waiting" as const,
      deadlineAt: drawAt,
      closedAt: null,
      reason: null,
      registeredCount: 0,
      winnerCount: null,
      participantLimit: 3,
    },
  };
  const state = {
    claim: null as ClaimDetail | null,
    registration: null as null | {
      id: string;
      activity: { id: string; title: string; status: "active" };
      registeredAt: string;
      status: "registered";
      drawAt: string;
      claim: null;
    },
    requests: [] as ClaimActivityInput[],
    solveRequests: [] as ClaimActivityInput[],
    solved: [] as string[],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "draw-csrf" } });
    if (path === `/api/activities/${drawActivityId}`)
      return route.fulfill({ json: { activity } });
    if (path === `/api/activities/${drawActivityId}/claim`) {
      if (request.method() === "GET")
        return route.fulfill({ json: { claim: state.claim } });
      const body = request.postDataJSON() as ClaimActivityInput;
      state.requests.push(body);
      if (body.password !== "Answer123")
        return route.fulfill({ json: { result: "incorrect" } });
      state.registration ??= {
        id: registrationId,
        activity: {
          id: drawActivityId,
          title: activity.title,
          status: "active",
        },
        registeredAt: new Date().toISOString(),
        status: "registered",
        drawAt,
        claim: null,
      };
      activity.draw.registeredCount = 1;
      return route.fulfill({
        json: { result: "registered", registration: state.registration },
      });
    }
    if (path === `/api/activities/${drawActivityId}/registration`)
      return route.fulfill({ json: { registration: state.registration } });
    if (path === `/api/activities/${drawActivityId}/passwords`) {
      return route.fulfill({
        json: {
          passwords: state.registration
            ? [
                {
                  text: "Answer123",
                  isClaimPassword: false,
                  isRegistrationPassword: true,
                  isSolved: false,
                },
                ...state.solved.map((text) => ({
                  text,
                  isClaimPassword: false,
                  isRegistrationPassword: false,
                  isSolved: true,
                })),
              ]
            : [],
          hiddenCount: state.registration ? 1 - state.solved.length : 2,
          canSolve: Boolean(state.registration),
        },
      });
    }
    if (path === `/api/activities/${drawActivityId}/password-solves`) {
      const body = request.postDataJSON() as ClaimActivityInput;
      state.solveRequests.push(body);
      if (
        body.password === "Second456" &&
        !state.solved.includes(body.password)
      )
        state.solved.push(body.password);
      return route.fulfill({
        json: {
          outcome: body.password === "Second456" ? "solved" : "incorrect",
        },
      });
    }
    if (path === `/api/activities/${drawActivityId}/recipients`)
      return route.fulfill({
        json: { enabled: true, items: [], nextCursor: null },
      });
    if (path === "/api/me/participations")
      return route.fulfill({
        json: {
          items: state.registration
            ? [{ kind: "registration", registration: state.registration }]
            : [],
          nextCursor: null,
        },
      });
    return route.fallback();
  });

  await page.goto(`/activities/${drawActivityId}`);
  await expect(
    page.getByText("报名中，等待开奖", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("兑换口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "报名", exact: true }).click();
  await expect(
    page.getByText("已报名，等待开奖", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("我的报名口令", { exact: true })).toBeVisible();
  await page.getByLabel("继续解口令", { exact: true }).fill("Second456");
  await page.getByRole("button", { name: "解锁口令", exact: true }).click();
  await expect(page.getByText("我已解出", { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(1);
  expect(state.solveRequests).toHaveLength(1);

  await page.getByRole("link", { name: "我的参与", exact: true }).click();
  await expect(page).toHaveURL("/my/claims");
  await expect(page.getByRole("heading", { name: "我的参与" })).toBeVisible();
  await expect(page.getByText("限时开奖 · 已报名")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "查看活动", exact: true }),
  ).toBeVisible();
});
