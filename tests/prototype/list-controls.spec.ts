import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const test = base.extend<{ isolatedNetwork: undefined }>({
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
        if (isForbidden(route.request().url())) {
          forbidden.add(route.request().url());
          await route.abort();
        } else {
          await route.continue();
        }
      });
      await use(undefined);
      expect(
        [...forbidden],
        "List controls use only the local prototype",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

async function mountLists(page: Page) {
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
      const {
        SegmentedControl,
        Pagination,
        usePagination,
        ListPanel,
        StatusBadge,
      } = await import("/components/list-controls.tsx");
      const app = document.getElementById("root");
      if (app) app.style.display = "none";
      const target = document.createElement("main");
      target.id = "list-controls-harness";
      target.style.cssText =
        "position:fixed;inset:16px;overflow:auto;display:grid;align-content:start;gap:12px;";
      document.body.append(target);
      const h = React.createElement;

      function Fixture() {
        const [items, setItems] = React.useState(() =>
          Array.from({ length: 45 }, (_, index) => index + 1),
        );
        const [filter, setFilter] = React.useState("all");
        const [tab, setTab] = React.useState("type-1");
        const [panelState, setPanelState] = React.useState("ready");
        const [retryCount, setRetryCount] = React.useState(0);
        const filtered = items.filter(
          (item: number) =>
            filter === "all" || (filter === "odd" && item % 2 === 1),
        );
        const pager = usePagination(filtered, filter);
        const state =
          panelState === "ready" && !filtered.length ? "empty" : panelState;
        return h(
          React.Fragment,
          null,
          h(SegmentedControl, {
            label: "记录筛选",
            value: filter,
            onChange: setFilter,
            options: [
              { value: "all", label: "全部", count: items.length },
              { value: "disabled", label: "不可用", disabled: true },
              { value: "odd", label: "仅单数", count: 23 },
              { value: "none", label: "无结果", count: 0 },
            ],
          }),
          h(SegmentedControl, {
            label: "类型标签",
            value: tab,
            onChange: setTab,
            mode: "tabs",
            options: Array.from({ length: 12 }, (_, index) => ({
              value: `type-${index + 1}`,
              label: `类型 ${index + 1}`,
              disabled: index === 1,
            })),
          }),
          h(
            "div",
            { style: { height: "280px", minHeight: 0 } },
            h(
              ListPanel,
              {
                state,
                emptyText: "没有匹配记录",
                resetKey: `${filter}:${pager.page}`,
                onRetry: () => {
                  setRetryCount((count: number) => count + 1);
                  setPanelState("ready");
                },
                footer: h(Pagination, {
                  label: "记录分页",
                  page: pager.page,
                  hasNext: pager.hasNext,
                  onPageChange: pager.setPage,
                  busy: state === "loading",
                }),
              },
              h(
                "ul",
                { style: { margin: 0, padding: 0, listStyle: "none" } },
                pager.pageItems.map((item: number) =>
                  h(
                    "li",
                    {
                      key: item,
                      "data-testid": "list-record",
                      style: { minHeight: "44px", padding: "10px 8px" },
                    },
                    `记录 ${item}`,
                  ),
                ),
              ),
            ),
          ),
          h(
            "div",
            {
              "aria-label": "测试操作",
              style: { display: "flex", flexWrap: "wrap" },
            },
            h(
              "button",
              { onClick: () => setItems((old: number[]) => old.slice(0, 40)) },
              "删除末页记录",
            ),
            h("button", { onClick: () => setItems([]) }, "清空记录"),
            ...["ready", "empty", "loading", "error"].map((next) =>
              h(
                "button",
                { key: next, onClick: () => setPanelState(next) },
                next,
              ),
            ),
            h("output", { "data-testid": "retry-count" }, String(retryCount)),
          ),
          h(
            "div",
            { "data-testid": "badges", style: { display: "flex", gap: "8px" } },
            h(StatusBadge, { tone: "neutral" }, "未开始"),
            h(StatusBadge, { tone: "success" }, "已完成"),
            h(StatusBadge, { tone: "pending" }, "待处理"),
            h(StatusBadge, { tone: "danger" }, "失败"),
          ),
        );
      }
      createRoot(target).render(h(Fixture));
    },
    { react, reactDom },
  );
  const harness = page.locator("#list-controls-harness");
  await expect(harness.getByTestId("list-record")).toHaveCount(20);
  return harness;
}

async function selectedBlockMatches(control: Locator) {
  return control.evaluate((element) => {
    const button = element.querySelector(
      '[aria-pressed="true"], [aria-selected="true"]',
    );
    const block = element.querySelector(".segmented-control__selection");
    if (!button || !block) return false;
    const expected = button.getBoundingClientRect();
    const actual = block.getBoundingClientRect();
    return ["x", "y", "width", "height"].every(
      (axis) =>
        Math.abs(
          actual[axis as "x" | "y" | "width" | "height"] -
            expected[axis as "x" | "y" | "width" | "height"],
        ) < 1,
    );
  });
}

test("single selection keeps button semantics and keyboard navigation skips disabled options", async ({
  page,
}) => {
  const harness = await mountLists(page);
  const group = harness.getByRole("group", { name: "记录筛选" });
  const all = group.getByRole("button", { name: /^全部/u });
  const disabled = group.getByRole("button", { name: "不可用", exact: true });
  const odd = group.getByRole("button", { name: /^仅单数/u });
  const empty = group.getByRole("button", { name: /^无结果/u });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(disabled).toBeDisabled();
  await expect(all).toHaveAttribute("tabindex", "0");
  await odd.focus();
  await odd.press("Home");
  await expect(all).toBeFocused();
  await all.press("ArrowRight");
  await expect(odd).toBeFocused();
  await expect(odd).toHaveAttribute("aria-pressed", "true");
  await odd.press("ArrowLeft");
  await expect(all).toBeFocused();
  await all.press("End");
  await expect(empty).toBeFocused();
  await expect(empty).toHaveAttribute("aria-pressed", "true");
  await empty.press("ArrowRight");
  await expect(all).toBeFocused();
  await expect(group.getByRole("button", { pressed: true })).toHaveCount(1);
});

test("tabs use tab semantics, keep the selected option visible, and isolate their sliding block", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const harness = await mountLists(page);
  const group = harness.getByRole("group", { name: "记录筛选" });
  const tabs = harness.getByRole("tablist", { name: "类型标签" });
  const first = tabs.getByRole("tab", { name: "类型 1", exact: true });
  const disabled = tabs.getByRole("tab", { name: "类型 2", exact: true });
  const third = tabs.getByRole("tab", { name: "类型 3", exact: true });
  const last = tabs.getByRole("tab", { name: "类型 12", exact: true });
  await expect(tabs).toHaveAttribute("aria-orientation", "horizontal");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(first).not.toHaveAttribute("aria-pressed");
  await expect(disabled).toBeDisabled();
  await first.focus();
  await first.press("ArrowRight");
  await expect(third).toBeFocused();
  await third.press("End");
  await expect(last).toBeFocused();
  await expect(last).toHaveAttribute("aria-selected", "true");
  const tabBox = await last.boundingBox();
  const frameBox = await tabs.boundingBox();
  if (!tabBox || !frameBox) throw new Error("Tabs have no bounds");
  expect(tabBox.x).toBeGreaterThanOrEqual(frameBox.x);
  expect(tabBox.x + tabBox.width).toBeLessThanOrEqual(
    frameBox.x + frameBox.width,
  );
  expect(await tabs.evaluate((element) => element.scrollLeft)).toBeGreaterThan(
    0,
  );
  await expect(group.getByRole("button", { name: /^全部/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => selectedBlockMatches(group)).toBe(true);
  await expect.poll(() => selectedBlockMatches(tabs)).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(
    0,
  );
});

test("pagination uses twenty records, one-based pages, and stable controls without totals", async ({
  page,
}) => {
  const harness = await mountLists(page);
  const pager = harness.getByRole("navigation", { name: "记录分页" });
  const previous = pager.getByRole("button", { name: "上一页" });
  const next = pager.getByRole("button", { name: "下一页" });
  const records = harness.getByTestId("list-record");
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect(pager).toContainText("第 1 页");
  await expect(records).toHaveCount(20);
  await expect(records.first()).toHaveText("记录 1");
  await next.click();
  await expect(pager).toContainText("第 2 页");
  await expect(records.first()).toHaveText("记录 21");
  await expect(records).toHaveCount(20);
  await next.click();
  await expect(pager).toContainText("第 3 页");
  await expect(records).toHaveCount(5);
  await expect(records.first()).toHaveText("记录 41");
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect(pager).toContainText("第 2 页");
  await expect(pager).not.toContainText(/共|总|\/\s*3/u);
  await harness.getByRole("button", { name: "loading", exact: true }).click();
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();
  await expect(pager).toHaveAttribute("aria-busy", "true");
});

test("filters reset the page and deleting the last page clamps to valid records", async ({
  page,
}) => {
  const harness = await mountLists(page);
  const pager = harness.getByRole("navigation", { name: "记录分页" });
  const next = pager.getByRole("button", { name: "下一页" });
  const filter = harness.getByRole("group", { name: "记录筛选" });
  await next.click();
  await next.click();
  await harness.getByRole("button", { name: "删除末页记录" }).click();
  await expect(pager).toContainText("第 2 页");
  await expect(harness.getByTestId("list-record")).toHaveCount(20);
  await expect(harness.getByTestId("list-record").first()).toHaveText(
    "记录 21",
  );
  await expect(next).toBeDisabled();
  await filter.getByRole("button", { name: /^仅单数/u }).click();
  await expect(pager).toContainText("第 1 页");
  await expect(harness.getByTestId("list-record").first()).toHaveText("记录 1");
  await filter.getByRole("button", { name: /^全部/u }).click();
  await expect(pager).toContainText("第 1 页");
  await harness.getByRole("button", { name: "清空记录" }).click();
  await expect(pager).toContainText("第 1 页");
  await expect(harness.getByTestId("list-record")).toHaveCount(0);
  await expect(
    harness.getByRole("region", { name: "列表内容" }).getByRole("status"),
  ).toContainText("没有匹配记录");
  await expect(pager.getByRole("button", { name: "上一页" })).toBeDisabled();
  await expect(next).toBeDisabled();
});

test("only the list scrolls, page changes reset it, and the pager retains focus", async ({
  page,
}) => {
  const harness = await mountLists(page);
  const scroll = harness.getByRole("region", { name: "列表内容" });
  const pager = harness.getByRole("navigation", { name: "记录分页" });
  const next = pager.getByRole("button", { name: "下一页" });
  const before = await pager.boundingBox();
  await scroll.evaluate((element) => {
    element.scrollTop = 300;
  });
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  expect(await pager.boundingBox()).toEqual(before);
  await next.click();
  await expect(pager).toContainText("第 2 页");
  await expect(next).toBeFocused();
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await pager.boundingBox()).toEqual(before);
  expect(
    await harness
      .locator(".list-panel")
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
});

test("empty, loading, error and retry keep the footer in place and expose meaningful status", async ({
  page,
}) => {
  const harness = await mountLists(page);
  const pager = harness.getByRole("navigation", { name: "记录分页" });
  const scroll = harness.getByRole("region", { name: "列表内容" });
  const footerBox = await pager.boundingBox();
  await harness.getByRole("button", { name: "empty", exact: true }).click();
  await expect(scroll.getByRole("status")).toHaveText("没有匹配记录");
  expect(await pager.boundingBox()).toEqual(footerBox);
  await harness.getByRole("button", { name: "loading", exact: true }).click();
  await expect(scroll).toHaveAttribute("aria-busy", "true");
  await expect(scroll.getByRole("status")).toHaveText("正在加载…");
  await expect(harness.getByTestId("list-record")).toHaveCount(0);
  expect(await pager.boundingBox()).toEqual(footerBox);
  await harness.getByRole("button", { name: "error", exact: true }).click();
  await expect(scroll.getByRole("alert")).toHaveText("加载失败，请重试。");
  await scroll.getByRole("button", { name: "重试" }).click();
  await expect(harness.getByTestId("retry-count")).toHaveText("1");
  await expect(harness.getByTestId("list-record")).toHaveCount(20);
  expect(await pager.boundingBox()).toEqual(footerBox);
});

test("status text and segmented states meet contrast and tap target requirements", async ({
  page,
}) => {
  const harness = await mountLists(page);
  const ratios = await harness.evaluate((element) => {
    const rgb = (color: string) =>
      (color.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number);
    const luminance = (color: string) => {
      const [r = 0, g = 0, b = 0] = rgb(color).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (first: string, second: string) => {
      const a = luminance(first);
      const b = luminance(second);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const badges = Array.from(
      element.querySelectorAll(".status-badge"),
      (badge) => {
        const style = getComputedStyle(badge);
        return {
          text: badge.textContent,
          ratio: contrast(style.color, style.backgroundColor),
        };
      },
    );
    const selected = element.querySelector<HTMLElement>(
      '[aria-pressed="true"]',
    );
    const block = selected?.querySelector(".segmented-control__selection");
    const frame = selected?.closest(".segmented-control__scroll");
    if (!selected || !block || !frame)
      throw new Error("Segmented state missing");
    return {
      badges,
      selectedText: contrast(
        getComputedStyle(selected).color,
        getComputedStyle(block).backgroundColor,
      ),
      selectedState: contrast(
        getComputedStyle(block).borderColor,
        getComputedStyle(frame).backgroundColor,
      ),
      border: contrast(
        getComputedStyle(frame).borderColor,
        getComputedStyle(frame).backgroundColor,
      ),
    };
  });
  for (const badge of ratios.badges)
    expect(
      badge.ratio,
      `${badge.text} normal text contrast`,
    ).toBeGreaterThanOrEqual(4.5);
  expect(ratios.selectedText).toBeGreaterThanOrEqual(4.5);
  expect(ratios.selectedState).toBeGreaterThanOrEqual(3);
  expect(ratios.border).toBeGreaterThanOrEqual(3);
  for (const control of await harness
    .locator(".segmented-control__button, .list-pagination__button")
    .all()) {
    const box = await control.boundingBox();
    if (!box) throw new Error("Control has no bounds");
    const isSegment = await control.evaluate((element) =>
      element.classList.contains("segmented-control__button"),
    );
    expect(box.width).toBeGreaterThanOrEqual(32);
    expect(box.height).toBeGreaterThanOrEqual(isSegment ? 26 : 32);
  }
  for (const frame of await harness.locator(".segmented-control__scroll").all())
    expect((await frame.boundingBox())?.height).toBeGreaterThanOrEqual(32);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("selection reaches its new position without a sliding transition", async ({
    page,
  }) => {
    const harness = await mountLists(page);
    const group = harness.getByRole("group", { name: "记录筛选" });
    const tabs = harness.getByRole("tablist", { name: "类型标签" });
    await tabs.getByRole("tab", { name: "类型 1", exact: true }).focus();
    await page.keyboard.press("End");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      tabs.getByRole("tab", { name: "类型 12", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    expect(await selectedBlockMatches(tabs)).toBe(true);
    expect(await selectedBlockMatches(group)).toBe(true);
    expect(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
  });
});
