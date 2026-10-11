import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const now = Date.parse("2026-10-06T04:00:00.000Z");

base.use({ timezoneId: "Asia/Shanghai" });

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
        "Time components stay inside the prototype",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

async function mountTimeHarness(page: Page) {
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
      const { RelativeTime, ShortTime } = await import("/time.tsx");
      const app = document.getElementById("root");
      if (app) app.style.display = "none";
      const target = document.createElement("main");
      target.id = "time-harness";
      target.style.cssText =
        "position:fixed;inset:16px;display:flex;gap:16px;align-items:center;";
      document.body.append(target);

      const nativeSetInterval = window.setInterval.bind(window);
      const nativeClearInterval = window.clearInterval.bind(window);
      const intervals = new Set<number>();
      let started = 0;
      let cleared = 0;
      const report = () => {
        target.dataset.activeTimers = String(intervals.size);
        target.dataset.startedTimers = String(started);
        target.dataset.clearedTimers = String(cleared);
      };
      window.setInterval = ((handler, timeout, ...args) => {
        const id = nativeSetInterval(handler, timeout, ...args);
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
      const recent = new Date(modules.now - 30_000).toISOString();
      const old = new Date(modules.now - 3_600_000).toISOString();
      const day = new Date(modules.now - 26 * 3_600_000).toISOString();

      function Fixture() {
        const [mounted, setMounted] = React.useState(true);
        return h(
          React.Fragment,
          null,
          mounted &&
            h(
              React.Fragment,
              null,
              h(RelativeTime, { value: recent, className: "recent" }),
              h(RelativeTime, { value: old, className: "old" }),
              h(RelativeTime, { value: day, className: "day" }),
            ),
          h(ShortTime, { value: "not-a-date", className: "invalid" }),
          h(ShortTime, { value: undefined, className: "missing" }),
          h(
            "button",
            { type: "button", onClick: () => setMounted(false) },
            "卸载",
          ),
        );
      }
      createRoot(target).render(h(Fixture));
    },
    { react, reactDom, now },
  );
  return page.locator("#time-harness");
}

test("relative times update from one shared clock and clean up after unmount", async ({
  page,
}) => {
  const harness = await mountTimeHarness(page);
  await expect(harness.locator(".recent")).toHaveText("刚刚");
  await expect(harness.locator(".old")).toContainText("1 小时");
  await expect(harness.locator(".day")).toContainText("1 天");
  await expect(harness.locator(".recent")).toHaveAttribute(
    "title",
    "2026-10-06 11:59:30",
  );
  await expect(harness.locator(".recent")).toHaveAttribute(
    "aria-description",
    "2026-10-06 11:59:30",
  );
  await expect(harness.locator(".invalid")).toHaveText("—");
  await expect(harness.locator(".missing")).toHaveText("—");
  await expect(harness).toHaveAttribute("data-active-timers", "1");
  await expect(harness).toHaveAttribute("data-started-timers", "1");

  await page.clock.runFor(20_000);
  await expect(harness.locator(".recent")).toContainText("1 分钟");
  await expect(harness).toHaveAttribute("data-started-timers", "1");

  await page.clock.setSystemTime(now + 90_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(harness.locator(".recent")).toContainText("2 分钟");

  await harness.getByRole("button", { name: "卸载" }).click();
  await expect(harness).toHaveAttribute("data-active-timers", "0");
  await expect(harness).toHaveAttribute("data-cleared-timers", "1");
});
