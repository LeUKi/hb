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
    failFirstOpenResponse: false,
    delayCreate: false,
    releaseCreate: undefined as (() => void) | undefined,
    creates: [] as (CreateActivityInput & { activity: TextActivityInput })[],
    csrf: [] as (string | undefined)[],
    privateReads: 0,
    deleted: false,
    deletes: 0,
    opens: [] as { version: number }[],
  };
  await page.route("**/api/me", (route) =>
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
    if (state.deleted && pathname === `/api/me/activities/${id}`)
      return route.fulfill({
        status: 404,
        json: { error: { code: "ACTIVITY_NOT_FOUND", message: "活动不存在" } },
      });
    if (pathname.endsWith("/claims"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
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
      const body = request.postDataJSON() as UpdateActivityInput & {
        activity: TextActivityInput;
      };
      state.activity = {
        ...state.activity,
        config: body.activity,
        title: body.activity.title,
        version: state.activity.version + 1,
        totalCount: body.activity.rewards.length,
      };
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
  await page.locator("#activity-title").fill("新文本活动");
  await page.getByLabel("口令 1", { exact: true }).fill("Answer123");
  await page.getByLabel("奖励 1", { exact: true }).fill("私有奖励\n第二行");
}

test("文本活动创建和开放不读取商户或检查凭证", async ({ page }) => {
  const state = await mockActivities(page);
  let merchantRequests = 0;
  await page.route("**/api/me/merchants**", async (route) => {
    merchantRequests++;
    await route.abort("failed");
  });
  await enterMinimalActivity(page);
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await expect(page).toHaveURL(`/my/activities/${id}`);
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  expect(state.activity.status).toBe("active");
  expect(merchantRequests).toBe(0);
});

test("单页只在提交时保存，重复文本保留为独立库存，开放后显示公共详情", async ({
  page,
}) => {
  const state = await mockActivities(page);
  await enterMinimalActivity(page);
  await expect(
    page.getByRole("button", { name: "下一步", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("领取前说明", { exact: true }),
  ).not.toBeVisible();
  await page.getByText("批量添加奖励", { exact: true }).click();
  await page.getByLabel("批量添加：每行一份").fill("重复奖励\n重复奖励");
  await page.getByRole("button", { name: "添加这些奖励" }).click();
  await page.locator("summary").filter({ hasText: "更多设置" }).click();
  await page
    .getByLabel("领取前说明", { exact: true })
    .fill("## 可见说明\n\n[论坛](https://linux.do)");
  await page.getByLabel("领取后说明", { exact: true }).fill("PRIVATE-AFTER");
  await page.getByLabel("结束后说明", { exact: true }).fill("PRIVATE-END");
  expect(state.creates).toHaveLength(0);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page).toHaveURL(`/my/activities/${id}`);
  await expect(page.getByText("准备中", { exact: true })).toBeVisible();
  expect(state.creates).toHaveLength(1);
  expect(
    state.creates[0]?.activity.rewards.map((reward) => reward.text),
  ).toEqual(["私有奖励\n第二行", "重复奖励", "重复奖励"]);
  expect(
    new Set(state.creates[0]?.activity.rewards.map((reward) => reward.id)).size,
  ).toBe(3);
  expect(state.csrf).toEqual(["test-csrf"]);
  await page.getByRole("button", { name: "开放领取", exact: true }).click();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "查看专属页" }).click();
  await expect(page.getByRole("heading", { name: "可见说明" })).toBeVisible();
  await expect(page.getByText("PRIVATE-AFTER")).toHaveCount(0);
  await expect(page.getByText("PRIVATE-END")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "领取", exact: true }),
  ).toBeVisible();
});

test("保存响应丢失后重试使用原请求标识和原内容", async ({ page }) => {
  const state = await mockActivities(page);
  state.failFirstCreate = true;
  await enterMinimalActivity(page);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText(/尚未确认保存结果/)).toBeVisible();
  await page.getByRole("button", { name: "重试原提交" }).click();
  await expect(page).toHaveURL(`/my/activities/${id}`);
  expect(state.creates).toHaveLength(2);
  expect(state.creates[1]).toEqual(state.creates[0]);
});

test("准备中专属设置锁定，编辑冲突保留输入", async ({ page }) => {
  const state = await mockActivities(page);
  state.conflict = true;
  await page.goto(`/my/activities/${id}`);
  await page.getByRole("button", { name: "编辑活动" }).click();
  await page.locator("summary").filter({ hasText: "更多设置" }).click();
  await expect(page.locator("#activity-forceDedicated")).toBeDisabled();
  await page.locator("#activity-title").fill("尚未保存的改动");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText(/当前输入已保留/)).toBeVisible();
  await expect(page.locator("#activity-title")).toHaveValue("尚未保存的改动");
});

test("开放后配置冻结而仍能追加新口令", async ({ page }) => {
  const state = await mockActivities(page);
  state.activity.status = "active";
  state.activity.openedAt = new Date().toISOString();
  state.activity.deadlineAt = new Date(Date.now() + 86400000).toISOString();
  await page.goto(`/my/activities/${id}`);
  await page.getByRole("button", { name: "编辑活动" }).click();
  await expect(page.locator("#activity-topicUrl")).toBeEnabled();
  await expect(page.locator("#activity-forceDedicated")).toBeDisabled();
  await expect(page.getByLabel("口令 1", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("奖励 1", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "奖励方式", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "添加口令" }).click();
  await page.getByLabel("口令 2", { exact: true }).fill("Another123");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("修改已保存。", { exact: true })).toBeVisible();
  expect(state.activity.config.passwords).toEqual([
    "私人口令ABC",
    "Another123",
  ]);
});

test("匿名用户不能加载作者配置，准备中专属页显示未找到", async ({ page }) => {
  const state = await mockActivities(page);
  state.signedIn = false;
  await page.goto(`/my/activities/${id}`);
  await expect(
    page.getByRole("link", { name: "登录 Linux DO 账号" }),
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
  await expect(page.getByText(/剩余.*份|共.*份|还有奖励/)).toHaveCount(0);
  expect(imageRequests.filter((url) => url.includes("tracker.png"))).toEqual(
    [],
  );
  await expect(page.getByText("PRIVATE-CODE-123")).toHaveCount(0);
});

test("未保存导航可取消，刷新清空表单且不持久化私有输入", async ({ page }) => {
  await mockActivities(page);
  await enterMinimalActivity(page);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "首页", exact: true }).click();
  await expect(page).toHaveURL("/activities/new");
  await expect(page.getByLabel("奖励 1", { exact: true })).toHaveValue(
    "私有奖励\n第二行",
  );
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
  await page.getByRole("button", { name: "编辑活动" }).click();
  await expect(page.getByLabel("奖励 1", { exact: true })).toHaveValue(
    "PRIVATE-CODE-123\n第二行",
  );
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "登录 Linux DO 账号" }),
  ).toBeVisible();
  await expect(page.getByLabel("奖励 1", { exact: true })).toHaveCount(0);
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
  await expect(page.locator("#activity-quantityVisibility")).toHaveValue(
    "exact",
  );
  await expect(page.getByLabel("展示领取名单", { exact: true })).toBeChecked();
  await expect(page.getByLabel("领取前说明", { exact: true })).toBeHidden();
  for (let n = 2; n <= 5; n++) {
    await page.getByRole("button", { name: "添加口令", exact: true }).click();
    await page.getByLabel(`口令 ${n}`, { exact: true }).fill(`Unique12${n}`);
  }
  await expect(
    page.getByRole("button", { name: "添加口令", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("口令 6", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page).toHaveURL(`/my/activities/${id}`);
  expect(state.creates[0]?.activity).toMatchObject({
    quantityVisibility: "exact",
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
  });
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
  await page.getByRole("button", { name: "编辑活动", exact: true }).click();
  for (let n = 1; n <= 6; n++)
    await expect(page.getByLabel(`口令 ${n}`, { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "添加口令", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#activity-quantityVisibility")).toHaveValue(
    "exact",
  );
  await page.locator("#activity-title").fill("历史配置只改标题");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("修改已保存。", { exact: true })).toBeVisible();
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
  await expect(page).toHaveURL("/my/activities");
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
  await expect(page.getByText(/活动已在其他页面修改/)).toBeVisible();
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
  await expect(page).toHaveURL(`/my/activities/${id}`);
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
  await page.getByRole("button", { name: "退出", exact: true }).click();
  state.releaseCreate?.();
  await expect(
    page.getByRole("link", { name: "登录 Linux DO 账号", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL("/activities/new");
  expect(state.opens).toHaveLength(0);
  await expect(page.getByLabel("奖励 1", { exact: true })).toHaveCount(0);
});
