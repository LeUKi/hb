import { test as base, expect, type Page } from "@playwright/test";
import { projectActivityNotes } from "../../apps/web/prototype/activity-notes";
import { activities } from "../../apps/web/prototype/fixtures";
import { gallerySamples } from "../../apps/web/prototype/framework-fixtures";
import {
  findWorkbenchActivity,
  fixtureActivityConfig,
  saveWorkbenchActivity,
  validateActivityConfig,
} from "../../apps/web/prototype/pages/workbench-store";
import type {
  Activity,
  ActivityViewState,
  Participation,
} from "../../apps/web/prototype/types";
import { activityStatusSentence } from "../../apps/web/prototype/view-state";

const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const forbidden: string[] = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          url.origin !== "http://127.0.0.1:4177" ||
          /^\/api(?:\/|$)/u.test(url.pathname)
        ) {
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
const region = (page: Page, stage: string) =>
  page.locator(`[data-note-region="${stage}"]`);
const content = (page: Page, stage: string) =>
  page.locator(`[data-note-stage="${stage}"]`);
async function identity(page: Page, value: string) {
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page.getByRole("combobox", { name: "体验身份" }).selectOption(value);
  await page.getByRole("button", { name: "场景与身份" }).click();
}
async function scenario(page: Page, value: string) {
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page
    .getByRole("combobox", { name: "活动状态", exact: true })
    .selectOption(value);
  await page.getByRole("button", { name: "场景与身份" }).click();
}
async function navigate(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

const sampleCases = [
  ["weekend", false, false],
  ["history-random-active", true, false],
  ["history-draw-won", true, true],
  ["thanks", false, true],
  ["history-random-ended", true, true],
  ["notes-drawing-ended", false, true],
] as const;
for (const [sample, reward, ended] of sampleCases) {
  test(`actual Markdown fields are correctly projected for ${sample}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/#activity?sample=${sample}`);
    const statusCopy: Record<string, string> = {
      weekend: "输入口令，兑换本次奖励。",
      "history-random-active": "兑换成功。",
      "history-draw-won": "已中奖。",
      thanks: "本次活动已结束。",
      "history-random-ended": "兑换成功。",
      "notes-drawing-ended": "报名已截止，正在开奖。",
    };
    await expect(page.locator(".activity-status-copy")).toHaveText(
      statusCopy[sample] ?? "",
    );
    await expect(content(page, "description")).toHaveCount(0);
    await expect(page.locator(".claim-copy h2")).toHaveCount(0);
    const fixture = gallerySamples.find(
      (item) => item.id === sample,
    ) as Activity;
    await expect(region(page, "before").locator("summary")).toHaveAttribute(
      "aria-expanded",
      String(!reward),
    );
    await expect(region(page, "after")).toHaveCount(Number(reward));
    await expect(region(page, "ended")).toHaveCount(Number(ended));
    if (reward) {
      await expect(content(page, "after")).toContainText(
        (fixture.afterClaimInfo ?? "").split("\n")[0] ?? "",
      );
      await region(page, "before").locator("summary").click();
    }
    await expect(content(page, "before")).toBeVisible();
    if (ended) {
      await expect(content(page, "ended")).toContainText(
        (fixture.afterEndInfo ?? "").split("\n")[0] ?? "",
      );
      expect(
        await region(page, "ended").evaluate(
          (node) => node.parentElement?.lastElementChild === node,
        ),
      ).toBe(true);
    }
    if (!reward)
      expect(await page.locator(".activity-page").textContent()).not.toContain(
        fixture.afterClaimInfo?.split("\n")[0],
      );
  });
}

test("note projection preserves source and denies unallocated or ineligible reward text", () => {
  const fixture = {
    ...activities[0],
    beforeInfo: " before ",
    afterClaimInfo: " secret ",
    afterEndInfo: " ended ",
  } as Activity;
  const state: ActivityViewState = {
    lifecycle: "active",
    participation: "none",
    drawProgress: null,
    paymentProgress: null,
  };
  const denied: Participation[] = ["none", "registered", "drawing", "not-won"];
  for (const participation of denied)
    expect(
      projectActivityNotes(fixture, { ...state, participation }, "standard"),
    ).toEqual({ before: " before ", after: undefined, ended: undefined });
  for (const participation of ["claimed", "won"] as const) {
    for (const paymentProgress of [null, "pending", "confirmed"] as const) {
      expect(
        projectActivityNotes(
          fixture,
          { ...state, participation, paymentProgress },
          "standard",
        ).after,
      ).toBe(" secret ");
    }
    expect(
      projectActivityNotes(fixture, { ...state, participation }, "guest").after,
    ).toBeUndefined();
    expect(
      projectActivityNotes(fixture, { ...state, participation }, "lite").after,
    ).toBeUndefined();
  }
  for (const lifecycle of ["ended", "archived"] as const)
    expect(
      projectActivityNotes(fixture, { ...state, lifecycle }, "guest").ended,
    ).toBe(" ended ");
  expect(
    projectActivityNotes(
      {
        ...fixture,
        beforeInfo: " \n",
        afterClaimInfo: "",
        afterEndInfo: undefined,
      },
      { ...state, lifecycle: "ended", participation: "claimed" },
      "standard",
    ),
  ).toEqual({ before: undefined, after: undefined, ended: undefined });
});

test("disclosure choices survive ticks, reset with identity or phase, and deadline grants no extra content", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/#activity?sample=evening");
  await region(page, "before").locator("summary").click();
  await page.clock.fastForward(601_000);
  await expect(page.locator(".activity-status-copy")).toHaveText(
    "报名已截止，正在开奖。",
  );
  await expect(region(page, "before").locator("summary")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(region(page, "ended")).toHaveCount(0);
  await expect(region(page, "after")).toHaveCount(0);
  await scenario(page, "registered");
  await expect(region(page, "before").locator("summary")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(region(page, "after")).toHaveCount(0);
  await scenario(page, "won");
  await expect(content(page, "after")).toBeVisible();
  await region(page, "after").locator("summary").click();
  await region(page, "ended").locator("summary").click();
  await page.clock.fastForward(5000);
  await expect(region(page, "after").locator("summary")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(region(page, "ended").locator("summary")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await identity(page, "guest");
  await expect(region(page, "after")).toHaveCount(0);
  await expect(content(page, "before")).toBeVisible();
  await expect(content(page, "ended")).toBeVisible();
  await identity(page, "standard");
  await expect(content(page, "after")).toBeVisible();
  await scenario(page, "not-won");
  await expect(region(page, "after")).toHaveCount(0);
  await expect(content(page, "ended")).toBeVisible();
  await identity(page, "guest");
  await scenario(page, "drawing");
  await region(page, "before").locator("summary").click();
  await scenario(page, "draw-no-winners");
  await expect(content(page, "before")).toBeVisible();
});

for (const width of [1440, 375]) {
  test(`author save, edit, allocation and end use the actual notes at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#create");
    await page
      .getByRole("group", { name: "奖励类型" })
      .getByRole("button", { name: "文本 / CDK", exact: true })
      .click();
    await page.locator("#work-title").fill("说明链路验证");
    await page.locator("#work-text-rewards").fill("NOTE-CDK-A\nNOTE-CDK-B");
    await page.locator("#work-password-1").fill("说明链路口令");
    await page.locator(".work-more-settings > summary").click();
    await expect(page.locator("#work-before-note")).toHaveValue("");
    await page
      .locator("#work-before-note")
      .fill(
        "**阅读说明**\n\n" +
          "长内容".repeat(90) +
          "\n\n![remote](https://example.com/forbidden.png)\n\n<script>alert(1)</script>",
      );
    await page.locator("#work-after-note").fill("**本人的奖励附言**\n\n第一版");
    await page
      .locator("#work-ended-note")
      .fill("**本期结束说明**\n\n感谢参与，已有奖励保留。");
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await page
      .getByRole("dialog", { name: "演示草稿已保存" })
      .getByRole("button", { name: "查看我的活动" })
      .click();
    const row = page
      .getByTestId("managed-activity")
      .filter({ hasText: "说明链路验证" });
    const id = await row.getAttribute("data-activity-id");
    await row
      .getByRole("button", { name: "说明链路验证：编辑草稿", exact: true })
      .click();
    await page.locator(".work-more-settings > summary").click();
    await expect(page.locator("#work-after-note")).toHaveValue(
      "**本人的奖励附言**\n\n第一版",
    );
    await page
      .locator("#work-after-note")
      .fill("**本人的奖励附言**\n\n保存编辑后的正文。");
    await page.getByRole("button", { name: "保存并开放", exact: true }).click();
    await page
      .getByRole("dialog", { name: "演示活动已开放" })
      .getByRole("button", { name: "查看活动", exact: true })
      .click();
    await expect(content(page, "before").locator("strong")).toHaveText(
      "阅读说明",
    );
    await expect(content(page, "description")).toHaveCount(0);
    await expect(content(page, "before").locator("img, script")).toHaveCount(0);
    await expect(region(page, "after")).toHaveCount(0);
    const beforeOrder = await page.evaluate(() => {
      const note = document.querySelector('[data-note-region="before"]');
      const input = document.querySelector("#activity-password");
      return Boolean(
        note &&
          input &&
          note.compareDocumentPosition(input) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(beforeOrder).toBe(true);
    if (width === 1440) {
      await identity(page, "lite");
      await expect(region(page, "after")).toHaveCount(0);
      await page.locator("#activity-password").fill("说明链路口令");
      await page
        .locator(".claim-form")
        .getByRole("button", { name: "领取奖励", exact: true })
        .click();
      await expect(content(page, "after")).toContainText("保存编辑后的正文");
      await navigate(page, "participations");
      await expect(
        page.getByRole("button", { name: "说明链路验证", exact: true }),
      ).toBeVisible();
      await navigate(page, `activity?sample=${id}`);
      await identity(page, "standard");
      await expect(region(page, "after")).toHaveCount(0);
    }
    await page.locator("#activity-password").fill("说明链路口令");
    await page
      .locator(".claim-form")
      .getByRole("button", { name: "领取奖励", exact: true })
      .click();
    await expect(content(page, "after")).toContainText("保存编辑后的正文");
    await expect(region(page, "before").locator("summary")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.locator(".text-reward")).toBeVisible();
    await navigate(page, "manage");
    // Closing an activity is a fixture transition; the list no longer exposes
    // the removed early-end action.
    const workbenchSource = await (
      await page.request.get("/pages/workbench.tsx")
    ).text();
    const storeUrl = workbenchSource.match(
      /from "([^"]*\/workbench-store\.ts[^"]*)"/u,
    )?.[1];
    if (!storeUrl || !id) throw new Error("Local activity store unavailable");
    await page.evaluate(
      async ({ storeUrl, id }) => {
        const { endWorkbenchActivity } = await import(storeUrl);
        endWorkbenchActivity("standard", id);
      },
      { storeUrl, id },
    );
    await expect(
      page.getByRole("menuitem", { name: "提前结束", exact: true }),
    ).toHaveCount(0);
    await navigate(page, `activity?sample=${id}`);
    await expect(content(page, "after")).toContainText("保存编辑后的正文");
    const widths = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      main: document.querySelector("main")?.scrollWidth,
    }));
    expect(widths.doc).toBeLessThanOrEqual(width);
    expect(widths.main).toBeLessThanOrEqual(width);
    await identity(page, "guest");
    await expect(region(page, "after")).toHaveCount(0);
    await expect(page.locator(".text-reward")).toHaveCount(0);
    await expect(content(page, "before")).toBeVisible();
    await expect(content(page, "ended")).toBeVisible();
    if (width === 1440) {
      await identity(page, "standard");
      for (const allEmpty of [false, true]) {
        await navigate(page, `create?edit=${id}`);
        await page.locator(".work-more-settings > summary").click();
        await page.locator("#work-after-note").fill("");
        await page.locator("#work-ended-note").fill("   ");
        if (allEmpty) await page.locator("#work-before-note").fill("");
        await page
          .getByRole("button", { name: "保存修改", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "演示活动已更新" })
          .getByRole("button", { name: "查看活动", exact: true })
          .click();
        await expect(region(page, "after")).toHaveCount(0);
        await expect(region(page, "ended")).toHaveCount(0);
        await expect(content(page, "description")).toHaveCount(0);
        if (allEmpty)
          await expect(page.locator(".activity-notes")).toHaveCount(0);
        else await expect(content(page, "before")).toBeVisible();
      }
    }
  });
}

test("system status copy keeps allocated rewards ahead of lifecycle and separates deadlines", () => {
  const state: ActivityViewState = {
    lifecycle: "active",
    participation: "none",
    drawProgress: null,
    paymentProgress: null,
  };
  const copy = (
    type: Activity["type"],
    overrides: Partial<ActivityViewState> = {},
    expired = false,
  ) => activityStatusSentence({ type }, { ...state, ...overrides }, expired);
  expect(copy("text")).toBe("输入口令，兑换本次奖励。");
  expect(copy("draw", { drawProgress: "waiting" })).toBe(
    "输入口令，报名参与开奖。",
  );
  expect(
    copy("draw", { participation: "registered", drawProgress: "waiting" }),
  ).toBe("报名已确认，等待开奖。");
  expect(
    copy("draw", {
      lifecycle: "ended",
      participation: "drawing",
      drawProgress: "settling",
    }),
  ).toBe("报名已截止，正在开奖。");
  expect(
    copy("draw", {
      participation: "not-won",
      lifecycle: "ended",
      drawProgress: "completed",
    }),
  ).toBe("本次未中奖。");
  expect(copy("ldc", {}, true)).toBe("活动已截止，不能继续兑换。");
  expect(copy("ldc", { lifecycle: "draft" })).toBe("活动尚未开放。");
  expect(copy("ldc", { lifecycle: "archived" })).toBe("本次活动已归档。");
  for (const lifecycle of ["active", "ended", "archived"] as const) {
    expect(
      copy(
        "ldc",
        { lifecycle, participation: "claimed", paymentProgress: "pending" },
        true,
      ),
    ).toBe("兑换成功。");
    expect(
      copy("draw", {
        lifecycle,
        participation: "won",
        drawProgress: "completed",
      }),
    ).toBe("已中奖。");
  }
});

test("legacy descriptions remain compatible without hidden validation errors", () => {
  const config = fixtureActivityConfig("standard");
  config.notes.description = "旧简介".repeat(4000);
  expect(validateActivityConfig(config).ok).toBe(true);
  const saved = saveWorkbenchActivity("standard", config, "draft");
  expect(saved).not.toBeNull();
  expect(
    findWorkbenchActivity("standard", saved?.id ?? "")?.config.notes
      .description,
  ).toBe(config.notes.description);
  config.notes.before = "新说明".repeat(4000);
  expect(validateActivityConfig(config).errors["notes.before"]).toBe(
    "说明不能超过 10,000 个字符。",
  );
});

for (const width of [1440, 375]) {
  test(`signed author cards remain compact, consistent and keyboard accessible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#activity?sample=history-random-ended");
    await region(page, "before").locator("summary").click();
    const cards = page.locator("[data-note-region]");
    await expect(cards).toHaveCount(3);
    const fixture = gallerySamples.find(
      (item) => item.id === "history-random-ended",
    ) as Activity;
    for (const card of await cards.all()) {
      await expect(card).toHaveCSS("background-color", "rgb(43, 38, 35)");
      await expect(card).toHaveCSS("border-radius", "8px");
      await expect(card).toHaveCSS("padding", "12px");
      await expect(card.locator(".activity-note")).toHaveCSS(
        "font-size",
        "14px",
      );
      await expect(card.locator(".activity-note-signature")).toContainText(
        "来自",
      );
      await expect(
        card.locator(".activity-note-signature-author"),
      ).toHaveAttribute("title", fixture.author);
      await expect(card.locator(".activity-note-signature .avatar")).toHaveCSS(
        "width",
        "18px",
      );
      await expect(
        card.locator(".activity-note-signature .user-identity"),
      ).toHaveCSS("font-size", "12px");
    }
    await expect(page.locator(".activity-status-copy")).toHaveCSS(
      "font-size",
      "18px",
    );
    const author = region(page, "after").locator(
      ".activity-note-signature .user-identity",
    );
    await author.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "用户资料" })).toContainText(
      fixture.author,
    );
    await page.keyboard.press("Escape");
    await expect(author).toBeFocused();
    await expect(page.getByRole("dialog", { name: "用户资料" })).toHaveCount(0);
    await region(page, "after").locator("summary").click();
    await expect(
      region(page, "after").locator(".activity-note-signature"),
    ).toHaveCount(0);
    expect(
      await region(page, "ended").evaluate(
        (node) => node.parentElement?.lastElementChild === node,
      ),
    ).toBe(true);
    await scenario(page, "long");
    const longAuthor = region(page, "before").locator(
      ".activity-note-signature-author",
    );
    await expect(longAuthor).toHaveAttribute(
      "title",
      "负责维护开源工具与活动资料的佬友",
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const bounds = await longAuthor.boundingBox();
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    for (const hash of [
      "create",
      "create?edit=20000000-0000-4000-8000-000000000002",
    ]) {
      await navigate(page, hash);
      await page.locator(".work-more-settings > summary").click();
      await expect(page.locator("#work-description")).toHaveCount(0);
      await expect(page.locator(".work-more-content textarea")).toHaveCount(3);
    }
  });
}
