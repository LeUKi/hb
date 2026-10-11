import { expect, test } from "@playwright/test";
import { prototypeStartedAt } from "../../apps/web/prototype/activity-metadata";
import {
  activities,
  createParticipationSeed,
  getSampleRecipients,
  getSampleResult,
  historySamples,
  type RandomRosterCase,
  randomActivities,
} from "../../apps/web/prototype/fixtures";
import { gallerySamples } from "../../apps/web/prototype/framework-fixtures";
import { recipientTitles } from "../../apps/web/prototype/recipient-titles";
import {
  activityRewardLabel,
  activityRewardSummary,
  projectActivityViewState,
} from "../../apps/web/prototype/view-state";

test("public history timestamps match the private participation event", () => {
  for (const activity of historySamples.filter(
    (item) => item.type !== "draw",
  )) {
    const result = getSampleResult(activity.id);
    const own = getSampleRecipients(activity.id)?.find(
      (row) => row.username === "linjian",
    );
    expect(own?.time).toBe(result?.participatedAt);
    if (result?.confirmedAt)
      expect(Date.parse(result.confirmedAt)).toBeGreaterThanOrEqual(
        Date.parse(own?.time ?? ""),
      );
  }
});

test("history seeds preserve identity boundaries and leave new claim examples unclaimed", () => {
  const standard = createParticipationSeed("standard");
  const lite = createParticipationSeed("lite");
  const guest = createParticipationSeed("guest");
  expect(historySamples).toHaveLength(24);
  expect(Object.keys(standard.records)).toHaveLength(24);
  expect(Object.keys(lite.records)).toHaveLength(6);
  expect(guest).toEqual({ records: {}, results: {}, viewStates: {} });
  expect(new Set(gallerySamples.map((activity) => activity.id)).size).toBe(
    gallerySamples.length,
  );
  const byId = new Map(
    gallerySamples.map((activity) => [activity.id, activity]),
  );
  for (const id of Object.keys(standard.records)) {
    expect(byId.has(id)).toBe(true);
    expect(standard.results[id]?.participation).toBe(standard.records[id]);
    expect(standard.viewStates[id]).toEqual(standard.results[id]?.viewState);
  }
  for (const id of Object.keys(lite.records))
    expect(byId.get(id)?.type).toBe("text");
  for (const activity of [...activities, ...randomActivities]) {
    expect(standard.records[activity.id]).toBeUndefined();
    expect(lite.records[activity.id]).toBeUndefined();
  }
});

test("history fixtures cover participation, settlement and independent payment progress", () => {
  const seed = createParticipationSeed("standard");
  expect(new Set(Object.values(seed.records))).toEqual(
    new Set(["claimed", "registered", "drawing", "won", "not-won"]),
  );
  expect(
    new Set(Object.values(seed.viewStates).map((state) => state.lifecycle)),
  ).toEqual(new Set(["active", "ended", "archived"]));
  expect(
    new Set(
      Object.values(seed.viewStates).map((state) => state.paymentProgress),
    ),
  ).toEqual(
    new Set([
      null,
      "pending",
      "sending",
      "reconciling",
      "waiting",
      "confirmed",
    ]),
  );
  expect(
    new Set(
      historySamples.map((activity) => activity.rewardMode).filter(Boolean),
    ),
  ).toEqual(new Set(["fixed", "instant_random", "timed_draw"]));
  for (const result of Object.values(seed.results)) {
    expect(Number.isNaN(Date.parse(result.participatedAt))).toBe(false);
    if (
      result.participation === "registered" ||
      result.participation === "drawing" ||
      result.participation === "not-won"
    ) {
      expect(result.rewardAmount).toBeUndefined();
      expect(result.rewardText).toBeUndefined();
      expect(result.viewState.paymentProgress).toBeNull();
    }
  }
});

test("each seed, private result and published roster is an independent copy", () => {
  const first = createParticipationSeed("standard");
  const second = createParticipationSeed("standard");
  const id = "history-random-active";
  const result = first.results[id];
  if (!result) throw new Error("Missing seeded private result");
  result.rewardAmount = "99.99";
  result.viewState.lifecycle = "draft";
  first.viewStates[id] = { lifecycle: "draft" };
  expect(second.results[id]?.rewardAmount).toBe("0.98");
  expect(getSampleResult(id)?.viewState.lifecycle).toBe("active");
  expect(createParticipationSeed("standard")).toEqual(second);
  const recipients = getSampleRecipients(id);
  if (!recipients?.[0]) throw new Error("Missing published recipient");
  recipients[0].amount = "99.99";
  recipients[0].name = "改动";
  expect(getSampleRecipients(id)?.[0]?.amount).toBe("1.80");
  expect(getSampleRecipients(id)?.[0]?.name).not.toBe("改动");
});

function cents(amount: string | undefined): number {
  expect(amount).toMatch(/^\d+\.\d{2}$/u);
  const [whole, fraction] = (amount ?? "").split(".");
  return Number(whole) * 100 + Number(fraction);
}

const rosterCases: Array<[RandomRosterCase, number, string]> = [
  ["unique", 1, "0.98"],
  ["tie-two", 2, "0.20"],
  ["tie-three", 0, "1.80"],
  ["equal", 0, "1.00"],
];

for (const [rosterCase, titlesPerExtreme, ownAmount] of rosterCases) {
  test(`random fixture ${rosterCase} fixes integer-cent allocations and evaluates the full roster`, () => {
    const rows = getSampleRecipients("random-ended", rosterCase);
    if (!rows) throw new Error("Missing random roster");
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((row) => row.username)).size).toBe(rows.length);
    const amounts = rows.map((row) => cents(row.amount));
    expect(
      amounts.every((amount) => Number.isSafeInteger(amount) && amount > 0),
    ).toBe(true);
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(2_000);
    if (rosterCase === "unique")
      expect(new Set(amounts).size).toBe(rows.length);
    expect(getSampleRecipients("random-ended", rosterCase)).toEqual(rows);
    expect(
      getSampleRecipients("random", rosterCase)?.map(
        ({ time: _time, ...row }) => row,
      ),
    ).toEqual(rows.map(({ time: _time, ...row }) => row));
    const active = randomActivities.find(
      (activity) => activity.id === "random",
    );
    if (!active) throw new Error("Missing active random activity");
    expect(2_000 + active.remaining * 100).toBe(cents(active.poolAmount));
    expect(rows.find((row) => row.username === "linjian")?.amount).toBe(
      ownAmount,
    );
    expect(getSampleResult("random-ended", rosterCase)?.rewardAmount).toBe(
      ownAmount,
    );
    expect(getSampleResult("random", rosterCase)?.rewardAmount).toBe(ownAmount);
    const titles = Object.values(recipientTitles(rows));
    expect(titles.filter((title) => title === "highest")).toHaveLength(
      titlesPerExtreme,
    );
    expect(titles.filter((title) => title === "lowest")).toHaveLength(
      titlesPerExtreme,
    );
    expect(
      getSampleRecipients("random-ended", rosterCase)?.slice(10),
    ).toHaveLength(10);
  });
}

test("unpublished draws have no winner list and text rosters reveal no reward content", () => {
  expect(getSampleRecipients("history-draw-registered")).toEqual([]);
  expect(getSampleRecipients("history-draw-settling")).toEqual([]);
  expect(
    getSampleRecipients("history-draw-not-won")?.some(
      (row) => row.username === "linjian",
    ),
  ).toBe(false);
  const winner = getSampleRecipients("history-draw-won")?.find(
    (row) => row.username === "linjian",
  );
  expect(winner?.amount).toBe(
    getSampleResult("history-draw-won")?.rewardAmount,
  );
  for (const activity of historySamples.filter(
    (entry) => entry.type === "text",
  )) {
    const rows = getSampleRecipients(activity.id);
    expect(rows?.length).toBeGreaterThan(0);
    expect(rows?.every((row) => row.amount === undefined)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("CDK-");
  }
  expect(getSampleRecipients("unknown")).toBeUndefined();
  expect(getSampleResult("unknown")).toBeUndefined();
});

test("published draw progress belongs to the activity without borrowing a private result", () => {
  const completed = historySamples.find(
    (activity) => activity.id === "history-draw-won",
  );
  const settling = historySamples.find(
    (activity) => activity.id === "history-draw-settling",
  );
  if (!completed || !settling) throw new Error("Missing public draw fixtures");
  expect(projectActivityViewState(completed)).toEqual({
    lifecycle: "ended",
    participation: "none",
    drawProgress: "completed",
    paymentProgress: null,
  });
  expect(projectActivityViewState(settling)).toEqual({
    lifecycle: "ended",
    participation: "none",
    drawProgress: "settling",
    paymentProgress: null,
  });
  expect(
    projectActivityViewState(completed, "none", { drawProgress: "settling" })
      .drawProgress,
  ).toBe("settling");
  expect(createParticipationSeed("lite").results[completed.id]).toBeUndefined();
  expect(
    createParticipationSeed("guest").results[completed.id],
  ).toBeUndefined();
});

test("public reward labels distinguish fixed shares from a random or draw pool", () => {
  const fixed = activities.find((activity) => activity.id === "weekend");
  const random = randomActivities.find((activity) => activity.id === "random");
  const draw = activities.find((activity) => activity.id === "evening");
  const text = activities.find((activity) => activity.id === "reading");
  if (!fixed || !random || !draw || !text)
    throw new Error("Missing reward examples");
  expect(activityRewardLabel(fixed)).toBe("固定均分");
  expect(activityRewardSummary(fixed)).toBe("0.88 LDC / 份");
  expect(activityRewardLabel(random)).toBe("即时随机");
  expect(activityRewardSummary(random)).toBe("30.00 LDC 奖池");
  expect(activityRewardSummary(draw)).toBe("20.00 LDC 奖池");
  expect(activityRewardSummary(text)).toBeNull();
  expect(
    activityRewardSummary({ ...random, poolAmount: undefined }),
  ).toBeNull();
});

test("history allocations and title cases ignore changes to the new-claim demo selector", () => {
  for (const [id, expectedAmount] of [
    ["history-random-tie-two", "0.20"],
    ["history-random-tie-three", "1.80"],
    ["history-random-equal", "1.00"],
  ]) {
    const recipients = getSampleRecipients(id ?? "");
    const result = getSampleResult(id ?? "");
    expect(result?.rewardAmount).toBe(expectedAmount);
    for (const [rosterCase] of rosterCases) {
      expect(getSampleRecipients(id ?? "", rosterCase)).toEqual(recipients);
      expect(getSampleResult(id ?? "", rosterCase)).toEqual(result);
    }
  }
});

const origin = "http://127.0.0.1:4177";
const browserTest = test.extend<{ isolatedNetwork: undefined }>({
  isolatedNetwork: [
    async ({ page }, use) => {
      const forbidden = new Set<string>();
      const isForbidden = (address: string) => {
        const url = new URL(address);
        return url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname);
      };
      page.on("request", (request) => {
        if (isForbidden(request.url())) forbidden.add(request.url());
      });
      page.on("websocket", (socket) => {
        if (new URL(socket.url()).host !== new URL(origin).host)
          forbidden.add(socket.url());
      });
      await page.route("**/*", async (route) => {
        if (isForbidden(route.request().url())) await route.abort();
        else await route.continue();
      });
      await use(undefined);
      expect(
        [...forbidden],
        "Fixtures must not call real business services",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

browserTest(
  "history shows personal rewards and participation times while public rows show pools",
  async ({ page }) => {
    // Node and the browser must share the fixture's session clock anchor.
    await page.clock.setFixedTime(new Date(prototypeStartedAt));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/#participations");
    const rows = page.locator(
      '.activity-rows[data-context="history"] .activity-rows-row',
    );
    await expect(rows).toHaveCount(20);
    const pagination = page.getByRole("navigation", {
      name: "参与记录分页",
      exact: true,
    });
    await expect(
      pagination.getByRole("button", { name: "上一页", exact: true }),
    ).toBeDisabled();
    await pagination
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await expect(rows).toHaveCount(4);
    await expect(
      pagination.getByRole("button", { name: "下一页", exact: true }),
    ).toBeDisabled();
    await pagination
      .getByRole("button", { name: "上一页", exact: true })
      .click();
    await expect(rows).toHaveCount(20);
    const randomRow = rows.filter({ hasText: "周六即时随机红包" });
    await expect(randomRow.locator(".activity-rows-type")).toHaveText(
      "即时随机",
    );
    await expect(randomRow.locator(".activity-rows-amount")).toHaveText(
      "+0.98 LDC",
    );
    await expect(randomRow.locator("time")).toHaveAttribute(
      "datetime",
      getSampleResult("history-random-active")?.participatedAt ?? "",
    );
    await expect(randomRow.locator("time")).toHaveText(
      /\d{2}\/\d{2}\s+\d{2}:\d{2}/u,
    );
    await randomRow.locator(".activity-rows-open").click();
    await expect(page.locator(".slip-amount")).toHaveText("+0.98");
    await expect(page.locator('[data-testid="envelope"]')).toHaveAttribute(
      "data-animate",
      "false",
    );
    await page
      .locator(".desktop-nav")
      .getByRole("link", { name: "活动广场", exact: true })
      .click();
    const publicRandom = page
      .locator('.activity-rows[data-context="public"] .activity-rows-row')
      .filter({ hasText: "即时随机红包 · 30 份" });
    await expect(publicRandom.locator(".activity-reward-summary")).toHaveText(
      "30.00 LDC 奖池",
    );
    await expect(publicRandom).not.toContainText("0.98 LDC");
  },
);

browserTest(
  "history switches to text-only Lite records and clears private results for guests",
  async ({ page }) => {
    await page.goto("/#participations");
    await page.getByRole("button", { name: "场景与身份" }).click();
    await page
      .getByRole("combobox", { name: "体验身份", exact: true })
      .selectOption("lite");
    await page.getByRole("button", { name: "场景与身份" }).click();
    const rows = page.locator(
      '.activity-rows[data-context="history"] .activity-rows-row',
    );
    await expect(rows).toHaveCount(6);
    await expect(rows.locator(".activity-rows-type")).toHaveText(
      Array<string>(6).fill("文本 / CDK"),
    );
    await expect(
      page.locator('.activity-rows[data-context="history"]'),
    ).not.toContainText("LDC");
    await page.getByRole("button", { name: "场景与身份" }).click();
    await page
      .getByRole("combobox", { name: "体验身份", exact: true })
      .selectOption("guest");
    await page.getByRole("button", { name: "场景与身份" }).click();
    await expect(rows).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "登录后查看参与记录", exact: true }),
    ).toBeVisible();
  },
);

browserTest(
  "record details retain each history allocation and complete-roster title rules",
  async ({ page }) => {
    const cases = [
      { id: "history-random-tie-two", amount: "0.20", count: 2 },
      { id: "history-random-tie-three", amount: "1.80", count: 0 },
      { id: "history-random-equal", amount: "1.00", count: 0 },
    ];
    for (const entry of cases) {
      await page.goto(`/#activity?sample=${entry.id}`);
      await expect(page.locator(".slip-amount")).toHaveText(`+${entry.amount}`);
      await page
        .getByRole("button", { name: "查看领取名单", exact: true })
        .click();
      await expect(page.locator(".recipient-title.title-highest")).toHaveCount(
        entry.count,
      );
      await expect(page.locator(".recipient-title.title-lowest")).toHaveCount(
        entry.count,
      );
      await expect(page.locator('[data-testid="envelope"]')).toHaveAttribute(
        "data-animate",
        "false",
      );
      await page.getByRole("button", { name: "关闭名单", exact: true }).click();
      await page.getByRole("button", { name: "场景与身份" }).click();
      await page
        .getByRole("combobox", { name: "拼手气称号样例", exact: true })
        .selectOption("unique");
      await page.getByRole("button", { name: "场景与身份" }).click();
      await page
        .getByRole("button", { name: "查看领取名单", exact: true })
        .click();
      await expect(page.locator(".slip-amount")).toHaveText(`+${entry.amount}`);
      await expect(page.locator(".recipient-title.title-highest")).toHaveCount(
        entry.count,
      );
      await expect(page.locator(".recipient-title.title-lowest")).toHaveCount(
        entry.count,
      );
      await page.getByRole("button", { name: "关闭名单", exact: true }).click();
      await page.getByRole("button", { name: "场景与身份" }).click();
      await page
        .getByRole("combobox", { name: "拼手气称号样例", exact: true })
        .selectOption("equal");
      await page.getByRole("button", { name: "场景与身份" }).click();
      await page
        .getByRole("button", { name: "查看领取名单", exact: true })
        .click();
      await expect(page.locator(".slip-amount")).toHaveText(`+${entry.amount}`);
      await expect(page.locator(".recipient-title.title-highest")).toHaveCount(
        entry.count,
      );
      await expect(page.locator(".recipient-title.title-lowest")).toHaveCount(
        entry.count,
      );
    }
  },
);

browserTest(
  "375px participating rows keep real amounts and times inside the compact columns",
  async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/#participations");
    const rows = page.locator(
      '.activity-rows[data-context="history"] .activity-rows-row',
    );
    await expect(rows).toHaveCount(20);
    await expect(
      rows
        .filter({ hasText: "周六即时随机红包" })
        .locator(".activity-rows-amount"),
    ).toHaveText("+0.98 LDC");
    for (const row of await rows.evaluateAll((elements) =>
      elements.map((element) => ({
        width: element.clientWidth,
        content: element.scrollWidth,
      })),
    ))
      expect(row.content).toBeLessThanOrEqual(row.width + 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(375);
  },
);

browserTest(
  "Lite and guest views retain published winners while clearing personal result markers",
  async ({ page }) => {
    await page.goto("/#activity?sample=history-draw-won");
    const activity = page.locator(".activity-page");
    const recipients = page.locator(".recipient");
    await expect(activity).toHaveAttribute("data-draw-progress", "completed");
    await page
      .getByRole("button", { name: "查看中奖名单", exact: true })
      .click();
    await expect(recipients).toHaveCount(3);
    const published = await recipients.allTextContents();
    await page.getByRole("button", { name: "关闭名单", exact: true }).click();
    for (const identity of ["lite", "guest"]) {
      await page.getByRole("button", { name: "场景与身份" }).click();
      await page
        .getByRole("combobox", { name: "体验身份", exact: true })
        .selectOption(identity);
      await page.getByRole("button", { name: "场景与身份" }).click();
      await expect(activity).toHaveAttribute("data-participation", "none");
      await expect(activity).toHaveAttribute("data-payment-progress", "none");
      await expect(activity).toHaveAttribute("data-draw-progress", "completed");
      await page
        .getByRole("button", { name: "查看中奖名单", exact: true })
        .click();
      await expect(recipients).toHaveText(published);
      await page.getByRole("button", { name: "关闭名单", exact: true }).click();
      await expect(page.locator(".slip-amount")).toHaveCount(0);
      await expect(
        page.getByText("已用此口令报名", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText("已用此口令兑换", { exact: true }),
      ).toHaveCount(0);
    }
  },
);

for (const identity of ["guest", "lite"] as const) {
  browserTest(
    `${identity} scenario controls cannot manufacture personal LDC rewards`,
    async ({ page }) => {
      await page.goto("/#activity");
      await page.getByRole("button", { name: "场景与身份" }).click();
      await page
        .getByRole("combobox", { name: "体验身份", exact: true })
        .selectOption(identity);
      for (const scenario of ["pending", "won"]) {
        await page
          .getByRole("combobox", { name: "活动状态", exact: true })
          .selectOption(scenario);
        await page.getByRole("button", { name: "场景与身份" }).click();
        await expect(page.locator(".activity-page")).toHaveAttribute(
          "data-participation",
          "none",
        );
        await expect(page.locator(".activity-page")).toHaveAttribute(
          "data-payment-progress",
          "none",
        );
        await expect(
          page.locator(".slip-amount, .slip-text-title"),
        ).toHaveCount(0);
        await expect(page.locator('[data-testid="envelope"]')).toHaveAttribute(
          "data-animate",
          "false",
        );
        await expect(
          page.getByRole("button", { name: "已发放说明", exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByText("已用此口令兑换", { exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByText("已用此口令报名", { exact: true }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: "场景与身份" }).click();
      }
      await page.getByRole("button", { name: "场景与身份" }).click();
      await page
        .locator(".desktop-nav")
        .getByRole("link", { name: "活动历史", exact: true })
        .click();
      const rows = page.locator(
        '.activity-rows[data-context="history"] .activity-rows-row',
      );
      await expect(rows).toHaveCount(identity === "guest" ? 0 : 6);
      if (identity === "lite")
        await expect(rows.locator(".activity-rows-type")).toHaveText(
          Array<string>(6).fill("文本 / CDK"),
        );
    },
  );
}

browserTest(
  "a newly registered draw publishes the same 2.18 reward in its result and history",
  async ({ page }) => {
    await page.goto("/#activity?sample=evening");
    await page.locator("#activity-password").fill("开奖口令2026");
    await page.getByRole("button", { name: "报名", exact: true }).click();
    await expect(page.locator(".activity-page")).toHaveAttribute(
      "data-participation",
      "registered",
    );
    await expect(page.locator(".reward-slip")).toHaveCount(0);
    await page.getByRole("button", { name: "场景与身份" }).click();
    await page
      .getByRole("button", { name: "预览中奖变化", exact: true })
      .click();
    await page.getByRole("button", { name: "场景与身份" }).click();
    await expect(page.locator(".activity-page")).toHaveAttribute(
      "data-participation",
      "won",
    );
    await expect(page.locator(".slip-amount")).toHaveText("+2.18");
    await page
      .locator(".desktop-nav")
      .getByRole("link", { name: "活动历史", exact: true })
      .click();
    const row = page
      .locator('.activity-rows[data-context="history"] .activity-rows-row')
      .filter({ hasText: "十分钟限时开奖" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".activity-rows-amount")).toHaveText("+2.18 LDC");
    await expect(
      row.getByRole("button", { name: "已发放说明", exact: true }),
    ).toHaveCount(1);
    await expect(row.locator("time")).not.toHaveText("—");
    await expect(row.locator("time")).toHaveText(/\d{2}\/\d{2}\s+\d{2}:\d{2}/u);
    expect(
      Number.isNaN(
        Date.parse((await row.locator("time").getAttribute("datetime")) ?? ""),
      ),
    ).toBe(false);
    await row.locator(".activity-rows-open").click();
    await expect(page.locator(".slip-amount")).toHaveText("+2.18");
    await expect(page.locator('[data-testid="envelope"]')).toHaveAttribute(
      "data-animate",
      "false",
    );
  },
);

browserTest(
  "a new immediate claim records a valid participation time instead of a dash",
  async ({ page }) => {
    await page.goto("/#activity?sample=weekend");
    await page.locator("#activity-password").fill("周末口令2026");
    await page.getByRole("button", { name: "领取红包", exact: true }).click();
    await expect(page.locator(".activity-page")).toHaveAttribute(
      "data-participation",
      "claimed",
    );
    await page
      .locator(".desktop-nav")
      .getByRole("link", { name: "活动历史", exact: true })
      .click();
    const row = page
      .locator('.activity-rows[data-context="history"] .activity-rows-row')
      .filter({ hasText: "周末红包 · 20 份" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".activity-rows-amount")).toHaveText("+0.88 LDC");
    await expect(row.locator("time")).toHaveText(/\d{2}\/\d{2}\s+\d{2}:\d{2}/u);
    expect(
      Number.isNaN(
        Date.parse((await row.locator("time").getAttribute("datetime")) ?? ""),
      ),
    ).toBe(false);
  },
);

browserTest(
  "an unknown activity UUID displays a missing activity instead of silently opening another reward",
  async ({ page }) => {
    const id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await page.goto(`/#activity?sample=${id}`);
    await expect(
      page.getByRole("heading", { name: "活动不存在", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".activity-page")).toHaveCount(0);
    await expect(page.locator('[data-testid="envelope"]')).toHaveCount(0);
    await expect(page.locator("#activity-password")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("周末红包");
    await expect(page).toHaveURL(new RegExp(id, "u"));
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "活动不存在", exact: true }),
    ).toBeVisible();
  },
);
