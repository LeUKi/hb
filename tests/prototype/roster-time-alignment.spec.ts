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
      expect(forbidden, "Roster display stays local").toEqual([]);
    },
    { auto: true },
  ],
});

async function checkTimeRows(page: Page, enlarged = false) {
  const rows = page.locator(".public-roster .recipient-time");
  await expect(rows.first()).toBeVisible();
  const geometry = await rows.evaluateAll((nodes) =>
    nodes.map((node) => {
      const absolute = node.querySelector<HTMLTimeElement>(
        ".recipient-time__absolute",
      );
      const relative = node.querySelector<HTMLElement>(
        ".recipient-time__relative, .recipient-time__speed",
      );
      if (!absolute) throw new Error("Missing roster timestamp");
      const full = absolute.getBoundingClientRect();
      const short = relative?.getBoundingClientRect() ?? null;
      const parent = node.getBoundingClientRect();
      const style = getComputedStyle(absolute);
      const range = document.createRange();
      range.selectNodeContents(absolute);
      return {
        fullText: absolute.textContent,
        firstClass: absolute.className,
        secondClass: relative?.className ?? null,
        sameDate:
          relative?.tagName === "TIME"
            ? absolute.dateTime === relative.getAttribute("datetime")
            : null,
        secondaryText: relative?.textContent ?? null,
        font: style.fontFamily,
        digits: style.fontVariantNumeric,
        basis: Number.parseFloat(style.flexBasis),
        left: full.left,
        width: full.width,
        relativeLeft: short?.left ?? null,
        gap: short ? short.left - full.right : null,
        wrapped: short ? short.top > full.top + 1 : null,
        textFits: range.getBoundingClientRect().width <= full.width + 1,
        fits:
          full.right <= parent.right + 1 &&
          (short ? short.right <= parent.right + 1 : true),
      };
    }),
  );
  expect(geometry.length).toBeGreaterThan(1);
  const absoluteRows = geometry.slice(0, 5);
  const secondaryRows = geometry.filter((row) => row.secondClass !== null);
  expect(secondaryRows.length).toBeGreaterThan(0);
  for (const row of absoluteRows) {
    expect(row.fullText).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
    expect(row.firstClass).toBe("recipient-time__absolute");
    expect(row.font).toContain("monospace");
    expect(row.digits).toContain("tabular-nums");
    expect(row.basis).toBeCloseTo(row.width, 1);
    expect(row.width).toBeCloseTo(absoluteRows[0].width, 1);
    expect(row.left).toBeCloseTo(absoluteRows[0].left, 1);
    expect(row.textFits).toBe(true);
    expect(row.fits).toBe(true);
  }
  for (const row of secondaryRows.slice(0, 5)) {
    if (row.secondClass === "recipient-time__speed") {
      expect(row.secondaryText).toMatch(/^\d+(?:\.\d{1,3})?秒$/u);
      expect(row.sameDate).toBeNull();
    } else {
      expect(row.secondClass).toBe("recipient-time__relative");
      expect(row.sameDate).toBe(true);
    }
    expect(row.relativeLeft).not.toBeNull();
    expect(row.relativeLeft).toBeCloseTo(secondaryRows[0].relativeLeft ?? 0, 1);
    if (enlarged) {
      expect(row.wrapped).toBe(true);
      expect(row.relativeLeft).toBeCloseTo(row.left, 1);
    } else {
      expect(row.wrapped).toBe(false);
      expect(row.gap).toBeCloseTo(8, 1);
    }
  }
}

for (const width of [1440, 375]) {
  test(`claim, registration and winner times align and wrap at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#activity?sample=history-random-active");
    await page
      .getByRole("button", { name: "查看领取名单", exact: true })
      .click();
    await checkTimeRows(page);
    await page.getByRole("dialog").press("Escape");

    await page.goto("/#activity?sample=history-draw-won");
    await page
      .getByRole("button", { name: "查看中奖名单", exact: true })
      .click();
    await expect(page.getByRole("tab", { name: /中奖名单/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await checkTimeRows(page);
    await page.getByRole("tab", { name: /报名名单/u }).click();
    await checkTimeRows(page);
    if (width === 375) {
      await page.addStyleTag({
        content: "html { font-size: 200% !important; }",
      });
      await checkTimeRows(page, true);
      const list = page.locator(".public-roster .recipient-list");
      expect(
        await list.evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
    }
  });
}

test("instantaneous claim seconds and the complete timestamp stay fixed as the clock advances", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-07T04:00:00.000Z") });
  await page.goto("/#activity?sample=history-random-active");
  await page.getByRole("button", { name: "查看领取名单", exact: true }).click();
  const row = page
    .locator(".public-roster .recipient-time")
    .filter({ has: page.locator(".recipient-time__speed") })
    .first();
  const absolute = row.locator(".recipient-time__absolute");
  const speed = row.locator(".recipient-time__speed");
  const original = await absolute.textContent();
  const before = await speed.textContent();
  await expect(speed).toHaveText(/^\d+(?:\.\d{1,3})?秒$/u);
  await page.clock.fastForward(2 * 24 * 60 * 60 * 1000);
  await expect(absolute).toHaveText(original ?? "");
  await expect(speed).toHaveText(before ?? "");
  await expect(row.locator(".recipient-time__relative")).toHaveCount(0);
});

test("speed and luck badges sit left of the amount at desktop and mobile widths while draw rosters keep relative time", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#activity?sample=history-random-active");
    await page
      .getByRole("button", { name: "查看领取名单", exact: true })
      .click();
    const recipient = page.locator(
      '.public-roster .recipient[data-username="nanfeng"]',
    );
    await recipient.scrollIntoViewIfNeeded();
    await expect(
      recipient.locator(".recipient-award .recipient-title"),
    ).toHaveText(["手气王", "我焯有桂！"]);
    await expect(recipient.locator(".recipient-title")).toHaveCount(2);
    await expect(recipient.locator(".recipient-time__speed")).toHaveText(
      "8.25秒",
    );
    const slowRecipient = page.locator(
      '.public-roster .recipient[data-username="qingning"]',
    );
    await expect(slowRecipient.locator(".recipient-time__absolute")).toHaveText(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u,
    );
    await expect(slowRecipient.locator(".recipient-time__speed")).toHaveCount(
      0,
    );
    await expect(
      slowRecipient.locator(".recipient-time__relative"),
    ).toHaveCount(0);
    const geometry = await recipient.evaluate((row) => {
      const amount = row.querySelector(".recipient-award-amount");
      const time = row.querySelector(".recipient-time");
      const list = row.closest(".recipient-list");
      if (!amount || !time || !list)
        throw new Error("Missing roster amount, time or list");
      const amountRect = amount.getBoundingClientRect();
      return {
        amount: {
          left: amountRect.left,
          top: amountRect.top,
          bottom: amountRect.bottom,
        },
        badges: [
          ...row.querySelectorAll(".recipient-award .recipient-title"),
        ].map((badge) => {
          const rect = badge.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          };
        }),
        timeRow: getComputedStyle(time).gridRowStart,
        listOverflows: list.scrollWidth > list.clientWidth,
        pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    for (const badge of geometry.badges) {
      expect(badge.right).toBeLessThanOrEqual(geometry.amount.left + 1);
      expect(badge.top).toBeLessThan(geometry.amount.bottom);
      expect(badge.bottom).toBeGreaterThan(geometry.amount.top);
    }
    expect(geometry.badges[0].right).toBeLessThanOrEqual(
      geometry.badges[1].left + 1,
    );
    expect(geometry.timeRow).toBe("2");
    expect(geometry.listOverflows).toBe(false);
    expect(geometry.pageOverflows).toBe(false);
    await page.getByRole("dialog").press("Escape");
  }
  await page.goto("/#activity?sample=history-draw-won");
  await page.getByRole("button", { name: "查看中奖名单", exact: true }).click();
  const roster = page.locator(".public-roster");
  await expect(roster.locator(".title-speed")).toHaveCount(0);
  await expect(roster.locator(".recipient-time__speed")).toHaveCount(0);
  await expect(
    roster.locator(".recipient-time__relative").first(),
  ).toBeVisible();
  await roster.getByRole("tab", { name: "报名名单", exact: true }).click();
  await expect(roster.locator(".title-speed")).toHaveCount(0);
  await expect(roster.locator(".recipient-time__speed")).toHaveCount(0);
  await expect(
    roster.locator(".recipient-time__relative").first(),
  ).toBeVisible();
});
