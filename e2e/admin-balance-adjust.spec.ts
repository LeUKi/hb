import { expect, test } from "@playwright/test";
import type {
  AdminCursorList,
  AdminUserDetail,
  AdminUserListItem,
} from "../packages/contracts/src";
import {
  csrfToken,
  type MockUser,
  mockSession,
  openApp,
  viewer,
} from "./support/app";

// 网站管理 · 用户 · 调整🐟额 against a mocked admin API (sweep 2026-11-21
// ADM-4): a 补加 whose answer never came may have been written, so the
// same 补加 again, even after closing the dialog and opening it again, is
// the very same request (one requestId, which the server answers once);
// the 🐟额 reads again after the failure; a new 补加 is a new request.

const admin: MockUser = {
  ...viewer,
  id: "admin-e2e",
  username: "admin",
  displayName: "测试管理员",
  isAdmin: true,
};

const hour = 3_600_000;

const member: AdminUserListItem = {
  id: "user-adjust",
  externalId: "1003",
  username: "xiaoman",
  displayName: "小满",
  avatarUrl: null,
  active: true,
  admin: false,
  createdAt: Date.now() - 48 * hour,
  lastLoginAt: Date.now() - hour,
  trustLevel: 2,
  silenced: false,
  profileSeenAt: Date.now() - hour,
  fish: null,
  plus: false,
};

type Sent = {
  requestId: string;
  direction: string;
  amount: string;
  reason: string;
};

test("调整🐟额：没收到结果时，关掉再打开、再按一次还是同一个请求；新的一笔才换请求", async ({
  page,
}) => {
  await mockSession(page, admin);
  await page.route(
    (url) => url.pathname === "/api/admin/users",
    (route) =>
      route.fulfill({
        json: {
          items: [member],
          nextCursor: null,
          readAt: Date.now(),
          total: 1,
        } satisfies AdminCursorList<AdminUserListItem>,
      }),
  );
  await page.route(
    (url) => url.pathname === `/api/admin/users/${member.id}`,
    (route) =>
      route.fulfill({
        json: {
          user: {
            ...member,
            counts: {
              authoredActivities: 0,
              claims: 0,
              registrations: 0,
              merchants: 0,
              paymentTasks: 0,
            },
            amounts: { sent: "0.00", received: "0.00" },
            tips: {
              cards: [],
              received: { count: 0, amountMinor: 0 },
              given: 0,
            },
          } satisfies AdminUserDetail,
        },
      }),
  );
  const sent: Sent[] = [];
  let reads = 0;
  await page.route(
    (url) => url.pathname.startsWith("/api/admin/balance/"),
    (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === `/api/admin/balance/users/${member.id}/adjustments`) {
        expect(request.headers()["x-csrf-token"]).toBe(csrfToken);
        sent.push(request.postDataJSON() as Sent);
        // The first one is written, but its answer is lost on the way.
        if (sent.length === 1) return route.abort("failed");
        return route.fulfill({
          json: {
            adjustment: {
              id: `adjustment-${sent.length}`,
              userId: member.id,
              direction: "add",
              amountMinor: 500,
              reason: "活动补发",
              createdAt: Date.now(),
            },
          },
        });
      }
      if (path === `/api/admin/balance/users/${member.id}`) {
        reads += 1;
        return route.fulfill({
          json: {
            account: { availableMinor: 0, lockedMinor: 0 },
            member: null,
            apiKeys: [],
            invitedCount: 0,
            items: [],
            nextCursor: null,
          },
        });
      }
      return route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "未找到" } },
      });
    },
  );

  await openApp(page, "/admin/users");
  await page.getByRole("button", { name: /小满/ }).click();
  const pane = page.getByRole("complementary", { name: "详情" });
  await pane.getByRole("button", { name: "调整🐟额" }).click();
  const adjust = page.getByRole("dialog", { name: "调整🐟额" });
  await adjust.getByLabel("数量").fill("5");
  await adjust.getByLabel("原因").fill("活动补发");
  const readsBefore = reads;
  await adjust.getByRole("button", { name: "补加" }).last().click();
  await expect(
    adjust.getByText(/没有收到结果，这笔调整可能已经记上了/),
  ).toBeVisible();
  // The 🐟额 reads again, to show whether it was written.
  await expect.poll(() => reads).toBeGreaterThan(readsBefore);

  // Closed and opened again: the same 补加, with what was said about it.
  await adjust.getByRole("button", { name: "返回" }).click();
  await expect(adjust).toHaveCount(0);
  await pane.getByRole("button", { name: "调整🐟额" }).click();
  await expect(adjust.getByLabel("数量")).toHaveValue("5");
  await expect(
    adjust.getByText(/没有收到结果，这笔调整可能已经记上了/),
  ).toBeVisible();
  await adjust.getByRole("button", { name: "补加" }).last().click();
  await expect(adjust).toHaveCount(0);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);

  // A new 补加 afterwards is a new request.
  await pane.getByRole("button", { name: "调整🐟额" }).click();
  await expect(adjust.getByLabel("数量")).toHaveValue("");
  await adjust.getByLabel("数量").fill("5");
  await adjust.getByLabel("原因").fill("活动补发");
  await adjust.getByRole("button", { name: "补加" }).last().click();
  await expect(adjust).toHaveCount(0);
  expect(sent).toHaveLength(3);
  expect(sent[2]?.requestId).not.toBe(sent[0]?.requestId);
});
