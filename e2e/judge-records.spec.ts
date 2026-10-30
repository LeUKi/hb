import { expect, type Page, test } from "@playwright/test";
import {
  emptyActivityInput,
  encodeActivityEmoji,
  type JudgeRecordFacts,
  type JudgeRecordList,
  type JudgeRecordPeople,
  type ManagedActivity,
  type PublicActivity,
} from "../packages/contracts/src";
import { type MockUser, mockSession, openApp } from "./support/app";

// 判定记录 (docs/judge-records-design.md): a 代码判定红包's 尝试统计 — the
// timeline with failures among it, 按人 and one person's whole record,
// 按内容 as before — for its sender.

const id = "99999999-8888-4777-8666-555555555555";
const code = encodeActivityEmoji(id);
const author: MockUser = {
  id: "author-e2e",
  username: "author",
  displayName: "小满",
  avatarUrl: null,
  isAdmin: false,
};
const openedAt = new Date(Date.now() - 3_600_000).toISOString();
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const xiaoming = {
  id: "11111111-2222-4333-8444-555555555555",
  username: "xiaoming",
  displayName: "小明",
  avatarUrl: null,
};
const xiaohong = {
  id: "66666666-7777-4888-8999-000000000000",
  username: "xiaohong",
  displayName: "小红",
  avatarUrl: null,
};

function publicActivity(): PublicActivity {
  return {
    id,
    title: "猜数字",
    rewardType: "ldc",
    participationMode: "code",
    status: "active",
    author: { ...author, avatarUrl: null },
    forceDedicated: true,
    topicUrl: null,
    openedAt,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    quantity: { mode: "exact", total: 3, claimed: 1, remaining: 2 },
    beforeInfo: "",
    judge: {
      protocol: 4,
      prompt: "猜 1 到 100",
      seedCommitment: "a".repeat(64),
      judged: 3,
    },
  } as PublicActivity;
}

const timeline: JudgeRecordList["items"] = [
  {
    kind: "judged",
    at: minutesAgo(1),
    user: { ...xiaohong, level: 2 },
    attempt: 2,
    input: "42",
    claimed: true,
    amount: "0.50",
    asked: "0.80",
    note: "cap",
    message: "猜对了",
    announce: "小红猜中了",
  },
  {
    kind: "failed",
    at: minutesAgo(2),
    user: { ...xiaoming, level: 1 },
    failure: "threw",
    detail: "炸了",
  },
  {
    kind: "judged",
    at: minutesAgo(3),
    user: { ...xiaohong, level: 2 },
    attempt: 1,
    input: "50",
    claimed: false,
    message: "大了",
  },
];

async function mockRecords(page: Page) {
  const asked: string[] = [];
  let facts: JudgeRecordFacts = {
    judged: 2,
    people: 2,
    claimedPeople: 1,
    paid: "0.50",
    failed: 1,
  };
  await mockSession(page, author);
  await page.route(`**/api/activities/${id}`, (route) =>
    route.fulfill({ json: { activity: publicActivity() } }),
  );
  await page.route(`**/api/me/activities/${id}`, (route) =>
    route.fulfill({
      json: {
        activity: {
          id,
          title: "猜数字",
          rewardType: "ldc",
          participationMode: "code",
          forceDedicated: true,
          status: "active",
          version: 2,
          createdAt: openedAt,
          openedAt,
          deadlineAt: publicActivity().deadlineAt,
          topicUrl: null,
          totalCount: 3,
          claimedCount: 1,
          author: publicActivity().author,
          config: {
            ...emptyActivityInput(),
            title: "猜数字",
            forceDedicated: true,
            participationMode: "code",
            funding: "balance",
          },
        } as ManagedActivity,
      },
    }),
  );
  await page.route(`**/api/me/activities/${id}/judge-facts`, (route) =>
    route.fulfill({ json: facts }),
  );
  await page.route(`**/api/me/activities/${id}/judge-timeline**`, (route) => {
    const filter = new URL(route.request().url()).searchParams.get("filter");
    asked.push(`timeline:${filter}`);
    const items = timeline.filter((item) =>
      filter === "failed"
        ? item.kind === "failed"
        : filter === "claimed"
          ? item.kind === "judged" && item.claimed
          : true,
    );
    return route.fulfill({ json: { items, nextCursor: null } });
  });
  await page.route(`**/api/me/activities/${id}/judge-people**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/judge-people/${xiaohong.id}`)) {
      asked.push("person");
      return route.fulfill({
        json: {
          items: [...timeline]
            .reverse()
            .filter((item) => item.user.id === xiaohong.id),
          nextCursor: null,
        } satisfies JudgeRecordList,
      });
    }
    asked.push(`people:${url.searchParams.get("sort")}`);
    return route.fulfill({
      json: {
        items: [
          { user: xiaohong, judged: 2, amount: "0.50", lastAt: minutesAgo(1) },
          { user: xiaoming, judged: 1, lastAt: minutesAgo(2) },
        ],
        nextCursor: null,
      } satisfies JudgeRecordPeople,
    });
  });
  await page.route(`**/api/me/activities/${id}/statistics**`, (route) =>
    route.fulfill({
      json: {
        totalAttempts: 2,
        uniqueUsers: 1,
        matchedAttempts: 1,
        successfulClaims: 1,
        items: [
          {
            password: "50",
            attempts: 1,
            uniqueUsers: 1,
            matchedAttempts: 0,
            matchedUsers: 0,
            unmatchedAttempts: 1,
            successfulClaims: 0,
          },
        ],
        validPasswords: [],
        nextCursor: null,
      },
    }),
  );
  return {
    asked,
    setFacts: (next: JudgeRecordFacts) => {
      facts = next;
    },
  };
}

test.describe("判定记录", () => {
  test("代码判定红包的尝试统计是判定记录：四个数，时间线里判定和出错排在一起，筛选出错", async ({
    page,
  }) => {
    const { asked } = await mockRecords(page);
    await openApp(page, `/🧧/${code}/📊`);
    await expect(page).toHaveTitle("判定记录 · 猜数字 · lafish的红包站");
    await expect(
      page.getByRole("heading", { name: "判定记录", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("每一次提交和判定器的判定，只有你看得到。"),
    ).toBeVisible();
    for (const text of ["2 次", "2 人", "1 人", "发出 0.50 LDC"])
      await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
    const rows = page.locator("main li");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("第 2 次");
    await expect(rows.nth(0)).toContainText("42");
    await expect(rows.nth(0)).toContainText("判定器给 0.80，按上限发 0.50");
    await expect(rows.nth(0)).toContainText("回复：猜对了");
    await expect(rows.nth(0)).toContainText("动态：小红猜中了");
    await expect(rows.nth(1)).toContainText("出错：抛错 · 炸了");
    await expect(rows.nth(2)).toContainText("没领到");
    await page.getByRole("button", { name: "出错", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(page).toHaveURL(/[?&]filter=failed/);
    expect(asked).toContain("timeline:failed");
  });

  test("按人：每人一行，点开是这个人的全部，旧的在上；按内容同原来的提交的内容", async ({
    page,
  }) => {
    const { asked } = await mockRecords(page);
    await openApp(page, `/🧧/${code}/📊?tab=people`);
    await expect(page.getByText("提交 2 次")).toBeVisible();
    await expect(page.getByText("领到 0.50")).toBeVisible();
    await page.getByRole("button", { name: "提交多的" }).click();
    await expect.poll(() => asked).toContain("people:most");
    await page.getByRole("button", { name: /小红/ }).first().click();
    const dialog = page.getByRole("dialog", { name: /小红/ });
    await expect(dialog).toBeVisible();
    const items = dialog.locator("li");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("第 1 次");
    await expect(items.nth(1)).toContainText("第 2 次");
    await dialog.getByRole("button", { name: "关闭" }).click();
    await page.getByRole("button", { name: "按内容" }).click();
    await expect(
      page.getByText("按次数从多到少。发没发按那一次判定器的判定。"),
    ).toBeVisible();
    await expect(page.getByText("没发 1 次")).toBeVisible();
  });

  test("有新的提交时，时间线顶上写有 N 次新的提交，点了读最新的", async ({
    page,
  }) => {
    const { asked, setFacts } = await mockRecords(page);
    await page.clock.install();
    await openApp(page, `/🧧/${code}/📊`);
    await expect(page.locator("main li")).toHaveCount(3);
    setFacts({
      judged: 4,
      people: 2,
      claimedPeople: 1,
      paid: "0.50",
      failed: 1,
    });
    await page.clock.runFor(16_000);
    const fresh = page.getByRole("button", { name: "有 2 次新的提交" });
    await expect(fresh).toBeVisible();
    const before = asked.filter((item) => item === "timeline:all").length;
    await fresh.click();
    await expect
      .poll(() => asked.filter((item) => item === "timeline:all").length)
      .toBeGreaterThan(before);
    await expect(fresh).toBeHidden();
  });
});
