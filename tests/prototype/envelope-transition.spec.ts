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
      | { kind: "text" | "missed" | "not-won" | "ended" };
    author?: { name: string; username: string; color?: string };
    payment?: { status: string; confirmedAt?: string };
    rosterLabel?: string;
    withInput?: boolean;
    timestampedNavigation?: boolean;
    reserveResultSpace?: boolean;
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
      const { RedemptionTransitionProvider, RedemptionRouteFrame } =
        await import(modules.transitionModule);
      const target = document.getElementById("root");
      if (!target) throw new Error("Prototype root missing");
      target.style.cssText =
        "display:block;position:fixed;inset:20px;overflow:auto";
      const h = React.createElement;
      const reward = modules.options.reward ?? { kind: "ldc", amount: "3.28" };
      let revision = 0;
      function Harness() {
        const [route, setRoute] = React.useState(modules.initial);
        const [open, setOpen] = React.useState(modules.hasReward);
        const [token, setToken] = React.useState(null);
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
                ? reward
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
                    h(Envelope, {
                      open: route === "activity" && open,
                      reward: route === "activity" && open ? reward : undefined,
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

test("home and activity use the same fold geometry and proportional illustration", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page);
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  const geometry = async () =>
    envelope.evaluate((stage) => {
      const body = stage.querySelector(".envelope");
      const flap = stage.querySelector(".envelope-flap");
      const front = stage.querySelector(".envelope-front");
      if (!body || !flap || !front) throw new Error("Envelope fold missing");
      const css = getComputedStyle(body);
      return {
        width: Number.parseFloat(css.width),
        height: Number.parseFloat(css.height),
        flap: getComputedStyle(flap).clipPath,
        front: getComputedStyle(front).clipPath,
        tags: [...body.children].map((child) => child.className),
      };
    });
  const home = await geometry();
  expect(home.width).toBe(104);
  await page.getByRole("button", { name: "直接查看", exact: true }).click();
  await page.clock.runFor(180);
  const detail = await geometry();
  expect(detail.width).toBe(210);
  expect(detail.width / detail.height).toBeCloseTo(home.width / home.height, 3);
  expect(detail.flap).toEqual(home.flap);
  expect(detail.front).toEqual(home.front);
  expect(detail.tags).toEqual(home.tags);
});

test("confirmed rewards open once with a complete flap and slip animation", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page, "activity");
  await page.getByRole("button", { name: "确认领取", exact: true }).click();
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await page.clock.runFor(250);
  const earlyFlap = await envelope
    .locator(".envelope-flap")
    .evaluate((el) => getComputedStyle(el).transform);
  const earlySlip = await envelope
    .locator(".reward-slip")
    .evaluate((el) => getComputedStyle(el).transform);
  await page.clock.runFor(600);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope.locator(".reward-slip")).toHaveCSS("opacity", "1");
  const finalFlap = await envelope
    .locator(".envelope-flap")
    .evaluate((el) => getComputedStyle(el).transform);
  const finalSlip = await envelope
    .locator(".reward-slip")
    .evaluate((el) => getComputedStyle(el).transform);
  expect(
    await envelope
      .locator(".reward-slip")
      .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42),
  ).toBeCloseTo(-70, 1);
  expect(earlyFlap).not.toEqual(finalFlap);
  expect(earlySlip).not.toEqual(finalSlip);
  await page.getByRole("button", { name: "重渲染", exact: true }).click();
  await page.clock.runFor(1_000);
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await expect(envelope.locator(".slip-amount")).toHaveText("+3.28");
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
  await page.clock.runFor(850);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await expect(envelope).toHaveAttribute("data-size", "small");
  await expect(envelope).toHaveAttribute("data-open", "false");
  await expect(envelope).toHaveAttribute("data-phase", "closing");
  await expect(envelope.locator(".reward-slip")).toHaveCount(1);
  await page.clock.runFor(150);
  await expect(envelope.locator(".reward-slip")).toHaveCount(1);
  await page.clock.runFor(170);
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await expect(envelope.locator(".reward-slip")).toHaveCount(0);
});

for (const { width, confirmationDelay } of [
  { width: 1440, confirmationDelay: 120 },
  { width: 375, confirmationDelay: 550 },
]) {
  test(`timestamped navigation keeps pending geometry and opens for 800ms after a ${confirmationDelay}ms confirmation at ${width}px`, async ({
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
    await page.clock.runFor(790);
    await expect(envelope).toHaveAttribute("data-phase", "opening");
    await page.clock.runFor(10);
    await expect(envelope).toHaveAttribute("data-phase", "open");
    await expect(envelope.locator(".slip-amount")).toHaveText("+3.28");
    expect(await geometry()).toEqual(pending);
    await page.getByRole("button", { name: "重渲染", exact: true }).click();
    await page.clock.runFor(1_000);
    await expect(envelope).toHaveAttribute("data-opening-count", "1");
  });
}

test("rapid navigation cancels late opening callbacks and direct history stays static", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page, "home", true);
  await page.getByRole("button", { name: "活动页", exact: true }).click();
  await page.clock.runFor(100);
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await page.clock.runFor(1_200);
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await expect(envelope).toHaveAttribute("data-opening-count", "0");
  await expect(page.locator('[data-route-presence="exiting"]')).toHaveCount(0);
  await page.getByRole("button", { name: "直接查看", exact: true }).click();
  await page.clock.runFor(200);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-animate", "false");
  await expect(envelope).toHaveAttribute("data-opening-count", "0");
  await page.getByRole("button", { name: "清理账号", exact: true }).click();
  await page.clock.runFor(320);
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await expect(envelope.locator(".reward-slip")).toHaveCount(0);
});

for (const width of [1440, 375]) {
  test(`paper and shadow stay clipped at the body bottom on every opening and closing frame at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const envelope = await mountEnvelopeHarness(page, "activity", false, {
      author: { name: "红包发起者", username: "author", color: "sage" },
      rosterLabel: "领取名单",
    });
    await page.getByRole("button", { name: "确认领取", exact: true }).click();
    await expect(envelope).toHaveAttribute("data-phase", "opening");
    await envelope.locator(".envelope-paper-clip").evaluate((clip) => {
      for (const [name, top] of [
        ["above", "-75%"],
        ["below", "calc(100% + 8px)"],
      ]) {
        const probe = document.createElement("span");
        probe.dataset.clipProbe = name;
        probe.setAttribute("aria-hidden", "true");
        probe.style.cssText = `position:absolute;top:${top};left:50%;width:8px;height:6px;pointer-events:auto;z-index:10`;
        clip.append(probe);
      }
    });
    // An unclipped control must hit the lower probe; otherwise an ancestor or
    // inert layer could make the clipping assertions pass without a real mask.
    const sensitive = await envelope
      .locator(".envelope-paper-clip")
      .evaluate((clip) => {
        const probe = clip.querySelector<HTMLElement>(
          '[data-clip-probe="below"]',
        );
        if (!probe) throw new Error("Paper clipping probe missing");
        const previous = (clip as HTMLElement).style.clipPath;
        (clip as HTMLElement).style.clipPath = "none";
        const bounds = probe.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        (clip as HTMLElement).style.clipPath = previous;
        return hit === probe;
      });
    expect(sensitive).toBe(true);
    const sample = () =>
      envelope.evaluate((stage) => {
        const body = stage.querySelector<HTMLElement>(".envelope");
        const clip = stage.querySelector<HTMLElement>(".envelope-paper-clip");
        const paper = stage.querySelector<HTMLElement>(".reward-slip");
        if (!body || !clip || !paper) throw new Error("Paper layer missing");
        const hitProbe = (name: string) => {
          const probe = clip.querySelector<HTMLElement>(
            `[data-clip-probe="${name}"]`,
          );
          if (!probe) throw new Error("Paper clipping probe missing");
          const bounds = probe.getBoundingClientRect();
          return (
            document.elementFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2,
            ) === probe
          );
        };
        const bodyBox = body.getBoundingClientRect();
        return {
          aboveHit: hitProbe("above"),
          belowHit: hitProbe("below"),
          clipPath: getComputedStyle(clip).clipPath,
          bodyClip: getComputedStyle(body).clipPath,
          stageClip: getComputedStyle(stage).clipPath,
          clipBottom: clip.getBoundingClientRect().bottom - bodyBox.bottom,
          overflow: paper.getBoundingClientRect().bottom - bodyBox.bottom,
          opacity: Number(getComputedStyle(paper).opacity),
          shadow: getComputedStyle(paper).boxShadow,
          containsFlap: clip.contains(stage.querySelector(".envelope-flap")),
          containsAuthor: clip.contains(
            stage.querySelector(".envelope-author"),
          ),
        };
      });
    let sampledFrames = 0;
    let visibleOverflowFrames = 0;
    let maxOverflow = 0;
    const checkFrame = async () => {
      const frame = await sample();
      sampledFrames++;
      if (frame.opacity > 0.05 && frame.overflow > 0) visibleOverflowFrames++;
      maxOverflow = Math.max(maxOverflow, frame.overflow);
      expect(frame.aboveHit).toBe(true);
      expect(frame.belowHit).toBe(false);
      expect(frame.clipPath).not.toBe("none");
      expect(frame.bodyClip).toBe("none");
      expect(frame.stageClip).toBe("none");
      expect(Math.abs(frame.clipBottom)).toBeLessThan(0.1);
      expect(frame.shadow).not.toBe("none");
      expect(frame.containsFlap).toBe(false);
      expect(frame.containsAuthor).toBe(false);
    };
    for (let frame = 0; frame < 50; frame++) {
      await page.clock.runFor(16);
      await checkFrame();
    }
    await expect(envelope).toHaveAttribute("data-phase", "open");
    const roster = envelope.getByRole("button", {
      name: "领取名单",
      exact: true,
    });
    await roster.focus();
    await expect(roster).toBeFocused();
    await expect(roster).toBeEnabled();
    await roster.click();
    await expect(page.locator("#roster-visits")).toHaveText("1");
    await page.getByRole("button", { name: "清理账号", exact: true }).click();
    await expect(envelope).toHaveAttribute("data-phase", "closing");
    for (let frame = 0; frame < 17; frame++) {
      await page.clock.runFor(16);
      await checkFrame();
    }
    expect(visibleOverflowFrames).toBeGreaterThan(2);
    await page.clock.runFor(32);
    await expect(envelope).toHaveAttribute("data-phase", "closed");
    await expect(envelope.locator(".envelope-paper-clip")).toHaveCount(0);
    console.log(
      `Paper clipping ${width}px: ${sampledFrames} frame samples, ${visibleOverflowFrames} visible overflow frames, max raw paper overflow ${maxOverflow.toFixed(2)}px; lower probes always clipped, upper probes exposed, mask bottom drift <0.1px`,
    );
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
  await expect(envelope.locator(".reward-slip")).toHaveCSS("opacity", "1");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-opening-count", "0");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await expect(envelope.locator(".reward-slip")).toHaveCount(0);
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
    await expect(envelope).toHaveAttribute("data-phase", "open");
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
    await expect(envelope.locator(".reward-slip")).toHaveCount(0);
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
    await expect(envelope.locator(".reward-slip")).toContainText(label);
    await expect(envelope.locator(".slip-amount")).toHaveCount(0);
    await expect(envelope.locator(".envelope-roster-link")).toBeDisabled();
    await page.clock.runFor(790);
    await expect(envelope).toHaveAttribute("data-phase", "open");
    await expect(
      envelope.getByRole("button", { name: "中奖名单", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "重渲染", exact: true }).click();
    await page.clock.runFor(1_200);
    await expect(envelope).toHaveAttribute("data-opening-count", "1");
    await page.getByRole("button", { name: "首页", exact: true }).click();
    await expect(envelope).toHaveAttribute("data-phase", "closing");
    await expect(envelope.locator(".reward-slip")).toContainText(label);
    await page.clock.runFor(320);
    await expect(envelope).toHaveAttribute("data-phase", "closed");
    await expect(envelope.locator(".reward-slip")).toHaveCount(0);
    await page.getByRole("button", { name: "直接查看", exact: true }).click();
    await page.clock.runFor(200);
    await expect(envelope).toHaveAttribute("data-phase", "open");
    await expect(envelope).toHaveAttribute("data-animate", "false");
    await expect(envelope).toHaveAttribute("data-opening-count", "0");
    await page.getByRole("button", { name: "确认领取", exact: true }).click();
    await page.clock.runFor(850);
    await expect(envelope).toHaveAttribute("data-opening-count", "0");
    await expect(envelope.locator(".reward-slip")).toContainText(label);
    await expect(envelope.locator(".slip-amount")).toHaveCount(0);
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
  await expect(envelope.locator(".reward-slip")).toHaveCount(0);
  await expect(page.locator('[data-route-presence="exiting"]')).toHaveCount(0);
  await page.getByRole("button", { name: "活动页", exact: true }).click();
  await page.clock.runFor(1_150);
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  await expect(envelope.locator(".reward-slip")).toContainText("未中奖");
  await expect(envelope.locator(".slip-amount")).toHaveCount(0);
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
                const paper = stage.querySelector<HTMLElement>(".reward-slip");
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

    const enteringPromise = capture(1_350);
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
    expect(openingTime).toBeGreaterThanOrEqual(770);
    expect(openingTime).toBeLessThan(870);
    expect(opened.at(-1)?.paperY).toBeCloseTo(-70, 1);
    const openingBoundary = Math.abs(
      opening[0].bodyTop - (moving.at(-1)?.bodyTop ?? Infinity),
    );
    expect(openingBoundary).toBeLessThan(12);
    await expect(envelope).toHaveAttribute("data-opening-count", "1");
    await expect(envelope.locator(".reward-slip")).toContainText("未中奖");
    await expect(envelope.locator(".slip-amount")).toHaveCount(0);
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
    await expect(envelope.locator(".reward-slip")).toHaveCount(0);
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

test("reward paper has readable colors, author identity and an accessible exposed roster action", async ({
  page,
}) => {
  const envelope = await mountEnvelopeHarness(page, "activity", false, {
    author: { name: "红包发起者", username: "author", color: "sage" },
    rosterLabel: "领取名单",
  });
  await expect(
    envelope.getByRole("button", { name: "红包发起者", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认领取", exact: true }).click();
  await expect(envelope.locator(".envelope-roster-link")).toBeDisabled();
  await page.clock.runFor(850);
  const roster = envelope.getByRole("button", {
    name: "领取名单",
    exact: true,
  });
  await expect(roster).toBeEnabled();
  await expect(envelope.locator(".reward-slip")).toHaveCSS(
    "background-color",
    "rgb(244, 220, 162)",
  );
  await expect(envelope.locator(".slip-amount")).toHaveCSS(
    "color",
    "rgb(140, 43, 36)",
  );
  const buttonIsExposed = await roster.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    );
    return button === hit || button.contains(hit);
  });
  expect(
    buttonIsExposed,
    "Roster button must be above the envelope folds",
  ).toBe(true);
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
  expect(await envelope.locator(".slip-value").textContent()).toContain("3.28");
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
  await expect(envelope.locator(".slip-amount")).toHaveText("+3.28");
  await expect(envelope.locator(".payment-confirmation")).toHaveCount(0);
});

for (const width of [1440, 375]) {
  test(`compact open envelope preserves the full roster action and stacked author at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const name = "这是一个需要截断但能够打开完整资料的很长发起者昵称";
    const envelope = await mountEnvelopeHarness(page, "activity", true, {
      author: { name, username: "long_author", color: "sage" },
      payment: {
        status: "confirmed",
        confirmedAt: "2026-10-06T03:52:10.000Z",
      },
      rosterLabel: "查看本场活动完整中奖名单",
    });
    await expect(envelope).toHaveAttribute("data-phase", "open");
    const roster = envelope.getByRole("button", {
      name: "查看本场活动完整中奖名单",
      exact: true,
    });
    await roster.focus();
    const geometry = await envelope.evaluate((stage) => {
      const body = stage.querySelector<HTMLElement>(".envelope");
      const flap = stage.querySelector<HTMLElement>(".envelope-flap");
      const paper = stage.querySelector<HTMLElement>(".reward-slip");
      const author = stage.querySelector<HTMLElement>(
        ".envelope-author .user-identity",
      );
      const roster = stage.querySelector<HTMLElement>(".envelope-roster-link");
      const avatar = author?.querySelector<HTMLElement>(".avatar");
      const nickname = author?.lastElementChild;
      if (
        !body ||
        !flap ||
        !paper ||
        !author ||
        !roster ||
        !avatar ||
        !nickname
      )
        throw new Error("Envelope content missing");
      const stageBox = stage.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      const flapBox = flap.getBoundingClientRect();
      const paperBox = paper.getBoundingClientRect();
      const rosterBox = roster.getBoundingClientRect();
      const avatarBox = avatar.getBoundingClientRect();
      const nicknameBox = nickname.getBoundingClientRect();
      const foldY = rosterBox.bottom + 4 - bodyBox.top;
      const sideWidth =
        bodyBox.width *
        0.6 *
        Math.max(0, (foldY - bodyBox.height * 0.05) / (bodyBox.height * 0.53));
      const hits = [
        [rosterBox.left + 3, rosterBox.top + 3],
        [rosterBox.right - 3, rosterBox.top + 3],
        [rosterBox.left + 3, rosterBox.bottom - 3],
        [rosterBox.right - 3, rosterBox.bottom - 3],
      ].map(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === roster || roster.contains(hit);
      });
      return {
        stageHeight: stageBox.height,
        flapClearance: flapBox.top - stageBox.top,
        bodyClearance: stageBox.bottom - bodyBox.bottom,
        paperOffset: paperBox.top - bodyBox.top,
        rosterHeight: rosterBox.height,
        rosterClearanceLeft: rosterBox.left - 4 - (bodyBox.left + sideWidth),
        rosterClearanceRight: bodyBox.right - sideWidth - (rosterBox.right + 4),
        hits,
        pointerEvents: [
          ".envelope-back",
          ".envelope-front",
          ".envelope-flap",
          ".envelope-seal",
        ].map((selector) => {
          const layer = stage.querySelector(selector);
          return layer ? getComputedStyle(layer).pointerEvents : "missing";
        }),
        avatarWidth: avatarBox.width,
        avatarCenter: avatarBox.left + avatarBox.width / 2,
        nicknameCenter: nicknameBox.left + nicknameBox.width / 2,
        bodyCenter: bodyBox.left + bodyBox.width / 2,
        authorGap: nicknameBox.top - avatarBox.bottom,
        nicknameTruncated: nickname.scrollWidth > nickname.clientWidth,
      };
    });
    expect(geometry.stageHeight).toBe(340);
    expect(geometry.flapClearance).toBeGreaterThanOrEqual(0);
    expect(geometry.bodyClearance).toBeGreaterThanOrEqual(0);
    expect(geometry.paperOffset).toBeCloseTo(-70, 1);
    expect(geometry.rosterHeight).toBeGreaterThanOrEqual(44);
    expect(geometry.rosterClearanceLeft).toBeGreaterThan(0);
    expect(geometry.rosterClearanceRight).toBeGreaterThan(0);
    expect(geometry.hits).toEqual([true, true, true, true]);
    expect(geometry.pointerEvents).toEqual(["none", "none", "none", "none"]);
    expect(geometry.avatarWidth).toBeCloseTo(28, 1);
    expect(geometry.avatarCenter).toBeCloseTo(geometry.bodyCenter, 1);
    expect(geometry.nicknameCenter).toBeCloseTo(geometry.bodyCenter, 1);
    expect(geometry.authorGap).toBeCloseTo(6, 1);
    expect(geometry.nicknameTruncated).toBe(true);
    await roster.click();
    await expect(page.locator("#roster-visits")).toHaveText("1");
    const author = envelope.getByRole("button", { name, exact: true });
    await roster.press("Tab");
    await expect(author).toBeFocused();
    const profile = page.getByRole("dialog", { name: "用户资料", exact: true });
    await expect(profile).toBeVisible();
    await expect(profile).toContainText(name);
    await page.keyboard.press("Escape");
    await expect(profile).toHaveCount(0);
    await expect(author).toBeFocused();
  });
}

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
