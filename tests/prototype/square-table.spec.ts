import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { prototypeStartedAt } from "../../apps/web/prototype/activity-metadata";
import type {
  Activity,
  ActivityViewStateOverrides,
  Participation,
  ParticipationResult,
} from "../../apps/web/prototype/types";

const origin = "http://127.0.0.1:4177";
const topicUrl = "https://linux.do/t/topic/2964597/1216";
const test = base.extend<{ forumRequests: string[]; localOnly: undefined }>({
  forumRequests: async ({ browserName }, use) => {
    void browserName;
    await use([]);
  },
  localOnly: [
    async ({ context, page, forumRequests }, use) => {
      const forbidden = new Set<string>();
      page.on("websocket", (socket) => {
        if (new URL(socket.url()).host !== new URL(origin).host)
          forbidden.add(socket.url());
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.href === topicUrl) {
          forumRequests.push(url.href);
          await route.abort();
        } else if (
          url.origin !== origin ||
          /^\/api(?:\/|$)/u.test(url.pathname)
        ) {
          forbidden.add(url.href);
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect([...forbidden], "Square stays inside the local prototype").toEqual(
        [],
      );
    },
    { auto: true },
  ],
});

const square = (page: Page) => page.locator(".gallery-page");
const publicRowSelector =
  '.activity-rows[data-context="public"] tr.activity-rows-row';
const publicRows = (page: Page) => page.locator(publicRowSelector);
const publicRow = (page: Page, id: string) =>
  page.locator(`${publicRowSelector}[data-activity-id="${id}"]`);

async function openSquare(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.setFixedTime(new Date(prototypeStartedAt));
  await page.goto("/#square");
  await expect(publicRows(page)).toHaveCount(20);
}

async function expectRowsToFit(rows: Locator) {
  expect(
    await rows.evaluateAll((elements) =>
      elements.flatMap((row) =>
        [row, ...row.querySelectorAll("td")]
          .filter((node) => node.scrollWidth > node.clientWidth + 1)
          .map((node) => ({
            activity: row.getAttribute("data-activity-id"),
            className: node.className,
            width: node.clientWidth,
            content: node.scrollWidth,
          })),
      ),
    ),
    "Rows and cells must contain enlarged text",
  ).toEqual([]);
}

for (const width of [1440, 375]) {
  test(`square table keeps five columns, independent controls and enlarged text at ${width}px`, async ({
    page,
    forumRequests,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSquare(page);
    const table = square(page).getByRole("table", {
      name: "公开活动",
      exact: true,
    });
    await expect(table.getByRole("columnheader")).toHaveText([
      "活动",
      "发布者",
      "奖励",
      "数量",
      "操作",
    ]);
    expect(
      await table
        .locator("col")
        .evaluateAll((columns) =>
          columns.map((column) => (column as HTMLElement).style.width),
        ),
    ).toEqual(["40%", "17%", "20%", "13%", "10%"]);
    const weekend = publicRow(page, "weekend");
    await expect(weekend.locator(":scope > td")).toHaveCount(5);
    const title = weekend.locator(
      ".activity-row-title-main > .activity-rows-open",
    );
    const link = weekend.getByRole("link", { name: "打开关联论坛帖子" });
    const view = weekend.getByRole("link", { name: "查看活动", exact: true });
    const author = weekend.locator(".activity-rows-author .user-identity");
    await expect(title).toHaveClass(/activity-table-open/u);
    await expect(title).toHaveCSS(
      "font-size",
      width === 1440 ? "16px" : "13px",
    );
    await expect(weekend.locator(".activity-row-title > div")).toHaveCount(2);
    await expect(
      weekend.locator(".activity-row-title-meta .status-badge"),
    ).toHaveCount(1);
    await expect(link).toHaveAttribute("href", topicUrl);
    await expect(view).toHaveAttribute("href", "#activity?sample=weekend");
    await expect(view).toHaveAttribute("target", "_blank");
    await expect(view).toHaveAttribute("rel", "noopener noreferrer");
    await expect(view).toBeVisible();
    await expect(link).toHaveCSS("width", width === 1440 ? "36px" : "40px");
    await expect(link).toHaveCSS("height", width === 1440 ? "24px" : "28px");
    const layout = await weekend.evaluate((node) => {
      const rect = (selector: string) => {
        const box = node.querySelector(selector)?.getBoundingClientRect();
        if (!box) throw new Error(`Missing ${selector}`);
        return {
          x: box.x,
          y: box.y,
          bottom: box.bottom,
          width: box.width,
        };
      };
      return {
        rowWidth: node.getBoundingClientRect().width,
        display: getComputedStyle(node).display,
        main: rect(".activity-row-title-main"),
        meta: rect(".activity-row-title-meta"),
        activity: rect(".activity-table-activity"),
        author: rect(".activity-table-author"),
        reward: rect(".activity-table-reward"),
        quantity: rect(".activity-table-quantity"),
        actions: rect(".activity-table-actions"),
      };
    });
    expect(layout.meta.y).toBeGreaterThanOrEqual(layout.main.bottom);
    if (width === 1440) {
      expect(layout.display).toBe("table-row");
      for (const [cell, fraction] of [
        [layout.activity, 0.4],
        [layout.author, 0.17],
        [layout.reward, 0.2],
        [layout.quantity, 0.13],
        [layout.actions, 0.1],
      ] as const)
        expect(cell.width / layout.rowWidth).toBeCloseTo(fraction, 2);
      const height = await publicRow(page, "evening").evaluate(
        (node) => node.getBoundingClientRect().height,
      );
      expect(height).toBeGreaterThanOrEqual(52);
      expect(height).toBeLessThanOrEqual(58);
    } else {
      expect(layout.display).toBe("grid");
      expect(layout.activity.width).toBeGreaterThan(layout.rowWidth * 0.85);
      expect(layout.author.x).toBeLessThan(layout.reward.x);
      expect(layout.reward.y).toBeGreaterThanOrEqual(layout.activity.bottom);
      expect(layout.quantity.y).toBeGreaterThanOrEqual(layout.reward.bottom);
      expect(layout.quantity.x).toBeCloseTo(layout.reward.x, 0);
      expect(layout.actions.y).toBeGreaterThanOrEqual(layout.quantity.bottom);
      expect(layout.actions.x).toBeCloseTo(layout.reward.x, 0);
    }

    const popupPromise = page.waitForEvent("popup");
    await link.click();
    const popup = await popupPromise;
    await expect.poll(() => forumRequests).toEqual([topicUrl]);
    await popup.close();
    await expect(page).toHaveURL(/#square$/u);
    await title.focus();
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(author).toBeFocused();
    const profile = page.getByRole("dialog", { name: "用户资料", exact: true });
    await expect(profile).toBeVisible();
    await expect(profile.locator("strong")).toHaveText("小满");
    await page.keyboard.press("Tab");
    await expect(
      profile.getByRole("button", { name: "关闭资料" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(profile).toHaveCount(0);
    await expect(author).toBeFocused();

    await weekend.evaluate((node) => {
      const title = node.querySelector(".activity-rows-open");
      const name = node.querySelector(".user-identity > span:last-child");
      const reward = node.querySelector(".activity-reward-summary");
      if (title) title.textContent = "超长活动标题和连续文本".repeat(12);
      if (name) name.textContent = "名字很长的论坛发布者".repeat(12);
      if (reward) reward.textContent = "12345678901234567890.00 LDC / 份";
    });
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await table.evaluate((node) => {
      for (const element of node.querySelectorAll<HTMLElement>(
        ".activity-rows-open, .user-identity, .status-badge, .activity-row-countdown, .activity-rows-participation, .activity-reward-label, .activity-reward-summary, .activity-rows-quantity, .view-activity-action",
      )) {
        const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
        element.style.setProperty(
          "font-size",
          `${fontSize * 2}px`,
          "important",
        );
      }
    });
    await expect(title).toHaveCSS(
      "font-size",
      width === 1440 ? "32px" : "26px",
    );
    await expectRowsToFit(publicRows(page));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await title.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#activity\?sample=weekend$/u);
    await expect(page.locator(".activity-page h1")).toHaveText(
      "周末红包 · 20 份",
    );
  });
}

const baseActivity: Activity = {
  id: "public-none",
  title: "公开固定奖励",
  author: "测试发布者",
  username: "square-test-author",
  color: "sage",
  type: "ldc",
  description: "本地公开测试",
  amount: "0.88",
  rewardMode: "fixed",
  count: 20,
  remaining: 12,
  deadlineAt: null,
  passwords: ["PRIVATE-ACTIVITY-PASSWORD"],
};
const cases: Array<{
  activity: Activity;
  participation: Participation;
  label: string | null;
  state?: ActivityViewStateOverrides;
}> = [
  { activity: baseActivity, participation: "none", label: null },
  {
    activity: { ...baseActivity, id: "public-claimed", remaining: 6 },
    participation: "claimed",
    label: "已领取",
  },
  ...(
    [
      ["registered", "已报名", "waiting"],
      ["drawing", "已报名", "settling"],
      ["won", "已中奖", "completed"],
      ["not-won", "未中奖", "completed"],
    ] as const
  ).map(([participation, label, drawProgress]) => ({
    activity: {
      ...baseActivity,
      id: `public-${participation}`,
      type: "draw" as const,
      rewardMode: "timed_draw" as const,
      amount: "20.00",
      poolAmount: "20.00",
      count: 10,
      remaining: 10,
      drawProgress,
    },
    participation,
    label,
    state: { drawProgress },
  })),
  {
    activity: {
      ...baseActivity,
      id: "public-random",
      rewardMode: "instant_random",
      amount: "",
      poolAmount: "30.00",
      count: 30,
      remaining: 2,
    },
    participation: "claimed",
    label: "已领取",
  },
  {
    activity: {
      ...baseActivity,
      id: "public-text",
      type: "text",
      rewardMode: undefined,
      amount: "",
      count: 12,
      remaining: 0,
      ended: true,
    },
    participation: "claimed",
    label: "已领取",
  },
];

async function mountPublicRows(page: Page) {
  const entry = await (await page.request.get("/main.tsx")).text();
  const react = entry.match(/from "([^"]+\/react\.js(?:\?[^"]*)?)"/u)?.[1];
  const reactDom = entry.match(
    /from "([^"]+\/react-dom_client\.js(?:\?[^"]*)?)"/u,
  )?.[1];
  if (!react || !reactDom) throw new Error("Prototype React modules not found");
  await page.goto("/");
  await expect(page.locator(".site-main")).toBeVisible();
  const records = Object.fromEntries(
    cases
      .filter((entry) => entry.participation !== "none")
      .map((entry) => [entry.activity.id, entry.participation]),
  );
  const states = Object.fromEntries(
    cases.map((entry) => [entry.activity.id, entry.state ?? {}]),
  );
  const results: Record<string, ParticipationResult> = Object.fromEntries(
    cases
      .filter(
        (entry) =>
          entry.participation === "none" ||
          entry.participation === "claimed" ||
          entry.participation === "won",
      )
      .map((entry) => [
        entry.activity.id,
        {
          participation: entry.participation === "won" ? "won" : "claimed",
          participatedAt: "2026-10-07T04:00:00.000Z",
          confirmedAt: "2026-10-07T04:00:01.000Z",
          rewardAmount: "9876.54",
          rewardText: "PRIVATE-CDK-CONTENT",
          password: "PRIVATE-SOURCE-PASSWORD",
          viewState: { participation: "claimed", paymentProgress: "confirmed" },
        },
      ]),
  );
  await page.evaluate(
    async (input) => {
      const React = (await import(input.react)).default;
      const { createRoot } = (await import(input.reactDom)).default;
      const { ActivityRows } = await import("/components/activity-rows.tsx");
      const app = document.getElementById("root");
      if (app) app.style.display = "none";
      const target = document.createElement("main");
      target.id = "public-square-harness";
      target.style.cssText = "position:fixed;inset:16px;overflow:auto;";
      document.body.append(target);
      const h = React.createElement;
      function Harness() {
        const [payment, setPayment] = React.useState("pending");
        const [fuzzy, setFuzzy] = React.useState(false);
        return h(
          React.Fragment,
          null,
          h(
            "select",
            {
              "aria-label": "测试付款进度",
              value: payment,
              onChange: (event: { target: { value: string } }) =>
                setPayment(event.target.value),
            },
            [
              "pending",
              "sending",
              "reconciling",
              "waiting",
              "confirmed",
              "attention",
            ].map((value) => h("option", { key: value, value }, value)),
          ),
          h(
            "label",
            null,
            h("input", {
              type: "checkbox",
              checked: fuzzy,
              onChange: (event: { target: { checked: boolean } }) =>
                setFuzzy(event.target.checked),
            }),
            "模糊公开数量",
          ),
          h(ActivityRows, {
            activities: input.activities,
            records: input.records,
            states: Object.fromEntries(
              Object.entries(input.states).map(([id, state]) => [
                id,
                { ...state, paymentProgress: payment },
              ]),
            ),
            results: input.results,
            fuzzy,
            onOpen: () => undefined,
          }),
        );
      }
      createRoot(target).render(h(Harness));
    },
    {
      react,
      reactDom,
      activities: cases.map((entry) => entry.activity),
      records,
      states,
      results,
    },
  );
  await expect(publicRows(page)).toHaveCount(cases.length);
}

test("public participation and reward summaries ignore private allocations and every payment state", async ({
  page,
}) => {
  await mountPublicRows(page);
  const rows = publicRows(page);
  for (const payment of [
    "pending",
    "sending",
    "reconciling",
    "waiting",
    "confirmed",
    "attention",
  ]) {
    await page
      .getByRole("combobox", { name: "测试付款进度" })
      .selectOption(payment);
    for (const entry of cases) {
      const row = publicRow(page, entry.activity.id);
      if (entry.label)
        await expect(
          row.locator(".activity-row-title-meta .activity-rows-participation"),
        ).toHaveText(entry.label);
      else
        await expect(row.locator(".activity-rows-participation")).toHaveCount(
          0,
        );
    }
    await expect(rows.locator(".activity-reward-summary")).toHaveText([
      "0.88 LDC / 份",
      "0.88 LDC / 份",
      "20.00 LDC 奖池",
      "20.00 LDC 奖池",
      "20.00 LDC 奖池",
      "20.00 LDC 奖池",
      "30.00 LDC 奖池",
    ]);
    await expect(
      rows.locator(
        ".activity-rows-amount, .payment-confirmation, .activity-rows-source, .activity-reward-status",
      ),
    ).toHaveCount(0);
    await expect(
      page.locator('.activity-rows[data-context="public"]'),
    ).not.toContainText(
      /9876\.54|PRIVATE-|待发放|发送中|核对中|等待恢复|已发放|异常待处理/u,
    );
  }
  await expect(
    publicRow(page, "public-drawing").locator(".status-badge"),
  ).toHaveText("正在开奖");
  await expect(
    publicRow(page, "public-text").locator(".activity-reward-label"),
  ).toHaveText("文本 / CDK");
  await expect(
    publicRow(page, "public-text").locator(".activity-reward-summary"),
  ).toHaveCount(0);
});

test("fuzzy public quantities hide exact counts without changing participation or pool summaries", async ({
  page,
}) => {
  await mountPublicRows(page);
  const rows = publicRows(page);
  await expect(rows.locator(".activity-rows-quantity")).toHaveText([
    "已领取 8 / 20 份",
    "已领取 14 / 20 份",
    "最多 10 人获奖",
    "最多 10 人获奖",
    "最多 10 人获奖",
    "最多 10 人获奖",
    "已领取 28 / 30 份",
    "已领取 12 / 12 份",
  ]);
  const summaries = await rows
    .locator(".activity-reward-summary")
    .allTextContents();
  const participation = await rows
    .locator(".activity-rows-participation")
    .allTextContents();
  await page.getByRole("checkbox", { name: "模糊公开数量" }).check();
  await expect(rows.locator(".activity-rows-quantity")).toHaveText([
    "奖励充足",
    "奖励有限",
    "名额不公开",
    "名额不公开",
    "名额不公开",
    "名额不公开",
    "剩余少量奖励",
    "奖励已领完",
  ]);
  await expect(rows.locator(".activity-reward-summary")).toHaveText(summaries);
  await expect(rows.locator(".activity-rows-participation")).toHaveText(
    participation,
  );
});

test("square pagination and public quantities survive account switching and an empty reward filter", async ({
  page,
}) => {
  await openSquare(page);
  const rows = publicRows(page);
  const totalLabel = square(page)
    .getByRole("region", { name: "活动广场统计" })
    .locator('[data-statistic="public"]');
  const total = Number((await totalLabel.innerText()).match(/\d+/u)?.[0]);
  expect(total).toBeGreaterThan(20);
  await expect(
    square(page).getByRole("button", { name: "刷新活动列表", exact: true }),
  ).toBeVisible();
  const pagination = square(page).getByRole("navigation", {
    name: "活动广场分页",
    exact: true,
  });
  const previous = pagination.getByRole("button", {
    name: "上一页",
    exact: true,
  });
  const next = pagination.getByRole("button", { name: "下一页", exact: true });
  const ids: string[] = [];
  for (let number = 1; number <= Math.ceil(total / 20); number++) {
    await expect(pagination).toContainText(`第 ${number} 页`);
    await expect(rows).toHaveCount(Math.min(20, total - ids.length));
    ids.push(
      ...(await rows.evaluateAll((elements) =>
        elements.map((row) => row.getAttribute("data-activity-id") ?? ""),
      )),
    );
    if (number < Math.ceil(total / 20)) {
      await square(page)
        .locator(".list-panel__scroll")
        .evaluate((node) => {
          node.scrollTop = 150;
        });
      await next.click();
      await expect
        .poll(() =>
          square(page)
            .locator(".list-panel__scroll")
            .evaluate((node) => node.scrollTop),
        )
        .toBe(0);
    }
  }
  expect(ids).toHaveLength(total);
  expect(new Set(ids).size).toBe(total);
  await expect(next).toBeDisabled();
  while (await previous.isEnabled()) await previous.click();
  await square(page).getByRole("button", { name: "LDC", exact: true }).click();
  const random = publicRow(page, "history-random-active");
  await expect(random.locator(".activity-rows-participation")).toHaveText(
    "已领取",
  );
  const quantity = await random.locator(".activity-rows-quantity").innerText();
  const reward = await random.locator(".activity-reward-summary").innerText();
  const filteredTotal = (await totalLabel.innerText()).replace(/\s+/gu, "");
  for (const identity of ["lite", "guest", "standard"]) {
    await page.getByRole("button", { name: "场景与身份" }).click();
    await page
      .getByRole("combobox", { name: "体验身份", exact: true })
      .selectOption(identity);
    await page.getByRole("button", { name: "场景与身份" }).click();
    // Identity changes remount the page and reset its local filters.
    await square(page)
      .getByRole("button", { name: "LDC", exact: true })
      .click();
    await expect(random).toHaveCount(1);
    if (identity === "standard")
      await expect(random.locator(".activity-rows-participation")).toHaveText(
        "已领取",
      );
    else
      await expect(random.locator(".activity-rows-participation")).toHaveCount(
        0,
      );
    await expect(random.locator(".activity-rows-quantity")).toHaveText(
      quantity,
    );
    await expect(random.locator(".activity-reward-summary")).toHaveText(reward);
    await expect(totalLabel).toHaveText(filteredTotal);
    await expect(
      rows.locator(".activity-rows-amount, .payment-confirmation"),
    ).toHaveCount(0);
  }

  await page.getByRole("button", { name: "场景与身份" }).click();
  await page
    .getByRole("combobox", { name: "列表场景", exact: true })
    .selectOption("empty");
  await page.getByRole("button", { name: "场景与身份" }).click();
  await expect(totalLabel).toHaveText("公开活动0场");
  await expect(square(page).locator(".list-panel")).toHaveAttribute(
    "data-state",
    "empty",
  );
  await expect(square(page).getByRole("status")).toHaveText("暂无记录");
  await expect(rows).toHaveCount(0);
  await expect(
    square(page).getByRole("table", { name: "公开活动" }),
  ).toHaveCount(0);
  await expect(pagination).toContainText("第 1 页");
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();
});
