import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const topicUrl = "https://linux.do/t/topic/2964597/1216";

const test = base.extend<{ externalRequests: string[]; localOnly: undefined }>({
  externalRequests: async ({ browserName }, use) => {
    void browserName;
    await use([]);
  },
  localOnly: [
    async ({ context, externalRequests }, use) => {
      const unexpected: string[] = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        const expectedExternal = url.href.startsWith(topicUrl);
        if (expectedExternal) {
          externalRequests.push(url.href);
          await route.abort();
          return;
        }
        if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
          unexpected.push(url.href);
          await route.abort();
          return;
        }
        await route.continue();
      });
      await use(undefined);
      expect(unexpected, "Activity row topic links stay bounded").toEqual([]);
    },
    { auto: true },
  ],
});

async function mountActivityRows(page: Page) {
  const response = await page.request.get("/main.tsx");
  const entry = await response.text();
  const react = entry.match(/from "([^"]+\/react\.js(?:\?[^"]*)?)"/u)?.[1];
  const reactDom = entry.match(
    /from "([^"]+\/react-dom_client\.js(?:\?[^"]*)?)"/u,
  )?.[1];
  if (!react || !reactDom) throw new Error("Prototype React modules not found");
  await page.goto("/");
  await expect(page.locator(".site-main")).toBeVisible();
  await page.evaluate(
    async (modules) => {
      const React = (await import(modules.react)).default;
      const { createRoot } = (await import(modules.reactDom)).default;
      const { ActivityRows } = await import("/components/activity-rows.tsx");
      const { activities } = await import("/fixtures.ts");
      const weekend = activities.find(
        (activity: { id: string }) => activity.id === "weekend",
      );
      const evening = activities.find(
        (activity: { id: string }) => activity.id === "evening",
      );
      const app = document.getElementById("root");
      if (app) app.style.display = "none";
      const target = document.createElement("main");
      target.id = "activity-rows-topic-harness";
      target.style.cssText = "position:fixed;inset:16px;overflow:auto;";
      document.body.append(target);
      const h = React.createElement;
      createRoot(target).render(
        h(
          React.Fragment,
          null,
          h(ActivityRows, {
            activities: [
              weekend,
              weekend && {
                ...weekend,
                id: "weekend-short-topic",
                title: "短路径论坛链接",
                topicUrl: "https://linux.do/t/2964597/1216",
              },
              weekend && {
                ...weekend,
                id: "weekend-invalid-topic",
                title: "非法论坛链接",
                topicUrl: "https://example.com/t/2964597/1216",
              },
              evening,
            ].filter(Boolean),
            onOpen: (activity: { id: string }) => {
              const output = document.querySelector("output");
              if (output) output.textContent = activity.id;
            },
          }),
          h("output", { "data-testid": "opened-activity" }),
        ),
      );
    },
    { react, reactDom },
  );
}

test("public rows expose independent Linux DO external links only when configured", async ({
  page,
  externalRequests,
}) => {
  await mountActivityRows(page);
  const row = page.locator(".activity-rows-row", { hasText: "周末红包" });
  const link = row.getByRole("link", { name: "打开关联论坛帖子" });
  await expect(link).toHaveAttribute("href", topicUrl);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/u);
  await expect(link.locator(".activity-rows-linuxdo-mark")).toHaveCount(1);
  await expect(link.locator(".activity-rows-linuxdo-mark circle")).toHaveCount(
    2,
  );
  await expect(link.locator(".activity-rows-linuxdo-mark rect")).toHaveCount(3);
  await expect(
    link.locator('.activity-rows-linuxdo-mark rect[fill="#1c1c1e"]'),
  ).toHaveCount(1);
  await expect(
    link.locator('.activity-rows-linuxdo-mark rect[fill="#f0f0f0"]'),
  ).toHaveCount(1);
  await expect(
    link.locator('.activity-rows-linuxdo-mark rect[fill="#ffb003"]'),
  ).toHaveCount(1);
  await expect(
    link.locator(".activity-rows-linuxdo-mark g[clip-path]"),
  ).toHaveCount(1);
  await expect(
    page
      .locator(".activity-rows-row", { hasText: "十分钟限时开奖" })
      .getByRole("link", { name: "打开关联论坛帖子" }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".activity-rows-row", { hasText: "短路径论坛链接" })
      .getByRole("link", { name: "打开关联论坛帖子" }),
  ).toHaveAttribute("href", topicUrl);
  await expect(
    page
      .locator(".activity-rows-row", { hasText: "非法论坛链接" })
      .getByRole("link", { name: "打开关联论坛帖子" }),
  ).toHaveCount(0);

  const popupPromise = page.waitForEvent("popup");
  await link.click();
  await popupPromise;
  expect(externalRequests).toContain(topicUrl);
  await expect(page.getByTestId("opened-activity")).toHaveText("");

  await row.getByRole("button", { name: /周末红包/u }).click();
  await expect(page.getByTestId("opened-activity")).toHaveText("weekend");
});

test("mobile gallery renders canonical forum links without widening the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#square");
  const link = page.getByRole("link", { name: "打开关联论坛帖子" }).first();
  await expect(link).toHaveAttribute("href", topicUrl);
  await expect(link.locator(".activity-rows-linuxdo-mark")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
});
