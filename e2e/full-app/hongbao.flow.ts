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
import { fakeDrandRound } from "./upstream.mjs";

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
  expect(claimed.claim?.payment?.status).toBe("confirmed");

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

test("🐟额红包：站长打开开关并给人加🐟，那人在发红包里选🐟额，别人领到当场存进🐟额", async ({
  browser,
}) => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const password = `鱼额${suffix}`;
  const title = `完整应用🐟额红包 ${suffix}`;
  const write = (csrf: string) => ({
    headers: { Origin: origin, "X-CSRF-Token": csrf },
  });

  // 网站设置: 🐟额红包 on; then 1.00 🐟 for the sender, by 调整.
  const admin = await account(browser, "author");
  const settings = (await (
    await admin.context.request.get("/api/admin/balance/settings")
  ).json()) as { settings: Record<string, unknown> & { version: number } };
  const { version, updatedAt: _u, ...current } = settings.settings;
  const switched = await admin.context.request.patch(
    "/api/admin/balance/settings",
    {
      ...write(admin.csrf),
      data: { ...current, expectedVersion: version, hongbaoEnabled: true },
    },
  );
  expect(switched.status()).toBe(200);
  const sender = await account(browser, "recipient2");
  const senderId = (
    (await (await sender.context.request.get("/api/session")).json()) as {
      user: { id: string };
    }
  ).user.id;
  const given = await admin.context.request.post(
    `/api/admin/balance/users/${senderId}/adjustments`,
    {
      ...write(admin.csrf),
      data: {
        requestId: randomUUID(),
        direction: "add",
        amount: "1.00",
        reason: "完整应用🐟额红包",
      },
    },
  );
  expect(given.status()).toBe(200);

  // The sender: 从哪发 🐟额, then 保存并开放. No merchant is needed.
  await sender.page.goto("/new");
  await waitForBoot(sender.page);
  await sender.page
    .getByRole("button", { name: /拼手气/ })
    .first()
    .click();
  await sender.page.getByRole("button", { name: /^🐟额/ }).click();
  await sender.page.locator("#hb-random-total").fill("0.30");
  await sender.page.locator("#hb-random-count").fill("3");
  await sender.page.locator("#hb-random-count").press("Enter");
  await sender.page.getByLabel("口令 1").fill(password);
  await sender.page.getByLabel("口令 1").press("Enter");
  await sender.page.locator("#hb-title").fill(title);
  await sender.page.getByRole("button", { name: "保存并开放" }).first().click();
  const { code, id } = await openedCode(sender.page);
  // The tag is named by its own words; what it means is its description.
  const fishTag = sender.page.getByRole("button", {
    name: "🐟额",
    exact: true,
  });
  await expect(fishTag).toBeVisible();
  await expect(fishTag).toHaveAccessibleDescription(/^领到的 LDC/);

  // Someone else takes a share: in their 🐟额 at once, no payment.
  const claimer = await account(browser, "recipient3");
  await waitOutCooldown(claimer.page);
  await claimer.page.goto(`/🧧/${code}`);
  await waitForBoot(claimer.page);
  await claimer.page.getByRole("button", { name: "输入口令领取" }).click();
  await claimer.page
    .getByRole("textbox", { name: "口令、红包链接或命令" })
    .fill(password);
  await claimer.page.keyboard.press("Enter");
  await expect(
    claimer.page
      .getByRole("status")
      .filter({ hasText: /^已领取 0\.\d\d LDC，存进了🐟额。$/ }),
  ).toHaveCount(1);
  await expect(
    claimer.page.locator("[data-hb-part=result]").getByText("已存入🐟额"),
  ).toBeVisible();
  const claimed = await participation(claimer.context, id);
  expect(claimed.claim?.payment).toBeUndefined();
  expect(claimed.claim?.activity.funding).toBe("balance");

  // The sender's 🐟额: what is still in it, and the 红包 in 明细.
  await sender.page.goto("/balance");
  await waitForBoot(sender.page);
  await expect(sender.page.getByText("发出未领")).toBeVisible();
  await expect(sender.page.getByText(`发红包「${title}」`)).toBeVisible();
  await admin.context.close();
  await sender.context.close();
  await claimer.context.close();
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

  // 开奖证明: drawn from the drand round right after closing; the browser
  // redoes it, both nodes answering as the Worker's did.
  await winner.page.route(
    /^https:\/\/(drand\.cloudflare\.com|api\.drand\.sh)\//,
    (route) =>
      route.fulfill({
        json: fakeDrandRound(
          Number(new URL(route.request().url()).pathname.split("/").pop()),
        ),
        headers: { "Access-Control-Allow-Origin": "*" },
      }),
  );
  await winner.page.locator("#roster-entry").click();
  await winner.page.getByRole("button", { name: /开奖证明/ }).click();
  const proof = winner.page.getByRole("dialog", { name: "开奖证明" });
  await proof.getByRole("button", { name: "自己验证" }).click();
  await expect(proof.getByText("完全一致")).toBeVisible({ timeout: 15_000 });
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

test("实时推送：领取后付款到账也是推过来的，连着时不轮询", async ({
  browser,
}) => {
  const author = await account(browser, "author");
  const merchant = await fullAppMerchant(author.context, author.csrf, origin);
  const headers = { Origin: origin, "X-CSRF-Token": author.csrf };
  const created = await author.context.request.post("/api/activities", {
    headers,
    data: {
      requestId: randomUUID(),
      activity: {
        ...emptyActivityInput(),
        title: `完整应用付款推送 ${randomUUID().slice(0, 8)}`,
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

  const viewer = await account(browser, "recipient3");
  await waitOutCooldown(viewer.page);
  // Every read of this 红包 the page makes, by what it reads.
  const reads: { at: number; what: string }[] = [];
  const base = `/api/activities/${activity.id}`;
  viewer.page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path.startsWith(base))
      reads.push({ at: Date.now(), what: path.slice(base.length) || "/" });
  });
  let mine = 0;
  viewer.page.on("websocket", (socket) => {
    socket.on("framereceived", (frame) => {
      if (String(frame.payload).includes('"mine"')) mine += 1;
    });
  });
  await viewer.page.goto(`/🧧/${encodeActivityEmoji(activity.id)}`);
  await waitForBoot(viewer.page);
  await viewer.page.getByRole("button", { name: "领取红包" }).click();
  await expect(
    viewer.page.getByRole("status").filter({ hasText: /^已领取 0\.10 LDC。$/ }),
  ).toHaveCount(1);
  const claimedAt = Date.now();
  // The payment goes through on the server: the page is told, not polling.
  await expect(viewer.page.getByText("已发放")).toBeVisible({
    timeout: 12_000,
  });
  expect(mine).toBeGreaterThan(0);
  const confirmedIn = Date.now() - claimedAt;
  // Once settled, a quiet stretch longer than any polling round: no reads.
  await viewer.page.waitForTimeout(2_000);
  const quietFrom = Date.now();
  await viewer.page.waitForTimeout(16_000);
  expect(reads.filter((read) => read.at >= quietFrom)).toEqual([]);
  test.info().annotations.push({
    type: "付款推送",
    description: `领取后 ${confirmedIn} ms 显示已发放；期间读取 ${reads
      .filter((read) => read.at >= claimedAt && read.at < quietFrom)
      .map((read) => read.what)
      .join(", ")}`,
  });
  await author.context.close();
  await viewer.context.close();
});

test("没有 Credit 账户：领取被拒，注册后自己重新发送一次就到账", async ({
  browser,
}) => {
  const author = await account(browser, "author");
  const merchant = await fullAppMerchant(author.context, author.csrf, origin);
  const headers = { Origin: origin, "X-CSRF-Token": author.csrf };
  const created = await author.context.request.post("/api/activities", {
    headers,
    data: {
      requestId: randomUUID(),
      activity: {
        ...emptyActivityInput(),
        title: `完整应用重新发送 ${randomUUID().slice(0, 8)}`,
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

  // The upstream knows no Credit account for them until after the first try.
  const latecomer = await account(browser, "latecomer");
  await waitOutCooldown(latecomer.page);
  await latecomer.page.goto(`/🧧/${encodeActivityEmoji(activity.id)}`);
  await waitForBoot(latecomer.page);
  await latecomer.page.getByRole("button", { name: "领取红包" }).click();
  const main = latecomer.page.locator("main");
  await expect(main.getByText("还没有 LINUX DO Credit 账户")).toBeVisible({
    timeout: 15_000,
  });
  const held = await participation(latecomer.context, activity.id);
  expect(held.claim?.payment).toMatchObject({
    status: "attention",
    reason: "recipient",
  });
  expect(held.claim?.payment.resendUntil).toBeTruthy();

  // Registered now: sent again once, looked up first, then paid.
  await main.getByRole("button", { name: "重新发送" }).click();
  await expect(main.getByText("正在重新发送，稍等十几秒。")).toBeVisible();
  await expect(main.getByText("已发放")).toBeVisible({ timeout: 40_000 });
  const paid = await participation(latecomer.context, activity.id);
  expect(paid.claim?.payment.status).toBe("confirmed");
  expect(paid.claim?.payment.resendUntil).toBeUndefined();
  // Once only: nothing left to send again.
  const again = await latecomer.context.request.post(
    `/api/me/claims/${paid.claim?.id}/resend`,
    { headers: { Origin: origin, "X-CSRF-Token": latecomer.csrf } },
  );
  expect(again.status()).toBe(409);
  await author.context.close();
  await latecomer.context.close();
});
