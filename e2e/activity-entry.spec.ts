import { expect, type Page, test } from "@playwright/test";

const activityId = "44444444-4444-4444-8444-444444444444";
const secondActivityId = "55555555-5555-4555-8555-555555555555";

const user = {
  id: "activity-entry-user",
  username: "entry-user",
  displayName: "活动页连续性用户",
  avatarUrl: null,
  accountTier: "standard",
  canUseLdc: true,
  loginProvider: "connect",
};

const author = {
  id: "activity-entry-author",
  username: "entry-author",
  displayName: "活动作者",
  avatarUrl: null,
  accountTier: "standard",
};

type Gate = {
  release: () => void;
  waitStarted: () => Promise<void>;
  wait: () => Promise<void>;
};

function gate(): Gate {
  let opened = false;
  const waiters: (() => void)[] = [];
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return {
    release: () => {
      opened = true;
      for (const waiter of waiters.splice(0)) waiter();
    },
    waitStarted: () => started,
    async wait() {
      markStarted();
      if (opened) return;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: activityId,
    title: "活动页进入连续性验收",
    rewardType: "ldc",
    status: "active",
    author,
    forceDedicated: true,
    topicUrl: null,
    openedAt: "2026-10-07T00:00:00.000Z",
    deadlineAt: "2026-10-12T00:00:00.000Z",
    quantity: { mode: "exact", total: 4, claimed: 0, remaining: 4 },
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
    beforeInfo:
      "活动说明第一段。\n\n慢数据到达时，口令区域和结束说明应该跟随布局动画移动，而不是突然跳动。",
    afterEndInfo:
      "结束说明用于验证活动页底部区域在上方内容异步变化时保持连续。",
    reward: { mode: "fixed", totalAmount: "4.00", count: 4 },
    myClaim: null,
    ...overrides,
  };
}

function claim() {
  return {
    id: "activity-entry-claim",
    activity: {
      id: activityId,
      title: "活动页进入连续性验收",
      status: "active",
    },
    rewardType: "ldc",
    amount: "1.00",
    payment: {
      id: "payment-entry",
      mode: "simulation",
      status: "confirmed",
      reason: null,
      confirmedAt: "2026-10-07T01:00:01.000Z",
    },
    afterClaimInfo:
      "奖励附言第一段。\n\n这里故意较长，用来观察领取结果出现后，活动口令和结束说明是否平滑移动。\n\n奖励附言第三段。",
    claimedAt: "2026-10-07T01:00:00.000Z",
  };
}

function registration() {
  return {
    id: "activity-entry-registration",
    activity: {
      id: activityId,
      title: "活动页进入连续性验收",
      status: "active",
    },
    registeredAt: "2026-10-07T01:00:00.000Z",
    drawAt: "2026-10-08T01:00:00.000Z",
    status: "registered",
    claim: null,
    sourcePassword: "EntryPass",
  };
}

async function setupActivityEntry(
  page: Page,
  options: {
    claimed?: boolean;
    registered?: boolean;
    draw?: boolean;
    sessionGate?: Gate;
    publicGate?: Gate;
    claimGate?: Gate;
    registrationGate?: Gate;
    passwordGate?: Gate;
    claimGetFailures?: number;
    status?: "active" | "ended";
  } = {},
) {
  await page.clock.setFixedTime(new Date("2026-10-09T00:00:00.000Z"));
  const state = {
    claimed: options.claimed ?? false,
    registered: options.registered ?? false,
    claimPosts: 0,
    externalRequests: [] as string[],
    activityGets: 0,
    claimGets: 0,
    passwordGets: 0,
    recipientGets: 0,
  };

  let claimGetFailures = options.claimGetFailures ?? 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      state.externalRequests.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    if (path === "/api/session" || path === "/api/me") {
      if (options.sessionGate) await options.sessionGate.wait();
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    }
    if (path === "/api/discovery/activities")
      return route.fulfill({
        json: {
          items: [
            activity(),
            { ...activity({ id: secondActivityId, title: "另一个活动" }) },
          ],
          nextCursor: null,
          total: 2,
        },
      });
    if (path === `/api/activities/${activityId}`) {
      state.activityGets += 1;
      if (options.publicGate) await options.publicGate.wait();
      return route.fulfill({
        json: {
          activity: activity({
            status: options.status ?? "active",
            deadlineAt:
              options.status === "ended"
                ? "2026-10-07T00:00:00.000Z"
                : "2026-10-12T00:00:00.000Z",
            ...(options.draw
              ? {
                  draw: {
                    state: "waiting",
                    deadlineAt: "2026-10-12T00:00:00.000Z",
                    closedAt: null,
                    reason: null,
                    registeredCount: state.registered ? 1 : 0,
                    winnerCount: 1,
                  },
                }
              : {}),
          }),
        },
      });
    }
    if (path === `/api/activities/${activityId}/participation`) {
      state.claimGets += 1;
      if (options.claimGate) await options.claimGate.wait();
      if (options.registrationGate) await options.registrationGate.wait();
      if (claimGetFailures > 0) {
        claimGetFailures -= 1;
        return route.fulfill({
          status: 500,
          json: { error: "参与记录读取失败。" },
        });
      }
      return route.fulfill({
        json: {
          claim: state.claimed ? claim() : null,
          registration: state.registered ? registration() : null,
        },
      });
    }
    if (path === `/api/activities/${activityId}/claim`) {
      state.claimPosts += 1;
      state.claimed = true;
      return route.fulfill({ json: { result: "claimed", claim: claim() } });
    }
    if (path === `/api/activities/${activityId}/passwords`) {
      state.passwordGets += 1;
      if (options.passwordGate) await options.passwordGate.wait();
      return route.fulfill({
        json: {
          passwords:
            state.claimed || state.registered
              ? [
                  {
                    text: "EntryPass",
                    isClaimPassword: state.claimed,
                    isRegistrationPassword: state.registered,
                    isSolved: true,
                  },
                ]
              : [],
          hiddenCount: state.claimed || state.registered ? 0 : 1,
          canSolve: false,
        },
      });
    }
    if (path === `/api/activities/${activityId}/recipients`) {
      state.recipientGets += 1;
      return route.fulfill({
        json: {
          enabled: true,
          items: state.claimed
            ? [
                {
                  ...user,
                  id: "recipient-entry",
                  claimedAt: "2026-10-07T01:00:00.000Z",
                },
              ]
            : [],
          nextCursor: null,
        },
      });
    }
    if (path === `/api/activities/${activityId}/registrations`)
      return route.fulfill({
        json: {
          enabled: true,
          items: state.registered
            ? [
                {
                  ...user,
                  id: "registration-entry",
                  registeredAt: "2026-10-07T01:00:00.000Z",
                },
              ]
            : [],
          nextCursor: null,
        },
      });
    if (path === `/api/me/activities/${activityId}`)
      return route.fulfill({
        json: {
          activity: {
            ...activity(),
            version: 1,
            createdAt: "2026-10-07T00:00:00.000Z",
            totalCount: 4,
            claimedCount: state.claimed ? 1 : 0,
            config: {
              title: "活动页进入连续性验收",
              rewardType: "ldc",
              rewardTexts: ["1.00"],
              passwords: ["EntryPass"],
              beforeInfo: activity().beforeInfo,
              afterEndInfo: activity().afterEndInfo,
              afterClaimInfo: claim().afterClaimInfo,
              quantity: 4,
              duration: 1,
              forceDedicated: true,
            },
          },
        },
      });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.continue();
  });
  return state;
}

async function regionMetrics(page: Page) {
  return page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        text: element.textContent?.trim() ?? "",
      };
    };
    return {
      title: read(".activity-heading"),
      art: read(".claim-art"),
      envelope: read('[data-testid="envelope"], .redemption-envelope'),
      copy: read(".claim-copy"),
      password: read('[data-layout-region="password-panel"]'),
      endNote: read('[data-note-region="ended"]'),
    };
  });
}

async function sampleTop(page: Page, selector: string, frames = 32) {
  return page.locator(selector).evaluate(async (element, count) => {
    const samples: { top: number; height: number; transform: string }[] = [];
    for (let index = 0; index < count; index += 1) {
      const rect = element.getBoundingClientRect();
      samples.push({
        top: Math.round(rect.top * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        transform: getComputedStyle(element).transform,
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return samples;
  }, frames);
}

function expectMeaningfulMovement(
  samples: { top: number; height: number; transform: string }[],
) {
  const tops = samples.map((sample) => sample.top);
  const range = Math.max(...tops) - Math.min(...tops);
  expect(new Set(tops).size).toBeGreaterThan(2);
  expect(range).toBeGreaterThan(8);
}

type LayoutRegionSample = {
  time: number;
  regions: Record<string, { top: number; height: number } | null>;
};

const stableRegionSelectors = {
  title: ".activity-heading",
  frame: ".claim-layout",
  stage: ".claim-art",
  envelope: '[data-testid="envelope"], .redemption-envelope',
  copy: ".claim-copy",
  password: '[data-layout-region="password-panel"]',
  endNote: ".activity-ended-region",
};

async function elementHandleFor(page: Page, selector: string) {
  const handle = await page.locator(selector).elementHandle();
  expect(handle).not.toBeNull();
  return handle;
}

async function expectEnvelopeHeight(page: Page, expectedHeight: number) {
  await expect
    .poll(async () => {
      const box = await page.locator('[data-testid="envelope"]').boundingBox();
      return box ? Math.round(box.height) : 0;
    })
    .toBe(expectedHeight);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        return root.scrollWidth - root.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(2);
}

async function expectTabReachesVisibleControl(page: Page) {
  await page.keyboard.press("Tab");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return false;
        const rect = active.getBoundingClientRect();
        const hidden =
          active.closest('[aria-hidden="true"]') || active.closest("[inert]");
        return !hidden && rect.width > 0 && rect.height > 0;
      }),
    )
    .toBe(true);
}

async function expectClaimCopyPendingOnly(page: Page) {
  const copy = page.locator(".claim-copy");
  await expect(copy.locator('[data-loading-region="records"]')).toHaveCount(1);
  await expect(copy.locator("[data-note-region]")).toHaveCount(0);
  await expect(copy.locator(".roster-entry")).toHaveCount(0);
  await expect(copy.locator("form")).toHaveCount(0);
}

async function expectClaimCopySkeletonHeightStable(page: Page) {
  const copy = page.locator(".claim-copy");
  const before = await copy.boundingBox();
  await page.waitForTimeout(120);
  const after = await copy.boundingBox();
  expect(
    Math.abs((after?.height ?? 0) - (before?.height ?? 0)),
  ).toBeLessThanOrEqual(2);
}

async function expectClaimCopyReady(page: Page) {
  await expect(
    page.locator('.claim-copy [data-loading-region="records"]'),
  ).toHaveCount(0);
}

async function sampleRegions(
  page: Page,
  selectors: Record<string, string>,
  frames = 32,
) {
  return page.evaluate(
    async ({ regionSelectors, count }) => {
      const samples: LayoutRegionSample[] = [];
      for (let index = 0; index < count + 120; index += 1) {
        const regions = Object.fromEntries(
          Object.entries(regionSelectors).map(([name, selector]) => {
            const element = document.querySelector(selector);
            if (!element) return [name, null];
            const rect = element.getBoundingClientRect();
            return [
              name,
              {
                top: Math.round(rect.top * 10) / 10,
                height: Math.round(rect.height * 10) / 10,
              },
            ];
          }),
        );
        samples.push({ time: performance.now(), regions });
        if (
          samples.length >= count &&
          document.querySelector('.activity-page[data-entry-ready="true"]') &&
          !document.querySelector('[data-layout-settling="true"]')
        ) {
          const tail = samples.slice(-3);
          const settled = Object.keys(regionSelectors).every((name) => {
            const boxes = tail.map((sample) => sample.regions[name]);
            return (
              boxes.every((box) => Boolean(box)) &&
              (["top", "height"] as const).every((metric) => {
                const values = boxes.map((box) => box?.[metric] ?? 0);
                return Math.max(...values) - Math.min(...values) <= 0.2;
              })
            );
          });
          if (settled) return samples;
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      throw new Error(
        "Activity layout did not settle within the sampling window",
      );
    },
    { regionSelectors: selectors, count: frames },
  );
}

function assertSmoothRegionChange(
  samples: LayoutRegionSample[],
  regionName: keyof typeof stableRegionSelectors,
  metric: "top" | "height",
  minimumChange = 0,
) {
  const points = samples
    .map((sample) => ({ time: sample.time, box: sample.regions[regionName] }))
    .filter(
      (
        sample,
      ): sample is {
        time: number;
        box: { top: number; height: number };
      } => sample.box !== null,
    );
  expect(points.length).toBeGreaterThan(8);

  const first = points[0];
  const last = points.at(-1);
  expect(first).toBeDefined();
  expect(last).toBeDefined();
  const start = first?.box[metric] ?? 0;
  const end = last?.box[metric] ?? 0;
  const totalMove = Math.abs(end - start);
  expect(totalMove).toBeGreaterThanOrEqual(minimumChange);
  const lowerBound = Math.min(start, end) - 2;
  const upperBound = Math.max(start, end) + 2;

  for (const point of points) {
    expect(point.box[metric]).toBeGreaterThanOrEqual(lowerBound);
    expect(point.box[metric]).toBeLessThanOrEqual(upperBound);
  }

  const frameDeltas = points
    .slice(1)
    .map((point, index) => {
      const previous = points[index];
      if (!previous) throw new Error("Missing previous layout sample");
      return {
        timeDelta: point.time - previous.time,
        valueDelta: Math.abs(point.box[metric] - previous.box[metric]),
      };
    })
    .filter((delta) => delta.timeDelta < 40);
  const maxFrameDelta = Math.max(
    0,
    ...frameDeltas.map((delta) => delta.valueDelta),
  );
  expect(maxFrameDelta).toBeLessThanOrEqual(Math.max(2, totalMove * 0.5));

  const firstWindow = points.slice(0, 3).map((point) => point.box[metric]);
  const lastWindow = points.slice(-3).map((point) => point.box[metric]);
  expect(
    Math.max(...firstWindow) - Math.min(...firstWindow),
  ).toBeLessThanOrEqual(2);
  expect(Math.max(...lastWindow) - Math.min(...lastWindow)).toBeLessThanOrEqual(
    2,
  );
}

test("冷进入时公共活动慢返回仍保留标题、红包和文案骨架外壳", async ({
  page,
}) => {
  const publicGate = gate();
  const state = await setupActivityEntry(page, { publicGate });

  await page.goto(`/activities/${activityId}`);
  await publicGate.waitStarted();
  await expect(page.locator(".activity-heading")).toBeVisible();
  await expect(page.locator(".claim-art")).toBeVisible();
  await expect(page.locator(".claim-copy")).toBeVisible();
  await expect(page.locator(".redemption-envelope")).toHaveCount(1);
  const shellEnvelope = await page
    .locator(".redemption-envelope")
    .elementHandle();
  const before = await regionMetrics(page);
  expect(before.title?.height).toBeGreaterThan(40);
  expect(before.art?.height).toBeGreaterThan(180);

  publicGate.release();
  await expect(
    page.getByRole("heading", { name: "活动页进入连续性验收" }),
  ).toBeVisible();
  await expect(page.locator('[data-testid="envelope"]')).toHaveCount(1);
  const realEnvelope = await page
    .locator(".redemption-envelope")
    .elementHandle();
  expect(shellEnvelope).not.toBeNull();
  expect(realEnvelope).not.toBeNull();
  expect(
    await shellEnvelope?.evaluate((node, next) => node === next, realEnvelope),
  ).toBe(true);
  expect(state.externalRequests).toEqual([]);
});

test("冷刷新时会话和活动数据分段返回仍保留稳定外框并平滑收缩", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const firstSessionGate = gate();
  const firstPublicGate = gate();
  await setupActivityEntry(page, {
    sessionGate: firstSessionGate,
    publicGate: firstPublicGate,
  });

  await page.goto(`/activities/${activityId}`);
  await firstSessionGate.waitStarted();
  firstSessionGate.release();
  await firstPublicGate.waitStarted();
  firstPublicGate.release();
  await expect(
    page.getByRole("heading", { name: "活动页进入连续性验收" }),
  ).toBeVisible();

  const refreshSessionGate = gate();
  const refreshPublicGate = gate();
  await page.unroute("**/*");
  await setupActivityEntry(page, {
    sessionGate: refreshSessionGate,
    publicGate: refreshPublicGate,
  });

  await page.reload();
  await refreshSessionGate.waitStarted();
  refreshSessionGate.release();
  await refreshPublicGate.waitStarted();
  await expect(page.locator(".activity-heading")).toBeVisible();
  await expect(page.locator(".claim-layout")).toBeVisible();
  await expect(page.locator(".claim-art")).toBeVisible();
  await expect(page.locator(".redemption-envelope")).toHaveCount(1);
  await expect(page.locator(".claim-copy")).toBeVisible();
  await expect(
    page.locator('[data-layout-region="password-panel"]'),
  ).toBeVisible();

  const handles = await Promise.all(
    Object.entries(stableRegionSelectors).map(async ([name, selector]) => ({
      name,
      selector,
      handle: await elementHandleFor(page, selector),
    })),
  );

  const samplesPromise = sampleRegions(page, stableRegionSelectors, 36);
  await page.waitForTimeout(40);
  refreshPublicGate.release();
  await expect(
    page.getByRole("heading", { name: "活动页进入连续性验收" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /领取红包/ })).toBeVisible();
  const samples = await samplesPromise;

  for (const { name, selector, handle } of handles) {
    expect(
      await handle?.evaluate(
        (node, currentSelector) =>
          document.querySelector(currentSelector) === node,
        selector,
      ),
      `${name} should preserve the same DOM node through segmented refresh`,
    ).toBe(true);
  }

  assertSmoothRegionChange(samples, "envelope", "height", 50);
  assertSmoothRegionChange(samples, "stage", "top", 6);
  assertSmoothRegionChange(samples, "password", "top", 6);
  assertSmoothRegionChange(samples, "endNote", "top", 6);
  await expectEnvelopeHeight(page, 280);
});

test("本人领取和口令分阶段返回时，活动页外壳持续存在且不误显示结束结果", async ({
  page,
}) => {
  const publicGate = gate();
  const claimGate = gate();
  const passwordGate = gate();
  await setupActivityEntry(page, {
    status: "ended",
    claimed: true,
    publicGate,
    claimGate,
    passwordGate,
  });

  await page.goto(`/activities/${activityId}`);
  await publicGate.waitStarted();
  publicGate.release();
  await claimGate.waitStarted();
  await expectClaimCopyPendingOnly(page);
  await expectClaimCopySkeletonHeightStable(page);
  await expect(page.getByText("本次活动已结束。")).toHaveCount(0);
  await expect(page.locator('[data-testid="envelope"]')).toHaveAttribute(
    "data-reserve-result-space",
    "true",
  );

  claimGate.release();
  await expect(page.getByText("兑换成功。")).toBeVisible();
  await expectClaimCopyReady(page);
  await expect(page.getByText("1.00")).toBeVisible();
  await passwordGate.waitStarted();
  await expect(
    page.locator('[data-layout-region="password-panel"]'),
  ).toBeVisible();
  passwordGate.release();
  await expect(page.getByText("已用此口令兑换")).toBeVisible();
});

test("本人报名分阶段返回时保留报名外壳，并在口令到达后显示报名来源", async ({
  page,
}) => {
  const registrationGate = gate();
  const passwordGate = gate();
  await setupActivityEntry(page, {
    draw: true,
    registered: true,
    registrationGate,
    passwordGate,
  });

  await page.goto(`/activities/${activityId}`);
  await registrationGate.waitStarted();
  await expectClaimCopyPendingOnly(page);
  registrationGate.release();
  await expect(page.getByText("报名已确认，等待开奖。")).toBeVisible();
  await expectClaimCopyReady(page);
  await expect(page.getByText("报名时间")).toBeVisible();
  await passwordGate.waitStarted();
  passwordGate.release();
  await expect(page.getByText("已用此口令报名")).toBeVisible();
});

test("提交领取后红包完整播放一次 800ms 展开，背景刷新不重复播放", async ({
  page,
}) => {
  const state = await setupActivityEntry(page);

  await page.goto(`/activities/${activityId}`);
  await page.getByLabel("兑换口令", { exact: true }).fill("EntryPass");
  await page.getByRole("button", { name: /领取红包/ }).click();

  const envelope = page.locator('[data-testid="envelope"]');
  await expect(envelope).toHaveAttribute("data-entry-token", /.+/);
  const entryToken = await envelope.getAttribute("data-entry-token");
  await expectClaimCopyReady(page);
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await page.waitForTimeout(850);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  expect(state.claimPosts).toBe(1);

  await page.clock.fastForward(15_000);
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await expect(envelope).toHaveAttribute("data-entry-token", entryToken ?? "");
});

test("参与记录初读失败后重试只触发一次已领取红包开封", async ({ page }) => {
  await setupActivityEntry(page, { claimed: true, claimGetFailures: 1 });

  await page.goto(`/activities/${activityId}`);
  await expect(page.getByText("参与记录读取失败。")).toBeVisible();
  await expect(page.locator('[data-testid="envelope"]')).toHaveAttribute(
    "data-opening-count",
    "0",
  );

  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("兑换成功。")).toBeVisible();
  const envelope = page.locator('[data-testid="envelope"]');
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await page.waitForTimeout(850);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
});

test("慢领取记录到达后仍完整播放 800ms 开封动画", async ({ page }) => {
  const claimGate = gate();
  await setupActivityEntry(page, { claimed: true, claimGate });

  await page.goto(`/activities/${activityId}`);
  await claimGate.waitStarted();
  await expectClaimCopyPendingOnly(page);
  await page.waitForTimeout(950);
  claimGate.release();

  const envelope = page.locator('[data-testid="envelope"]');
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await page.waitForTimeout(400);
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await page.waitForTimeout(450);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
});

test("直接访问和刷新每次进入都完整播放展示性展开，但不重复提交业务", async ({
  page,
}) => {
  const state = await setupActivityEntry(page, { claimed: true });

  await page.goto(`/activities/${activityId}`);
  const envelope = page.locator('[data-testid="envelope"]');
  await expect(envelope).toHaveAttribute("data-entry-token", /.+/);
  const firstToken = await envelope.getAttribute("data-entry-token");
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await page.waitForTimeout(850);
  await expect(envelope).toHaveAttribute("data-phase", "open");

  await page.reload();
  await expect(envelope).toHaveAttribute("data-entry-token", /.+/);
  const reloadToken = await envelope.getAttribute("data-entry-token");
  expect(reloadToken).not.toBe(firstToken);
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await page.waitForTimeout(850);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  expect(state.claimPosts).toBe(0);
});

test("从列表进入、后退再前进会重新展示开封，但不重交业务", async ({ page }) => {
  const state = await setupActivityEntry(page, { claimed: true });

  await page.goto("/square");
  await page.getByRole("link", { name: "查看活动" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/activities/${activityId}$`));
  const envelope = page.locator('[data-testid="envelope"]');
  await expect(envelope).toHaveAttribute("data-entry-token", /.+/);
  const firstToken = await envelope.getAttribute("data-entry-token");
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await page.waitForTimeout(850);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  const before = await regionMetrics(page);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "活动广场" })).toBeVisible();
  await page.goForward();
  await expect(page.getByText("兑换成功。")).toBeVisible();
  await expect(envelope).toHaveAttribute("data-entry-token", /.+/);
  const forwardToken = await envelope.getAttribute("data-entry-token");
  expect(forwardToken).not.toBe(firstToken);
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await page.waitForTimeout(850);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  expect(state.claimPosts).toBe(0);
  expect((await regionMetrics(page)).art?.height).toBe(before.art?.height);
});

test("名单弹窗和后台刷新不会触发红包重新展开", async ({ page }) => {
  await setupActivityEntry(page, { claimed: true });

  await page.goto(`/activities/${activityId}`);
  const envelope = page.locator('[data-testid="envelope"]');
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await page.waitForTimeout(850);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  const entryToken = await envelope.getAttribute("data-entry-token");
  await page.getByRole("button", { name: "查看领取名单" }).click();
  await expect(
    page.getByRole("dialog", { name: "活动页进入连续性验收" }),
  ).toBeVisible();
  await page.clock.fastForward(15_000);
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await expect(envelope).toHaveAttribute("data-entry-token", entryToken ?? "");
  await page.getByRole("button", { name: "关闭" }).click();
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await expect(envelope).toHaveAttribute("data-entry-token", entryToken ?? "");
});

for (const viewport of [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 900 },
  { name: "375", width: 375, height: 812 },
]) {
  test(`未领取活动最终收缩在 ${viewport.name}px 下通过多帧平滑移动`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    if (viewport.width === 768) {
      await page.addInitScript(() => {
        document.documentElement.style.fontSize = "200%";
      });
    }
    const claimGate = gate();
    await setupActivityEntry(page, { claimGate });

    await page.goto(`/activities/${activityId}`);
    await claimGate.waitStarted();
    const samplesPromise = sampleTop(
      page,
      '[data-layout-region="password-panel"]',
    );
    await page.waitForTimeout(30);
    claimGate.release();
    const samples = await samplesPromise;

    await expect(page.getByRole("button", { name: /领取红包/ })).toBeVisible();
    await expect(page.locator(".claim-art")).toBeVisible();
    await expect(page.locator(".claim-copy")).toBeVisible();
    await expect(page.locator('[data-note-region="ended"]')).toBeVisible();
    await expectEnvelopeHeight(page, viewport.width <= 760 ? 250 : 280);
    if (viewport.width === 768) {
      await expectNoHorizontalOverflow(page);
      await expectTabReachesVisibleControl(page);
    }
    expectMeaningfulMovement(samples);
  });
}

test("减少动态效果下异步内容即时稳定替换，不产生多帧布局动画", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const claimGate = gate();
  await setupActivityEntry(page, { claimed: true, claimGate });

  await page.goto(`/activities/${activityId}`);
  await claimGate.waitStarted();
  const samplesPromise = sampleTop(
    page,
    '[data-layout-region="password-panel"]',
  );
  await page.waitForTimeout(30);
  claimGate.release();
  const samples = await samplesPromise;

  await expect(page.getByText("1.00")).toBeVisible();
  expect(samples.filter((sample) => sample.transform !== "none")).toHaveLength(
    0,
  );
  expect(new Set(samples.map((sample) => sample.top)).size).toBeLessThanOrEqual(
    2,
  );
});
