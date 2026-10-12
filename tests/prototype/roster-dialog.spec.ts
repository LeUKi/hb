import { test as base, expect, type Page } from "@playwright/test";
import {
  appendRosterRows,
  readRosterBatch,
  rosterRecords,
} from "../../apps/web/prototype/roster-cursor";

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
      expect(
        forbidden,
        "Public rosters stay inside the local prototype",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

async function mountRoster(page: Page) {
  const response = await page.request.get("/main.tsx");
  const entry = await response.text();
  const react = entry.match(/from "([^"]+\/react\.js(?:\?[^"]*)?)"/u)?.[1];
  const reactDom = entry.match(
    /from "([^"]+\/react-dom_client\.js(?:\?[^"]*)?)"/u,
  )?.[1];
  if (!react || !reactDom) throw new Error("Prototype React modules not found");
  await page.goto("/");
  await page.evaluate(
    async (modules) => {
      const React = (await import(modules.react)).default;
      const { createRoot } = (await import(modules.reactDom)).default;
      const { PublicRoster } = await import("/components/public-roster.tsx");
      const app = document.getElementById("root");
      if (app) app.style.display = "none";
      const target = document.createElement("main");
      target.id = "roster-harness";
      target.style.cssText = "position:fixed;inset:16px;overflow:auto;";
      document.body.append(target);
      const root = createRoot(target);
      const baseTime = Date.now() - 5_000;
      const recipients = Array.from({ length: 45 }, (_, index) => ({
        id: `record-${String(index + 1).padStart(3, "0")}`,
        name: `佬友${String(index + 1).padStart(2, "0")}`,
        username: `member${index}`,
        color: "blue",
        time: new Date(baseTime - Math.floor(index / 5) * 60_000).toISOString(),
        amount: index === 0 ? "0.01" : index === 44 ? "4.99" : "1.00",
        privateReward: "PRIVATE-LDC-DO-NOT-RENDER",
      }));
      let props = {
        open: false,
        activityId: "roster-harness-activity",
        activityTitle: "即时随机 LDC · 公开领取记录",
        author: { name: "活动作者", username: "author", color: "sage" },
        type: "ldc",
        registrations: recipients.map(
          ({ amount: _amount, ...record }) => record,
        ),
        recipients,
        drawProgress: null as string | null,
        showRecipients: true,
        authorView: false,
        fuzzy: false,
        identity: "standard",
        listState: "ready",
        onClose: () => {
          props = { ...props, open: false };
          render();
        },
        onOwnProfile: () => {
          props = { ...props, open: false };
          render();
        },
      };
      function render() {
        root.render(
          React.createElement(
            React.Fragment,
            null,
            React.createElement(
              "button",
              {
                type: "button",
                onClick: () => {
                  props = { ...props, open: true };
                  render();
                },
              },
              "查看名单",
            ),
            React.createElement(PublicRoster, props),
          ),
        );
      }
      window.addEventListener("patch-roster-harness", (event) => {
        const patch = (event as CustomEvent<Partial<typeof props>>).detail;
        props = { ...props, ...patch };
        render();
      });
      window.addEventListener("add-roster-harness-record", () => {
        props = {
          ...props,
          recipients: [
            {
              ...recipients[0],
              id: "record-new",
              name: "新增佬友",
              username: "new-member",
              time: new Date(Date.now()).toISOString(),
              amount: "0.50",
            },
            ...props.recipients,
          ],
        };
        render();
      });
      window.addEventListener("empty-roster-harness", () => {
        props = { ...props, recipients: [], registrations: [] };
        render();
      });
      window.addEventListener("refresh-roster-harness", () => {
        props = {
          ...props,
          recipients: props.recipients.map((row) => ({ ...row })),
          registrations: props.registrations.map((row) => ({ ...row })),
        };
        render();
      });
      render();
    },
    { react, reactDom },
  );
  return page.locator("#roster-harness");
}

async function patchRoster(page: Page, props: Record<string, unknown>) {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent("patch-roster-harness", { detail }));
  }, props);
}

function dialog(page: Page) {
  return page.locator("dialog.public-roster-dialog");
}

async function openRoster(page: Page) {
  await page.getByRole("button", { name: "查看名单", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  return dialog(page);
}

async function scrollToEnd(page: Page) {
  await dialog(page)
    .locator(".recipient-list")
    .evaluate((list) => {
      list.scrollTop = list.scrollHeight;
    });
}

test("cursor batches use stable IDs, descending timestamp ties, and deduplicate appends", () => {
  const rows = Array.from({ length: 45 }, (_, index) => ({
    id: `id-${String(index).padStart(3, "0")}`,
    name: `佬友 ${index}`,
    username: `member-${index}`,
    color: "blue",
    time: new Date(
      1_700_000_000_000 - Math.floor(index / 5) * 60_000,
    ).toISOString(),
  }));
  const normalized = rosterRecords(
    [...rows, { ...rows[0], name: "更新的昵称" }],
    "test",
  );
  expect(normalized).toHaveLength(45);
  expect(normalized.slice(0, 5).map((row) => row.id)).toEqual([
    "id-004",
    "id-003",
    "id-002",
    "id-001",
    "id-000",
  ]);
  expect(normalized.find((row) => row.id === "id-000")?.name).toBe(
    "更新的昵称",
  );
  const first = readRosterBatch(normalized);
  const second = readRosterBatch(normalized, first.nextCursor);
  const third = readRosterBatch(normalized, second.nextCursor);
  expect(first.rows).toHaveLength(20);
  expect(second.rows).toHaveLength(20);
  expect(third.rows).toHaveLength(5);
  expect(third.hasMore).toBe(false);
  expect(third.nextCursor).toBeNull();
  const merged = appendRosterRows(appendRosterRows(first.rows, second.rows), [
    ...second.rows,
    ...third.rows,
  ]);
  expect(merged).toEqual(normalized);
  expect(
    rosterRecords(
      rows.map(({ id: _id, ...row }) => row),
      "test",
    ),
  ).toEqual(
    rosterRecords(
      rows.map(({ id: _id, ...row }) => row),
      "test",
    ),
  );
});

test("a compact modal keeps its header fixed and appends 20-row batches without changing outer scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  const harness = await mountRoster(page);
  const roster = await openRoster(page);
  await expect(roster.locator(".recipient")).toHaveCount(20);
  const box = await roster.boundingBox();
  if (!box) throw new Error("Roster bounds missing");
  expect(box.width).toBeCloseTo(440, 0);
  expect(box.height).toBeLessThanOrEqual(720);
  await expect(roster.locator('[data-username="member0"]')).toHaveAttribute(
    "data-title",
    "lowest",
  );
  await expect(roster.locator('[data-title="highest"]')).toHaveCount(0);
  const headerTop = await roster
    .locator("header")
    .evaluate((header) => header.getBoundingClientRect().top);
  const initialIds = await roster
    .locator(".recipient")
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-record-id")),
    );
  await scrollToEnd(page);
  await expect(roster.locator(".recipient")).toHaveCount(40);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("refresh-roster-harness")),
  );
  await expect(roster.locator(".recipient")).toHaveCount(40);
  expect(
    (
      await roster
        .locator(".recipient")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-record-id")),
        )
    ).slice(0, 20),
  ).toEqual(initialIds);
  expect(
    await roster
      .locator("header")
      .evaluate((header) => header.getBoundingClientRect().top),
  ).toBe(headerTop);
  expect(await roster.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await harness.evaluate((element) => element.scrollTop)).toBe(0);
  await scrollToEnd(page);
  await expect(roster.locator(".recipient")).toHaveCount(45);
  await expect(roster.locator('[data-username="member44"]')).toHaveAttribute(
    "data-title",
    "highest",
  );
  await expect(roster.getByRole("status")).toHaveText("已显示全部");
});

test("Escape, backdrop and reopening preserve opener focus and obtain fresh first batches", async ({
  page,
}) => {
  const harness = await mountRoster(page);
  const opener = harness.getByRole("button", { name: "查看名单", exact: true });
  const roster = await openRoster(page);
  await expect(roster.getByRole("button", { name: "关闭名单" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(roster).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("add-roster-harness-record")),
  );
  await openRoster(page);
  await expect(roster.locator(".recipient")).toHaveCount(20);
  await expect(roster.locator(".recipient").first()).toHaveAttribute(
    "data-username",
    "new-member",
  );
  await page.mouse.click(4, 4);
  await expect(roster).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("initial and later errors can retry while preserving loaded rows, and pending loads cancel on close", async ({
  page,
}) => {
  await mountRoster(page);
  await patchRoster(page, { listState: "error" });
  const roster = await openRoster(page);
  await expect(roster.getByRole("alert")).toHaveText("名单加载失败");
  await expect(roster.locator(".recipient")).toHaveCount(0);
  await roster.getByRole("button", { name: "重试", exact: true }).click();
  await expect(roster.locator(".recipient")).toHaveCount(20);
  const firstIds = await roster
    .locator(".recipient")
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-record-id")),
    );
  await patchRoster(page, { listState: "loading" });
  await expect(roster.getByRole("status")).toHaveText("加载中…");
  await patchRoster(page, { listState: "error" });
  await expect(roster.locator(".recipient")).toHaveCount(20);
  await expect(roster.getByRole("alert")).toHaveText("名单加载失败");
  await roster.getByRole("button", { name: "重试", exact: true }).click();
  await expect(roster.locator(".recipient")).toHaveCount(40);
  expect(
    (
      await roster
        .locator(".recipient")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-record-id")),
        )
    ).slice(0, 20),
  ).toEqual(firstIds);
  await roster.getByRole("button", { name: "关闭名单" }).click();
  await patchRoster(page, { listState: "ready" });
  await openRoster(page);
  await expect(roster.locator(".recipient")).toHaveCount(20);
  await scrollToEnd(page);
  await expect(roster.getByRole("status")).toHaveText("加载中…");
  await roster.getByRole("button", { name: "关闭名单" }).click();
  await openRoster(page);
  await expect(roster.locator(".recipient")).toHaveCount(20);
});

test("draw phases select the correct roster without fabricating results or disturbing a manual tab", async ({
  page,
}) => {
  await mountRoster(page);
  await patchRoster(page, { type: "draw", drawProgress: "waiting" });
  const roster = await openRoster(page);
  await expect(roster.getByRole("tab", { name: "报名名单" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(roster.locator(".recipient-award")).toHaveCount(0);
  await roster.getByRole("tab", { name: "中奖名单" }).click();
  await expect(roster.getByRole("status")).toHaveText("等待开奖");
  await patchRoster(page, { drawProgress: "settling" });
  await expect(roster.getByRole("status")).toHaveText("正在开奖");
  await expect(roster.locator(".recipient")).toHaveCount(0);
  await patchRoster(page, { drawProgress: "completed" });
  await expect(roster.getByRole("tab", { name: "中奖名单" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(roster.locator(".recipient")).toHaveCount(20);
  await roster.getByRole("tab", { name: "报名名单" }).click();
  await patchRoster(page, { fuzzy: true });
  await expect(roster.getByRole("tab", { name: "报名名单" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(roster.locator(".public-roster__summary")).not.toContainText(
    "45 人",
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("empty-roster-harness")),
  );
  await patchRoster(page, { drawProgress: "empty" });
  await expect(roster.getByRole("status")).toHaveText("无人报名");
  await roster.getByRole("tab", { name: "中奖名单" }).click();
  await expect(roster.getByRole("status")).toHaveText("无人中奖");
});

test("user popovers stay in the modal top layer, remain clickable, and close before the roster", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountRoster(page);
  const roster = await openRoster(page);
  const user = roster.locator(".recipient .user-identity").first();
  await user.hover();
  const profile = page.getByRole("dialog", { name: "用户资料", exact: true });
  await expect(profile).toBeVisible();
  expect(
    await profile.evaluate((element) =>
      Boolean(element.closest("dialog.public-roster-dialog")),
    ),
  ).toBe(true);
  const link = profile.getByRole("link", { name: "查看 Linux DO 主页" });
  await link.hover();
  expect(
    await link.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        ),
      );
    }),
  ).toBe(true);
  await link.focus();
  await page.keyboard.press("Escape");
  await expect(profile).toHaveCount(0);
  await expect(user).toBeFocused();
  await expect(roster).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(roster).toHaveCount(0);
});

test("mobile sheets and enlarged text stay usable without horizontal overflow or outer scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await mountRoster(page);
  await patchRoster(page, {
    activityTitle: "长标题活动记录 · LDC 即时随机红包领取名单布局验证",
    type: "draw",
    drawProgress: "waiting",
  });
  const roster = await openRoster(page);
  const box = await roster.boundingBox();
  if (!box) throw new Error("Roster bounds missing");
  expect(box.width).toBeLessThanOrEqual(351);
  expect(box.height).toBeLessThanOrEqual(667 * 0.85);
  const user = roster.locator(".recipient .user-identity").first();
  await user.click();
  const profile = page.getByRole("dialog", { name: "用户资料", exact: true });
  await expect(profile).toHaveAttribute("data-side", "sheet");
  await expect(profile.getByRole("button", { name: "关闭资料" })).toBeFocused();
  await profile.getByRole("button", { name: "关闭资料" }).click();
  await expect(profile).toHaveCount(0);
  await page.evaluate(() => (document.documentElement.style.fontSize = "32px"));
  expect(
    await roster.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  const headerTop = await roster
    .locator("header")
    .evaluate((element) => element.getBoundingClientRect().top);
  await roster.locator(".recipient-list").focus();
  await page.keyboard.press("PageDown");
  await expect
    .poll(() =>
      roster
        .locator(".recipient-list")
        .evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(0);
  expect(
    await roster
      .locator("header")
      .evaluate((element) => element.getBoundingClientRect().top),
  ).toBe(headerTop);
  await roster.getByRole("button", { name: "关闭名单" }).click();
  await expect(roster).toHaveCount(0);
});

test("author detail rows share the mobile roster dialog without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await mountRoster(page);
  await patchRoster(page, {
    authorView: true,
    showRecipients: false,
    activityTitle: "作者完整明细 · LDC 长内容布局验证",
  });
  const roster = await openRoster(page);
  await expect(roster.locator(".public-roster__summary")).toContainText(
    "作者明细",
  );
  const detail = roster.locator(".recipient-author-detail").first();
  await expect(detail).toBeVisible();
  await detail.locator("summary").click();
  await expect(detail).toContainText("LDC 金额");
  expect(
    await roster.evaluate((element) => ({
      dialogFits: element.scrollWidth <= element.clientWidth,
      viewportFits: document.documentElement.scrollWidth <= window.innerWidth,
    })),
  ).toEqual({ dialogFits: true, viewportFits: true });
  expect(
    await detail.evaluate((element) => {
      const detailBox = element.getBoundingClientRect();
      const listBox = element
        .closest(".recipient-list")
        ?.getBoundingClientRect();
      return Boolean(
        listBox &&
          detailBox.left >= listBox.left - 1 &&
          detailBox.right <= listBox.right + 1,
      );
    }),
  ).toBe(true);
});

test("hidden LDC lists and fuzzy counts do not reveal private or unauthorized content", async ({
  page,
}) => {
  await mountRoster(page);
  await patchRoster(page, { type: "ldc", fuzzy: true });
  const roster = await openRoster(page);
  await expect(roster.locator(".recipient-award")).toHaveCount(20);
  await expect(
    roster.locator('[data-record-id="record-001"] .recipient-award'),
  ).toContainText("0.01");
  await expect(roster.locator(".public-roster__summary")).not.toContainText(
    "45 人",
  );
  await expect(roster).not.toContainText("PRIVATE-LDC-DO-NOT-RENDER");
  await patchRoster(page, { showRecipients: false });
  await expect(roster).toHaveCount(0);
  await expect(page.locator(".recipient")).toHaveCount(0);
});
