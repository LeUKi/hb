import { expect, test } from "@playwright/test";
import {
  exportWorkbenchStoresSnapshot,
  findWorkbenchActivity,
  fixtureActivityConfig,
  importWorkbenchStoresSnapshot,
  type ManagedActivity,
  saveWorkbenchActivity,
} from "../../apps/web/prototype/pages/workbench-store";

test("snapshot import excludes retired records without reading reward payloads and preserves LDC allocations", () => {
  const initial = exportWorkbenchStoresSnapshot();
  try {
    const ldc = structuredClone(
      findWorkbenchActivity("standard", "20000000-0000-4000-8000-000000000003"),
    );
    if (!ldc) throw new Error("LDC fixture is missing");
    ldc.title = "标题中的 CDK 是用户原文";
    ldc.rewardAmountInventory = [
      ...(ldc.rewardAmountInventory ?? []),
    ].reverse();
    const before = structuredClone(ldc);
    const retired = {
      id: "retired-text-id",
      config: {
        rewardKind: "text",
        get plan() {
          throw new Error("Retired configuration was read");
        },
        get textRewards() {
          throw new Error("Retired reward payload was read");
        },
      },
    } as unknown as ManagedActivity;
    importWorkbenchStoresSnapshot([
      ["standard", { activities: [retired, ldc], payments: [] }],
      ["lite", { activities: [retired], payments: [] }],
    ]);
    expect(findWorkbenchActivity("standard", retired.id)).toBeUndefined();
    expect(findWorkbenchActivity("standard", ldc.id)).toEqual(before);
    expect(
      exportWorkbenchStoresSnapshot().find(
        ([identity]) => identity === "lite",
      )?.[1],
    ).toEqual({ activities: [], payments: [] });
    expect(retired.config.rewardKind).toBe("text");
  } finally {
    importWorkbenchStoresSnapshot(initial);
  }
});

test("only official identities may save LDC configurations and retired inputs never convert", () => {
  const config = fixtureActivityConfig("standard");
  const initial = exportWorkbenchStoresSnapshot();
  expect(saveWorkbenchActivity("lite", config, "draft")).toBeNull();
  expect(saveWorkbenchActivity("guest", config, "active")).toBeNull();
  const retired = { ...config, rewardKind: "text" } as unknown as typeof config;
  expect(saveWorkbenchActivity("standard", retired, "active")).toBeNull();
  expect(exportWorkbenchStoresSnapshot()).toEqual(initial);
});

for (const width of [1440, 375]) {
  test(`LDC-only forms and legacy filter URLs stay usable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#create");
    await expect(
      page.getByRole("group", { name: "奖励类型", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("#work-text-rewards")).toHaveCount(0);
    const plans = page.getByRole("group", {
      name: "LDC 奖励方式",
      exact: true,
    });
    await expect(plans.getByRole("button")).toHaveText([
      "固定均分",
      "即时随机",
      "自定义金额",
      "限时开奖",
    ]);
    await page.locator("#work-title").fill("保留完整标题和口令");
    await page.locator("#work-password-1").fill("完整口令2026");
    for (const name of ["即时随机", "自定义金额", "限时开奖", "固定均分"])
      await plans.getByRole("button", { name, exact: true }).click();
    await expect(page.locator("#work-title")).toHaveValue("保留完整标题和口令");
    await expect(page.locator("#work-password-1")).toHaveValue("完整口令2026");
    for (const route of ["square", "participations", "manage"]) {
      await page.goto(`/#${route}?rewardType=text&cursor=retired&page=3`);
      await expect(page).toHaveURL(
        new RegExp(
          route === "square" ? "#home\\?dialog=square$" : `#${route}$`,
          "u",
        ),
      );
      await expect(page.getByRole("group", { name: "奖励筛选" })).toHaveCount(
        0,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }
    await page.goto(
      "/#admin?section=activities&type=text&page=2&cursor=retired",
    );
    await expect(page).toHaveURL(/#admin\?section=activities$/u);
    await expect(
      page.getByRole("combobox", { name: "类型", exact: true }),
    ).toHaveCount(0);
    for (const retiredId of ["reading", "history-text-handbook"]) {
      await page.goto(`/#activity?sample=${retiredId}`);
      await expect(
        page.getByRole("heading", { name: "活动不存在", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".activity-page, .slip-amount")).toHaveCount(0);
    }
  });
}

test("cross-window bootstrap rejects the previous snapshot version before restoring private results", async ({
  page,
}) => {
  await page.goto("/#home");
  const source = await (await page.request.get("/app.tsx")).text();
  const moduleUrl = source.match(
    /from "([^"]*\/activity-window\.ts[^"]*)"/u,
  )?.[1];
  if (!moduleUrl) throw new Error("Activity window module is missing");
  const accepted = await page.evaluate(async (url) => {
    const module = await import(url);
    const token = "retired-window-snapshot";
    const channel = new BroadcastChannel(
      `hb-prototype-activity-window-v2:${token}`,
    );
    channel.onmessage = (event) => {
      if (event.data.type === "ready")
        channel.postMessage({
          type: "snapshot",
          token,
          snapshot: {
            version: 1,
            createdAt: Date.now(),
            active: { type: "text" },
          },
        });
    };
    window.history.replaceState(
      null,
      "",
      `#activity?sample=retired&view=${token}`,
    );
    const result = await module.bootstrapActivityWindow();
    channel.close();
    return result?.ok;
  }, moduleUrl);
  expect(accepted).toBe(false);
  await expect(page.locator(".slip-amount")).toHaveCount(0);
});
