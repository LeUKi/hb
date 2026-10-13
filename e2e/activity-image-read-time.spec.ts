import { expect, test } from "@playwright/test";

const activityId = "44444444-4444-4444-8444-444444444444";
const initialTime = "2026-10-09T00:00:00.000Z";
const personalReadTime = "2026-10-09T00:00:12.000Z";

test("私有图片使用参与事实读取时间，重绘及失败不重标，成功读取新事实才更新", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date(initialTime) });
  let releaseInitialRead = () => {};
  const initialRead = new Promise<void>((resolve) => {
    releaseInitialRead = resolve;
  });
  const state = {
    participationGets: 0,
    activityGets: 0,
    fail: false,
    registrationStatus: "registered",
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    if (path === "/api/session")
      return route.fulfill({
        json: {
          user: {
            id: "personal-image-viewer",
            username: "viewer",
            displayName: "本人读取时间测试",
            avatarUrl: null,
            accountTier: "standard",
            canUseLdc: true,
            loginProvider: "connect",
          },
          csrfToken: "csrf",
        },
      });
    if (path === `/api/activities/${activityId}`) {
      state.activityGets += 1;
      return route.fulfill({
        json: {
          activity: {
            id: activityId,
            title: "参与事实时间验收",
            rewardType: "ldc",
            status: "active",
            author: {
              id: "personal-image-author",
              username: "author",
              displayName: "活动作者",
              avatarUrl: null,
              accountTier: "standard",
            },
            participationMode: "direct",
            forceDedicated: true,
            topicUrl: null,
            openedAt: initialTime,
            deadlineAt: "2026-10-12T00:00:00.000Z",
            quantity: { mode: "exact", total: 4, claimed: 0, remaining: 4 },
            showRecipientList: false,
            showRecipientUsername: false,
            showRecipientTime: false,
            beforeInfo: "",
            afterEndInfo: "",
            reward: { mode: "fixed", totalAmount: "4.00", count: 4 },
            draw: {
              state: "waiting",
              deadlineAt: "2026-10-12T00:00:00.000Z",
              closedAt: null,
              reason: null,
              registeredCount: 1,
              winnerCount: 1,
            },
          },
        },
      });
    }
    if (path === `/api/activities/${activityId}/participation`) {
      state.participationGets += 1;
      if (state.participationGets === 1) await initialRead;
      if (state.fail)
        return route.fulfill({
          status: 500,
          json: { error: "参与记录读取失败。" },
        });
      return route.fulfill({
        json: {
          claim: null,
          registration: {
            id: "personal-image-registration",
            activity: {
              id: activityId,
              title: "参与事实时间验收",
              status: "active",
            },
            registeredAt: initialTime,
            drawAt: "2026-10-12T00:00:00.000Z",
            status: state.registrationStatus,
            claim: null,
          },
        },
      });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto(`/activities/${activityId}`);
  await expect.poll(() => state.participationGets).toBe(1);
  await page.clock.setSystemTime(new Date(personalReadTime));
  releaseInitialRead();
  const image = page.locator(".envelope-svg svg");
  await expect(image).toHaveAttribute("data-state", "registered");
  const firstReadAt = (await image.getAttribute("data-updated-at")) ?? "";
  expect(Date.parse(firstReadAt)).toBeGreaterThanOrEqual(
    Date.parse(personalReadTime),
  );
  const visibleReadTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(firstReadAt));
  await expect(image.locator(".snapshot-time")).toContainText(visibleReadTime);

  await page.clock.runFor(2_000);
  await expect(image).toHaveAttribute("data-updated-at", firstReadAt);
  expect(state.participationGets).toBe(1);

  state.fail = true;
  await page.clock.runFor(15_000);
  await expect.poll(() => state.participationGets).toBe(2);
  await expect(
    page.getByText("刷新失败，当前内容已保留。", { exact: true }),
  ).toBeVisible();
  await expect(image).toHaveAttribute("data-state", "registered");
  await expect(image).toHaveAttribute("data-updated-at", firstReadAt);
  expect(state.activityGets).toBeGreaterThan(1);

  state.fail = false;
  state.registrationStatus = "drawing";
  await page.clock.runFor(15_000);
  await expect.poll(() => state.participationGets).toBe(3);
  await expect(image).toHaveAttribute("data-state", "drawing");
  const newReadAt = await image.getAttribute("data-updated-at");
  expect(Date.parse(newReadAt ?? "")).toBeGreaterThan(Date.parse(firstReadAt));
  await expect(
    page.getByText("刷新失败，当前内容已保留。", { exact: true }),
  ).toHaveCount(0);
  await page.clock.runFor(1_000);
  await expect(image).toHaveAttribute("data-updated-at", newReadAt ?? "");
  expect(state.participationGets).toBe(3);
});
