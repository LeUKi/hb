import { expect, type Page, test } from "@playwright/test";
import {
  type CreateActivityInput,
  emptyActivityInput,
  type ManagedActivity,
  type PublicActivity,
  type TextActivityInput,
  type UpdateActivityInput,
} from "../packages/contracts/src";

const id = "b674025a-0879-4569-8774-1a4bfc9e2328";
const rewardId = "daef3bf5-a2c7-4f9f-b425-5e80d9b76a24";
const author = {
  id: "creator-1",
  username: "ada",
  displayName: "Ada",
  avatarUrl: null,
  accountTier: "standard" as const,
  canUseLdc: true,
  loginProvider: "connect" as const,
};

function fixture(): ManagedActivity {
  const config = {
    ...emptyActivityInput(),
    title: "待开放文本活动",
    passwords: ["私人口令ABC"],
    rewards: [{ id: rewardId, text: "PRIVATE-CODE-123\n第二行" }],
    beforeInfo: "**欢迎参与**",
    afterClaimInfo: "领取后秘密",
    afterEndInfo: "结束后秘密",
  };
  return {
    id,
    author,
    config,
    title: config.title,
    rewardType: "text",
    forceDedicated: config.forceDedicated,
    status: "draft",
    version: 1,
    createdAt: new Date().toISOString(),
    openedAt: null,
    deadlineAt: null,
    topicUrl: null,
    totalCount: 1,
    claimedCount: 0,
  };
}

function textConfig(config: ManagedActivity["config"]): TextActivityInput {
  if (config.rewardType !== "text") throw new Error("Expected text activity");
  return config;
}

async function expectPathname(page: Page, pathname: string) {
  await expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
}

async function logoutViaAccount(page: Page) {
  await page
    .locator("header")
    .first()
    .getByRole("link", { name: /我的账号/ })
    .click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
}

async function chooseSegmented(
  page: Page,
  groupName: string,
  optionName: string | RegExp,
) {
  await page
    .getByRole("group", { name: groupName, exact: true })
    .getByRole("button", {
      name: optionName,
      exact: typeof optionName === "string",
    })
    .click();
}

function textRewardInput(page: Page) {
  return page.locator("#activity-text-rewards");
}

function segmentedOption(page: Page, groupName: string, optionName: string) {
  return page
    .getByRole("group", { name: groupName, exact: true })
    .getByRole("button", { name: optionName, exact: true });
}

function publicView(activity: ManagedActivity): PublicActivity {
  return {
    id,
    author,
    title: activity.title,
    rewardType: "text",
    status: activity.status,
    forceDedicated: activity.config.forceDedicated,
    topicUrl: activity.topicUrl,
    openedAt: activity.openedAt,
    deadlineAt: activity.deadlineAt,
    quantity:
      activity.config.quantityVisibility === "exact"
        ? {
            mode: "exact",
            total: activity.totalCount,
            claimed: activity.claimedCount,
            remaining: activity.totalCount - activity.claimedCount,
          }
        : { mode: "fuzzy", level: "plenty" },
    showRecipientList: false,
    showRecipientUsername: false,
    showRecipientTime: false,
    beforeInfo: activity.config.beforeInfo,
    ...(activity.status === "ended" || activity.status === "archived"
      ? { afterEndInfo: activity.config.afterEndInfo }
      : {}),
  };
}

async function mockActivities(page: Page) {
  const state = {
    activity: fixture(),
    signedIn: true,
    conflict: false,
    failFirstCreate: false,
    failFirstUpdateResponse: false,
    failFirstOpenResponse: false,
    delayCreate: false,
    releaseCreate: undefined as (() => void) | undefined,
    creates: [] as (CreateActivityInput & { activity: TextActivityInput })[],
    updates: [] as (UpdateActivityInput & { activity: TextActivityInput })[],
    csrf: [] as (string | undefined)[],
    privateReads: 0,
    detailReads: 0,
    failDetailReads: 0,
    deleted: false,
    deletes: 0,
    opens: [] as { version: number }[],
  };
  await page.route(/\/api\/(?:session|me)$/, (route) =>
    route.fulfill({
      json: state.signedIn
        ? { user: author, csrfToken: "test-csrf" }
        : { user: null, csrfToken: null },
    }),
  );
  await page.route("**/api/auth/logout", (route) => {
    state.signedIn = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/me/merchants", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/api/me/activities**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET") state.privateReads++;
    else state.csrf.push(request.headers()["x-csrf-token"]);
    if (!state.signedIn)
      return route.fulfill({
        status: 401,
        json: {
          error: { code: "HTTP_401", message: "Authentication required" },
        },
      });
    if (request.method() === "GET" && pathname === `/api/me/activities/${id}`) {
      state.detailReads++;
      if (state.failDetailReads > 0) {
        state.failDetailReads--;
        return route.fulfill({
          status: 500,
          json: { error: { code: "READ_FAILED", message: "测试刷新失败" } },
        });
      }
    }
    if (state.deleted && pathname === `/api/me/activities/${id}`)
      return route.fulfill({
        status: 404,
        json: { error: { code: "ACTIVITY_NOT_FOUND", message: "活动不存在" } },
      });
    if (pathname.endsWith("/claims"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (pathname.endsWith("/statistics"))
      return route.fulfill({
        json: {
          totalAttempts: 0,
          uniqueUsers: 0,
          successfulClaims: 0,
          items: [],
          validPasswords: [],
          nextCursor: null,
        },
      });
    if (pathname.endsWith("/open")) {
      state.opens.push(request.postDataJSON());
      state.activity = {
        ...state.activity,
        status: "active",
        version: state.activity.version + 1,
        openedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
      };
      if (state.failFirstOpenResponse && state.opens.length === 1)
        return route.abort("failed");
    } else if (request.method() === "DELETE") {
      state.deletes++;
      if (state.conflict || state.activity.openedAt)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "ACTIVITY_VERSION_CONFLICT",
              message: "活动已修改，请刷新后重试",
            },
          },
        });
      state.deleted = true;
      return route.fulfill({
        json: {
          id,
          deleted: true,
          deletedAt: new Date().toISOString(),
          version: state.activity.version + 1,
        },
      });
    } else if (request.method() === "PATCH") {
      const body = request.postDataJSON() as UpdateActivityInput & {
        activity: TextActivityInput;
      };
      state.updates.push(body);
      if (state.conflict)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "ACTIVITY_VERSION_CONFLICT",
              message: "活动已更新，请刷新后重试",
            },
          },
        });
      if (body.version !== state.activity.version)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "ACTIVITY_VERSION_CONFLICT",
              message: "活动已更新，请刷新后重试",
            },
          },
        });
      state.activity = {
        ...state.activity,
        config: body.activity,
        title: body.activity.title,
        version: state.activity.version + 1,
        totalCount: body.activity.rewards.length,
      };
      if (state.failFirstUpdateResponse && state.updates.length === 1)
        return route.abort("failed");
    } else if (pathname === "/api/me/activities") {
      return route.fulfill({
        json: {
          items: state.deleted ? [] : [state.activity],
          nextCursor: null,
        },
      });
    }
    return route.fulfill({ json: { activity: state.activity } });
  });
  await page.route("**/api/activities**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/participation"))
      return route.fulfill({ json: { claim: null, registration: null } });
    if (pathname.endsWith("/claim"))
      return route.fulfill({ json: { claim: null } });
    if (pathname.endsWith("/recipients"))
      return route.fulfill({
        json: { enabled: false, items: [], nextCursor: null },
      });
    if (pathname.endsWith("/passwords")) {
      const revealed =
        state.signedIn ||
        state.activity.status === "ended" ||
        state.activity.status === "archived";
      return route.fulfill({
        json: {
          passwords: revealed
            ? state.activity.config.passwords.map((text) => ({
                text,
                isClaimPassword: false,
                isSolved: false,
              }))
            : [],
          hiddenCount: revealed ? 0 : state.activity.config.passwords.length,
          canSolve: false,
        },
      });
    }
    if (request.method() === "POST") {
      const body = request.postDataJSON() as CreateActivityInput & {
        activity: TextActivityInput;
      };
      state.creates.push(body);
      state.csrf.push(request.headers()["x-csrf-token"]);
      state.activity = {
        ...fixture(),
        config: body.activity,
        title: body.activity.title,
        totalCount: body.activity.rewards.length,
      };
      if (state.failFirstCreate && state.creates.length === 1)
        return route.abort("failed");
      const json = { activity: state.activity };
      if (state.delayCreate)
        await new Promise<void>((resolve) => {
          state.releaseCreate = resolve;
        });
      try {
        return await route.fulfill({ json });
      } catch {
        return;
      }
    }
    if (state.activity.status === "draft" && !state.signedIn)
      return route.fulfill({
        status: 404,
        json: { error: { code: "ACTIVITY_NOT_FOUND", message: "活动不存在" } },
      });
    return route.fulfill({ json: { activity: publicView(state.activity) } });
  });
  return state;
}

async function enterMinimalActivity(page: Page) {
  await page.goto("/activities/new");
  await chooseSegmented(page, "奖励类型", "文本 / CDK");
  await page.locator("#activity-title").fill("新文本活动");
  await page.getByLabel("口令 1", { exact: true }).fill("Answer123");
  await textRewardInput(page).fill("私有奖励\n第二行");
}

test("文本活动保存和开放不检查商户凭证", async ({ page }) => {
  const state = await mockActivities(page);
  let merchantRequests = 0;
  await page.route("**/api/me/merchants**", async (route) => {
    if (route.request().method() !== "GET") merchantRequests++;
    await route.abort("failed");
  });
  await enterMinimalActivity(page);
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await expectPathname(page, `/my/activities/${id}`);
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  expect(state.activity.status).toBe("active");
  expect(merchantRequests).toBe(0);
});

for (const search of ["", "?edit=true", "?edit=false"]) {
  test(`作者旧链接直接显示编辑表单 ${search || "默认地址"}`, async ({
    page,
  }) => {
    await mockActivities(page);
    const records: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path === `/api/me/activities/${id}/claims` ||
        path === `/api/me/activities/${id}/registrations`
      )
        records.push(path);
    });
    await page.goto(`/my/activities/${id}${search}`);
    await expect(
      page.getByRole("heading", { name: "编辑活动", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#activity-title")).toHaveValue("待开放文本活动");
    await expect(
      page.getByRole("heading", { name: "管理活动", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "编辑活动", exact: true }),
    ).toHaveCount(0);
    expect(records).toEqual([]);
  });
}

test("刷新可取消，失败保留输入，同版本成功刷新也重置未保存内容", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockActivities(page);
  await page.goto(`/my/activities/${id}`);
  const title = page.locator("#activity-title");
  const refresh = page.getByRole("button", { name: "刷新", exact: true });
  await expect(title).toHaveValue(state.activity.title);
  await title.fill("同版本未保存内容");
  const reads = state.detailReads;
  page.once("dialog", (dialog) => dialog.dismiss());
  await refresh.click();
  await expect(title).toHaveValue("同版本未保存内容");
  expect(state.detailReads).toBe(reads);
  state.failDetailReads = 1;
  page.once("dialog", (dialog) => dialog.accept());
  await refresh.click();
  await expect(
    page.getByText("刷新失败，请重试。", { exact: true }),
  ).toBeVisible();
  await expect(title).toHaveValue("同版本未保存内容");
  expect(state.activity.version).toBe(1);
  page.once("dialog", (dialog) => dialog.accept());
  await refresh.click();
  await expect(title).toHaveValue("待开放文本活动");
  expect(state.activity.version).toBe(1);
  expect(state.updates).toEqual([]);
  await page.getByRole("link", { name: "兑奖", exact: true }).click();
  await expectPathname(page, "/");
});

test("保存后继续编辑仍确认未保存离开，取消保留输入且确认后离开", async ({
  page,
}) => {
  const state = await mockActivities(page);
  await page.goto(`/my/activities/${id}`);
  await page.locator("#activity-title").fill("第一次已保存");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存。", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#activity-title")).toHaveValue("第一次已保存");
  await page.locator("#activity-title").fill("第二次尚未保存");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "兑奖", exact: true }).click();
  await expectPathname(page, `/my/activities/${id}`);
  await expect(page.locator("#activity-title")).toHaveValue("第二次尚未保存");
  expect(state.updates).toHaveLength(1);
  expect(state.activity.title).toBe("第一次已保存");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("link", { name: "兑奖", exact: true }).click();
  await expectPathname(page, "/");
});

test("文本奖励初始不显示空值错误，失焦后校验且输入后清除", async ({ page }) => {
  await mockActivities(page);
  await page.goto("/activities/new");
  await chooseSegmented(page, "奖励类型", "文本 / CDK");
  const input = textRewardInput(page);
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("奖励文本不能为空", { exact: true })).toHaveCount(
    0,
  );

  await input.focus();
  await page.locator("#activity-title").focus();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("奖励文本不能为空", { exact: true }),
  ).toBeVisible();

  await input.fill("可领取文本");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("奖励文本不能为空", { exact: true })).toHaveCount(
    0,
  );
});

test("旧版单份文本奖励初始不显示空值错误，失焦后校验且输入后清除", async ({
  page,
}) => {
  const state = await mockActivities(page);
  const config = textConfig(state.activity.config);
  state.activity = {
    ...state.activity,
    totalCount: 2,
    config: {
      ...config,
      rewards: [
        { id: rewardId, text: "" },
        { id: "4ff9d5f4-f6a8-46e9-8d5d-5ff7a4a4ad95", text: "旧版\n多行" },
      ],
    },
  };

  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  const input = page.locator("#activity-text-reward-1");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("奖励文本不能为空", { exact: true })).toHaveCount(
    0,
  );

  await input.focus();
  await page.locator("#activity-title").focus();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("奖励文本不能为空", { exact: true }),
  ).toBeVisible();

  await input.fill("补齐旧版文本");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("奖励文本不能为空", { exact: true })).toHaveCount(
    0,
  );
});

test("单页只在提交时保存，重复文本保留为独立库存，开放后显示公共详情", async ({
  page,
}) => {
  const state = await mockActivities(page);
  await enterMinimalActivity(page);
  await expect(
    page.getByRole("button", { name: "下一步", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#activity-beforeInfo")).not.toBeVisible();
  await expect(page.getByText("批量添加奖励", { exact: true })).toHaveCount(0);
  await expect(page.locator("#activity-bulk-rewards")).toHaveCount(0);
  await textRewardInput(page).fill("私有奖励\n第二行\n重复奖励\n重复奖励");
  await page.locator("summary").filter({ hasText: "更多设置" }).click();
  await page
    .locator("#activity-beforeInfo")
    .fill("## 可见说明\n\n[论坛](https://linux.do)");
  await page.locator("#activity-afterClaimInfo").fill("PRIVATE-AFTER");
  await page.locator("#activity-afterEndInfo").fill("PRIVATE-END");
  expect(state.creates).toHaveLength(0);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expectPathname(page, `/my/activities/${id}`);
  await expect(page.getByText("准备中", { exact: true })).toBeVisible();
  expect(state.creates).toHaveLength(1);
  expect(
    state.creates[0]?.activity.rewards.map((reward) => reward.text),
  ).toEqual(["私有奖励", "第二行", "重复奖励", "重复奖励"]);
  expect(
    new Set(state.creates[0]?.activity.rewards.map((reward) => reward.id)).size,
  ).toBe(4);
  expect(state.csrf).toEqual(["test-csrf"]);
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "查看活动页" }).click();
  await expect(page.getByRole("heading", { name: "可见说明" })).toBeVisible();
  await expect(page.getByText("PRIVATE-AFTER")).toHaveCount(0);
  await expect(page.getByText("PRIVATE-END")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "领取奖励", exact: true }),
  ).toBeVisible();
});

test("保存响应丢失后重试使用原请求标识和原内容", async ({ page }) => {
  const state = await mockActivities(page);
  state.failFirstCreate = true;
  await enterMinimalActivity(page);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText(/尚未确认保存结果/)).toBeVisible();
  await page.getByRole("button", { name: "重试原提交" }).click();
  await expectPathname(page, `/my/activities/${id}`);
  expect(state.creates).toHaveLength(2);
  expect(state.creates[1]).toEqual(state.creates[0]);
});

test("编辑保存响应丢失后用原版本恢复已生效配置", async ({ page }) => {
  const state = await mockActivities(page);
  state.failFirstUpdateResponse = true;
  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await page.locator("#activity-title").fill("响应丢失但已保存");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText(/尚未确认保存结果/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "刷新", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "删除草稿", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "重试原提交" }).click();
  await expect(page.getByText("草稿已保存。", { exact: true })).toBeVisible();
  await expect(page.locator("#activity-title")).toHaveValue("响应丢失但已保存");
  expect(state.updates).toHaveLength(2);
  expect(state.updates[1]).toEqual(state.updates[0]);
  expect(state.activity.version).toBe(2);
});

test("编辑保存并开放响应丢失后恢复配置并继续开放", async ({ page }) => {
  const state = await mockActivities(page);
  state.failFirstUpdateResponse = true;
  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await page.locator("#activity-title").fill("恢复后继续开放");
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await expect(page.getByText(/尚未确认保存结果/)).toBeVisible();
  await page.getByRole("button", { name: "重试原提交" }).click();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  expect(state.updates).toHaveLength(2);
  expect(state.updates[1]).toEqual(state.updates[0]);
  expect(state.opens).toHaveLength(1);
  expect(state.activity.status).toBe("active");
  expect(state.activity.title).toBe("恢复后继续开放");
});

test("编辑响应丢失后账号失效不会把迟到恢复写回表单", async ({ page }) => {
  const state = await mockActivities(page);
  state.failFirstUpdateResponse = true;
  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await page.locator("#activity-title").fill("账号切换前的保存");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText(/尚未确认保存结果/)).toBeVisible();
  state.signedIn = false;
  await page.getByRole("button", { name: "重试原提交" }).click();
  await expect(page.getByText("草稿已保存。", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("main").getByRole("link", { name: "前往登录", exact: true }),
  ).toBeVisible();
});

test("旧版多行文本库存编辑时不按换行拆份或重配ID", async ({ page }) => {
  const state = await mockActivities(page);
  const secondRewardId = "4ff9d5f4-f6a8-46e9-8d5d-5ff7a4a4ad95";
  const config = textConfig(state.activity.config);
  state.activity = {
    ...state.activity,
    totalCount: 2,
    config: {
      ...config,
      rewards: [
        { id: rewardId, text: "PRIVATE-CODE-123\n第二行" },
        { id: secondRewardId, text: "SINGLE-CODE-456" },
      ],
    },
  };

  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();

  await expect(page.locator("#activity-text-rewards")).toHaveCount(0);
  await expect(page.getByText(/为避免静默改变库存/)).toBeVisible();
  await expect(page.locator("#activity-text-reward-1")).toHaveValue(
    "PRIVATE-CODE-123\n第二行",
  );
  await expect(page.locator("#activity-text-reward-2")).toHaveValue(
    "SINGLE-CODE-456",
  );

  await page
    .locator("#activity-text-reward-1")
    .fill("PRIVATE-CODE-123\n第二行已修改");
  await page.getByRole("button", { name: "添加一份奖励", exact: true }).click();
  await page.locator("#activity-text-reward-3").fill("新增奖励\n仍是同一份");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存。", { exact: true })).toBeVisible();

  const rewards = textConfig(state.activity.config).rewards;
  expect(rewards.slice(0, 2)).toEqual([
    { id: rewardId, text: "PRIVATE-CODE-123\n第二行已修改" },
    { id: secondRewardId, text: "SINGLE-CODE-456" },
  ]);
  expect(rewards[2]).toMatchObject({ text: "新增奖励\n仍是同一份" });
  expect(new Set(rewards.map((reward) => reward.id)).size).toBe(3);
  expect(state.activity.totalCount).toBe(3);
});

test("准备中可修改口令尝试统计，冲突核对期间锁定表单并保留输入", async ({
  page,
}) => {
  const state = await mockActivities(page);
  state.conflict = true;
  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await page.locator("summary").filter({ hasText: "更多设置" }).click();
  await expect(page.locator("#activity-forceDedicated")).toBeEnabled();
  await page.locator("#activity-forceDedicated").check();
  await page.locator("#activity-title").fill("尚未保存的改动");
  let releaseRead = () => {};
  let beginRead = () => {};
  const readStarted = new Promise<void>((resolve) => {
    beginRead = resolve;
  });
  const readPending = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route(`**/api/me/activities/${id}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    beginRead();
    await readPending;
    return route.fulfill({ json: { activity: state.activity } });
  });
  try {
    await page.getByRole("button", { name: "保存草稿" }).click();
    await readStarted;
    await expect(page.locator("#activity-title")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "刷新", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "删除草稿", exact: true }),
    ).toBeDisabled();
  } finally {
    releaseRead();
  }
  await expect(
    page.getByText(/活动内容已发生变化，请刷新后再试。/),
  ).toBeVisible();
  await expect(page.locator("#activity-title")).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "刷新", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("#activity-title")).toHaveValue("尚未保存的改动");
  await expect(page.locator("#activity-forceDedicated")).toBeChecked();
  expect(state.updates).toHaveLength(1);
});

test("开放后配置冻结且不能追加口令", async ({ page }) => {
  const state = await mockActivities(page);
  state.activity.status = "active";
  state.activity.openedAt = new Date().toISOString();
  state.activity.deadlineAt = new Date(Date.now() + 86400000).toISOString();
  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "活动与奖励", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("活动名称", { exact: true })).toBeVisible();
  await expect(page.locator("#activity-topicUrl")).toBeEnabled();
  await expect(page.locator("#activity-forceDedicated")).toBeDisabled();
  await expect(page.getByLabel("口令 1", { exact: true })).toBeDisabled();
  await expect(page.locator("#activity-text-reward-1")).toBeDisabled();
  await expect(segmentedOption(page, "发放顺序", "按顺序")).toBeDisabled();
  await expect(segmentedOption(page, "奖励类型", "文本 / CDK")).toBeDisabled();
  await expect(segmentedOption(page, "奖励类型", "LDC 奖励")).toBeDisabled();
  await expect(page.getByRole("button", { name: "添加口令" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "添加一份奖励", exact: true }),
  ).toHaveCount(0);
  await page.locator("#activity-title").fill("开放后只改标题");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("修改已保存。", { exact: true })).toBeVisible();
  expect(state.activity.title).toBe("开放后只改标题");
  expect(state.activity.config.passwords).toEqual(["私人口令ABC"]);
});

test("强制活动草稿不显示尝试统计，开放后显示", async ({ page }) => {
  const state = await mockActivities(page);
  state.activity = {
    ...state.activity,
    forceDedicated: true,
    config: { ...state.activity.config, forceDedicated: true },
  };

  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("button", { name: "查看尝试统计", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "查看活动页", exact: true }).click();
  await page.getByRole("button", { name: "管理活动", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "兑换尝试统计", exact: true }),
  ).toBeVisible();
});

test("作者活动页将分享和管理入口分离", async ({ page }) => {
  const state = await mockActivities(page);
  state.activity = {
    ...state.activity,
    status: "active",
    openedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 86400000).toISOString(),
    config: { ...state.activity.config, forceDedicated: true },
  };

  await page.goto(`/activities/${id}`);
  await expect(
    page.getByRole("button", { name: "分享活动", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "管理活动", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "分享活动", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "复制链接" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "复制分享文案" }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "复制口令1" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "兑换尝试统计" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "管理活动", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "编辑配置" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "兑换尝试统计" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "兑换尝试统计" }).click();
  const statisticsDialog = page.getByRole("dialog", {
    name: "兑换尝试统计",
    exact: true,
  });
  await expect(statisticsDialog).toBeVisible();
  await expect(
    statisticsDialog.locator(".attempt-statistics-summary"),
  ).toContainText("0");
  await expectPathname(page, `/activities/${id}`);
  await page.keyboard.press("Escape");
  await expect(statisticsDialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "管理活动", exact: true }),
  ).toBeFocused();
});

test("匿名用户不能加载作者配置，准备中活动页显示未找到", async ({ page }) => {
  const state = await mockActivities(page);
  state.signedIn = false;
  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("main").getByRole("link", { name: "前往登录" }),
  ).toBeVisible();
  expect(state.privateReads).toBe(0);
  await page.goto(`/activities/${id}`);
  await expect(
    page.getByText("未找到活动，或你无权查看此活动。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(state.activity.title, { exact: true }),
  ).toHaveCount(0);
});

test("公共说明支持安全Markdown，模糊数量且不加载图片或执行HTML", async ({
  page,
}) => {
  const state = await mockActivities(page);
  state.signedIn = false;
  state.activity.status = "active";
  state.activity.config.quantityVisibility = "fuzzy";
  state.activity.config.beforeInfo =
    "## 正常标题\n\n**重点**\n\n[帖子](https://linux.do/t/123)\n\n[站内](../account)\n\n[危险](javascript:alert(1))\n\n![跟踪图](https://example.invalid/tracker.png)\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>";
  const imageRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "image") imageRequests.push(request.url());
  });
  await page.goto(`/activities/${id}`);
  await expect(page.getByRole("heading", { name: "正常标题" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "帖子", exact: true }),
  ).toHaveAttribute("rel", /noopener/);
  await expect(
    page.getByRole("link", { name: "站内", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "危险", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("main img")).toHaveCount(0);
  await expect(page.locator("main script")).toHaveCount(0);
  await expect(
    page.getByText(/剩余.*份|共.*份|已领取.*份|还有奖励/),
  ).toHaveCount(0);
  expect(imageRequests.filter((url) => url.includes("tracker.png"))).toEqual(
    [],
  );
  await expect(page.getByText("PRIVATE-CODE-123")).toHaveCount(0);
});

test("未保存导航可取消，刷新清空表单且不持久化私有输入", async ({ page }) => {
  await mockActivities(page);
  await enterMinimalActivity(page);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "兑奖", exact: true }).click();
  await expectPathname(page, "/activities/new");
  await expect(textRewardInput(page)).toHaveValue("私有奖励\n第二行");
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toMatch(/Answer123|私有奖励/);
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.locator("#activity-title")).toHaveValue("");
});

test("退出时卸载私有编辑器并清除可见奖励", async ({ page }) => {
  await mockActivities(page);
  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#activity-text-reward-1")).toHaveValue(
    "PRIVATE-CODE-123\n第二行",
  );
  await logoutViaAccount(page);
  await expect(
    page.getByRole("main").getByRole("link", {
      name: "通过LINUX DO登录",
      exact: true,
    }),
  ).toBeVisible();
  await expectPathname(page, "/account");
  await expect(textRewardInput(page)).toHaveCount(0);
  await expect(page.locator("#activity-text-reward-1")).toHaveCount(0);
  await expect(
    page.getByText("PRIVATE-CODE-123", { exact: false }),
  ).toHaveCount(0);
});

test("窄屏单页表单与公开长文本不产生横向溢出", async ({ page }) => {
  const state = await mockActivities(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await enterMinimalActivity(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  state.activity.status = "active";
  state.activity.config.beforeInfo = `\`\`\`\n${"very-long-code".repeat(40)}\n\`\`\``;
  await page.goto(`/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: state.activity.title, exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("新活动仅五个口令、精确数量与完整名单默认开启，更多设置初始折叠", async ({
  page,
}) => {
  const state = await mockActivities(page);
  await enterMinimalActivity(page);
  await expect(
    page.getByRole("group", { name: "数量展示", exact: true }),
  ).toBeHidden();
  await expect(page.getByLabel("展示领取名单", { exact: true })).toBeHidden();
  await expect(page.locator("#activity-forceDedicated")).toBeVisible();
  await expect(page.locator("#activity-joinSquare")).toBeEnabled();
  await expect(page.locator("#activity-beforeInfo")).toBeHidden();
  await page.locator("summary").filter({ hasText: "更多设置" }).click();
  await expect(segmentedOption(page, "数量展示", "精确")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("展示领取名单", { exact: true })).toBeChecked();
  for (let n = 2; n <= 5; n++) {
    await page.getByRole("button", { name: "添加口令", exact: true }).click();
    await page.getByLabel(`口令 ${n}`, { exact: true }).fill(`Unique12${n}`);
  }
  await expect(
    page.getByRole("button", { name: "添加口令", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("口令 6", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expectPathname(page, `/my/activities/${id}`);
  expect(state.creates[0]?.activity).toMatchObject({
    quantityVisibility: "exact",
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
  });
});

for (const joinSquare of [false, true])
  for (const topicUrl of ["", "https://linux.do/t/topic/2964597/1216"])
    test(`广场与精确关联独立保存：广场 ${joinSquare}，关联 ${Boolean(topicUrl)}`, async ({
      page,
    }) => {
      const state = await mockActivities(page);
      await enterMinimalActivity(page);
      await page.locator("#activity-topicUrl").fill(topicUrl);
      await page.locator("#activity-joinSquare").setChecked(joinSquare);
      await page.locator("#activity-forceDedicated").check();
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      await expectPathname(page, `/my/activities/${id}`);
      expect(state.creates[0]?.activity).toMatchObject({
        joinSquare,
        topicUrl,
        forceDedicated: true,
      });
    });

test("已加入广场可以清空关联帖子，广场设置仍锁定", async ({ page }) => {
  const state = await mockActivities(page);
  state.activity.config.joinSquare = true;
  state.activity.config.topicUrl = "https://linux.do/t/topic/2964597/1216";
  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#activity-joinSquare")).toBeChecked();
  await expect(page.locator("#activity-joinSquare")).toBeDisabled();
  await page.locator("#activity-topicUrl").fill("");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存。", { exact: true })).toBeVisible();
  expect(state.activity.config).toMatchObject({
    joinSquare: true,
    topicUrl: "",
  });
});

test("更多设置的校验错误即使不是首个也会展开并定位错误", async ({ page }) => {
  await mockActivities(page);
  await enterMinimalActivity(page);
  await page.route("**/api/activities", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: {
          code: "VALIDATION_ERROR",
          message: "请修正配置",
          issues: [
            { path: "activity.title", message: "标题需要修正" },
            { path: "activity.afterEndInfo", message: "结束后说明需要修正" },
          ],
        },
      },
    }),
  );
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.locator("#activity-afterEndInfo")).toBeVisible();
  await expect(page.locator("#activity-errors")).toBeFocused();
  await expect(page.locator("#activity-errors")).toContainText(
    "结束后说明需要修正",
  );
});

test("历史超过五个口令仍可查看且整体锁定，旧数量模式归一为精确", async ({
  page,
}) => {
  const state = await mockActivities(page);
  state.activity.config.passwords = Array.from(
    { length: 6 },
    (_, n) => `Answer12${n}`,
  );
  state.activity.config.quantityVisibility = "availability";
  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  for (let n = 1; n <= 6; n++)
    await expect(page.getByLabel(`口令 ${n}`, { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "添加口令", exact: true }),
  ).toBeDisabled();
  await page.locator("summary").filter({ hasText: "更多设置" }).click();
  await expect(segmentedOption(page, "数量展示", "精确")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#activity-title").fill("历史配置只改标题");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存。", { exact: true })).toBeVisible();
  expect(state.activity.config.passwords).toHaveLength(6);
});

test("删除草稿须确认并携带版本，删除后列表与原详情不再展示", async ({
  page,
}) => {
  const state = await mockActivities(page);
  await page.goto(`/my/activities/${id}`);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "删除草稿", exact: true }).click();
  expect(state.deletes).toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除草稿", exact: true }).click();
  await expectPathname(page, "/my/activities");
  expect(state.deletes).toBe(1);
  await expect(
    page.getByText(state.activity.title, { exact: true }),
  ).toHaveCount(0);
  await page.goto(`/my/activities/${id}`);
  await expect(page.getByText(/未找到活动/)).toBeVisible();
});

test("陈旧删除保留草稿，已开放活动不显示删除", async ({ page }) => {
  const state = await mockActivities(page);
  state.conflict = true;
  await page.goto(`/my/activities/${id}`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除草稿", exact: true }).click();
  await expect(
    page.getByText(/活动内容已发生变化，请刷新后再试。/),
  ).toBeVisible();
  expect(state.deleted).toBe(false);
  state.activity.status = "active";
  state.activity.openedAt = new Date().toISOString();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "删除草稿", exact: true }),
  ).toHaveCount(0);
});

test("保存并开放的开放响应丢失后只读恢复结果，不重复保存或开放", async ({
  page,
}) => {
  const state = await mockActivities(page);
  state.failFirstOpenResponse = true;
  await enterMinimalActivity(page);
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await expectPathname(page, `/my/activities/${id}`);
  await expect(page.getByText("进行中", { exact: true }).first()).toBeVisible();
  expect(state.creates).toHaveLength(1);
  expect(state.opens).toHaveLength(1);
});

test("保存并开放请求未完成时退出，迟到保存响应不导航或继续开放", async ({
  page,
}) => {
  const state = await mockActivities(page);
  state.delayCreate = true;
  await enterMinimalActivity(page);
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await expect.poll(() => Boolean(state.releaseCreate)).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await logoutViaAccount(page);
  state.releaseCreate?.();
  await expect(
    page.getByRole("main").getByRole("link", {
      name: "通过LINUX DO登录",
      exact: true,
    }),
  ).toBeVisible();
  await expectPathname(page, "/account");
  expect(state.opens).toHaveLength(0);
  await expect(textRewardInput(page)).toHaveCount(0);
  await expect(page.locator("#activity-text-reward-1")).toHaveCount(0);
  await expect(page.getByText("私有奖励", { exact: false })).toHaveCount(0);
});
