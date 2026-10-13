import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const forbidden = new Set<string>();
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
          forbidden.add(url.href);
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect([...forbidden], "Envelope presentation stays local").toEqual([]);
    },
    { auto: true },
  ],
});

async function mountEnvelopeHarness(
  page: Page,
  initial: "home" | "activity" = "home",
  hasReward = false,
  options: {
    reward?:
      | { kind: "ldc"; amount: string }
      | { kind: "missed" | "not-won" | "ended" };
    author?: { name: string; username: string; color?: string };
    payment?: { status: string; confirmedAt?: string };
    rosterLabel?: string;
    withInput?: boolean;
    timestampedNavigation?: boolean;
    reserveResultSpace?: boolean;
    entryToken?: boolean;
  } = {},
) {
  const [entryResponse, envelopeResponse, htmlResponse] = await Promise.all([
    page.request.get("/main.tsx"),
    page.request.get("/components/envelope.tsx"),
    page.request.get("/"),
  ]);
  const entry = await entryResponse.text();
  const envelope = await envelopeResponse.text();
  const react = entry.match(/from "([^"]+\/react\.js(?:\?[^"]*)?)"/u)?.[1];
  const reactDom = entry.match(
    /from "([^"]+\/react-dom_client\.js(?:\?[^"]*)?)"/u,
  )?.[1];
  const motion = envelope.match(
    /from "([^"]+\/motion_react\.js(?:\?[^"]*)?)"/u,
  )?.[1];
  const transitionModule = envelope.match(
    /from "([^"]+\/redemption-transition\.tsx(?:\?[^"]*)?)"/u,
  )?.[1];
  if (!react || !reactDom || !motion || !transitionModule)
    throw new Error("Prototype React/Motion modules not found");
  const html = (await htmlResponse.text()).replace(
    /<script\b[^>]*\bsrc="\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/u,
    '<script type="module">import "/styles.css"; import "/framework.css";</script>',
  );
  await page.route(`${origin}/`, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.clock.install({ time: new Date("2026-10-06T03:59:00.000Z") });
  await page.goto("/");
  await page.clock.pauseAt(new Date("2026-10-06T04:00:00.000Z"));
  await page.evaluate(
    async (modules) => {
      const React = (await import(modules.react)).default;
      const { createRoot } = (await import(modules.reactDom)).default;
      const { AnimatePresence, MotionConfig } = await import(modules.motion);
      const { Envelope } = await import("/components/envelope.tsx");
      const { PasswordInput } = await import("/components/password-input.tsx");
      const {
        RedemptionTransitionProvider,
        RedemptionRouteFrame,
        useActivityEntryToken,
      } = await import(modules.transitionModule);
      const target = document.getElementById("root");
      if (!target) throw new Error("Prototype root missing");
      target.style.cssText =
        "display:block;position:fixed;inset:20px;overflow:auto";
      const h = React.createElement;
      const reward = modules.options.reward ?? { kind: "ldc", amount: "3.28" };
      function ActivityEnvelope(props) {
        const entryToken = useActivityEntryToken("fixture-activity");
        return h(Envelope, {
          ...props,
          entryToken: modules.options.entryToken ? entryToken : null,
        });
      }
      let revision = 0;
      function Harness() {
        const [route, setRoute] = React.useState(modules.initial);
        const [open, setOpen] = React.useState(modules.hasReward);
        const [token, setToken] = React.useState(null);
        const [amount, setAmount] = React.useState(
          reward.kind === "ldc" ? reward.amount : null,
        );
        const [title, setTitle] = React.useState("真实活动标题");
        const [identity, setIdentity] = React.useState("fixture-session");
        const [snapshotAt, setSnapshotAt] = React.useState(Date.now());
        const currentReward =
          reward.kind === "ldc" ? { ...reward, amount } : reward;
        const presentation = {
          title,
          sender: modules.options.author?.name ?? "真实发起人",
          state: open
            ? reward.kind === "ldc"
              ? "claimed"
              : reward.kind === "not-won"
                ? "not_won"
                : "ended"
            : "active",
          sealLabel: open
            ? reward.kind === "missed"
              ? "错过了"
              : reward.kind === "not-won"
                ? "未中奖"
                : reward.kind === "ended"
                  ? "已结束"
                  : "开"
            : "开",
          quantityText: "剩余 7 份",
          amount: amount ? `${amount} LDC` : null,
          statusText:
            modules.options.payment?.status === "confirmed"
              ? "已发放"
              : "已领取",
          claimedAt: "2026-10-06T03:50:00.000Z",
          updatedAt: new Date(snapshotAt),
        };
        const [transition, setTransition] = React.useState(null);
        const [renderCount, setRenderCount] = React.useState(0);
        const [rosterVisits, setRosterVisits] = React.useState(0);
        const [password, setPassword] = React.useState("测试口令abc２０26");
        const go = (next, shared = true, from = route) => {
          setTransition({
            id: ++revision,
            startedAt: modules.options.timestampedNavigation
              ? Date.now()
              : undefined,
            from,
            to: next,
            activityId: "fixture-activity",
            shared,
            closingReward:
              from === "activity" && next === "home" && open
                ? currentReward
                : undefined,
          });
          setRoute(next);
          setToken(null);
        };
        const button = (text, action) =>
          h("button", { type: "button", onClick: action }, text);
        return h(
          React.Fragment,
          null,
          h(
            "nav",
            { style: { display: "flex", gap: "12px", minHeight: "48px" } },
            button("首页", () => go("home")),
            button("活动页", () => go("activity")),
            button("确认领取", () => {
              setOpen(true);
              setToken(++revision);
            }),
            button("重渲染", () => setRenderCount((count) => count + 1)),
            button("更新事实", () => {
              setAmount("4.56");
              setTitle("更新后的活动标题");
              setSnapshotAt(Date.now());
            }),
            button("切换会话", () => {
              setIdentity("rotated-session");
              setOpen(false);
              setToken(null);
              setTransition(null);
            }),
            button("直接查看", () => go("activity", false, "participations")),
            button("活动历史", () => go("participations")),
            button("清理账号", () => {
              setOpen(false);
              setToken(null);
              setTransition(null);
            }),
          ),
          h("output", null, renderCount),
          h("output", { id: "roster-visits" }, rosterVisits),
          h(
            RedemptionTransitionProvider,
            { transition },
            h(
              AnimatePresence,
              { initial: false, mode: "popLayout" },
              h(
                RedemptionRouteFrame,
                { key: route, routeKey: route },
                h(
                  "div",
                  {
                    className: route === "home" ? "home-page" : "activity-page",
                    style: {
                      position: "relative",
                      marginLeft:
                        window.innerWidth <= 760
                          ? "0px"
                          : route === "home"
                            ? "20px"
                            : "300px",
                      marginTop: route === "home" ? "20px" : "110px",
                    },
                  },
                  route !== "participations" &&
                    h(route === "activity" ? ActivityEnvelope : Envelope, {
                      key: identity,
                      open: route === "activity" && open,
                      reward:
                        route === "activity" && open
                          ? currentReward
                          : undefined,
                      presentation:
                        route === "activity" ? presentation : undefined,
                      presentationIdentity: identity,
                      size: route === "home" ? "small" : "detail",
                      reserveResultSpace:
                        route === "activity" &&
                        !open &&
                        modules.options.reserveResultSpace,
                      animationToken: token,
                      author: modules.options.author,
                      payment: modules.options.payment,
                      rosterLabel: modules.options.rosterLabel,
                      onOpenRoster: modules.options.rosterLabel
                        ? () => setRosterVisits((count) => count + 1)
                        : undefined,
                    }),
                  modules.options.withInput &&
                    route !== "participations" &&
                    h(
                      "div",
                      {
                        style: { width: route === "home" ? "420px" : "300px" },
                      },
                      h(PasswordInput, {
                        value: password,
                        onChange: setPassword,
                        label: "转场口令",
                        sharedFrame: true,
                      }),
                    ),
                  route === "participations" && h("h1", null, "活动历史"),
                ),
              ),
            ),
          ),
        );
      }
      createRoot(target).render(
        h(
          React.StrictMode,
          null,
          h(MotionConfig, { reducedMotion: "user" }, h(Harness)),
        ),
      );
    },
    { react, reactDom, motion, transitionModule, initial, hasReward, options },
  );
  return page.locator(
    '[data-route-presence="present"] [data-testid="envelope"]',
  );
}

test("home and activity use the same 420 by 560 SVG source geometry without invented home facts", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page);
  const source =
    "M10 36c0-15.5 12.5-28 28-28h344c15.5 0 28 12.5 28 28v290c-72 40-138.6 60-200 60S82 366 10 326V36Z";
  const geometry = () =>
    envelope.locator(".envelope").evaluate((body) => {
      const svg = body.querySelector("svg");
      if (!svg) throw new Error("SVG missing");
      const box = body.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        viewBox: svg.getAttribute("viewBox"),
        paths: [...svg.querySelectorAll("path")].map((path) =>
          path.getAttribute("d"),
        ),
      };
    });
  const home = await geometry();
  expect(home.width).toBe(104);
  expect(home.viewBox).toBe("0 0 420 560");
  expect(home.paths).toContain(source);
  await expect(envelope.locator("svg")).toHaveAttribute(
    "data-state",
    "neutral",
  );
  await expect(
    envelope.locator(".prize,.data-row,.snapshot-time,.claimed-time"),
  ).toHaveCount(0);
  expect(await envelope.textContent()).not.toMatch(
    /18\.88|发红包的人|未命名活动|活动发起人/,
  );
  await page.getByRole("button", { name: "直接查看", exact: true }).click();
  await page.clock.runFor(180);
  const detail = await geometry();
  expect(detail.width).toBe(210);
  expect(detail.height).toBe(280);
  expect(detail.paths).toContain(source);
  expect(detail.width / detail.height).toBeCloseTo(home.width / home.height, 3);
  await expect(envelope.locator(".sender")).toHaveText("真实发起人");
  await expect(envelope.locator(".title-line")).toHaveText("真实活动标题");
});

test("confirmed results reveal for 1800 ms and retain the animation DOM across refetch", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page, "activity");
  await page.getByRole("button", { name: "确认领取", exact: true }).click();
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await envelope.locator("svg").evaluate((svg) => {
    Reflect.set(window, "openingSvg", svg);
  });
  await expect(envelope.locator(".claimed-result")).toHaveCSS("opacity", "0");
  await page.clock.runFor(700);
  const earlyCover = await envelope
    .locator(".open-upper")
    .evaluate((node) => getComputedStyle(node).transform);
  await page.getByRole("button", { name: "更新事实", exact: true }).click();
  expect(
    await envelope
      .locator("svg")
      .evaluate((svg) => Reflect.get(window, "openingSvg") === svg),
  ).toBe(true);
  await expect(envelope.locator(".prize")).toHaveText("+3.28 LDC");
  await page.clock.runFor(1090);
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await page.clock.runFor(10);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope.locator(".claimed-result")).toHaveCSS("opacity", "1");
  await expect(envelope.locator(".prize")).toHaveText("+4.56 LDC");
  await expect(envelope.locator(".title-line")).toHaveText("更新后的活动标题");
  expect(earlyCover).not.toEqual("matrix(1, 0, 0, 1, 0, -196)");
  await page.getByRole("button", { name: "重渲染", exact: true }).click();
  await page.clock.runFor(1000);
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
});

test("shared navigation moves before opening and closes with retained paper", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page, "home", true);
  await page.getByRole("button", { name: "活动页", exact: true }).click();
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await expect(envelope).toHaveAttribute("data-opening-count", "0");
  const exiting = page.locator('[data-route-presence="exiting"]');
  await expect(exiting).toHaveAttribute("inert", "");
  await expect(exiting).toHaveAttribute("aria-hidden", "true");
  await page.clock.runFor(250);
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await page.clock.runFor(60);
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await page.clock.runFor(1850);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await expect(envelope).toHaveAttribute("data-size", "small");
  await expect(envelope).toHaveAttribute("data-open", "false");
  await expect(envelope).toHaveAttribute("data-phase", "closing");
  await expect(envelope.locator(".claimed-result, .ended-stamp")).toHaveCount(
    1,
  );
  await page.clock.runFor(150);
  await expect(envelope.locator(".claimed-result, .ended-stamp")).toHaveCount(
    1,
  );
  await page.clock.runFor(170);
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await expect(envelope.locator(".claimed-result, .ended-stamp")).toHaveCount(
    0,
  );
});

for (const { width, confirmationDelay } of [
  { width: 1440, confirmationDelay: 120 },
  { width: 375, confirmationDelay: 550 },
]) {
  test(`timestamped navigation keeps pending geometry and opens for 1800ms after a ${confirmationDelay}ms confirmation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const envelope = await mountEnvelopeHarness(page, "home", false, {
      timestampedNavigation: true,
      reserveResultSpace: true,
    });
    await page.getByRole("button", { name: "活动页", exact: true }).click();
    await expect(envelope).toHaveAttribute("data-phase", "closed");
    const geometry = () =>
      envelope.evaluate((stage) => ({
        height: stage.getBoundingClientRect().height,
        localTop: stage.querySelector<HTMLElement>(".envelope")?.offsetTop,
      }));
    const pending = await geometry();
    expect(pending.height).toBe(340);
    await page.clock.runFor(confirmationDelay);
    expect(await geometry()).toEqual(pending);
    await page.getByRole("button", { name: "确认领取", exact: true }).click();
    const remainingMove = Math.max(0, 300 - confirmationDelay);
    if (remainingMove) {
      await expect(envelope).toHaveAttribute("data-phase", "closed");
      await page.clock.runFor(remainingMove - 1);
      await expect(envelope).toHaveAttribute("data-phase", "closed");
      await page.clock.runFor(1);
    }
    await expect(envelope).toHaveAttribute("data-phase", "opening");
    await expect(envelope).toHaveAttribute("data-opening-count", "1");
    expect(await geometry()).toEqual(pending);
    await page.clock.runFor(1790);
    await expect(envelope).toHaveAttribute("data-phase", "opening");
    await page.clock.runFor(10);
    await expect(envelope).toHaveAttribute("data-phase", "open");
    await expect(envelope.locator(".prize")).toHaveText("+3.28 LDC");
    expect(await geometry()).toEqual(pending);
    await page.getByRole("button", { name: "重渲染", exact: true }).click();
    await page.clock.runFor(1_000);
    await expect(envelope).toHaveAttribute("data-opening-count", "1");
  });
}

test("rapid navigation cancels late opening callbacks and direct claimed history opens once per entry", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page, "home", true, {
    entryToken: true,
  });
  await page.getByRole("button", { name: "活动页", exact: true }).click();
  await page.clock.runFor(100);
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await page.clock.runFor(1_200);
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await expect(envelope).toHaveAttribute("data-opening-count", "0");
  await expect(page.locator('[data-route-presence="exiting"]')).toHaveCount(0);

  await page.getByRole("button", { name: "直接查看", exact: true }).click();
  const entryToken = await envelope.getAttribute("data-entry-token");
  expect(entryToken).toBeTruthy();
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await expect(envelope.locator(".claimed-result")).toHaveCSS("opacity", "0");
  const openingAnimation = await envelope
    .locator(".open-upper")
    .evaluate((node) => getComputedStyle(node).animationName);
  expect(openingAnimation).toMatch(/upper-open/u);

  await page.getByRole("button", { name: "更新事实", exact: true }).click();
  await page.getByRole("button", { name: "重渲染", exact: true }).click();
  await page.clock.runFor(1_850);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await expect(envelope).toHaveAttribute("data-entry-token", entryToken ?? "");
  await expect(envelope.locator(".prize")).toHaveText("+4.56 LDC");

  await page.getByRole("button", { name: "清理账号", exact: true }).click();
  await page.clock.runFor(320);
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await expect(envelope.locator(".claimed-result, .ended-stamp")).toHaveCount(
    0,
  );
});

for (const width of [1440, 375]) {
  test(`SVG clips the opening covers to its own viewport at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const envelope = await mountEnvelopeHarness(page, "activity", false, {
      rosterLabel: "领取名单",
    });
    await page.getByRole("button", { name: "确认领取", exact: true }).click();
    const geometry = () =>
      envelope.locator("svg").evaluate((svg) => {
        const clip = svg.querySelector("clipPath rect");
        const packet = svg.querySelector(".claimed-packet > g");
        const bounds = svg.getBoundingClientRect();
        return {
          viewBox: svg.getAttribute("viewBox"),
          mask: clip
            ? [
                clip.getAttribute("x"),
                clip.getAttribute("y"),
                clip.getAttribute("width"),
                clip.getAttribute("height"),
              ]
            : [],
          clipPath: packet?.getAttribute("clip-path"),
          overflow: getComputedStyle(svg).overflow,
          wrapperOverflow: getComputedStyle(svg.parentElement).overflow,
          width: bounds.width,
          height: bounds.height,
        };
      });
    for (const interval of [0, 16, 200, 450, 484, 640, 16]) {
      await page.clock.runFor(interval);
      const frame = await geometry();
      expect(frame.viewBox).toBe("0 0 420 560");
      expect(frame.mask).toEqual(["10", "8", "400", "544"]);
      expect(frame.clipPath).toMatch(/^url\(#rp-.*-packetClip\)$/);
      expect(frame.overflow).toBe("hidden");
      expect(frame.wrapperOverflow).toBe("hidden");
      expect(frame.width).toBe(210);
      expect(frame.height).toBe(280);
    }
    await expect(envelope).toHaveAttribute("data-phase", "open");
    const roster = envelope.getByRole("button", {
      name: "领取名单",
      exact: true,
    });
    await expect(roster).toBeEnabled();
    await roster.focus();
    await roster.press("Enter");
    await expect(page.locator("#roster-visits")).toHaveText("1");
  });
}

test("reduced motion directly shows the result and returns with a closed envelope", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const envelope = await mountEnvelopeHarness(page, "home", true);
  await page.getByRole("button", { name: "活动页", exact: true }).click();
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-animate", "false");
  await expect(envelope).toHaveAttribute("data-opening-count", "0");
  await expect(envelope.locator(".claimed-result, .ended-stamp")).toHaveCSS(
    "opacity",
    "1",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-opening-count", "0");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await expect(envelope.locator(".claimed-result, .ended-stamp")).toHaveCount(
    0,
  );
});

for (const width of [1440, 375]) {
  test(`home return keeps the closing endpoint continuous at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#activity?sample=history-random-active");
    const envelope = page.locator(
      '[data-route-presence="present"] [data-testid="envelope"]',
    );
    await expect(envelope).toHaveAttribute("data-entry-token", /.+/u);
    await expect(envelope).toHaveAttribute("data-phase", "opening");
    await expect(envelope.locator(".claimed-result")).toHaveCSS("opacity", "0");
    const openingAnimation = await envelope
      .locator(".open-upper")
      .evaluate((node) => getComputedStyle(node).animationName);
    expect(openingAnimation).toMatch(/upper-open/u);
    await expect(envelope).toHaveAttribute("data-phase", "open", {
      timeout: 3_000,
    });
    const samplesPromise = page.evaluate(() => {
      type Frame = {
        time: number;
        phase: string;
        stageTop: number;
        stageHeight: number;
        localTop: number;
        bodyTop: number;
        transformY: number;
        overflow: string;
        scrollTop: number;
      };
      return new Promise<Frame[]>((resolve) => {
        const frames: Frame[] = [];
        const started = performance.now();
        function sample() {
          const stage = document.querySelector<HTMLElement>(
            '[data-route-presence="present"] [data-testid="envelope"][data-size="small"]',
          );
          const body = stage?.querySelector<HTMLElement>(".envelope");
          if (stage && body) {
            const stageBox = stage.getBoundingClientRect();
            const bodyBox = body.getBoundingClientRect();
            const transform = getComputedStyle(body).transform;
            frames.push({
              time: performance.now() - started,
              phase: stage.dataset.phase ?? "",
              stageTop: stageBox.top,
              stageHeight: stageBox.height,
              localTop: body.offsetTop,
              bodyTop: bodyBox.top,
              transformY:
                transform === "none" ? 0 : new DOMMatrix(transform).m42,
              overflow: getComputedStyle(stage).overflow,
              scrollTop: document.querySelector("#main")?.scrollTop ?? 0,
            });
          }
          if (performance.now() - started < 850) requestAnimationFrame(sample);
          else resolve(frames);
        }
        requestAnimationFrame(sample);
      });
    });
    await page.getByRole("button", { name: "返回兑奖", exact: true }).click();
    const frames = await samplesPromise;
    const closing = frames.filter((frame) => frame.phase === "closing");
    const closed = frames.filter((frame) => frame.phase === "closed");
    expect(closing.length).toBeGreaterThan(2);
    expect(closed.length).toBeGreaterThan(4);
    expect(new Set(frames.map((frame) => frame.stageHeight))).toEqual(
      new Set([150]),
    );
    expect(new Set(frames.map((frame) => frame.localTop))).toEqual(
      new Set([frames[0].localTop]),
    );
    expect(new Set(frames.map((frame) => frame.overflow))).toEqual(
      new Set(["visible"]),
    );
    expect(new Set(frames.map((frame) => frame.scrollTop))).toEqual(
      new Set([0]),
    );
    const stageDrift =
      Math.max(...frames.map((frame) => frame.stageTop)) -
      Math.min(...frames.map((frame) => frame.stageTop));
    const closedDrift =
      Math.max(...closed.map((frame) => frame.bodyTop)) -
      Math.min(...closed.map((frame) => frame.bodyTop));
    expect(stageDrift).toBeLessThan(1);
    expect(
      closedDrift,
      "Closed paper must not start another layout shift",
    ).toBeLessThan(1.5);
    expect(Math.abs(closed.at(-1)?.transformY ?? Infinity)).toBeLessThan(0.1);
    await expect(envelope).toHaveAttribute("data-phase", "closed");
    await expect(envelope.locator(".claimed-result, .ended-stamp")).toHaveCount(
      0,
    );
    await expect(page.locator('[data-route-presence="exiting"]')).toHaveCount(
      0,
    );
    console.log(
      `Home return ${width}px: ${frames.length} frames, stage 150px, local top ${frames[0].localTop}px, stage drift ${stageDrift.toFixed(3)}px, closed drift ${closedDrift.toFixed(3)}px`,
    );
  });
}

for (const [kind, label] of [
  ["missed", "错过了"],
  ["not-won", "未中奖"],
  ["ended", "已结束"],
] as const) {
  test(`${kind} paper opens once on home navigation and stays static on direct entry`, async ({
    page,
  }) => {
    const envelope = await mountEnvelopeHarness(page, "home", true, {
      reward: { kind },
      rosterLabel: "中奖名单",
    });
    await page.getByRole("button", { name: "活动页", exact: true }).click();
    await expect(envelope).toHaveAttribute("data-phase", "closed");
    await expect(envelope).toHaveAttribute("data-animate", "false");
    await expect(envelope).toHaveAttribute("data-opening-count", "0");
    await page.clock.runFor(250);
    await expect(envelope).toHaveAttribute("data-phase", "closed");
    await page.clock.runFor(60);
    await expect(envelope).toHaveAttribute("data-phase", "opening");
    await expect(envelope).toHaveAttribute("data-opening-count", "1");
    await expect(
      envelope.locator(".claimed-result, .ended-stamp"),
    ).toContainText(label);
    await expect(envelope.locator(".prize")).toHaveCount(0);
    await expect(envelope.locator(".envelope-roster-link")).toBeDisabled();
    await page.clock.runFor(1790);
    await expect(envelope).toHaveAttribute("data-phase", "open");
    await expect(
      envelope.getByRole("button", { name: "中奖名单", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "重渲染", exact: true }).click();
    await page.clock.runFor(1_200);
    await expect(envelope).toHaveAttribute("data-opening-count", "1");
    await page.getByRole("button", { name: "首页", exact: true }).click();
    await expect(envelope).toHaveAttribute("data-phase", "closing");
    await expect(
      envelope.locator(".claimed-result, .ended-stamp"),
    ).toContainText(label);
    await page.clock.runFor(320);
    await expect(envelope).toHaveAttribute("data-phase", "closed");
    await expect(envelope.locator(".claimed-result, .ended-stamp")).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "直接查看", exact: true }).click();
    await page.clock.runFor(200);
    await expect(envelope).toHaveAttribute("data-phase", "open");
    await expect(envelope).toHaveAttribute("data-animate", "false");
    await expect(envelope).toHaveAttribute("data-opening-count", "0");
    await page.getByRole("button", { name: "确认领取", exact: true }).click();
    await page.clock.runFor(1850);
    await expect(envelope).toHaveAttribute("data-opening-count", "0");
    await expect(
      envelope.locator(".claimed-result, .ended-stamp"),
    ).toContainText(label);
    await expect(envelope.locator(".prize")).toHaveCount(0);
  });
}

test("non-winning paper skips presentation opening with reduced motion and ignores late navigation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const envelope = await mountEnvelopeHarness(page, "home", true, {
    reward: { kind: "not-won" },
  });
  await page.getByRole("button", { name: "活动页", exact: true }).click();
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-animate", "false");
  await expect(envelope).toHaveAttribute("data-opening-count", "0");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.runFor(1_200);
  await expect(envelope).toHaveAttribute("data-opening-count", "0");
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await page.clock.runFor(320);
  await page.getByRole("button", { name: "活动页", exact: true }).click();
  await page.clock.runFor(100);
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await page.clock.runFor(1_200);
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await expect(envelope.locator(".claimed-result, .ended-stamp")).toHaveCount(
    0,
  );
  await expect(page.locator('[data-route-presence="exiting"]')).toHaveCount(0);
  await page.getByRole("button", { name: "活动页", exact: true }).click();
  await page.clock.runFor(2_150);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await expect(envelope.locator(".claimed-result, .ended-stamp")).toContainText(
    "未中奖",
  );
  await expect(envelope.locator(".prize")).toHaveCount(0);
});

for (const width of [1440, 375]) {
  test(`non-winning activity moves, opens and returns continuously at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#home");
    const envelope = page.locator(
      '[data-route-presence="present"] [data-testid="envelope"]',
    );
    const capture = (milliseconds: number) =>
      page.evaluate(
        (duration) =>
          new Promise<
            {
              time: number;
              presence: string;
              size: string;
              phase: string;
              count: number;
              stageHeight: number;
              stageTop: number;
              localTop: number;
              bodyLeft: number;
              bodyTop: number;
              bodyWidth: number;
              paperY: number | null;
              scrollTop: number;
            }[]
          >((resolve) => {
            const frames: Parameters<typeof resolve>[0] = [];
            const start = performance.now();
            function sample() {
              for (const stage of document.querySelectorAll<HTMLElement>(
                ".route-frame .envelope-stage",
              )) {
                const body = stage.querySelector<HTMLElement>(".envelope");
                if (!body) continue;
                const stageBox = stage.getBoundingClientRect();
                const bodyBox = body.getBoundingClientRect();
                const paper = stage.querySelector<HTMLElement>(
                  ".claimed-result, .ended-stamp",
                );
                frames.push({
                  time: performance.now() - start,
                  presence:
                    stage.closest<HTMLElement>(".route-frame")?.dataset
                      .routePresence ?? "",
                  size: stage.dataset.size ?? "",
                  phase: stage.dataset.phase ?? "",
                  count: Number(stage.dataset.openingCount),
                  stageHeight: stageBox.height,
                  stageTop: stageBox.top,
                  localTop: body.offsetTop,
                  bodyLeft: bodyBox.left,
                  bodyTop: bodyBox.top,
                  bodyWidth: bodyBox.width,
                  paperY: paper
                    ? new DOMMatrix(getComputedStyle(paper).transform).m42
                    : null,
                  scrollTop: document.querySelector("#main")?.scrollTop ?? 0,
                });
              }
              if (performance.now() - start < duration)
                requestAnimationFrame(sample);
              else resolve(frames);
            }
            requestAnimationFrame(sample);
          }),
        milliseconds,
      );

    const enteringPromise = capture(2_450);
    await page.evaluate(() => {
      window.location.hash = "activity?sample=history-draw-not-won";
    });
    await page.waitForTimeout(250);
    const entering = (await enteringPromise).filter(
      (frame) => frame.presence === "present" && frame.size === "detail",
    );
    const moving = entering.filter((frame) => frame.phase === "closed");
    const opening = entering.filter((frame) => frame.phase === "opening");
    const opened = entering.filter((frame) => frame.phase === "open");
    expect(moving.length).toBeGreaterThan(2);
    expect(opening.length).toBeGreaterThan(10);
    expect(opened.length).toBeGreaterThan(2);
    expect(new Set(entering.map((frame) => frame.stageHeight))).toEqual(
      new Set([340]),
    );
    expect(new Set(moving.map((frame) => frame.count))).toEqual(new Set([0]));
    expect(
      new Set([...opening, ...opened].map((frame) => frame.count)),
    ).toEqual(new Set([1]));
    expect(moving[0].bodyWidth).toBeLessThan(150);
    expect(opened.at(-1)?.bodyWidth).toBeCloseTo(210, 0);
    const moveTime = opening[0].time - entering[0].time;
    const openingTime = opened[0].time - opening[0].time;
    expect(moveTime).toBeGreaterThanOrEqual(240);
    expect(moveTime).toBeLessThan(370);
    expect(openingTime).toBeGreaterThanOrEqual(1770);
    expect(openingTime).toBeLessThan(1910);
    const openingBoundary = Math.abs(
      opening[0].bodyTop - (moving.at(-1)?.bodyTop ?? Infinity),
    );
    expect(openingBoundary).toBeLessThan(12);
    await expect(envelope).toHaveAttribute("data-opening-count", "1");
    await expect(
      envelope.locator(".claimed-result, .ended-stamp"),
    ).toContainText("未中奖");
    await expect(envelope.locator(".prize")).toHaveCount(0);
    const facts = page.locator(
      '[data-route-presence="present"] .activity-page',
    );
    await expect(facts).toHaveAttribute("data-participation", "not-won");
    await expect(facts).toHaveAttribute("data-draw-progress", "completed");
    await expect(facts).toHaveAttribute("data-payment-progress", "none");

    const returningPromise = capture(850);
    await page.getByRole("button", { name: "返回兑奖", exact: true }).click();
    const returning = await returningPromise;
    const source = returning.filter(
      (frame) => frame.size === "detail" && frame.presence === "exiting",
    );
    const home = returning.filter(
      (frame) => frame.size === "small" && frame.presence === "present",
    );
    const closing = home.filter((frame) => frame.phase === "closing");
    const closed = home.filter((frame) => frame.phase === "closed");
    expect(source.length).toBeGreaterThan(2);
    expect(new Set(source.map((frame) => frame.stageHeight))).toEqual(
      new Set([340]),
    );
    expect(closing.length).toBeGreaterThan(2);
    expect(closed.length).toBeGreaterThan(4);
    expect(new Set(home.map((frame) => frame.stageHeight))).toEqual(
      new Set([150]),
    );
    expect(new Set(home.map((frame) => frame.localTop))).toEqual(
      new Set([home[0].localTop]),
    );
    expect(new Set(home.map((frame) => frame.scrollTop))).toEqual(new Set([0]));
    const stageDrift =
      Math.max(...home.map((frame) => frame.stageTop)) -
      Math.min(...home.map((frame) => frame.stageTop));
    const closedDrift =
      Math.max(...closed.map((frame) => frame.bodyTop)) -
      Math.min(...closed.map((frame) => frame.bodyTop));
    const closingBoundary = Math.abs(
      closed[0].bodyTop - (closing.at(-1)?.bodyTop ?? Infinity),
    );
    expect(stageDrift).toBeLessThan(1);
    expect(closedDrift).toBeLessThan(1.5);
    expect(closingBoundary).toBeLessThan(5);
    await expect(envelope).toHaveAttribute("data-phase", "closed");
    await expect(envelope.locator(".claimed-result, .ended-stamp")).toHaveCount(
      0,
    );
    await expect(page.locator('[data-route-presence="exiting"]')).toHaveCount(
      0,
    );
    const maxFrameStep = (frames: typeof entering) =>
      Math.max(
        ...frames
          .slice(1)
          .map((frame, index) =>
            Math.hypot(
              frame.bodyLeft - frames[index].bodyLeft,
              frame.bodyTop - frames[index].bodyTop,
            ),
          ),
      );
    console.log(
      `Non-winning ${width}px: entry ${entering.length} frames, move ${moveTime.toFixed(1)}ms + open ${openingTime.toFixed(1)}ms, max frame step ${maxFrameStep(entering).toFixed(3)}px, opening boundary ${openingBoundary.toFixed(3)}px; return ${home.length} frames, max frame step ${maxFrameStep(home).toFixed(3)}px, source height 340px, target height 150px, stage drift ${stageDrift.toFixed(3)}px, closing boundary ${closingBoundary.toFixed(3)}px, closed drift ${closedDrift.toFixed(3)}px`,
    );
  });
}

test("SVG has cream paper, a green amount and an accessible roster control", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page, "activity", false, {
    author: { name: "红包发起者", username: "author" },
    rosterLabel: "领取名单",
  });
  await page.getByRole("button", { name: "确认领取", exact: true }).click();
  await expect(envelope.locator(".envelope-roster-link")).toBeDisabled();
  await page.clock.runFor(1850);
  await expect(envelope.locator(".prize")).toHaveCSS(
    "fill",
    "rgb(22, 128, 69)",
  );
  expect(
    await envelope.locator('rect[fill="#f6efdf"]').count(),
  ).toBeGreaterThan(0);
  const roster = envelope.getByRole("button", {
    name: "领取名单",
    exact: true,
  });
  const accessible = await roster.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    );
    return {
      height: box.height,
      exposed: hit === button || button.contains(hit),
      parent: button.parentElement.className,
    };
  });
  expect(accessible.height).toBeGreaterThanOrEqual(44);
  expect(accessible.exposed).toBe(true);
  expect(accessible.parent).toBe("envelope-actions");
  await roster.click();
  await expect(page.locator("#roster-visits")).toHaveText("1");
});

test("only confirmed payment gets an accessible confirmation next to the amount", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page, "activity", true, {
    payment: { status: "confirmed", confirmedAt: "2026-10-06T03:52:10.000Z" },
    rosterLabel: "领取名单",
  });
  const confirmation = envelope.getByRole("button", {
    name: "已发放说明",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  expect(await envelope.locator(".prize").textContent()).toContain("3.28");
  await confirmation.click();
  const help = page.getByRole("dialog", {
    name: "已发放说明",
    exact: true,
  });
  await expect(help).toContainText("已发放");
  await expect(help.locator("time")).toHaveAttribute(
    "dateTime",
    "2026-10-06T03:52:10.000Z",
  );
});

test("pending payment keeps its amount without a confirmation mark", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page, "activity", true, {
    payment: { status: "pending" },
  });
  await expect(envelope.locator(".prize")).toHaveText("+3.28 LDC");
  await expect(envelope.locator(".payment-confirmation")).toHaveCount(0);
});

for (const width of [1440, 375]) {
  test(`long content keeps SVG, roster and payment help inside the page at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const envelope = await mountEnvelopeHarness(page, "activity", true, {
      author: {
        name: "这是一个需要截断但能够打开完整资料的很长发起者昵称",
        username: "long_author",
      },
      payment: { status: "confirmed", confirmedAt: "2026-10-06T03:52:10.000Z" },
      rosterLabel: "查看本场活动完整中奖名单",
    });
    const geometry = await envelope.evaluate((stage) => {
      const svg = stage.querySelector("svg");
      const roster = stage.querySelector(".envelope-roster-link");
      const bounds = svg.getBoundingClientRect();
      const action = roster.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        actionHeight: action.height,
        actionLeft: action.left,
        actionRight: action.right,
        viewport: window.innerWidth,
        pointerEvents: getComputedStyle(svg).pointerEvents,
      };
    });
    expect(geometry.width).toBe(210);
    expect(geometry.height).toBe(280);
    expect(geometry.pointerEvents).toBe("none");
    expect(geometry.actionHeight).toBeGreaterThanOrEqual(44);
    expect(geometry.actionLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.actionRight).toBeLessThanOrEqual(geometry.viewport);
    const roster = envelope.getByRole("button", {
      name: "查看本场活动完整中奖名单",
      exact: true,
    });
    await roster.focus();
    await roster.press("Enter");
    await expect(page.locator("#roster-visits")).toHaveText("1");
    await envelope
      .getByRole("button", { name: "已发放说明", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "已发放说明", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      envelope.getByRole("button", { name: "已发放说明", exact: true }),
    ).toBeFocused();
  });
}

test("private amount is withdrawn immediately on same-account session rotation", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page, "activity", true);
  await expect(envelope.locator(".prize")).toHaveText("+3.28 LDC");
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  await expect(
    envelope.locator(".prize,.claimed-time,.payment-confirmation"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await expect(envelope.locator(".prize,.claimed-time")).toHaveCount(0);
});

test("active aging uses the recorded read time at 10, 30 and 60 seconds", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page, "activity");
  const updatedAt = await envelope
    .locator("svg")
    .getAttribute("data-updated-at");
  await expect(envelope.locator(".patina-wash")).toHaveCSS("opacity", "0");
  await page.clock.runFor(11_000);
  await expect(envelope.locator(".freshness-warning")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(envelope.locator(".stale-prompt")).toHaveCSS("opacity", "0");
  await page.clock.runFor(20_000);
  await expect(envelope.locator(".stale-prompt")).toHaveCSS("opacity", "1");
  await expect(envelope.locator(".freshness-warning")).toHaveCSS(
    "opacity",
    "0",
  );
  await page.clock.runFor(30_000);
  await expect(envelope.locator(".patina-wash")).toHaveCSS("opacity", "0.5");
  await expect(envelope.locator("svg")).toHaveAttribute(
    "data-updated-at",
    updatedAt,
  );
  await page.getByRole("button", { name: "更新事实", exact: true }).click();
  await expect(envelope.locator(".patina-wash")).toHaveCSS("opacity", "0");
  await expect(envelope.locator(".data-row")).toHaveText("剩余 7 份");
});

test("shared input moves the editor, highlighted text and controls as one field", async ({
  page,
}) => {
  await mountEnvelopeHarness(page, "home", false, { withInput: true });
  const current = page.locator('[data-route-presence="present"]');
  const field = current.locator(".pw-input__field");
  const start = await field.boundingBox();
  if (!start) throw new Error("Source field missing");
  await page.getByRole("button", { name: "活动页", exact: true }).click();
  await page.clock.runFor(150);
  const positions = async () =>
    field.evaluate((element) => {
      const fieldBox = element.getBoundingClientRect();
      const textarea = element.querySelector("textarea");
      const count = element.querySelector(".pw-input__count");
      const mirror = element.querySelector(".pw-input__mirror");
      if (!textarea || !count || !mirror)
        throw new Error("Input layers missing");
      const relative = (child: Element) => {
        const box = child.getBoundingClientRect();
        return {
          x: (box.x - fieldBox.x) / fieldBox.width,
          y: (box.y - fieldBox.y) / fieldBox.height,
        };
      };
      return {
        x: fieldBox.x,
        y: fieldBox.y,
        textarea: relative(textarea),
        mirror: relative(mirror),
        count: relative(count),
      };
    });
  const moving = await positions();
  const exiting = page.locator('[data-route-presence="exiting"]');
  await expect(exiting.locator("textarea")).toHaveCount(0);
  expect(await exiting.textContent()).not.toContain("测试口令abc２０26");
  await expect(page.locator("textarea")).toHaveCount(1);
  await expect(field.locator(".pw-input__invalid")).toHaveCount(2);
  await page.clock.runFor(200);
  const final = await positions();
  expect(moving.x).toBeGreaterThan(start.x + 5);
  expect(moving.x).toBeLessThan(final.x - 5);
  expect(moving.y).toBeLessThan(final.y - 5);
  for (const layer of ["textarea", "mirror", "count"] as const) {
    expect(moving[layer].x).toBeCloseTo(final[layer].x, 1);
    expect(moving[layer].y).toBeCloseTo(final[layer].y, 1);
  }
  await expect(
    current.getByRole("textbox", { name: "转场口令", exact: true }),
  ).toHaveValue("测试口令abc２０26");
});
