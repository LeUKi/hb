import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const firstPassword = "公共口令2026";
const secondPassword = "开奖口令2026";

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
      expect(
        forbidden,
        "Password components never request business data",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

type ListState = {
  scope: string;
  hiddenCount: number;
  known: { text: string; label?: string }[];
  defaultRevealed: boolean;
  mounted: boolean;
  tick: number;
};

async function mountList(page: Page) {
  const response = await page.request.get("/main.tsx");
  expect(response.ok()).toBe(true);
  const entry = await response.text();
  const react = entry.match(/from "([^"]+\/react\.js(?:\?[^"]*)?)"/u)?.[1];
  const reactDom = entry.match(
    /from "([^"]+\/react-dom_client\.js(?:\?[^"]*)?)"/u,
  )?.[1];
  if (!react || !reactDom) throw new Error("Prototype React modules not found");
  await page.goto("/");
  await expect(page.locator(".site-main")).toBeVisible();
  await page.evaluate(
    async ({ modules, first, second }) => {
      const React = (await import(modules.react)).default;
      const { createRoot } = (await import(modules.reactDom)).default;
      const { PasswordList } = await import("/components/password-list.tsx");
      const app = document.getElementById("root");
      if (app) app.style.display = "none";
      const target = document.createElement("main");
      target.id = "password-list-harness";
      target.style.cssText = "position:fixed;inset:16px;overflow:auto;";
      document.body.append(target);
      const root = createRoot(target);
      let state: ListState = {
        scope: "activity-a:account-a",
        hiddenCount: 3,
        known: [{ text: first, label: "已用此口令兑换" }, { text: second }],
        defaultRevealed: false,
        mounted: true,
        tick: 0,
      };
      function render(updates: Partial<ListState> = {}) {
        state = { ...state, ...updates };
        root.render(
          React.createElement(
            React.Fragment,
            null,
            state.mounted
              ? React.createElement(PasswordList, {
                  known: state.known,
                  hiddenCount: state.hiddenCount,
                  scope: state.scope,
                  heading: React.createElement("h2", null, "活动口令"),
                  defaultRevealed: state.defaultRevealed,
                })
              : null,
            React.createElement(
              "output",
              { "data-testid": "timer-tick" },
              String(state.tick),
            ),
          ),
        );
      }
      Reflect.set(window, "updatePasswordList", render);
      render();
    },
    {
      modules: { react, reactDom },
      first: firstPassword,
      second: secondPassword,
    },
  );
  await expect(page.locator("#password-list-harness .pw-reveal")).toHaveCount(
    2,
  );
  return page.locator("#password-list-harness");
}

async function updateList(page: Page, updates: Partial<ListState>) {
  await page.evaluate(
    (next) => Reflect.get(window, "updatePasswordList")(next),
    updates,
  );
}

test("known rows have optional labels without headings, numbers or copy actions", async ({
  page,
}) => {
  const harness = await mountList(page);
  const rows = harness.locator(".pw-reveal");
  await expect(rows.first().locator(".pw-reveal__label")).toHaveText(
    "已用此口令兑换",
  );
  await expect(rows.nth(1).locator(".pw-reveal__heading")).toHaveCount(0);
  await expect(harness.locator(".pw-reveal__index")).toHaveCount(0);
  await expect(rows.locator("button")).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("data-password-state", "known");
  await expect(rows.nth(1)).toHaveAttribute("data-password-state", "known");
  await expect(rows.first().locator(".pw-reveal__value")).toHaveCSS(
    "filter",
    "blur(5px)",
  );
  await expect(harness.getByRole("button", { name: /复制/u })).toHaveCount(0);
});

test("title eye reveals and hides all known passwords without unlocking placeholders", async ({
  page,
}) => {
  const harness = await mountList(page);
  const titleEye = harness.getByRole("button", { name: "显示全部口令" });
  const rows = harness.locator(".pw-reveal");
  const values = rows.locator(".pw-reveal__value");
  await expect(titleEye).toBeEnabled();
  await expect(titleEye).toHaveAttribute("aria-pressed", "false");
  await titleEye.click();
  await expect(
    harness.getByRole("button", { name: "隐藏全部口令" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(values.nth(0)).toHaveAttribute("aria-hidden", "false");
  await expect(values.nth(1)).toHaveAttribute("aria-hidden", "false");
  await expect(harness.locator(".pw-locked button")).toHaveCount(0);
  await harness.getByRole("button", { name: "隐藏全部口令" }).click();
  await expect(values.nth(0)).toHaveAttribute("aria-hidden", "true");
  await expect(values.nth(1)).toHaveAttribute("aria-hidden", "true");
  await rows.first().locator(".pw-reveal__interaction").hover();
  await expect(values.nth(0)).toHaveAttribute("aria-hidden", "false");
});

test("title eye is disabled when every password row is locked", async ({
  page,
}) => {
  const harness = await mountList(page);
  await updateList(page, { known: [] });
  const titleEye = harness.getByRole("button", { name: "显示全部口令" });
  await expect(titleEye).toBeDisabled();
  await expect(harness.locator(".pw-locked")).toHaveCount(3);
  expect(await harness.innerHTML()).not.toContain(firstPassword);
});

test("batch hide masks a currently hovered password until pointer leaves", async ({
  page,
}) => {
  const harness = await mountList(page);
  const rows = harness.locator(".pw-reveal");
  const value = rows.first().locator(".pw-reveal__value");
  await rows.first().locator(".pw-reveal__interaction").hover();
  await expect(value).toHaveAttribute("aria-hidden", "false");
  const titleEye = harness.getByRole("button", { name: "显示全部口令" });
  await titleEye.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(value).toHaveAttribute("aria-hidden", "true");
  await rows.first().locator(".pw-reveal__interaction").hover();
  await expect(value).toHaveAttribute("aria-hidden", "true");
  await page.mouse.move(0, 0);
  await rows.first().locator(".pw-reveal__interaction").hover();
  await expect(value).toHaveAttribute("aria-hidden", "false");
});

test("locked rows render unrelated 12-character ASCII placeholders and never reveal", async ({
  page,
}) => {
  const harness = await mountList(page);
  const locked = harness.locator(".pw-locked");
  await expect(locked).toHaveCount(3);
  const placeholders = await locked
    .locator(".pw-locked__value")
    .allTextContents();
  for (const placeholder of placeholders)
    expect(placeholder).toMatch(/^[A-Za-z0-9]{12}$/u);
  expect(new Set(placeholders).size).toBe(3);
  await expect(locked.locator("button")).toHaveCount(0);
  await expect(locked.locator(".pw-locked__status")).toHaveText([
    "未解出",
    "未解出",
    "未解出",
  ]);
  await expect(locked.first()).toHaveAttribute("data-password-state", "locked");
  expect(
    await locked
      .first()
      .locator(".pw-locked__value")
      .evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain("monospace");
  expect(await locked.first().ariaSnapshot()).not.toContain(placeholders[0]);
  const before = await locked.first().innerHTML();
  await locked.first().hover();
  expect(await locked.first().innerHTML()).toBe(before);
  expect(await locked.first().innerHTML()).not.toContain(firstPassword);
  expect(await locked.first().innerHTML()).not.toContain(secondPassword);
  await updateList(page, { known: [] });
  await expect(harness.locator(".pw-reveal")).toHaveCount(0);
  await expect(locked).toHaveCount(3);
  expect(await harness.innerHTML()).not.toContain(firstPassword);
  expect(await harness.innerHTML()).not.toContain(secondPassword);
});

test("locked placeholders survive timer rerenders, solving, unmounting and returning to a scope", async ({
  page,
}) => {
  const harness = await mountList(page);
  const placeholders = harness.locator(".pw-locked__value");
  const initial = await placeholders.allTextContents();
  await updateList(page, { tick: 1 });
  await expect(harness.getByTestId("timer-tick")).toHaveText("1");
  expect(await placeholders.allTextContents()).toEqual(initial);
  await updateList(page, { hiddenCount: 2 });
  await expect(placeholders).toHaveCount(2);
  expect(await placeholders.allTextContents()).toEqual(initial.slice(0, 2));
  await updateList(page, { mounted: false });
  await expect(placeholders).toHaveCount(0);
  await updateList(page, { mounted: true, hiddenCount: 3 });
  await expect(placeholders).toHaveCount(3);
  expect(await placeholders.allTextContents()).toEqual(initial);
  await updateList(page, { scope: "activity-a:account-b" });
  await expect
    .poll(async () => placeholders.allTextContents())
    .not.toEqual(initial);
  const otherAccount = await placeholders.allTextContents();
  await updateList(page, { scope: "activity-b:account-b" });
  await expect
    .poll(async () => placeholders.allTextContents())
    .not.toEqual(otherAccount);
  await updateList(page, { scope: "activity-a:account-a" });
  await expect
    .poll(async () => placeholders.allTextContents())
    .toEqual(initial);
});

test("known reveal state resets after remount while locked placeholders stay unchanged", async ({
  page,
}) => {
  const harness = await mountList(page);
  const initial = await harness.locator(".pw-locked__value").allTextContents();
  const known = harness.locator(".pw-reveal").first();
  await known.getByRole("button").click();
  await page.mouse.move(0, 0);
  await expect(known.locator(".pw-reveal__value")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  await updateList(page, { mounted: false });
  await expect(known).toHaveCount(0);
  await updateList(page, { mounted: true });
  await expect(known.locator(".pw-reveal__value")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(known.getByRole("button")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(await harness.locator(".pw-locked__value").allTextContents()).toEqual(
    initial,
  );
});

test("published-password defaults reveal immediately, and timer updates preserve explicit hiding", async ({
  page,
}) => {
  const harness = await mountList(page);
  await page.evaluate(() => {
    const target = document.getElementById("password-list-harness");
    if (!target) throw new Error("Password harness missing");
    const snapshots: string[][] = [];
    Reflect.set(window, "publishedPasswordSnapshots", snapshots);
    const observer = new MutationObserver(() => {
      snapshots.push(
        Array.from(
          target.querySelectorAll(".pw-reveal__value"),
          (value) => value.getAttribute("aria-hidden") ?? "",
        ),
      );
    });
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    Reflect.set(window, "publishedPasswordObserver", observer);
  });
  await updateList(page, { defaultRevealed: true });
  const values = harness.locator(".pw-reveal__value");
  await expect(values.nth(0)).toHaveAttribute("aria-hidden", "false");
  await expect(values.nth(1)).toHaveAttribute("aria-hidden", "false");
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "publishedPasswordSnapshots"),
    ),
  ).not.toContainEqual(["true", "true"]);
  await page.evaluate(() => {
    Reflect.get(window, "publishedPasswordObserver").disconnect();
  });
  await harness.getByRole("button", { name: "隐藏全部口令" }).click();
  await updateList(page, { tick: 2 });
  await expect(harness.getByTestId("timer-tick")).toHaveText("2");
  await expect(values.nth(0)).toHaveAttribute("aria-hidden", "true");
  await expect(values.nth(1)).toHaveAttribute("aria-hidden", "true");
  await expect(harness.locator(".pw-locked button")).toHaveCount(0);
  await expect(harness.locator(".pw-locked__value").first()).toHaveCSS(
    "filter",
    "blur(5px)",
  );
  await updateList(page, { scope: "activity-a:account-b" });
  await expect(values.nth(0)).toHaveAttribute("aria-hidden", "false");
  await updateList(page, { known: [{ text: "公开答案2026" }] });
  await expect(values).toHaveCount(1);
  await expect(values.first()).toHaveAttribute("aria-hidden", "false");
  await updateList(page, { defaultRevealed: false });
  await expect(values.first()).toHaveAttribute("aria-hidden", "true");
});

test("default-visible rows retain independent eye and hover-hide priority", async ({
  page,
}) => {
  const harness = await mountList(page);
  await updateList(page, { defaultRevealed: true });
  const rows = harness.locator(".pw-reveal");
  const value = rows.first().locator(".pw-reveal__value");
  await rows.first().locator(".pw-reveal__interaction").hover();
  await rows.first().getByRole("button", { name: "隐藏内容" }).click();
  await expect(value).toHaveAttribute("aria-hidden", "true");
  await expect(rows.nth(1).locator(".pw-reveal__value")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  await expect(
    harness.getByRole("button", { name: "显示全部口令" }),
  ).toHaveAttribute("aria-pressed", "false");
  await updateList(page, { tick: 3 });
  await expect(value).toHaveAttribute("aria-hidden", "true");
  await page.mouse.move(0, 0);
  await rows.first().locator(".pw-reveal__interaction").hover();
  await expect(value).toHaveAttribute("aria-hidden", "false");
});

test("blurred values have visible overflow without expanding compact rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 850 });
  const harness = await mountList(page);
  const row = harness.locator(".pw-reveal").first();
  const body = row.locator(".pw-reveal__body");
  await expect(body).toHaveCSS("overflow-x", "visible");
  await expect(body).toHaveCSS("overflow-y", "visible");
  const rowBox = await row.boundingBox();
  const textBox = await row.locator(".pw-reveal__value").boundingBox();
  if (!rowBox || !textBox) throw new Error("Password bounds missing");
  expect(rowBox.height).toBeLessThanOrEqual(50);
  expect(textBox.x - rowBox.x).toBeGreaterThanOrEqual(12);
  await updateList(page, {
    known: [{ text: "完整的十八个汉字领取口令保留内容" }],
  });
  expect(
    await harness.evaluate((element) => element.scrollWidth),
  ).toBeLessThanOrEqual(343);
});

for (const width of [1440, 375]) {
  test(`known and locked passwords occupy compact rows at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    const harness = await mountList(page);
    const row = harness.locator(".pw-reveal").first();
    const box = await row.boundingBox();
    const value = await row.locator(".pw-reveal__value").boundingBox();
    const eye = await row.getByRole("button").boundingBox();
    const label = await row.locator(".pw-reveal__heading").boundingBox();
    if (!box || !value || !eye || !label)
      throw new Error("Password row bounds are missing");
    expect(box.width).toBeLessThanOrEqual(640);
    expect(box.height).toBeLessThanOrEqual(50);
    expect(eye.x - value.x - value.width).toBeCloseTo(6, 0);
    expect(eye.height).toBeGreaterThanOrEqual(44);
    expect(
      Math.abs(label.y + label.height / 2 - eye.y - eye.height / 2),
    ).toBeLessThanOrEqual(1);
    expect(
      await harness.evaluate((element) => element.scrollWidth),
    ).toBeLessThanOrEqual(width - 32);
    await expect(harness.locator(".pw-locked").first()).toHaveCSS(
      "min-height",
      "46px",
    );
  });
}
