import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  type ActivityParticipationResponse,
  decodeActivityEmoji,
  emptyActivityInput,
  encodeActivityEmoji,
  type ManagedActivity,
} from "../../packages/contracts/src";
import { fullAppMerchant } from "./ldc-fixture";
import {
  localOnly,
  origin,
  signIn,
  waitForBoot,
  waitOutCooldown,
} from "./session";

// Migration phase 3 on the real stack: a 红包 made in the 发红包 steps and
// opened from there, claimed on its page and paid; a timed draw that draws
// as soon as it is full.

async function account(
  browser: import("@playwright/test").Browser,
  role: string,
) {
  const context = await browser.newContext({ baseURL: origin });
  await localOnly(context);
  const page = await context.newPage();
  const csrf = await signIn(page, role);
  return { context, page, csrf };
}

/** The 红包 the page now shows (after 保存并开放). */
async function openedCode(page: Page) {
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toMatch(/^\/🧧\/[^/]+$/u);
  const code = decodeURIComponent(new URL(page.url()).pathname).split("/")[2];
  const id = decodeActivityEmoji(code ?? "");
  expect(id).not.toBeNull();
  return { code: code ?? "", id: id ?? "" };
}

async function participation(context: BrowserContext, id: string) {
  const response = await context.request.get(
    `/api/activities/${id}/participation`,
  );
  return (await response.json()) as ActivityParticipationResponse;
}

test("在发红包的四步里开放，领取后付款记录里有这一笔", async ({ browser }) => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const password = `界面${suffix}`;
  const title = `完整应用界面红包 ${suffix}`;

  const author = await account(browser, "author");
  await fullAppMerchant(author.context, author.csrf, origin);
  await author.page.goto("/new");
  await waitForBoot(author.page);
  await author.page
    .getByRole("button", { name: /拼手气/ })
    .first()
    .click();
  await expect(author.page.locator("#hb-random-total")).toBeVisible();
  await author.page.locator("#hb-random-total").fill("0.20");
  await author.page.locator("#hb-random-count").fill("2");
  await author.page.locator("#hb-random-count").press("Enter");
  await author.page.getByLabel("口令 1").fill(password);
  await author.page.getByLabel("口令 1").press("Enter");
  await author.page.locator("#hb-title").fill(title);
  await author.page.getByRole("button", { name: "保存并开放" }).first().click();
  const { code, id } = await openedCode(author.page);
  await expect(
    author.page.getByRole("heading", { name: title, level: 1 }),
  ).toBeVisible();

  const recipient = await account(browser, "recipient3");
  await waitOutCooldown(recipient.page);
  await recipient.page.goto(`/🧧/${code}`);
  await waitForBoot(recipient.page);
  await recipient.page.getByRole("button", { name: "输入口令领取" }).click();
  const input = recipient.page.getByRole("textbox", {
    name: "口令、红包链接或命令",
  });
  await input.fill(password);
  await recipient.page.keyboard.press("Enter");
  await expect(
    recipient.page
      .getByRole("status")
      .filter({ hasText: /^已领取 0\.\d\d LDC。$/ }),
  ).toHaveCount(1);
  await expect(recipient.page.getByText("已发放")).toBeVisible({
    timeout: 30_000,
  });
  const claimed = await participation(recipient.context, id);
  expect(claimed.claim?.payment.status).toBe("confirmed");

  // The sender's 付款记录: the 红包 heads its payment, already paid.
  await author.page.goto(`/🧧/${code}/🧾`);
  await waitForBoot(author.page);
  await expect(author.page.getByText(title)).toBeVisible();
  await expect(author.page.getByText("完整应用第三参与者")).toBeVisible();
  await author.page.getByText("完整应用第三参与者").click();
  await expect(
    author.page.getByRole("heading", { name: "付给 完整应用第三参与者" }),
  ).toBeVisible();
  await expect(author.page.getByText("已发放").first()).toBeVisible();

  // 红包记录 → 我发的: the row's 名单 opens the 名单弹窗 right there.
  await author.page.goto("/history");
  await waitForBoot(author.page);
  const rosterButton = author.page.getByRole("button", {
    name: `名单「${title}」`,
  });
  await rosterButton.click();
  const roster = author.page.getByRole("dialog", { name: /领取名单/ });
  await expect(roster.getByText("完整应用第三参与者")).toBeVisible();
  expect(decodeURIComponent(new URL(author.page.url()).pathname)).toBe(
    "/history",
  );
  await author.page.keyboard.press("Escape");
  await expect(roster).toHaveCount(0);
  await expect(rosterButton).toBeFocused();
  await author.context.close();
  await recipient.context.close();
});

test("限时开奖：无需口令，报满即开，中奖的人到账", async ({ browser }) => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const title = `完整应用限时开奖 ${suffix}`;

  const author = await account(browser, "author");
  await fullAppMerchant(author.context, author.csrf, origin);
  const page = author.page;
  await page.goto("/new");
  await waitForBoot(page);
  await page
    .getByRole("button", { name: /限时开奖/ })
    .first()
    .click();
  await expect(page.locator("#hb-draw-pool")).toBeVisible();
  await page.locator("#hb-draw-pool").fill("0.20");
  await page.locator("#hb-draw-winners").fill("1");
  await page.locator("#hb-draw-winners").press("Enter");
  await page.getByRole("button", { name: /无需口令/ }).click();
  // 报名上限 is in 更多设置: two sign-ups draw at once.
  await page.locator("#hb-quiet-timing").click();
  await page.locator("#hb-draw-limit").fill("2");
  await page.keyboard.press("Escape");
  await expect(page.locator("#hb-draw-limit")).toBeHidden();
  await page.getByRole("button", { name: "下一步" }).last().click();
  await page.locator("#hb-title").fill(title);
  await page.getByRole("button", { name: "保存并开放" }).first().click();
  const { code, id } = await openedCode(page);

  const entrants = [
    await account(browser, "recipient"),
    await account(browser, "recipient2"),
  ];
  for (const entrant of entrants) {
    await waitOutCooldown(entrant.page);
    await entrant.page.goto(`/🧧/${code}`);
    await waitForBoot(entrant.page);
    await entrant.page
      .getByRole("button", { name: "报名", exact: true })
      .click();
    await expect(
      entrant.page
        .getByRole("status")
        .filter({ hasText: /已报名|已中奖|未中奖/ }),
    ).toHaveCount(1, { timeout: 15_000 });
  }

  // Full: the draw runs now. One prize, the whole pool.
  await expect
    .poll(
      async () =>
        (
          await Promise.all(
            entrants.map(
              async (entrant) =>
                (
                  await participation(entrant.context, id)
                ).registration?.status,
            ),
          )
        )
          .sort()
          .join(","),
      { timeout: 30_000 },
    )
    .toBe("not_won,won");
  const results = await Promise.all(
    entrants.map((entrant) => participation(entrant.context, id)),
  );
  const winner =
    entrants[results.findIndex((r) => r.registration?.status === "won")];
  if (!winner) throw new Error("No winner");
  await winner.page.reload();
  await waitForBoot(winner.page);
  await expect(
    winner.page.getByRole("status").filter({ hasText: "已中奖，0.20 LDC。" }),
  ).toHaveCount(1);
  await expect(winner.page.getByText("已发放")).toBeVisible({
    timeout: 30_000,
  });
  for (const entrant of entrants) await entrant.context.close();
  await author.context.close();
});

test("实时推送：别人领取后，开着红包页的人立刻看到", async ({ browser }) => {
  const author = await account(browser, "author");
  const merchant = await fullAppMerchant(author.context, author.csrf, origin);
  const headers = { Origin: origin, "X-CSRF-Token": author.csrf };
  const created = await author.context.request.post("/api/activities", {
    headers,
    data: {
      requestId: randomUUID(),
      activity: {
        ...emptyActivityInput(),
        title: `完整应用实时推送 ${randomUUID().slice(0, 8)}`,
        participationMode: "direct",
        merchantId: merchant.id,
        deadline: { mode: "duration", value: 1, unit: "days" },
        money: { mode: "fixed", totalAmount: "0.30", count: 3 },
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const activity = ((await created.json()) as { activity: ManagedActivity })
    .activity;
  const opened = await author.context.request.post(
    `/api/me/activities/${activity.id}/open`,
    { headers, data: { version: activity.version } },
  );
  expect(opened.status(), await opened.text()).toBe(200);

  // A signed-in viewer keeps the page open; its live channel is a socket.
  const viewer = await account(browser, "recipient");
  let pushed = 0;
  viewer.page.on("websocket", (socket) => {
    socket.on("framereceived", () => {
      pushed += 1;
    });
  });
  await viewer.page.goto(`/🧧/${encodeActivityEmoji(activity.id)}`);
  await waitForBoot(viewer.page);
  await expect(
    viewer.page.getByText("0 / 3 份", { exact: true }).first(),
  ).toBeVisible();
  await expect.poll(() => pushed).toBeGreaterThan(0);
  const before = pushed;

  const claimer = await account(browser, "recipient2");
  await waitOutCooldown(claimer.page);
  const claimed = await claimer.context.request.post(
    `/api/activities/${activity.id}/claim`,
    {
      headers: { Origin: origin, "X-CSRF-Token": claimer.csrf },
      data: { submissionId: randomUUID(), participationMode: "direct" },
    },
  );
  expect(claimed.status(), await claimed.text()).toBe(200);
  // Pushed, not polled (a poll is 5 s away): the count moves at once.
  await expect(
    viewer.page.getByText("1 / 3 份", { exact: true }).first(),
  ).toBeVisible({ timeout: 2_000 });
  expect(pushed).toBeGreaterThan(before);
  await author.context.close();
  await viewer.context.close();
  await claimer.context.close();
});
