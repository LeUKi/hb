import { test as base, expect, type Page } from "@playwright/test";
import { createDrawRosterStore } from "../../apps/web/prototype/draw-rosters";
import { historySamples } from "../../apps/web/prototype/fixtures";
import type { Activity } from "../../apps/web/prototype/types";
import { effectiveDrawProgress } from "../../apps/web/prototype/view-state";

const origin = "http://127.0.0.1:4177";
const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const forbidden: string[] = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
          forbidden.push(url.href);
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect(forbidden).toEqual([]);
    },
    { auto: true },
  ],
});

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "isolated-draw",
    title: "报名名单样例",
    author: "阿山",
    username: "ashan",
    color: "blue",
    type: "draw",
    description: "",
    amount: "20.00",
    poolAmount: "20.00",
    rewardMode: "timed_draw",
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    count: 10,
    remaining: 10,
    passwords: ["测试口令2026"],
    ...overrides,
  };
}

function totalCents(rows: readonly { amount?: string }[]) {
  return rows.reduce(
    (sum, row) => sum + Math.round(Number(row.amount ?? "0") * 100),
    0,
  );
}

async function controls(page: Page) {
  const button = page.getByRole("button", { name: "场景与身份" });
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
  return button;
}

async function selectScenario(page: Page, scenario: string) {
  const modal = page.locator("dialog.public-roster-dialog");
  if (await modal.isVisible())
    await modal.getByRole("button", { name: "关闭名单" }).click();
  const button = await controls(page);
  await page.getByRole("combobox", { name: "活动状态" }).selectOption(scenario);
  await button.click();
}

test("data: registrations are full activity facts without amounts or unpublished winners", () => {
  const store = createDrawRosterStore();
  const draw = activity();
  const roster = store.getDrawRoster(draw);
  expect(roster.progress).toBe("waiting");
  expect(roster.registrations).toHaveLength(30);
  expect(roster.winners).toEqual([]);
  expect(new Set(roster.registrations.map((row) => row.username)).size).toBe(
    30,
  );
  expect(roster.registrations.every((row) => row.amount === undefined)).toBe(
    true,
  );
  expect(
    roster.registrations.every(
      (row) =>
        Number.isFinite(Date.parse(row.time)) &&
        Date.parse(row.time) < Date.parse(draw.deadlineAt ?? ""),
    ),
  ).toBe(true);
  expect(store.getDrawRoster({ ...draw })).toBe(roster);
  expect(Object.isFrozen(roster)).toBe(true);
  expect(Object.isFrozen(roster.registrations)).toBe(true);
  expect(Object.isFrozen(roster.registrations[0])).toBe(true);
});

test("data: history winners are stable registration subsets and match personal results", () => {
  const store = createDrawRosterStore();
  for (const [id, participation] of [
    ["history-draw-won", "won"],
    ["history-draw-not-won", "not-won"],
  ]) {
    const draw = historySamples.find((entry) => entry.id === id);
    expect(draw).toBeDefined();
    if (!draw) return;
    const roster = store.getDrawRoster(draw);
    const before = JSON.stringify(roster);
    expect(roster.progress).toBe("completed");
    expect(roster.winners).toHaveLength(3);
    expect(totalCents(roster.winners)).toBe(2_000);
    const registered = new Set(roster.registrations.map((row) => row.username));
    expect(roster.winners.every((row) => registered.has(row.username))).toBe(
      true,
    );
    expect(store.resolveDrawParticipation(draw, "linjian").participation).toBe(
      participation,
    );
    if (participation === "won")
      expect(store.resolveDrawParticipation(draw, "linjian").rewardAmount).toBe(
        "2.18",
      );
    store.resolveDrawParticipation(draw, "nanfeng");
    store.resolveDrawParticipation(draw, "other-viewer");
    expect(JSON.stringify(store.getDrawRoster(draw))).toBe(before);
  }
});

test("data: registration is deduplicated and cannot continue after closure", () => {
  const store = createDrawRosterStore();
  const draw = activity();
  const profile = { name: "林间", username: "linjian", color: "sage" };
  const time = new Date().toISOString();
  expect(store.recordDrawRegistration(draw, profile, time)).toBe(true);
  expect(store.recordDrawRegistration(draw, profile, time)).toBe(false);
  expect(store.getDrawRoster(draw).registrations).toHaveLength(31);
  expect(store.resolveDrawParticipation(draw, "linjian")).toEqual({
    participation: "registered",
    participatedAt: time,
  });
  store.setDrawScenario(draw, "drawing");
  expect(store.resolveDrawParticipation(draw, "linjian").participation).toBe(
    "drawing",
  );
  expect(store.getDrawRoster(draw).winners).toEqual([]);
  expect(
    store.recordDrawRegistration(draw, { ...profile, username: "late" }),
  ).toBe(false);
});

test("data: cutoff only projects settling and never publishes winners", () => {
  const now = Date.now();
  const draw = activity({ deadlineAt: new Date(now + 1_000).toISOString() });
  const state = {
    lifecycle: "active" as const,
    drawProgress: "waiting" as const,
  };
  const store = createDrawRosterStore();
  const roster = store.getDrawRoster(draw);
  expect(effectiveDrawProgress(draw, state, now)).toBe("waiting");
  expect(effectiveDrawProgress(draw, state, now + 1_000)).toBe("settling");
  expect(
    effectiveDrawProgress(draw, { ...state, lifecycle: "ended" }, now),
  ).toBe("settling");
  expect(
    effectiveDrawProgress(draw, { ...state, lifecycle: "archived" }, now),
  ).toBe("settling");
  expect(
    effectiveDrawProgress(draw, { ...state, lifecycle: "draft" }, now + 2_000),
  ).toBe("waiting");
  expect(
    effectiveDrawProgress(draw, { ...state, drawProgress: "completed" }, now),
  ).toBe("completed");
  expect(store.getDrawRoster(draw)).toBe(roster);
  expect(roster.progress).toBe("waiting");
  expect(roster.winners).toEqual([]);
  const expired = activity({
    id: "expired",
    deadlineAt: new Date(now - 1_000).toISOString(),
  });
  expect(
    store.recordDrawRegistration(expired, {
      name: "晚到",
      username: "late",
      color: "blue",
    }),
  ).toBe(false);
});

test("data: published-empty and zero-registration are different fixed facts", () => {
  const store = createDrawRosterStore();
  const draw = activity();
  const noWinners = store.setDrawScenario(draw, "draw-no-winners");
  expect(noWinners.progress).toBe("completed");
  expect(noWinners.registrations.length).toBeGreaterThan(20);
  expect(noWinners.winners).toEqual([]);
  expect(store.resolveDrawParticipation(draw, "linjian").participation).toBe(
    "not-won",
  );
  const empty = store.setDrawScenario(draw, "draw-empty");
  expect(empty.progress).toBe("empty");
  expect(empty.registrations).toEqual([]);
  expect(empty.winners).toEqual([]);
  expect(store.resolveDrawParticipation(draw, "linjian").participation).toBe(
    "none",
  );
  expect(
    effectiveDrawProgress(draw, { lifecycle: "ended", drawProgress: "empty" }),
  ).toBe("empty");
});

test("data: scenario publication uses fixed cents and viewer reads never regenerate them", () => {
  const store = createDrawRosterStore();
  const draw = activity({ count: 2, poolAmount: "1.23", amount: "1.23" });
  const published = store.setDrawScenario(draw, "won");
  expect(published.winners).toHaveLength(2);
  expect(totalCents(published.winners)).toBe(123);
  expect(
    published.winners.every((winner) =>
      published.registrations.some(
        (registration) => registration.username === winner.username,
      ),
    ),
  ).toBe(true);
  store.resolveDrawParticipation(draw, "linjian");
  store.resolveDrawParticipation(draw, "nanfeng");
  expect(store.getDrawRoster(draw)).toBe(published);
  const lost = store.setDrawScenario(draw, "not-won");
  expect(lost.winners.some((winner) => winner.username === "linjian")).toBe(
    false,
  );
  expect(totalCents(lost.winners)).toBe(123);
});

test("data: registration notifications clean up and non-draw activities are excluded", () => {
  const store = createDrawRosterStore();
  const draw = activity();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  store.setDrawScenario(draw, "drawing");
  expect(notifications).toBe(1);
  unsubscribe();
  store.setDrawScenario(draw, "won");
  expect(notifications).toBe(1);
  const instant = activity({ id: "ldc", type: "ldc" });
  expect(store.getDrawRoster(instant)).toEqual({
    progress: null,
    registrations: [],
    winners: [],
  });
  expect(
    store.recordDrawRegistration(instant, {
      name: "林间",
      username: "linjian",
      color: "sage",
    }),
  ).toBe(false);
});

test("data: newly created draws have no fabricated registrations and drafts reject registration", () => {
  const store = createDrawRosterStore();
  const draw = activity({ registrationCount: 0 });
  expect(store.getDrawRoster(draw).registrations).toEqual([]);
  const draft = activity({
    id: "draft",
    lifecycle: "draft",
    deadlineAt: null,
    registrationCount: 0,
  });
  expect(store.getDrawRoster(draft).registrations).toEqual([]);
  expect(
    store.recordDrawRegistration(draft, {
      name: "林间",
      username: "linjian",
      color: "sage",
    }),
  ).toBe(false);
});

async function openPublicRoster(page: Page) {
  const modal = page.locator("dialog.public-roster-dialog");
  if (!(await modal.isVisible()))
    await page
      .getByRole("button", { name: /^查看(?:报名|中奖|领取)名单$/u })
      .click();
  await expect(modal).toBeVisible();
  return page.locator(".public-roster");
}

test("registration and winner tabs append batches independently without scrolling the activity", async ({
  page,
}) => {
  await page.goto("/#activity?sample=evening");
  const before = await page.locator("#main").evaluate((main) => main.scrollTop);
  const roster = await openPublicRoster(page);
  const rows = roster.locator(".recipient");
  await expect(roster.getByRole("tab", { name: "报名名单" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rows).toHaveCount(20);
  await expect(roster.locator(".recipient-award")).toHaveCount(0);
  const firstIds = await rows.evaluateAll((records) =>
    records.map((row) => row.getAttribute("data-record-id")),
  );
  await roster.locator(".recipient-list").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(rows).toHaveCount(30);
  expect(
    (
      await rows.evaluateAll((records) =>
        records.map((row) => row.getAttribute("data-record-id")),
      )
    ).slice(0, 20),
  ).toEqual(firstIds);
  expect(await page.locator("#main").evaluate((main) => main.scrollTop)).toBe(
    before,
  );
  await roster.getByRole("tab", { name: "中奖名单" }).click();
  await expect(roster.getByRole("status")).toHaveText("等待开奖");
  await expect(rows).toHaveCount(0);
  expect(
    await roster.locator(".recipient-list").evaluate((list) => list.scrollTop),
  ).toBe(0);
  await roster.getByRole("tab", { name: "报名名单" }).click();
  await expect(rows).toHaveCount(20);
});

test("cutoff keeps all registrations and shows drawing instead of future publication copy", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-06T06:00:00Z") });
  await page.goto("/#activity?sample=evening");
  await page.clock.fastForward(600_000);
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-draw-progress",
    "settling",
  );
  const roster = await openPublicRoster(page);
  await expect(roster.locator(".recipient")).toHaveCount(20);
  await roster.getByRole("tab", { name: "中奖名单" }).click();
  await expect(roster.getByRole("status")).toHaveText("正在开奖");
  await expect(roster.locator(".recipient")).toHaveCount(0);
  await expect(page.locator(".activity-page")).not.toContainText(
    /开奖后揭晓|开奖后公布中奖名单/u,
  );
  await page
    .locator("dialog.public-roster-dialog")
    .getByRole("button", { name: "关闭名单" })
    .click();
  await expect(page.locator(".password-list .pw-locked")).toHaveCount(2);
  await expect(page.locator(".password-list .pw-reveal")).toHaveCount(0);
});

test("published winners and amounts survive standard, LiteAuth and guest viewing", async ({
  page,
}) => {
  await page.goto("/#activity?sample=evening");
  await selectScenario(page, "won");
  const roster = await openPublicRoster(page);
  await expect(roster.getByRole("tab", { name: "中奖名单" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const snapshot = async () =>
    roster.locator(".recipient").evaluateAll((rows) =>
      rows.map((row) => ({
        username: row.getAttribute("data-username"),
        amount: row.querySelector(".recipient-award strong")?.textContent,
      })),
    );
  const standard = await snapshot();
  expect(standard).toHaveLength(3);
  expect(standard.find((row) => row.username === "linjian")?.amount).toContain(
    "2.18",
  );
  for (const identity of ["lite", "guest", "standard"]) {
    await page
      .locator("dialog.public-roster-dialog")
      .getByRole("button", { name: "关闭名单" })
      .click();
    const button = await controls(page);
    await page
      .getByRole("combobox", { name: "体验身份" })
      .selectOption(identity);
    await button.click();
    await openPublicRoster(page);
    await expect(roster.locator(".recipient")).toHaveCount(3);
    expect(await snapshot()).toEqual(standard);
  }
});

test("empty results keep both rosters truthful and clock updates preserve the viewer's tab", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-06T06:00:00Z") });
  await page.goto("/#activity?sample=evening");
  await selectScenario(page, "draw-no-winners");
  const roster = await openPublicRoster(page);
  await expect(roster.getByRole("status")).toHaveText("无人中奖");
  await roster.getByRole("tab", { name: "报名名单" }).click();
  await expect(roster.locator(".recipient")).toHaveCount(20);
  await page.clock.fastForward(60_000);
  await expect(roster.getByRole("tab", { name: "报名名单" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await selectScenario(page, "draw-empty");
  await openPublicRoster(page);
  await expect(roster.getByRole("tab", { name: "中奖名单" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(roster.getByRole("status")).toHaveText("无人中奖");
  await roster.getByRole("tab", { name: "报名名单" }).click();
  await expect(roster.getByRole("status")).toHaveText("无人报名");
  await expect(roster.getByRole("button", { name: "加载更多" })).toHaveCount(0);
});

test("managed draw summaries use the same registrations and published winners as activity details", async ({
  page,
}) => {
  const id = "20000000-0000-4000-8000-000000000009";
  await page.goto("/#manage");
  const row = page.locator(`[data-activity-id="${id}"]`);
  await expect(row.locator(".work-managed-progress")).toContainText("30 人");
  await expect(row.locator(".work-managed-progress")).toContainText("已报名");
  await page.goto(`/#activity?sample=${id}`);
  const roster = await openPublicRoster(page);
  await expect(roster).toContainText("30 人报名");
  await expect(roster.locator(".recipient")).toHaveCount(20);
  await page
    .locator("dialog.public-roster-dialog")
    .getByRole("button", { name: "关闭名单" })
    .click();
  await page.evaluate(() => {
    window.location.hash = "manage";
  });
  await expect(row).toBeVisible();
  await page.evaluate(async (activityId) => {
    const resources = performance.getEntriesByType("resource");
    const findModule = (path: string) => {
      const entry = resources.find(
        (resource) => new URL(resource.name).pathname === path,
      );
      if (!entry)
        throw new Error(`Loaded prototype module is missing: ${path}`);
      return entry.name;
    };
    const { setDrawScenario } = await import(findModule("/draw-rosters.ts"));
    const { findWorkbenchActivity, toPrototypeActivity } = await import(
      findModule("/pages/workbench-store.ts")
    );
    const item = findWorkbenchActivity("standard", activityId);
    if (!item) throw new Error("Managed draw fixture is missing");
    setDrawScenario(toPrototypeActivity(item), "completed");
  }, id);
  await expect(row.locator(".status-badge")).toHaveText("已结束");
  await expect(row.locator(".work-managed-progress")).toContainText("3 / 10");
  await expect(row.locator(".work-managed-progress")).toContainText("已中奖");
  await expect(page.getByRole("group", { name: "奖励筛选" })).toHaveCount(0);
  await page.goto(`/#activity?sample=${id}`);
  await openPublicRoster(page);
  await expect(roster).toContainText("3 人中奖");
  const recipients = roster.locator(".recipient");
  await expect(recipients).toHaveCount(3);
  const amounts = await recipients
    .locator(".recipient-award strong")
    .allTextContents();
  expect(
    amounts.reduce(
      (sum, amount) => sum + Math.round(Number.parseFloat(amount) * 100),
      0,
    ),
  ).toBe(2_000);
  await roster.getByRole("tab", { name: "报名名单", exact: true }).click();
  await expect(roster).toContainText("30 人报名");
});
