import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  type AuthorClaim,
  type AuthorRegistration,
  type ClaimDetail,
  emptyActivityInput,
  type ManagedActivity,
  type PublicActivity,
  type PublicRecipient,
} from "../packages/contracts/src";

const activityId = "61111111-1111-4111-8111-111111111111";
const title = "人数与名单同步刷新";
const owner = {
  id: "roster-author",
  username: "maker",
  displayName: "名单活动作者",
  avatarUrl: null,
  accountTier: "standard" as const,
  loginProvider: "connect" as const,
  canUseLdc: true,
  isAdmin: false,
};
const viewer = {
  ...owner,
  id: "roster-viewer",
  username: "viewer",
  displayName: "名单查看者",
};
const deadline = new Date(Date.now() + 86_400_000).toISOString();

function gate() {
  let release = () => {};
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    started,
    wait: () => {
      markStarted();
      return pending;
    },
  };
}

function recipient(index: number, prefix = "user"): PublicRecipient {
  return {
    id: `${prefix}-${String(index).padStart(3, "0")}`,
    username: `${prefix}${index}`,
    displayName: `${prefix === "user" ? "名单参与者" : "新增参与者"} ${index}`,
    avatarUrl: null,
    accountTier: "standard",
    claimedAt: new Date(Date.now() - index * 1_000).toISOString(),
  };
}

async function focusPage(page: Page) {
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
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    if (previous) Object.defineProperty(document, "visibilityState", previous);
    else Reflect.deleteProperty(document, "visibilityState");
  });
}

async function visibility(page: Page, value: "visible" | "hidden") {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: next,
    });
    window.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}

async function mockRoster(
  page: Page,
  options: {
    count?: number;
    draw?: boolean;
    author?: boolean;
    motion?: boolean;
    longName?: string;
  } = {},
) {
  const state = {
    user: options.author ? owner : viewer,
    openedAt: new Date(Date.now() - 3_600_000).toISOString(),
    showTime: true,
    rows: Array.from({ length: options.count ?? 1 }, (_, index) => ({
      ...recipient(index + 1),
      ...(index === 0 && options.longName
        ? { displayName: options.longName }
        : {}),
    })),
    claimRows: options.draw ? ([] as PublicRecipient[]) : null,
    allowed: true,
    publicGate: null as ReturnType<typeof gate> | null,
    listGate: null as ReturnType<typeof gate> | null,
    claimsGate: null as ReturnType<typeof gate> | null,
    failList: 0,
    failClaims: 0,
    failManaged: 0,
    failCursor: null as string | null,
    requests: [] as { path: string; cursor: string | null }[],
    writes: [] as string[],
    external: [] as string[],
  };
  const draw = options.draw ?? false;
  await page.emulateMedia({
    reducedMotion: options.motion ? "no-preference" : "reduce",
  });
  function publicActivity(): PublicActivity {
    return {
      id: activityId,
      title,
      rewardType: "ldc",
      status: "active",
      paymentMode: "simulation",
      author: owner,
      forceDedicated: true,
      topicUrl: null,
      openedAt: state.openedAt,
      deadlineAt: deadline,
      quantity: {
        mode: "exact",
        total: 100,
        claimed: draw ? 0 : state.rows.length,
        remaining: draw ? 100 : 100 - state.rows.length,
      },
      showRecipientList: state.allowed,
      showRecipientUsername: true,
      showRecipientTime: state.showTime,
      beforeInfo: "名单和人数必须在同一刷新轮次完成后一起更新。",
      reward: draw
        ? {
            mode: "timed_draw",
            totalAmount: "0.30",
            count: 3,
            participantLimit: 100,
          }
        : { mode: "fixed", unitAmount: "0.10", count: 100 },
      ...(draw
        ? {
            draw: {
              state: "waiting" as const,
              registeredCount: state.rows.length,
              winnerCount: 3,
              participantLimit: 100,
              deadlineAt: deadline,
              closedAt: null,
              reason: null,
            },
          }
        : {}),
    };
  }
  function managed(): ManagedActivity {
    const common = {
      ...emptyActivityInput(),
      title,
      passwords: ["RosterPass123"],
      forceDedicated: true,
    };
    const activity = publicActivity();
    return {
      id: activityId,
      title,
      author: owner,
      rewardType: activity.rewardType,
      status: "active",
      forceDedicated: true,
      version: 2,
      createdAt: activity.openedAt ?? deadline,
      openedAt: activity.openedAt,
      deadlineAt: deadline,
      topicUrl: null,
      totalCount: draw ? 3 : 100,
      claimedCount: draw ? 0 : state.rows.length,
      draw: activity.draw,
      config: draw
        ? {
            ...common,
            rewardType: "ldc",
            allocation: "random",
            merchantId: "62222222-2222-4222-8222-222222222222",
            money: {
              mode: "timed_draw",
              algorithm: "double_mean_v1",
              totalAmount: "0.30",
              count: 3,
              participantLimit: 100,
              countdownSeconds: 86_400,
              distributeFullPool: true,
            },
          }
        : common,
    };
  }
  function rowsPage(cursor: string | null, rows = state.rows) {
    const after = cursor?.replace(/^after:/, "");
    const start = after ? rows.findIndex((row) => row.id === after) + 1 : 0;
    const items = rows.slice(start, start + 20);
    const tail = items.at(-1);
    return {
      items,
      nextCursor:
        start + items.length < rows.length && tail ? `after:${tail.id}` : null,
    };
  }
  const paper: ClaimDetail = {
    id: "roster-paper-result",
    activity: { id: activityId, title, status: "active" },
    rewardType: "ldc",
    claimedAt: new Date().toISOString(),
    amount: "0.19",
    payment: {
      id: "roster-paper-payment",
      mode: "simulation",
      status: "confirmed",
      reason: null,
      confirmedAt: deadline,
    },
    afterClaimInfo: "名单刷新不会再次开封。",
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      state.external.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    const cursor = url.searchParams.get("cursor");
    state.requests.push({ path, cursor });
    if (request.method() !== "GET") state.writes.push(path);
    if (path === "/api/session" || path === "/api/me")
      return route.fulfill({
        json: {
          user: state.user,
          csrfToken: "csrf",
          loginOptions: { liteauthEnabled: true },
          attemptCooldown: null,
        },
      });
    if (path === `/api/activities/${activityId}`) {
      const activity = structuredClone(publicActivity());
      await state.publicGate?.wait();
      return route.fulfill({ json: { activity } });
    }
    if (
      path === `/api/activities/${activityId}/recipients` ||
      path === `/api/activities/${activityId}/registrations`
    ) {
      const pageResult = rowsPage(cursor);
      const payload = {
        enabled: state.allowed,
        items: state.allowed
          ? pageResult.items.map((row) =>
              path.endsWith("/registrations")
                ? { ...row, registeredAt: row.claimedAt }
                : row,
            )
          : [],
        nextCursor: state.allowed ? pageResult.nextCursor : null,
      };
      await state.listGate?.wait();
      if (
        state.failList > 0 ||
        (cursor !== null && cursor === state.failCursor)
      ) {
        state.failList = Math.max(0, state.failList - 1);
        state.failCursor = null;
        return route.fulfill({
          status: 500,
          json: { error: { code: "UNAVAILABLE", message: "名单暂时不可用" } },
        });
      }
      return route.fulfill({ json: payload });
    }
    if (path === `/api/activities/${activityId}/participation`)
      return route.fulfill({
        json: {
          claim: draw || state.user.id !== viewer.id ? null : paper,
          registration: null,
        },
      });
    if (path === `/api/activities/${activityId}/passwords`)
      return route.fulfill({
        json: { passwords: [], hiddenCount: 1, canSolve: false },
      });
    if (path === `/api/me/activities/${activityId}`) {
      if (state.failManaged || state.user.id !== owner.id)
        return route.fulfill({
          status: 403,
          json: { error: { code: "FORBIDDEN", message: "无权读取活动" } },
        });
      return route.fulfill({ json: { activity: managed() } });
    }
    if (path === `/api/me/activities/${activityId}/claims`) {
      const result = rowsPage(cursor, state.claimRows ?? state.rows);
      const items: AuthorClaim[] = result.items.map((row) => ({
        id: row.id,
        claimant: row,
        activity: { id: activityId, title, status: "active" },
        claimedAt: row.claimedAt ?? deadline,
        ...(row.speedTitle ? { speedTitle: row.speedTitle } : {}),
        rewardType: "ldc",
        amount: "0.10",
        payment: {
          id: `payment-${row.id}`,
          mode: "simulation",
          status: "confirmed",
          reason: null,
          confirmedAt: deadline,
        },
      }));
      await state.claimsGate?.wait();
      if (state.failClaims > 0) {
        state.failClaims--;
        return route.fulfill({
          status: 500,
          json: {
            error: { code: "UNAVAILABLE", message: "领取记录暂时不可用" },
          },
        });
      }
      return route.fulfill({ json: { items, nextCursor: result.nextCursor } });
    }
    if (path === `/api/me/activities/${activityId}/registrations`) {
      const result = rowsPage(cursor);
      const items: AuthorRegistration[] = result.items.map((row) => ({
        id: row.id,
        participant: row,
        activity: { id: activityId, title, status: "active" },
        registeredAt: row.claimedAt ?? deadline,
        status: "registered",
        drawAt: deadline,
        claim: null,
      }));
      await state.listGate?.wait();
      if (state.failList > 0) {
        state.failList--;
        return route.fulfill({
          status: 500,
          json: {
            error: { code: "UNAVAILABLE", message: "报名记录暂时不可用" },
          },
        });
      }
      return route.fulfill({ json: { items, nextCursor: result.nextCursor } });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "未找到" } },
    });
  });
  return state;
}

function reads(state: Awaited<ReturnType<typeof mockRoster>>, suffix: string) {
  return state.requests.filter(
    (request) => request.path === `/api/activities/${activityId}${suffix}`,
  ).length;
}

async function openPublic(page: Page, draw = false) {
  await page.goto(`/activities/${activityId}`);
  await page
    .getByRole("button", {
      name: draw ? "查看报名名单" : "查看领取名单",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog.locator(".recipient").first()).toBeVisible();
  return dialog;
}

async function listedIds(dialog: Locator) {
  return dialog
    .locator(".recipient")
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-record-id")),
    );
}

test("公共人数与名单同轮公布，手动/焦点合并慢请求，五秒轮询只在可见时运行且不重播红包", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await mockRoster(page, { motion: true });
  const dialog = await openPublic(page);
  const envelope = page.locator('[data-testid="envelope"]');
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  const refresh = dialog.getByRole("button", {
    name: /^刷新领取名单/,
  });
  const before = {
    public: reads(state, ""),
    list: reads(state, "/recipients"),
  };
  const slow = gate();
  state.rows = [recipient(1, "new"), ...state.rows];
  state.listGate = slow;
  try {
    await refresh.click();
    await slow.started;
    await expect(
      page.getByText("已领取 1 / 100 份", { exact: true }),
    ).toBeVisible();
    await expect(dialog.locator(".recipient")).toHaveCount(1);
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute("aria-disabled", "true");
    await expect(refresh).toBeFocused();
    await refresh.dispatchEvent("click");
    await focusPage(page);
    await page.waitForTimeout(180);
    expect(reads(state, "")).toBe(before.public + 1);
    expect(reads(state, "/recipients")).toBe(before.list + 1);
    await expect(refresh).toBeFocused();
    slow.release();
    state.listGate = null;
    await expect(
      dialog.getByText("新增参与者 1", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("已领取 2 / 100 份", { exact: true }),
    ).toBeVisible();
    await expect(refresh).toBeEnabled();
    await expect(refresh).toBeFocused();
    state.rows = [recipient(2, "new"), ...state.rows];
    await expect(dialog.getByText("新增参与者 2", { exact: true })).toBeVisible(
      { timeout: 7_000 },
    );
    await expect(
      page.getByText("已领取 3 / 100 份", { exact: true }),
    ).toBeVisible();
    await visibility(page, "hidden");
    const hiddenReads = {
      public: reads(state, ""),
      list: reads(state, "/recipients"),
    };
    await page.waitForTimeout(5_250);
    expect(reads(state, "")).toBe(hiddenReads.public);
    expect(reads(state, "/recipients")).toBe(hiddenReads.list);
    await visibility(page, "visible");
    await expect(envelope).toHaveAttribute("data-opening-count", "1");
    await expect(envelope).toHaveAttribute("data-phase", "open");
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(refresh).toBeEnabled();
    const close = dialog.getByRole("button", { name: "关闭", exact: true });
    const refreshBox = await refresh.boundingBox();
    const closeBox = await close.boundingBox();
    expect(refreshBox).not.toBeNull();
    expect(closeBox).not.toBeNull();
    if (!refreshBox || !closeBox) throw new Error("名单顶栏操作不可见");
    expect(closeBox.x).toBeGreaterThan(refreshBox.x);
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(768);
    expect(
      Math.abs(
        closeBox.y +
          closeBox.height / 2 -
          (refreshBox.y + refreshBox.height / 2),
      ),
    ).toBeLessThanOrEqual(4);
    await refresh.focus();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "查看领取名单", exact: true }),
    ).toBeFocused();
    await expect(envelope).toHaveAttribute("data-opening-count", "1");
    expect(state.writes).toEqual([]);
    expect(state.external).toEqual([]);
  } finally {
    slow.release();
  }
});

test("手机已加载两页从新头部重建游标，保留行锚点和焦点，追加失败可重试且缓存返回复用", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const state = await mockRoster(page, { count: 60 });
  const dialog = await openPublic(page);
  await expect(
    page.getByText("已领取 60 / 100 份", { exact: true }),
  ).toBeVisible();
  const list = dialog.getByRole("region", { name: "领取记录", exact: true });
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(dialog.locator(".recipient")).toHaveCount(40);
  const anchor = dialog.locator('[data-record-id="user-025"]');
  await anchor.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const anchorButton = anchor.getByRole("button", {
    name: "名单参与者 25",
    exact: true,
  });
  await anchorButton.focus();
  await expect(dialog.locator(".recipient")).toHaveCount(40);
  const before = await anchor.evaluate(
    (node) =>
      node.getBoundingClientRect().top -
      (node.closest(".recipient-list")?.getBoundingClientRect().top ?? 0),
  );
  state.rows = [
    recipient(1, "new"),
    recipient(2, "new"),
    recipient(3, "new"),
    recipient(4, "new"),
    ...state.rows,
  ];
  await dialog.getByRole("button", { name: /^刷新领取名单/ }).click();
  await expect
    .poll(() => listedIds(dialog))
    .toEqual(state.rows.slice(0, 40).map((row) => row.id));
  await expect(
    page.getByText("已领取 64 / 100 份", { exact: true }),
  ).toBeVisible();
  // Clicking refresh changes focus intentionally; restore the reader's focus
  // before a background round to verify that polling preserves it.
  await anchorButton.focus();
  const refreshBefore = reads(state, "/recipients");
  await focusPage(page);
  await expect
    .poll(() => reads(state, "/recipients"))
    .toBeGreaterThan(refreshBefore);
  await expect(anchorButton).toBeFocused();
  const after = await anchor.evaluate(
    (node) =>
      node.getBoundingClientRect().top -
      (node.closest(".recipient-list")?.getBoundingClientRect().top ?? 0),
  );
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  expect(new Set(await listedIds(dialog)).size).toBe(40);
  state.failCursor = `after:${state.rows[39]?.id}`;
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(
    dialog.getByText("后续记录读取失败，可重试加载。", { exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".recipient")).toHaveCount(40);
  await dialog.getByRole("button", { name: "重试加载", exact: true }).click();
  await expect(dialog.locator(".recipient")).toHaveCount(60);
  const beforeReturn = reads(state, "/recipients");
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await page.goForward();
  await expect(dialog.locator(".recipient")).toHaveCount(60);
  expect(reads(state, "/recipients")).toBe(beforeReturn);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(state.external).toEqual([]);
});

test("公共整轮失败保留旧人数与记录，权限关闭立即清除，换账号后迟到名单不回填", async ({
  page,
}) => {
  const state = await mockRoster(page);
  const dialog = await openPublic(page);
  const refresh = dialog.getByRole("button", {
    name: /^刷新领取名单/,
  });
  state.rows = [recipient(1, "new"), ...state.rows];
  state.failList = 1;
  await refresh.click();
  await expect(refresh).toHaveText("刷新失败");
  await expect(dialog.locator(".refresh-notice")).toHaveCount(0);
  await expect(
    page.getByText("已领取 1 / 100 份", { exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".recipient")).toHaveCount(1);
  await expect(dialog.getByText("新增参与者 1", { exact: true })).toHaveCount(
    0,
  );
  await refresh.click();
  await expect(dialog.locator(".recipient")).toHaveCount(2);
  await expect(
    page.getByText("已领取 2 / 100 份", { exact: true }),
  ).toBeVisible();
  state.allowed = false;
  await refresh.click();
  await expect(page.locator(".public-roster-dialog .recipient")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "查看领取名单", exact: true }),
  ).toHaveCount(0);
  if (await dialog.count()) await page.keyboard.press("Escape");
  state.allowed = true;
  await focusPage(page);
  const opener = page.getByRole("button", {
    name: "查看领取名单",
    exact: true,
  });
  const reopenedRecipients = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/activities/${activityId}/recipients` &&
      response.status() === 200
    );
  });
  await opener.click();
  await reopenedRecipients;
  const reopenedDialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(reopenedDialog.locator(".recipient")).toHaveCount(2);
  const reopenedRefresh = reopenedDialog.getByRole("button", {
    name: /^刷新领取名单/,
  });
  const late = gate();
  state.listGate = late;
  try {
    await reopenedRefresh.click();
    await late.started;
    const sessionResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/session",
    );
    state.user = {
      ...viewer,
      id: "second-roster-account",
      username: "second",
      displayName: "另一个账号",
    };
    state.allowed = false;
    await focusPage(page);
    await sessionResponse;
    await expect(dialog).toHaveCount(0);
    late.release();
    state.listGate = null;
    await expect(
      page.getByRole("button", { name: "查看领取名单", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".public-roster-dialog .recipient")).toHaveCount(
      0,
    );
    await expect(
      page.locator(".envelope-svg .prize", { hasText: "+0.19" }),
    ).toHaveCount(0);
    expect(state.writes).toEqual([]);
    expect(state.external).toEqual([]);
  } finally {
    late.release();
  }
});

test("作者在活动页名单中同步刷新人数与私有记录，合并在途请求且失败保留整轮", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await mockRoster(page, { author: true, draw: true });
  const registrations = await openPublic(page, true);
  const count = registrations.locator(".public-roster__summary");
  await expect(count).toContainText("报名 1 人");
  await expect(
    registrations.getByText("名单参与者 1", { exact: true }),
  ).toBeVisible();
  const refresh = registrations.getByRole("button", {
    name: /^刷新报名名单/,
  });
  const before = state.requests.length;
  state.rows = [recipient(1, "new"), ...state.rows];
  const slow = gate();
  state.listGate = slow;
  try {
    await refresh.click();
    await slow.started;
    await expect(count).toContainText("报名 1 人");
    await expect(
      registrations.getByText("新增参与者 1", { exact: true }),
    ).toHaveCount(0);
    await expect(refresh).toBeDisabled();
    await focusPage(page);
    await page.waitForTimeout(180);
    for (const suffix of ["", "/registrations"])
      expect(
        state.requests
          .slice(before)
          .filter(
            (request) =>
              request.path === `/api/me/activities/${activityId}${suffix}`,
          ),
      ).toHaveLength(1);
    slow.release();
    state.listGate = null;
    await expect(count).toContainText("报名 2 人");
    await expect(
      registrations.getByText("新增参与者 1", { exact: true }),
    ).toBeVisible();
    expect(
      state.requests.some(
        (request) => request.path === `/api/me/activities/${activityId}/claims`,
      ),
    ).toBe(false);
    state.rows = [recipient(2, "new"), ...state.rows];
    await expect(count).toContainText("报名 3 人", { timeout: 7_000 });
    await expect(
      registrations.getByText("新增参与者 2", { exact: true }),
    ).toBeVisible();
    state.rows = [recipient(3, "new"), ...state.rows];
    state.failList = 1;
    await refresh.click();
    await expect(refresh).toHaveText("刷新失败");
    await expect(count).toContainText("报名 3 人");
    await expect(
      registrations.getByText("新增参与者 3", { exact: true }),
    ).toHaveCount(0);
    await refresh.click();
    await expect(count).toContainText("报名 4 人");
    await expect(
      registrations.getByText("新增参与者 3", { exact: true }),
    ).toBeVisible();

    expect(state.writes).toEqual([]);
    expect(state.external).toEqual([]);
  } finally {
    slow.release();
  }
});

test("关闭公开名单后作者仍使用唯一入口查看付款明细，长名称和分页刷新保留全部记录且403清除", async ({
  page,
}) => {
  const longName = `很长的领取者名称${"长昵称".repeat(40)}`;
  const state = await mockRoster(page, {
    author: true,
    count: 25,
    longName,
  });
  state.allowed = false;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/activities/${activityId}`);
  const opener = page.getByRole("button", {
    name: "查看领取名单",
    exact: true,
  });
  await expect(opener).toHaveCount(1);
  expect(
    state.requests.filter(
      (request) => request.path === `/api/me/activities/${activityId}/claims`,
    ),
  ).toEqual([]);
  await opener.click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog.locator(".recipient")).toHaveCount(20);
  await expect(dialog.getByText(longName, { exact: true })).toBeVisible();
  await expect(dialog.locator(".recipient-private").first()).toContainText(
    "0.10 LDC",
  );
  await expect(dialog.locator(".recipient-private").first()).toContainText(
    "模拟发放已确认",
  );
  const layout = await dialog
    .locator(".recipient")
    .first()
    .evaluate((row) => {
      const bounds = (selector: string) => {
        const node = row.querySelector(selector);
        if (!node) throw new Error(`Missing roster row element: ${selector}`);
        const rect = node.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
        };
      };
      const list = row.closest(".recipient-list");
      const modal = row.closest("dialog");
      if (!list || !modal) throw new Error("Missing roster modal or list");
      const listBounds = list.getBoundingClientRect();
      const modalBounds = modal.getBoundingClientRect();
      return {
        profile: bounds(".user-identity"),
        time: bounds(".recipient-time"),
        details: bounds(".recipient-private"),
        amount: bounds(".recipient-private span"),
        list: { left: listBounds.left, right: listBounds.right },
        modal: { left: modalBounds.left, right: modalBounds.right },
        listOverflows: list.scrollWidth > list.clientWidth,
        pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
  expect(layout.details.top).toBeGreaterThanOrEqual(layout.profile.bottom);
  expect(layout.details.top).toBeGreaterThanOrEqual(layout.time.bottom);
  expect(layout.amount.left).toBeGreaterThanOrEqual(layout.list.left);
  expect(layout.amount.right).toBeLessThanOrEqual(layout.list.right);
  expect(layout.modal.left).toBeGreaterThanOrEqual(0);
  expect(layout.modal.right).toBeLessThanOrEqual(375);
  expect(layout.listOverflows).toBe(false);
  expect(layout.pageOverflows).toBe(false);
  await dialog.locator(".recipient-list").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(dialog.locator(".recipient")).toHaveCount(25);
  expect(
    state.requests.some(
      (request) =>
        request.path === `/api/me/activities/${activityId}/claims` &&
        request.cursor === "after:user-020",
    ),
  ).toBe(true);
  state.rows = [recipient(1, "new"), ...state.rows];
  const refresh = dialog.getByRole("button", {
    name: /^刷新领取名单/,
  });
  await refresh.click();
  await expect(dialog.locator(".recipient")).toHaveCount(26);
  const ids = await listedIds(dialog);
  expect(new Set(ids).size).toBe(26);
  expect(
    state.requests.filter(
      (request) => request.path === `/api/activities/${activityId}/recipients`,
    ),
  ).toEqual([]);
  state.failManaged = 1;
  await refresh.click();
  await expect(
    page.locator(".public-roster-dialog .recipient-private"),
  ).toHaveCount(0);
  await expect(page.getByText(longName, { exact: true })).toHaveCount(0);
  await expect(opener).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.external).toEqual([]);
});

test("作者报名和中奖名单共享弹窗并保留报名状态、开奖时间及付款状态", async ({
  page,
}) => {
  const state = await mockRoster(page, { author: true, draw: true });
  state.allowed = false;
  state.claimRows = [recipient(1)];
  const dialog = await openPublic(page, true);
  await expect(dialog.getByText("已报名", { exact: true })).toBeVisible();
  await expect(dialog.locator(".recipient-private")).toContainText("开奖");
  await dialog.getByRole("tab", { name: "中奖名单", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: title, exact: true }),
  ).toHaveCount(1);
  await expect(dialog.locator(".recipient")).toHaveCount(1);
  await expect(
    dialog.getByText("模拟发放已确认", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("本地模拟", { exact: true })).toBeVisible();
  expect(
    state.requests.some(
      (request) =>
        request.path === `/api/me/activities/${activityId}/registrations`,
    ),
  ).toBe(true);
  expect(
    state.requests.some(
      (request) => request.path === `/api/me/activities/${activityId}/claims`,
    ),
  ).toBe(true);
  expect(
    state.requests.some(
      (request) =>
        request.path === `/api/activities/${activityId}/recipients` ||
        request.path === `/api/activities/${activityId}/registrations`,
    ),
  ).toBe(false);
});

test("普通用户保持公开名单权限且不读取作者配置或私有记录", async ({ page }) => {
  const state = await mockRoster(page, { count: 2 });
  const dialog = await openPublic(page);
  await expect(dialog.locator(".recipient")).toHaveCount(2);
  await expect(dialog.getByText("查看已分配文本", { exact: true })).toHaveCount(
    0,
  );
  expect(
    state.requests.filter((request) =>
      request.path.startsWith(`/api/me/activities/${activityId}`),
    ),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  state.allowed = false;
  await focusPage(page);
  await expect(
    page.getByRole("button", { name: "查看领取名单", exact: true }),
  ).toHaveCount(0);
});

test("换账号后关闭作者名单，迟到付款明细响应不能恢复记录或入口", async ({
  page,
}) => {
  const state = await mockRoster(page, { author: true });
  state.allowed = false;
  const dialog = await openPublic(page);
  await expect(dialog.locator(".recipient-private")).toContainText(
    "模拟发放已确认",
  );
  const late = gate();
  state.claimsGate = late;
  try {
    await dialog.getByRole("button", { name: /^刷新领取名单/ }).click();
    await late.started;
    const sessionResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/session",
    );
    state.user = viewer;
    await focusPage(page);
    await sessionResponse;
    await expect(dialog).toHaveCount(0);
    late.release();
    state.claimsGate = null;
    await expect(
      page.locator(".public-roster-dialog .recipient-private"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "查看领取名单", exact: true }),
    ).toHaveCount(0);
    expect(state.writes).toEqual([]);
    expect(state.external).toEqual([]);
  } finally {
    late.release();
  }
});

for (const registered of [0, 1]) {
  test(`活动页管理菜单提前结束按报名人数显隐 ${registered}`, async ({
    page,
  }) => {
    await mockRoster(page, { author: true, draw: true, count: registered });
    await page.goto(`/activities/${activityId}`);
    await page.getByRole("button", { name: "管理活动", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "提前结束", exact: true }),
    ).toHaveCount(registered === 0 ? 1 : 0);
    await expect(
      page.getByRole("menuitem", { name: "付款记录", exact: true }),
    ).toHaveAttribute("href", `/my/payments?activityId=${activityId}`);
  });
}

for (const width of [1440, 375]) {
  test(`领取手速秒数固定且与手气称号并列，时间撤销不残留手速 ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.clock.install();
    const state = await mockRoster(page);
    state.rows = [
      {
        ...recipient(1),
        displayName: "很长的手气与手速双称号领取者名字",
        claimedAt: new Date(Date.parse(state.openedAt) + 9125).toISOString(),
        amount: "1.80",
        title: "highest",
        speedTitle: "flash",
      },
    ];
    const dialog = await openPublic(page);
    const row = dialog.locator(".recipient").first();
    await expect(row.locator(".recipient-time__speed")).toHaveText("9.125秒");
    await expect(row.locator(".recipient-time__relative")).toHaveCount(0);
    await expect(row.locator(".recipient-title")).toHaveText([
      "手气王",
      "我焯有桂！",
    ]);
    const geometry = await row.evaluate((node) => {
      const [luck, speed] = [...node.querySelectorAll(".recipient-title")];
      if (!luck || !speed) throw new Error("Missing luck or speed title");
      const a = luck.getBoundingClientRect();
      const b = speed.getBoundingClientRect();
      const amount = node
        .querySelector(".recipient-award-amount")
        ?.getBoundingClientRect();
      const time = node
        .querySelector(".recipient-time")
        ?.getBoundingClientRect();
      if (!amount || !time) throw new Error("Missing recipient amount or time");
      const bounds = node.getBoundingClientRect();
      return {
        sameLine: Math.abs(a.top - b.top) < 1,
        gap: b.left - a.right,
        badgesBeforeAmount: Math.max(a.right, b.right) + 6 <= amount.left,
        timeAfterAward: time.top >= Math.max(a.bottom, b.bottom, amount.bottom),
        fits: b.right <= bounds.right && a.left >= bounds.left,
        color: getComputedStyle(speed).color,
      };
    });
    expect(geometry).toMatchObject({
      sameLine: true,
      gap: 6,
      badgesBeforeAmount: true,
      timeAfterAward: true,
      fits: true,
      color: "rgb(145, 223, 104)",
    });
    await page.clock.fastForward(120_000);
    await expect(row.locator(".recipient-time__speed")).toHaveText("9.125秒");
    if (width === 375) {
      await page.addStyleTag({
        content: "html { font-size: 200% !important; }",
      });
      expect(
        await dialog
          .locator(".recipient-list")
          .evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
    }
    state.showTime = false;
    state.failList = 1;
    await dialog.getByRole("button", { name: /^刷新领取名单/ }).click();
    await expect(dialog.locator(".recipient-time__speed")).toHaveCount(0);
    await expect(dialog.locator(".title-speed")).toHaveCount(0);
    await expect(dialog.locator(".title-highest")).toHaveText("手气王");
    expect(state.writes).toEqual([]);
  });
}
