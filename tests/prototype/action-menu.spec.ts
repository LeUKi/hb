import { test as base, expect, type Page } from "@playwright/test";

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
      expect(forbidden, "Menus stay inside the local prototype").toEqual([]);
    },
    { auto: true },
  ],
});

async function mountMenus(page: Page) {
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
      const { ActionMenu } = await import("/components/action-menu.tsx");
      const app = document.getElementById("root");
      app?.remove();
      const target = document.createElement("main");
      target.id = "action-menu-harness";
      target.style.cssText =
        "position:fixed;inset:16px;overflow:auto;display:flex;align-items:start;gap:8px;flex-wrap:wrap;";
      document.body.append(target);
      const root = createRoot(target);
      let selected = "全部";
      let copied = "";
      function render() {
        root.render(
          React.createElement(
            React.Fragment,
            null,
            React.createElement(ActionMenu, {
              label: `状态：${selected}`,
              ariaLabel: "活动状态",
              items: ["全部", "准备中", "进行中", "已结束"].map((label) => ({
                label,
                selected: label === selected,
                disabled: label === "准备中",
                onSelect: () => {
                  selected = label;
                  render();
                },
              })),
            }),
            React.createElement(ActionMenu, {
              label: "复制领取文案",
              items: ["不含口令", "包含全部口令"].map((label) => ({
                label,
                onSelect: () => {
                  copied = label;
                  render();
                },
              })),
            }),
            React.createElement("button", { type: "button" }, "外部操作"),
            React.createElement(
              "output",
              { "data-testid": "status-value" },
              selected,
            ),
            React.createElement(
              "output",
              { "data-testid": "copy-value" },
              copied,
            ),
            React.createElement("div", {
              "data-testid": "scroll-filler",
              style: { height: "1500px", width: "100%" },
            }),
          ),
        );
      }
      render();
    },
    { react, reactDom },
  );
  return page.locator("#action-menu-harness");
}

test("portal menu navigates radio options by keyboard, skips disabled items and returns focus", async ({
  page,
}) => {
  const harness = await mountMenus(page);
  const trigger = harness.getByRole("button", { name: "活动状态" });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "活动状态" });
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((element) => element.parentElement === document.body),
  ).toBe(true);
  await expect(menu.getByRole("menuitemradio", { name: "全部" })).toBeFocused();
  await expect(menu.getByRole("menuitemradio", { name: "全部" })).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitemradio", { name: "进行中" }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitemradio", { name: "已结束" }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitemradio", { name: "全部" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(
    menu.getByRole("menuitemradio", { name: "已结束" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(harness.getByTestId("status-value")).toHaveText("已结束");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(
    menu.getByRole("menuitemradio", { name: "已结束" }),
  ).toBeFocused();
  const exitingMenu = await menu.elementHandle();
  await page.keyboard.press("Escape");
  expect(
    await exitingMenu?.evaluate(
      (element) =>
        element.inert && element.getAttribute("aria-hidden") === "true",
    ),
  ).toBe(true);
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("action menus select on one click and close on outside input, scrolling and another menu", async ({
  page,
}) => {
  const harness = await mountMenus(page);
  const copy = harness.getByRole("button", { name: "复制领取文案" });
  await copy.click();
  const menu = page.getByRole("menu", { name: "复制领取文案" });
  await menu.getByRole("menuitem", { name: "包含全部口令" }).click();
  await expect(menu).toHaveCount(0);
  await expect(copy).toBeFocused();
  await expect(harness.getByTestId("copy-value")).toHaveText("包含全部口令");
  await copy.click();
  await harness.getByRole("button", { name: "活动状态" }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("menu", { name: "活动状态" })).toBeVisible();
  await harness.getByRole("button", { name: "外部操作" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await copy.click();
  await harness.evaluate((element) => {
    element.scrollTop = 100;
  });
  await expect(menu).toHaveCount(0);
});

test("Tab closes the portal and continues beyond the trigger", async ({
  page,
}) => {
  const harness = await mountMenus(page);
  const status = harness.getByRole("button", { name: "活动状态" });
  await status.focus();
  await page.keyboard.press("ArrowUp");
  await expect(
    page.getByRole("menuitemradio", { name: "已结束" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(
    harness.getByRole("button", { name: "复制领取文案" }),
  ).toBeFocused();
});

test("narrow edge placement keeps the menu within the viewport and outside clipped containers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 500 });
  const harness = await mountMenus(page);
  const trigger = harness.getByRole("button", { name: "复制领取文案" });
  await harness.evaluate((element) => {
    element.style.cssText =
      "position:fixed;right:12px;bottom:12px;width:160px;height:44px;overflow:hidden;";
  });
  await trigger.evaluate((element) => {
    element.style.position = "fixed";
    element.style.right = "12px";
    element.style.bottom = "12px";
  });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "复制领取文案" });
  const bounds = await menu.boundingBox();
  if (!bounds) throw new Error("Menu bounds missing");
  expect(bounds.x).toBeGreaterThanOrEqual(12);
  expect(bounds.y).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(363);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(488);
  await expect(menu.getByRole("menuitem", { name: "不含口令" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
