import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const localHost = new URL(origin).host;
const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ context, page }, use) => {
      const forbidden = new Set<string>();
      const observePage = (current: Page) => {
        current.on("websocket", (socket) => {
          if (new URL(socket.url()).host !== localHost)
            forbidden.add(socket.url());
        });
      };
      observePage(page);
      context.on("page", observePage);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
          forbidden.add(url.href);
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      context.off("page", observePage);
      expect(
        [...forbidden],
        "Login, previews and activity popups stay inside the local prototype",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

test.use({ reducedMotion: "reduce" });

type ViewerIdentity = "guest" | "lite" | "standard";

async function chooseIdentity(page: Page, identity: ViewerIdentity) {
  const publicList = page.getByRole("dialog", {
    name: "活动广场",
    exact: true,
  });
  const restoreList = await publicList.isVisible();
  if (restoreList) {
    await publicList.getByRole("button", { name: "关闭活动广场" }).click();
    await expect(publicList).toHaveCount(0);
  }
  const trigger = page.getByRole("button", { name: "场景与身份" });
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  const select = page.getByRole("combobox", { name: "体验身份" });
  await select.selectOption(identity);
  if (
    identity === "guest" &&
    /^#account(?:$|\?)/u.test(new URL(page.url()).hash)
  ) {
    await expect(page.locator(".tool-shell--guest-login")).toBeVisible();
    return;
  }
  await expect(select).toHaveValue(identity);
  if ((await trigger.getAttribute("aria-expanded")) === "true")
    await trigger.click();
  await expect(page.locator(".scenario-panel")).toHaveCount(0);
  if (restoreList) {
    await page.goForward();
    await expect(publicList).toBeVisible();
  }
}

async function expectLoginGeometry(page: Page, expanded: boolean) {
  const layout = await page.locator(".work-login-card").evaluate((node) => {
    const card = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const leftInset =
      Number.parseFloat(style.paddingLeft) +
      Number.parseFloat(style.borderLeftWidth);
    const rightInset =
      Number.parseFloat(style.paddingRight) +
      Number.parseFloat(style.borderRightWidth);
    const actions = [
      ...node.querySelectorAll(
        ".work-login-primary, .work-login-lite-trigger, .work-login-secondary",
      ),
    ].map((action) => {
      const rect = action.getBoundingClientRect();
      return {
        className: action.className,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    });
    return {
      left: card.left,
      top: card.top,
      right: card.right,
      bottom: card.bottom,
      centerX: card.left + card.width / 2,
      centerY: card.top + card.height / 2,
      contentLeft: card.left + leftInset,
      contentWidth: card.width - leftInset - rightInset,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      actions,
    };
  });
  expect(
    Math.abs(layout.centerX - layout.viewportWidth / 2),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(layout.centerY - layout.viewportHeight / 2),
  ).toBeLessThanOrEqual(2);
  expect(layout.left).toBeGreaterThanOrEqual(16);
  expect(layout.top).toBeGreaterThanOrEqual(16);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth - 16);
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight - 16);
  expect(layout.actions).toHaveLength(expanded ? 3 : 2);
  for (const action of layout.actions) {
    expect(Math.abs(action.left - layout.contentLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(action.width - layout.contentWidth)).toBeLessThanOrEqual(1);
    if (action.className.includes("work-login-primary"))
      expect(action.height).toBeGreaterThanOrEqual(48);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(layout.viewportWidth);
}

async function openActivityWindow(
  page: Page,
  link: Locator,
  activityId: string,
) {
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const href = await link.getAttribute("href");
  if (!href) throw new Error("Activity view link is missing its local route");
  const target = new URL(href, page.url());
  expect(target.origin).toBe(origin);
  expect(target.hash.split("?")[0]).toBe("#activity");
  expect(new URLSearchParams(target.hash.split("?")[1]).get("sample")).toBe(
    activityId,
  );
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await expect(popup.locator(".activity-page")).toBeVisible();
  const params = new URLSearchParams(new URL(popup.url()).hash.split("?")[1]);
  expect(params.get("sample")).toBe(activityId);
  expect(params.has("view"), "Temporary snapshot token is removed").toBe(false);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  return popup;
}

for (const width of [1440, 768, 375]) {
  test(`guest login keeps a centered shell and full-width actions at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#account");
    await chooseIdentity(page, "guest");
    await expect(
      page.getByRole("heading", { name: "登录解meme", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(
        ".prototype-review, .scenario-panel, .site-header, .desktop-nav, .mobile-nav",
      ),
    ).toHaveCount(0);
    const primary = page.getByRole("button", {
      name: "通过LINUX DO登录",
      exact: true,
    });
    const disclosure = page.getByRole("button", {
      name: "青春版登录",
      exact: true,
    });
    const secondary = page.getByRole("button", {
      name: "通过 LiteAuth 登录",
      exact: true,
    });
    await expect(primary).toBeVisible();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(disclosure).toHaveAttribute(
      "aria-controls",
      "work-lite-login-panel",
    );
    await expect(page.locator("#work-lite-login-panel")).toHaveCount(0);
    await expectLoginGeometry(page, false);

    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(secondary).toBeVisible();
    await expectLoginGeometry(page, true);
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#work-lite-login-panel")).toHaveCount(0);
    await expect(disclosure).toBeFocused();

    await disclosure.click();
    await secondary.focus();
    await page.keyboard.press("Escape");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#work-lite-login-panel")).toHaveCount(0);
    await expect(disclosure).toBeFocused();
    await expectLoginGeometry(page, false);

    const signedInIdentity = width === 375 ? "lite" : "standard";
    if (signedInIdentity === "lite") {
      await disclosure.click();
      await secondary.click();
    } else await primary.click();
    await expect(
      page.getByRole("heading", { name: "账号信息", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".tool-shell--guest-login")).toHaveCount(0);
    await expect(page.locator(".site-header")).toBeVisible();
    const tools = page.getByRole("button", { name: "场景与身份" });
    await expect(tools).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".scenario-panel")).toHaveCount(0);
    await tools.click();
    await expect(page.getByRole("combobox", { name: "体验身份" })).toHaveValue(
      signedInIdentity,
    );
    await tools.click();
    await expect(page.locator(".site-header .lite-badge")).toHaveCount(
      signedInIdentity === "lite" ? 1 : 0,
    );
  });
}

test("three note editors preserve source and update safe Markdown across shared preview modes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#create");
  await page.locator(".work-more-settings > summary").click();
  const modes = page.getByRole("group", { name: "说明预览模式" });
  await expect(
    modes.getByRole("button", { name: "分栏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const fields = [
    { id: "work-before-note", stage: "before", heading: "活动说明粗体" },
    { id: "work-after-note", stage: "after", heading: "奖励附言粗体" },
    { id: "work-ended-note", stage: "ended", heading: "结束说明粗体" },
  ] as const;
  const sources = {
    before:
      "  **活动说明粗体**\n\n第一行  \n第二行\n\n- 第一项\n- 第二项\n\n" +
      "[进入广场](#square)\n\n[安全外链](https://example.invalid/note)\n\n" +
      "![不加载远程图片](https://example.invalid/blocked.png)\n\n" +
      "<script>document.documentElement.dataset.noteInjected = 'yes'</script>\n\n" +
      '<img src="https://example.invalid/blocked-html.png" onerror="document.documentElement.dataset.noteInjected=\'yes\'">\n\n' +
      '<iframe src="https://example.invalid/frame"></iframe>\n\n' +
      "[危险链接](javascript:alert(1))\n  ",
    after: "**奖励附言粗体**\n\n 保留附言原文空格。 \n",
    ended: "**结束说明粗体**\n\n结束时可显示这段原文。  \n",
  };
  await expect(page.locator(".work-note-editor")).toHaveCount(3);
  for (const field of fields) {
    const source = page.locator(`#${field.id}`);
    const editor = page.locator(".work-note-editor").filter({ has: source });
    await expect(editor).toHaveAttribute("data-note-mode", "split");
    await expect(source).toHaveValue("");
    await expect(source).toBeVisible();
    await expect(editor.locator(".work-note-editor-rendered")).toBeVisible();
    await source.fill(sources[field.stage]);
    await expect(source).toHaveValue(sources[field.stage]);
    await expect(
      editor.locator(`[data-note-stage="${field.stage}"] strong`),
    ).toHaveText(field.heading);
    const columns = await editor.evaluate((node) => {
      const sourceRect = node
        .querySelector(".work-note-editor-source")
        ?.getBoundingClientRect();
      const previewRect = node
        .querySelector(".work-note-editor-rendered")
        ?.getBoundingClientRect();
      if (!sourceRect || !previewRect)
        throw new Error("Note editor is incomplete");
      return {
        sourceRight: sourceRect.right,
        sourceTop: sourceRect.top,
        sourceWidth: sourceRect.width,
        previewLeft: previewRect.left,
        previewTop: previewRect.top,
        previewWidth: previewRect.width,
      };
    });
    expect(columns.previewLeft).toBeGreaterThanOrEqual(columns.sourceRight);
    expect(
      Math.abs(columns.previewTop - columns.sourceTop),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(columns.previewWidth - columns.sourceWidth),
    ).toBeLessThanOrEqual(1);
  }

  const before = page.locator('.work-note-preview [data-note-stage="before"]');
  await expect(before.locator("ul > li")).toHaveText(["第一项", "第二项"]);
  await expect(before.locator("br")).toHaveCount(1);
  await expect(before.getByText("进入广场", { exact: true })).toBeVisible();
  await expect(before.getByRole("link", { name: "进入广场" })).toHaveCount(0);
  const safeExternal = before.getByRole("link", { name: "安全外链" });
  await expect(safeExternal).toHaveAttribute(
    "href",
    "https://example.invalid/note",
  );
  await expect(safeExternal).toHaveAttribute("target", "_blank");
  await expect(safeExternal).toHaveAttribute("rel", "noopener noreferrer");
  await expect(before.getByText("危险链接", { exact: true })).toBeVisible();
  await expect(before.getByRole("link", { name: "危险链接" })).toHaveCount(0);
  const unsafeContent = page
    .locator(".work-note-preview")
    .locator(
      "img, script, iframe, [onclick], [onerror], a[href^='javascript:']",
    );
  await expect(unsafeContent).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-note-injected");

  await modes.getByRole("button", { name: "原文", exact: true }).click();
  for (const field of fields) {
    const source = page.locator(`#${field.id}`);
    const editor = page.locator(".work-note-editor").filter({ has: source });
    await expect(editor).toHaveAttribute("data-note-mode", "source");
    await expect(source).toBeVisible();
    await expect(source).toHaveValue(sources[field.stage]);
    await expect(editor.locator(".work-note-editor-rendered")).toBeHidden();
  }
  sources.after += "\n\n**原文模式修改**";
  await page.locator("#work-after-note").fill(sources.after);

  await modes.getByRole("button", { name: "Markdown", exact: true }).click();
  for (const field of fields) {
    const source = page.locator(`#${field.id}`);
    const editor = page.locator(".work-note-editor").filter({ has: source });
    await expect(editor).toHaveAttribute("data-note-mode", "preview");
    await expect(source).toBeHidden();
    await expect(source).toHaveValue(sources[field.stage]);
    await expect(editor.locator(".work-note-editor-rendered")).toBeVisible();
  }
  await expect(
    page.locator('.work-note-preview [data-note-stage="after"] strong'),
  ).toHaveText(["奖励附言粗体", "原文模式修改"]);

  await modes.getByRole("button", { name: "分栏", exact: true }).click();
  sources.ended += "\n\n**分栏实时修改**";
  await page.locator("#work-ended-note").fill(sources.ended);
  await expect(
    page.locator('.work-note-preview [data-note-stage="ended"] strong'),
  ).toHaveText(["结束说明粗体", "分栏实时修改"]);
  await page.setViewportSize({ width: 375, height: 900 });
  for (const field of fields) {
    const source = page.locator(`#${field.id}`);
    const editor = page.locator(".work-note-editor").filter({ has: source });
    await expect(editor).toHaveAttribute("data-note-mode", "split");
    await expect(source).toBeVisible();
    await expect(source).toHaveValue(sources[field.stage]);
    await expect(editor.locator(".work-note-editor-rendered")).toBeVisible();
    const stack = await editor.evaluate((node) => {
      const sourceRect = node
        .querySelector(".work-note-editor-source")
        ?.getBoundingClientRect();
      const previewRect = node
        .querySelector(".work-note-editor-rendered")
        ?.getBoundingClientRect();
      if (!sourceRect || !previewRect)
        throw new Error("Note editor is incomplete");
      return {
        sourceBottom: sourceRect.bottom,
        sourceLeft: sourceRect.left,
        sourceWidth: sourceRect.width,
        previewTop: previewRect.top,
        previewLeft: previewRect.left,
        previewWidth: previewRect.width,
        width: node.clientWidth,
        contentWidth: node.scrollWidth,
      };
    });
    expect(stack.previewTop).toBeGreaterThanOrEqual(stack.sourceBottom);
    expect(Math.abs(stack.previewLeft - stack.sourceLeft)).toBeLessThanOrEqual(
      1,
    );
    expect(
      Math.abs(stack.previewWidth - stack.sourceWidth),
    ).toBeLessThanOrEqual(1);
    expect(stack.contentWidth).toBeLessThanOrEqual(stack.width + 1);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
  await expect(unsafeContent).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-note-injected");
});

test("square defaults to all and real view links preserve viewer identity in a new tab", async ({
  page,
}) => {
  await page.goto("/#square");
  await expect(
    page.getByRole("button", { name: "活动状态筛选", exact: true }),
  ).toHaveText("状态：全部");
  await page.getByRole("button", { name: "活动状态筛选", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "进行中", exact: true })
    .click();
  const rows = page.locator(
    '.activity-rows[data-context="public"] tr.activity-rows-row',
  );
  const weekendRow = page.locator(
    '.activity-rows[data-context="public"] tr[data-activity-id="weekend"]',
  );
  await expect(weekendRow).toBeVisible();
  expect(
    await rows.evaluateAll((nodes) => [
      ...new Set(nodes.map((node) => node.getAttribute("data-lifecycle"))),
    ]),
  ).toEqual(["active"]);
  await expect(
    weekendRow.getByRole("button", { name: "周末红包 · 20 份", exact: true }),
  ).toBeVisible();
  await expect(
    weekendRow.getByRole("link", { name: "打开关联论坛帖子", exact: true }),
  ).toBeVisible();
  const view = weekendRow.getByRole("link", { name: "查看活动", exact: true });
  await expect(view).toHaveCount(1);
  for (const identity of ["guest", "lite", "standard"] as const) {
    await chooseIdentity(page, identity);
    const popup = await openActivityWindow(page, view, "weekend");
    await expect(popup.locator(".activity-page h1")).toHaveText(
      "周末红包 · 20 份",
    );
    await expect(popup.locator(".activity-page")).toHaveAttribute(
      "data-participation",
      "none",
    );
    const tools = popup.getByRole("button", { name: "场景与身份" });
    await tools.click();
    await expect(popup.getByRole("combobox", { name: "体验身份" })).toHaveValue(
      identity,
    );
    await tools.click();
    if (identity === "guest") {
      await expect(
        popup.getByRole("button", { name: "登录领取", exact: true }),
      ).toBeVisible();
      await expect(popup.locator("#activity-password")).toHaveCount(0);
    } else if (identity === "lite") {
      await expect(
        popup.getByRole("button", { name: "使用官方 Connect", exact: true }),
      ).toBeVisible();
      await expect(popup.locator("#activity-password")).toHaveCount(0);
    } else await expect(popup.locator("#activity-password")).toBeVisible();
    await expect(page).toHaveURL(
      /#home\?dialog=square(?:&status=(?:active|ended))?$/u,
    );
    await popup.close();
  }
});

test("new-tab viewing carries a locally published activity and its notes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#create");
  const title = "新窗口本地活动验证";
  await page.locator("#work-title").fill(title);
  await page.getByRole("button", { name: "自定义金额", exact: true }).click();
  await page.locator("#work-custom-amounts").fill("0.50\n0.88");
  await page.locator("#work-password-1").fill("新窗口验证口令");
  await page.locator(".work-more-settings > summary").click();
  await page
    .locator("#work-before-note")
    .fill("**新窗说明**\n\n保留刚创建活动的正文。");
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await page
    .getByRole("dialog", { name: "演示活动已开放" })
    .getByRole("button", { name: "查看活动", exact: true })
    .click();
  await expect(page.locator(".activity-page h1")).toHaveText(title);
  await page.evaluate(() => {
    window.location.hash = "manage";
  });
  const row = page.getByTestId("managed-activity").filter({ hasText: title });
  await expect(row).toBeVisible();
  const id = await row.getAttribute("data-activity-id");
  if (!id) throw new Error("Published activity has no local ID");
  const popup = await openActivityWindow(
    page,
    row.getByRole("link", { name: `${title}：查看活动`, exact: true }),
    id,
  );
  await expect(popup.locator(".activity-page h1")).toHaveText(title);
  await expect(popup.locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "none",
  );
  const before = popup.locator('[data-note-stage="before"]');
  await expect(before.locator("strong")).toHaveText("新窗说明");
  await expect(before).toContainText("保留刚创建活动的正文。");
  await expect(popup.locator(".activity-quantity .sr-only")).toHaveText(
    "已领取 0 份，共 2 份",
  );
  await expect(popup.locator("#activity-password")).toHaveCount(0);
  await expect(
    popup.getByText("不能领取自己发起的 LDC 活动", { exact: true }),
  ).toBeVisible();
  await expect(
    popup.getByRole("button", { name: "复制奖励", exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/#manage$/u);
  await popup.close();
});
