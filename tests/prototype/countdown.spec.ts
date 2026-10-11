import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const now = Date.parse("2026-10-06T04:00:00.000Z");
const deadlineIn = (milliseconds: number) =>
  new Date(now + milliseconds).toISOString();

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
      expect([...forbidden], "Countdown uses only the local prototype").toEqual(
        [],
      );
    },
    { auto: true },
  ],
});

type FixtureOptions = {
  deadlineAt: string | null;
  kind?: "instant" | "draw";
  active?: boolean;
  managed?: boolean;
};

async function mountCountdown(page: Page, options: FixtureOptions) {
  const [entryResponse, htmlResponse] = await Promise.all([
    page.request.get("/main.tsx"),
    page.request.get("/"),
  ]);
  const entry = await entryResponse.text();
  const react = entry.match(/from "([^"]+\/react\.js(?:\?[^"]*)?)"/u)?.[1];
  const reactDom = entry.match(
    /from "([^"]+\/react-dom_client\.js(?:\?[^"]*)?)"/u,
  )?.[1];
  if (!react || !reactDom) throw new Error("Prototype React modules not found");
  const html = (await htmlResponse.text()).replace(
    /<script\b[^>]*\bsrc="\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/u,
    '<script type="module">import "/styles.css";</script>',
  );
  await page.route(`${origin}/`, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.clock.install({ time: now - 60_000 });
  await page.goto("/");
  await page.clock.pauseAt(now);
  await page.evaluate(
    async (modules) => {
      const React = (await import(modules.react)).default;
      const { createRoot } = (await import(modules.reactDom)).default;
      const { ActivityCountdown, useActivityCountdown } = await import(
        "/components/activity-countdown.tsx"
      );
      const app = document.getElementById("root");
      if (app) app.style.display = "none";
      const target = document.createElement("main");
      target.id = "countdown-harness";
      target.style.cssText =
        "position:fixed;inset:16px;overflow:auto;display:flex;flex-direction:column;align-items:flex-start;gap:16px;";
      document.body.append(target);

      const nativeSetInterval = window.setInterval.bind(window);
      const nativeClearInterval = window.clearInterval.bind(window);
      const intervals = new Set<number>();
      let started = 0;
      let cleared = 0;
      let ticks = 0;
      const report = () => {
        target.dataset.activeTimers = String(intervals.size);
        target.dataset.startedTimers = String(started);
        target.dataset.clearedTimers = String(cleared);
        target.dataset.timerTicks = String(ticks);
      };
      window.setInterval = ((handler, timeout, ...args) => {
        const wrapped =
          typeof handler === "function"
            ? (...callbackArgs: unknown[]) => {
                ticks += 1;
                report();
                handler(...callbackArgs);
              }
            : handler;
        const id = nativeSetInterval(wrapped, timeout, ...args);
        intervals.add(id);
        started += 1;
        report();
        return id;
      }) as typeof window.setInterval;
      window.clearInterval = (id) => {
        if (id !== undefined && intervals.delete(id)) cleared += 1;
        nativeClearInterval(id);
        report();
      };
      report();
      const h = React.createElement;

      function ManagedCountdown(props: {
        deadlineAt: string | null;
        active: boolean;
        kind: "instant" | "draw";
      }) {
        const value = useActivityCountdown(props);
        return h(
          React.Fragment,
          null,
          h(ActivityCountdown, { ...props, remaining: value.remaining }),
          h(
            "output",
            { "data-testid": "hook-remaining" },
            value.remaining === null ? "null" : String(value.remaining),
          ),
          h("output", { "data-testid": "hook-expired" }, String(value.expired)),
        );
      }

      function Fixture() {
        const [deadlineAt, setDeadlineAt] = React.useState(
          modules.options.deadlineAt,
        );
        const [active, setActive] = React.useState(
          modules.options.active ?? true,
        );
        const [mounted, setMounted] = React.useState(true);
        const [, rerender] = React.useReducer((value: number) => value + 1, 0);
        const renders = React.useRef(0);
        renders.current += 1;
        const props = {
          deadlineAt,
          active,
          kind: modules.options.kind ?? "instant",
        };
        return h(
          React.Fragment,
          null,
          mounted &&
            h(
              modules.options.managed ? ManagedCountdown : ActivityCountdown,
              props,
            ),
          h("output", { "data-testid": "parent-renders" }, renders.current),
          h(
            "output",
            { "data-testid": "activity-state" },
            active ? "active" : "inactive",
          ),
          h(
            "button",
            { type: "button", onClick: () => rerender() },
            "重绘页面",
          ),
          h(
            "button",
            { type: "button", onClick: () => setActive(false) },
            "暂停活动",
          ),
          h(
            "button",
            { type: "button", onClick: () => setActive(true) },
            "恢复活动",
          ),
          h(
            "button",
            { type: "button", onClick: () => setDeadlineAt(null) },
            "移除期限",
          ),
          h(
            "button",
            {
              type: "button",
              onClick: () => setDeadlineAt(modules.replacementDeadline),
            },
            "更换期限",
          ),
          h(
            "button",
            { type: "button", onClick: () => setMounted(false) },
            "卸载倒计时",
          ),
        );
      }
      createRoot(target).render(h(Fixture));
    },
    { react, reactDom, options, replacementDeadline: deadlineIn(120_000) },
  );
  const harness = page.locator("#countdown-harness");
  await expect(harness.getByTestId("parent-renders")).toHaveText("1");
  return harness;
}

test("ticks each second with tabular numbers and keeps page rendering isolated", async ({
  page,
}) => {
  const harness = await mountCountdown(page, {
    deadlineAt: deadlineIn(10_000),
  });
  const timer = harness.getByRole("timer", { name: "活动结束倒计时" });
  const value = timer.locator(".activity-countdown__value");
  await expect(timer).toHaveAttribute("aria-live", "off");
  await expect(timer).toContainText("距结束");
  await expect(value).toHaveText("00:00:10");
  expect(
    await value.evaluate(
      (element) => getComputedStyle(element).fontVariantNumeric,
    ),
  ).toBe("tabular-nums");
  await page.clock.runFor(1_000);
  await expect(value).toHaveText("00:00:09");
  await page.clock.runFor(1_000);
  await expect(value).toHaveText("00:00:08");
  await expect(harness.getByTestId("parent-renders")).toHaveText("1");
  await expect(harness).toHaveAttribute("data-active-timers", "1");
});

test("formats multi-day deadlines and crosses midnight without a reset", async ({
  page,
}) => {
  const harness = await mountCountdown(page, {
    deadlineAt: deadlineIn(86_402_000),
    kind: "draw",
  });
  const timer = harness.getByRole("timer", { name: "开奖倒计时" });
  const value = timer.locator(".activity-countdown__value");
  await expect(timer).toContainText("距开奖");
  await expect(value).toHaveText("1天 00:00:02");
  await page.clock.runFor(2_000);
  await expect(value).toHaveText("1天 00:00:00");
  await page.clock.runFor(1_000);
  await expect(value).toHaveText("23:59:59");
});

test("missed callbacks use the wall clock rather than decrementing once", async ({
  page,
}) => {
  const harness = await mountCountdown(page, {
    deadlineAt: deadlineIn(60_000),
  });
  await page.clock.fastForward(45_000);
  await expect(harness.locator(".activity-countdown__value")).toHaveText(
    "00:00:15",
  );
  await expect(harness).toHaveAttribute("data-timer-ticks", "1");
});

test("focus and visible restoration immediately correct a paused background clock", async ({
  page,
}) => {
  const harness = await mountCountdown(page, {
    deadlineAt: deadlineIn(60_000),
  });
  const value = harness.locator(".activity-countdown__value");
  await page.clock.setSystemTime(now + 45_000);
  await expect(value).toHaveText("00:01:00");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(value).toHaveText("00:00:15");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.setSystemTime(now + 59_500);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(value).toHaveText("00:00:01");
  await page.clock.setSystemTime(now + 60_000);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(harness.getByRole("timer")).toHaveText("已截止");
  await expect(harness).toHaveAttribute("data-active-timers", "0");
});

test("parent rerenders retain the fixed ISO deadline and the original timer", async ({
  page,
}) => {
  const harness = await mountCountdown(page, {
    deadlineAt: deadlineIn(10_000),
  });
  await page.clock.runFor(2_000);
  await harness.getByRole("button", { name: "重绘页面" }).click();
  await expect(harness.locator(".activity-countdown__value")).toHaveText(
    "00:00:08",
  );
  await expect(harness).toHaveAttribute("data-started-timers", "1");
  await page.clock.runFor(1_000);
  await expect(harness.locator(".activity-countdown__value")).toHaveText(
    "00:00:07",
  );
});

test("a managed hook shares one timer and expires without producing an activity result", async ({
  page,
}) => {
  const harness = await mountCountdown(page, {
    deadlineAt: deadlineIn(3_000),
    kind: "draw",
    managed: true,
  });
  await expect(harness).toHaveAttribute("data-active-timers", "1");
  await expect(harness.getByTestId("hook-remaining")).toHaveText("3000");
  await expect(harness.getByTestId("hook-expired")).toHaveText("false");
  await page.clock.runFor(3_000);
  await expect(harness.getByRole("timer")).toHaveText("报名已截止");
  await expect(harness.getByTestId("hook-remaining")).toHaveText("0");
  await expect(harness.getByTestId("hook-expired")).toHaveText("true");
  await expect(harness.getByTestId("activity-state")).toHaveText("active");
  await expect(harness).toHaveAttribute("data-active-timers", "0");
  await expect(harness).toHaveAttribute("data-started-timers", "1");
  await page.clock.fastForward(60_000);
  await expect(harness).toHaveAttribute("data-timer-ticks", "3");
});

for (const kind of ["instant", "draw"] as const) {
  test(`${kind} already expired deadlines render their stop label without a timer`, async ({
    page,
  }) => {
    const harness = await mountCountdown(page, {
      deadlineAt: deadlineIn(-1_000),
      kind,
      managed: true,
    });
    await expect(harness.getByRole("timer")).toHaveText(
      kind === "draw" ? "报名已截止" : "已截止",
    );
    await expect(harness.getByTestId("hook-expired")).toHaveText("true");
    await expect(harness.getByTestId("hook-remaining")).toHaveText("0");
    await expect(harness).toHaveAttribute("data-started-timers", "0");
  });
}

test("no deadline is neither expired nor timed", async ({ page }) => {
  const harness = await mountCountdown(page, {
    deadlineAt: null,
    managed: true,
  });
  await expect(harness.getByRole("timer")).toHaveCount(0);
  await expect(harness.getByTestId("hook-remaining")).toHaveText("null");
  await expect(harness.getByTestId("hook-expired")).toHaveText("false");
  await expect(harness).toHaveAttribute("data-started-timers", "0");
  await page.clock.fastForward(60_000);
  await expect(harness).toHaveAttribute("data-timer-ticks", "0");
});

test("inactive activities stay untimed and reactivation uses the current clock", async ({
  page,
}) => {
  const harness = await mountCountdown(page, {
    deadlineAt: deadlineIn(60_000),
    kind: "draw",
    active: false,
    managed: true,
  });
  await expect(harness.getByRole("timer")).toHaveCount(0);
  await expect(harness).toHaveAttribute("data-started-timers", "0");
  await page.clock.fastForward(30_000);
  await harness.getByRole("button", { name: "恢复活动" }).click();
  await expect(harness.locator(".activity-countdown__value")).toHaveText(
    "00:00:30",
  );
  await expect(harness).toHaveAttribute("data-active-timers", "1");
  await harness.getByRole("button", { name: "暂停活动" }).click();
  await expect(harness.getByRole("timer")).toHaveCount(0);
  await expect(harness).toHaveAttribute("data-active-timers", "0");
  await page.clock.fastForward(60_000);
  await expect(harness).toHaveAttribute("data-timer-ticks", "0");
  await harness.getByRole("button", { name: "恢复活动" }).click();
  await expect(harness.getByRole("timer")).toHaveText("报名已截止");
  await expect(harness.getByTestId("hook-expired")).toHaveText("true");
  await expect(harness).toHaveAttribute("data-active-timers", "0");
});

test("replacing a deadline reuses the shared clock and removing it cleans the subscription", async ({
  page,
}) => {
  const harness = await mountCountdown(page, {
    deadlineAt: deadlineIn(60_000),
  });
  await page.clock.runFor(10_000);
  await harness.getByRole("button", { name: "更换期限" }).click();
  await expect(harness.locator(".activity-countdown__value")).toHaveText(
    "00:01:50",
  );
  await expect(harness).toHaveAttribute("data-active-timers", "1");
  await expect(harness).toHaveAttribute("data-started-timers", "1");
  await expect(harness).toHaveAttribute("data-cleared-timers", "0");
  await harness.getByRole("button", { name: "移除期限" }).click();
  await expect(harness.getByRole("timer")).toHaveCount(0);
  await expect(harness).toHaveAttribute("data-active-timers", "0");
  await expect(harness).toHaveAttribute("data-cleared-timers", "1");
});

test("unmount clears the timer and restoration events have no further callbacks", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const harness = await mountCountdown(page, {
    deadlineAt: deadlineIn(60_000),
  });
  await harness.getByRole("button", { name: "卸载倒计时" }).click();
  await expect(harness.getByRole("timer")).toHaveCount(0);
  await expect(harness).toHaveAttribute("data-active-timers", "0");
  await expect(harness).toHaveAttribute("data-cleared-timers", "1");
  await page.clock.fastForward(60_000);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(harness).toHaveAttribute("data-timer-ticks", "0");
  expect(errors).toEqual([]);
});
