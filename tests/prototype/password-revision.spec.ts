import { mkdir } from "node:fs/promises";
import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const firstPassword = "公共口令2026";
const secondPassword = "开奖口令2026";

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
        "Password checks stay inside the prototype",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

type HarnessState = {
  text: string;
  scope: string;
  raw: string;
  submissions: number;
};

async function mountPasswords(page: Page) {
  const response = await page.request.get("/main.tsx");
  expect(response.ok()).toBe(true);
  const entry = await response.text();
  const react = entry.match(/from "([^"]+\/react\.js(?:\?[^"]*)?)"/u)?.[1];
  const reactDom = entry.match(
    /from "([^"]+\/react-dom_client\.js(?:\?[^"]*)?)"/u,
  )?.[1];
  expect(react).toBeTruthy();
  expect(reactDom).toBeTruthy();
  if (!react || !reactDom) throw new Error("Prototype React modules not found");

  await page.goto("/");
  await expect(page.locator(".site-main")).toBeVisible();
  await page.evaluate(
    async ({ modules, first, second }) => {
      const React = (await import(modules.react)).default;
      const { createRoot } = (await import(modules.reactDom)).default;
      const { PasswordReveal } = await import(
        "/components/password-reveal.tsx"
      );
      const { PasswordInput } = await import("/components/password-input.tsx");
      const app = document.getElementById("root");
      app?.replaceChildren();
      const target = document.createElement("main");
      target.id = "password-revision-harness";
      target.style.cssText =
        "position:fixed;inset:16px;overflow:auto;display:grid;align-content:start;gap:16px;";
      document.body.append(target);
      const root = createRoot(target);
      let state: HarnessState = {
        text: first,
        scope: "activity-a",
        raw: "",
        submissions: 0,
      };
      function render(updates: Partial<HarnessState> = {}) {
        state = { ...state, ...updates };
        const submit = () => render({ submissions: state.submissions + 1 });
        root.render(
          React.createElement(
            React.Fragment,
            null,
            React.createElement(PasswordReveal, {
              key: "first",
              text: state.text,
              scope: state.scope,
              label: "第一口令",
            }),
            React.createElement(PasswordReveal, {
              key: "second",
              text: second,
              scope: state.scope,
              label: "第二口令",
            }),
            React.createElement(
              "form",
              {
                onSubmit: (event: Event) => {
                  event.preventDefault();
                  submit();
                },
              },
              React.createElement(PasswordInput, {
                id: "revision-password",
                label: "继续解口令",
                compact: true,
                value: state.raw,
                onChange: (raw: string) => render({ raw }),
                onSubmit: submit,
                action: React.createElement(
                  "button",
                  { type: "submit", className: "button secondary" },
                  "验证口令",
                ),
              }),
              React.createElement(
                "output",
                { "data-testid": "submissions" },
                String(state.submissions),
              ),
            ),
          ),
        );
      }
      Reflect.set(window, "updatePasswordRevision", render);
      render();
    },
    {
      modules: { react, reactDom },
      first: firstPassword,
      second: secondPassword,
    },
  );
  await expect(
    page.locator("#password-revision-harness .pw-reveal"),
  ).toHaveCount(2);
  return page.locator("#password-revision-harness");
}

async function updateHarness(page: Page, updates: Partial<HarnessState>) {
  await page.evaluate((next) => {
    Reflect.get(window, "updatePasswordRevision")(next);
  }, updates);
}

async function expectMasked(row: Locator) {
  await expect(row.locator(".pw-reveal__value")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(row.locator(".pw-reveal__value")).toHaveCSS(
    "filter",
    "blur(5px)",
  );
}

async function openMultipleActivity(page: Page) {
  await page.goto("/#activity");
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page
    .getByRole("complementary", { name: "原型场景" })
    .getByLabel("活动状态")
    .selectOption("multiple");
  const rows = page.locator("main .password-list .pw-reveal");
  await expect(rows).toHaveCount(2);
  return rows;
}

test("an actual activity eye click hides the password when pointerdown also closes the scene panel", async ({
  page,
}) => {
  const rows = await openMultipleActivity(page);
  const row = rows.first();
  const eye = row.getByRole("button");
  await expect(eye).toHaveAttribute("aria-pressed", "true");
  await eye.click();
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "场景与身份" }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.mouse.move(0, 0);
  await expectMasked(row);
  await expect(rows.nth(1).locator(".pw-reveal__value")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  await eye.click();
  await expect(eye).toHaveAttribute("aria-pressed", "true");
  await expect(row.locator(".pw-reveal__value")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
});

for (const width of [1440, 375]) {
  test(`the integrated solve form keeps the input and action side by side at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 375 ? 850 : 1000 });
    const rows = await openMultipleActivity(page);
    await page.keyboard.press("Escape");
    const input = page.getByLabel("验证其他口令", { exact: true });
    const raw = "口令Ａbc1\n第二行!\n第三行🙂";
    await input.fill(raw);
    await expect(input).toHaveValue(raw);
    const solve = page.locator("main .solve-row");
    const fieldBox = await solve.locator(".pw-input__field").boundingBox();
    const buttonBox = await solve
      .getByRole("button", { name: "验证口令", exact: true })
      .boundingBox();
    expect(fieldBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    if (!fieldBox || !buttonBox) throw new Error("Solve form has no bounds");
    expect(buttonBox.y).toBeCloseTo(fieldBox.y, 0);
    expect(buttonBox.height).toBeCloseTo(fieldBox.height, 0);
    expect(buttonBox.x).toBeGreaterThanOrEqual(fieldBox.x + fieldBox.width);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(width);

    await input.fill("");
    await input.blur();
    await page
      .locator("main .password-section")
      .evaluate((section) =>
        section.scrollIntoView({ block: "start", behavior: "instant" }),
      );
    await page.mouse.move(0, 0);
    await expect(
      page.getByRole("button", { name: "场景与身份" }),
    ).toHaveAttribute("aria-expanded", "false");
    await page
      .getByRole("button", { name: "隐藏全部口令", exact: true })
      .click();
    await page.mouse.move(0, 0);
    await expectMasked(rows.nth(0));
    await expectMasked(rows.nth(1));
    await expect(
      solve.getByRole("heading", { name: "验证其他口令" }),
    ).toBeVisible();
    await expect(input).toBeInViewport();
    await expect(
      solve.getByRole("button", { name: "验证口令", exact: true }),
    ).toBeInViewport();
    await page.evaluate(() => document.fonts.ready);
    const header = page.locator(".site-header");
    await expect(header).toBeInViewport({ ratio: 1 });
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    if (!headerBox) throw new Error("Header has no bounds");
    expect(
      headerBox.y,
      "Header stays inside the viewport after content scroll",
    ).toBeGreaterThanOrEqual(0);
    const scroll = await page.evaluate(() => ({
      document: document.scrollingElement?.scrollTop,
      body: document.body.scrollTop,
      root: document.getElementById("root")?.scrollTop,
      shell: document.querySelector(".tool-shell")?.scrollTop,
      main: document.querySelector(".site-main")?.scrollTop,
      mainScrollHeight: document.querySelector(".site-main")?.scrollHeight,
      mainClientHeight: document.querySelector(".site-main")?.clientHeight,
      viewportHeight: window.innerHeight,
    }));
    expect(
      scroll.document,
      "Document must not be programmatically scrolled",
    ).toBe(0);
    expect(scroll.body, "Body must not be programmatically scrolled").toBe(0);
    expect(
      scroll.root,
      "React root must not be programmatically scrolled",
    ).toBe(0);
    expect(scroll.shell, "Shell must not be programmatically scrolled").toBe(0);
    expect(
      scroll.main,
      "Password section scroll belongs to main content when needed",
    ).toBeGreaterThanOrEqual(0);
    if (
      width === 375 ||
      (scroll.mainScrollHeight ?? 0) > (scroll.mainClientHeight ?? 0)
    ) {
      expect(
        scroll.main,
        "Scrollable password section scroll belongs to main content",
      ).toBeGreaterThan(0);
    }
    if (width === 375) {
      const navigation = page.getByRole("navigation", { name: "手机导航" });
      await expect(navigation).toBeInViewport({ ratio: 1 });
      const navigationBox = await navigation.boundingBox();
      expect(navigationBox).not.toBeNull();
      if (!navigationBox) throw new Error("Mobile navigation has no bounds");
      expect(
        navigationBox.y + navigationBox.height,
        "Mobile navigation remains at the viewport bottom",
      ).toBeCloseTo(scroll.viewportHeight, 0);
    }
    const artifacts = ".wrangler/verification/prototype";
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({
      path: `${artifacts}/utility-passwords-${width}.png`,
      animations: "disabled",
    });
  });
}

test("only the natural text-and-eye area temporarily reveals a password", async ({
  page,
}) => {
  const harness = await mountPasswords(page);
  const rows = harness.locator(".pw-reveal");
  const first = rows.nth(0);
  await expectMasked(first);
  await expectMasked(rows.nth(1));
  expect(await harness.ariaSnapshot()).not.toContain(firstPassword);
  expect(await harness.ariaSnapshot()).not.toContain(secondPassword);
  await expect(harness.getByRole("button", { name: "复制内容" })).toHaveCount(
    0,
  );

  await first.locator(".pw-reveal__heading").hover();
  await expectMasked(first);
  const body = first.locator(".pw-reveal__body");
  const bodyBox = await body.boundingBox();
  expect(bodyBox).not.toBeNull();
  if (!bodyBox) throw new Error("Password body has no bounds");
  await body.hover({ position: { x: bodyBox.width - 2, y: 2 } });
  await expectMasked(first);

  const value = first.locator(".pw-reveal__value");
  const eye = first.getByRole("button");
  await value.hover();
  await expect(value).toHaveAttribute("aria-hidden", "false");
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  expect(await harness.ariaSnapshot()).toContain(firstPassword);
  await expectMasked(rows.nth(1));
  await eye.hover();
  await expect(value).toHaveAttribute("aria-hidden", "false");
  const valueBox = await value.boundingBox();
  const eyeBox = await eye.boundingBox();
  expect(valueBox).not.toBeNull();
  expect(eyeBox).not.toBeNull();
  if (!valueBox || !eyeBox) throw new Error("Reveal controls have no bounds");
  expect(eyeBox.x - valueBox.x - valueBox.width).toBeCloseTo(6, 0);
  await page.mouse.move(0, 0);
  await expectMasked(first);
});

test("click pins the reveal and clicking again masks it until the pointer leaves", async ({
  page,
}) => {
  const harness = await mountPasswords(page);
  const row = harness.locator(".pw-reveal").first();
  const value = row.locator(".pw-reveal__value");
  const eye = row.getByRole("button");
  await value.hover();
  await eye.click();
  await expect(eye).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await expect(value).toHaveAttribute("aria-hidden", "false");
  await eye.click();
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  await expectMasked(row);
  await value.hover();
  await expectMasked(row);
  await row.locator(".pw-reveal__heading").hover();
  await value.hover();
  await expect(value).toHaveAttribute("aria-hidden", "false");
  await page.mouse.move(0, 0);
  await expectMasked(row);
});

test("keyboard toggles visibility and changing either scope or text resets a pinned reveal", async ({
  page,
}) => {
  const harness = await mountPasswords(page);
  const row = harness.locator(".pw-reveal").first();
  const eye = row.getByRole("button");
  await eye.focus();
  await page.keyboard.press("Enter");
  await expect(eye).toHaveAttribute("aria-pressed", "true");
  await expect(row.locator(".pw-reveal__value")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  await page.keyboard.press("Space");
  await expectMasked(row);
  await page.keyboard.press("Enter");
  await updateHarness(page, { scope: "activity-b" });
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  await expectMasked(row);
  expect(await row.ariaSnapshot()).not.toContain(firstPassword);
  await eye.focus();
  await page.keyboard.press("Enter");
  await updateHarness(page, { text: "周末口令2026" });
  await expectMasked(row);
  expect(await row.ariaSnapshot()).not.toContain("周末口令2026");
  await updateHarness(page, { scope: "activity-a", text: firstPassword });
  await expectMasked(row);
});

test.describe("touch reveal", () => {
  test.use({ hasTouch: true });
  test("tap toggles visibility without relying on hover", async ({ page }) => {
    const harness = await mountPasswords(page);
    const row = harness.locator(".pw-reveal").first();
    const eye = row.getByRole("button");
    await expectMasked(row);
    await eye.tap();
    await expect(eye).toHaveAttribute("aria-pressed", "true");
    await expect(row.locator(".pw-reveal__value")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    await eye.tap();
    await expectMasked(row);
  });
});

for (const width of [1440, 375]) {
  test(`the action matches the actual input height at ${width}px, even with multiline errors`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const harness = await mountPasswords(page);
    const input = harness.getByLabel("继续解口令", { exact: true });
    const button = harness.getByRole("button", { name: "验证口令" });
    await input.fill("口令Ａbc1\n第二行!\n第三行🙂");
    await expect(input).toHaveValue("口令Ａbc1\n第二行!\n第三行🙂");
    const fieldBox = await harness.locator(".pw-input__field").boundingBox();
    const buttonBox = await button.boundingBox();
    const footerBox = await harness.locator(".pw-input__footer").boundingBox();
    expect(fieldBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    if (!fieldBox || !buttonBox || !footerBox)
      throw new Error("Input layout has no bounds");
    expect(buttonBox.y).toBeCloseTo(fieldBox.y, 0);
    expect(buttonBox.height).toBeCloseTo(fieldBox.height, 0);
    expect(buttonBox.x).toBeGreaterThanOrEqual(fieldBox.x + fieldBox.width);
    expect(footerBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(width);
  });
}

for (const zoom of [1, 2]) {
  test(`narrow effective width intentionally stacks the action at ${zoom * 100}% layout zoom`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320 * zoom, height: 900 });
    const harness = await mountPasswords(page);
    await page.evaluate((factor) => {
      document.documentElement.style.zoom = String(factor);
    }, zoom);
    const fieldBox = await harness.locator(".pw-input__field").boundingBox();
    const buttonBox = await harness
      .getByRole("button", { name: "验证口令" })
      .boundingBox();
    expect(fieldBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    if (!fieldBox || !buttonBox) throw new Error("Input layout has no bounds");
    expect(buttonBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
    expect(buttonBox.x).toBeCloseTo(fieldBox.x, 0);
    expect(buttonBox.width).toBeCloseTo(fieldBox.width, 0);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(320 * zoom);
  });
}

test("raw input and IME composition remain intact with the adjacent action", async ({
  page,
}) => {
  const harness = await mountPasswords(page);
  const input = harness.getByLabel("继续解口令", { exact: true });
  const raw = "　口令Ａｂ１２!\n好🙂";
  await input.fill(raw);
  await expect(input).toHaveValue(raw);
  await input.dispatchEvent("compositionstart", { data: "Ａ" });
  await expect(input).toHaveAttribute("aria-invalid", "false");
  await expect(
    harness.getByRole("button", { name: "一键优化" }),
  ).toBeDisabled();
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  await expect(harness.getByTestId("submissions")).toHaveText("0");
  await expect(input).toHaveValue(raw);
  await input.dispatchEvent("compositionend", { data: "Ａ" });
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(harness.getByRole("button", { name: "一键优化" })).toBeEnabled();
  await harness.getByRole("button", { name: "一键优化" }).click();
  await expect(input).toHaveValue("口令Ab12好");
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect(harness.getByTestId("submissions")).toHaveText("1");
});

test("input count and clear control stay inside the field and clear validation", async ({
  page,
}) => {
  const harness = await mountPasswords(page);
  const input = harness.getByLabel("继续解口令", { exact: true });
  const field = harness.locator(".pw-input__field");
  await input.fill("口令Ａbc1!");
  await expect(input).toHaveValue("口令Ａbc1!");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  const count = field.locator(".pw-input__count");
  const clear = field.getByRole("button", { name: "清空输入" });
  await expect(count).toHaveText("7 / 18");
  const fieldBox = await field.boundingBox();
  const countBox = await count.boundingBox();
  const clearBox = await clear.boundingBox();
  expect(fieldBox).not.toBeNull();
  expect(countBox).not.toBeNull();
  expect(clearBox).not.toBeNull();
  if (!fieldBox || !countBox || !clearBox)
    throw new Error("Input controls have no bounds");
  expect(countBox.x + countBox.width).toBeLessThanOrEqual(
    fieldBox.x + fieldBox.width - 8,
  );
  expect(clearBox.x).toBeGreaterThan(fieldBox.x);
  expect(clearBox.x + clearBox.width).toBeLessThan(countBox.x);
  await clear.click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "false");
  await expect(clear).toHaveCount(0);
  await expect(count).toHaveText("0 / 18");
});

test("optimization help no longer stretches the compact footer", async ({
  page,
}) => {
  const harness = await mountPasswords(page);
  const input = harness.getByLabel("继续解口令", { exact: true });
  await input.fill("公共口令2026");
  const footer = harness.locator(".pw-input__footer");
  const stable = await footer.boundingBox();
  await input.fill("公共口令2026!");
  const withOptimize = await footer.boundingBox();
  const help = harness.getByRole("button", {
    name: "口令优化说明",
    exact: true,
  });
  const helpBox = await help.boundingBox();
  expect(stable).not.toBeNull();
  expect(withOptimize).not.toBeNull();
  expect(helpBox).not.toBeNull();
  if (!stable || !withOptimize || !helpBox)
    throw new Error("Footer controls have no bounds");
  expect(withOptimize.height).toBeCloseTo(stable.height, 0);
  expect(withOptimize.height).toBeLessThan(32);
  expect(helpBox.width).toBeLessThanOrEqual(24);
  expect(helpBox.height).toBeLessThanOrEqual(24);
});

test("home clear removes the current input feedback without submitting", async ({
  page,
}) => {
  await page.goto("/#home");
  const input = page.getByLabel("口令", { exact: true });
  await input.fill("坏!");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(page.locator(".home-exchange .form-message")).toContainText(
    "请先检查",
  );
  await page.getByRole("button", { name: "清空输入" }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(page.locator(".home-exchange .form-message")).toHaveCount(0);
});

test("optimization explains its changes through Help instead of persistent prose", async ({
  page,
}) => {
  const harness = await mountPasswords(page);
  await harness.getByLabel("继续解口令", { exact: true }).fill("　口令Ａbc1!");
  const explanation = "优化会将全角字母、数字转为半角，并移除其他不可用字符。";
  await expect(harness.getByText(explanation, { exact: true })).toHaveCount(0);
  const help = harness.getByRole("button", {
    name: "口令优化说明",
    exact: true,
  });
  await expect(help).toBeVisible();
  await help.click();
  await expect(
    page
      .getByRole("dialog", { name: "口令优化说明", exact: true })
      .getByText(explanation, { exact: true }),
  ).toBeVisible();
});
