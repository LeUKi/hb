import { readFileSync } from "node:fs";
import {
  type ActivityProofData,
  encodeActivityEmoji,
  formatAmount,
} from "@hb/contracts";
import { expect, type Page, test } from "@playwright/test";
import vectors from "../packages/contracts/test/fixtures/draw-proof-v2.json";
import { expectPath, mockSession, openApp, viewer } from "./support/app";

// 开奖证明 (docs/draw-proof-design.md): the browser redoes a v2 红包's
// random parts from its public data and two drand nodes. The data here is
// the shared test vectors, so the check really runs.

const vector = vectors.draws[0];
const queueVector = vectors.queues[0];
if (!vector || !queueVector) throw new Error("Missing vectors");
const author = { username: "xiaoman", displayName: "小满", avatarUrl: null };
const person = (index: number) => ({
  username: `p${index}`,
  displayName: `报名者${index}`,
  avatarUrl: null,
});
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const drawData: ActivityProofData = {
  kind: "draw",
  version: 2,
  stage: "drawn",
  activity: {
    id: vector.activityId,
    title: "周五抽奖",
    author,
    deadlineAt: iso(now - 600_000),
    closedAt: iso(now - 600_000),
    money: vector.money as Extract<
      ActivityProofData,
      { kind: "draw" }
    >["activity"]["money"],
  },
  drand: {
    chainHash:
      "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
    roundAt: iso(now - 598_000),
    ...vector.drand,
  },
  roster: {
    hash: vector.rosterHash,
    entries: vector.roster.map((entry) => ({
      ...entry,
      registeredAt: iso(now - 3_600_000 + entry.ordinal * 60_000),
      user: person(entry.ordinal),
    })),
  },
  seed: vector.seed,
  result: {
    picked: vector.picked,
    amounts: vector.amounts,
    winners: vector.winners,
  },
};
const claimedShares = 4;
const queueData: ActivityProofData = {
  kind: "queue",
  version: 2,
  stage: "ended",
  activity: {
    id: queueVector.activityId,
    title: "周末拼手气",
    author,
    openedAt: iso(now - 3_600_000),
    endedAt: iso(now - 60_000),
    money: queueVector.money as Extract<
      ActivityProofData,
      { kind: "queue" }
    >["activity"]["money"],
  },
  commitment: queueVector.commitment,
  secret: queueVector.secret,
  queue: queueVector.queue.map((amountMinor, position) => ({
    position,
    amountMinor,
    claim:
      position < claimedShares
        ? { user: person(position + 1), claimedAt: iso(now - 600_000) }
        : null,
  })),
};

function activityOf(data: ActivityProofData, done: boolean) {
  if (data.kind === "draw") {
    const deadline = Date.parse(data.activity.deadlineAt);
    return {
      id: data.activity.id,
      title: data.activity.title,
      rewardType: "ldc",
      participationMode: "direct",
      status: done ? "ended" : "active",
      author: { id: "author-e2e", ...author },
      forceDedicated: false,
      topicUrl: null,
      openedAt: iso(now - 7_200_000),
      deadlineAt: iso(deadline),
      quantity: {
        mode: "exact",
        total: 3,
        claimed: done ? 3 : 0,
        remaining: 3,
      },
      reward: {
        mode: "timed_draw",
        totalAmount: "10.00",
        count: 3,
        algorithm: "double_mean_v1",
        participantLimit: null,
        distributeFullPool: false,
      },
      beforeInfo: "",
      paymentMode: "simulation",
      draw: {
        state: done ? "completed" : "waiting",
        deadlineAt: iso(deadline),
        closedAt: done ? iso(deadline) : null,
        reason: done ? "deadline" : null,
        registeredCount: 7,
        winnerCount: done ? 3 : null,
        participantLimit: null,
      },
      drawProof: {
        kind: "draw",
        round: data.drand.round,
        roundAt: data.drand.roundAt,
        ...(done ? { rosterHash: data.roster.hash } : {}),
      },
      rosterPreview: [],
    };
  }
  if (data.kind !== "queue") throw new Error("No such 红包");
  return {
    id: data.activity.id,
    title: data.activity.title,
    rewardType: "ldc",
    participationMode: "direct",
    status: done ? "ended" : "active",
    author: { id: "author-e2e", ...author },
    forceDedicated: false,
    topicUrl: null,
    openedAt: data.activity.openedAt,
    deadlineAt: iso(now + (done ? -60_000 : 3_600_000)),
    quantity: {
      mode: "exact",
      total: 6,
      claimed: claimedShares,
      remaining: 6 - claimedShares,
    },
    reward: {
      mode: "random",
      totalAmount: "8.88",
      count: 6,
      algorithm: "double_mean_v1",
    },
    beforeInfo: "",
    paymentMode: "simulation",
    drawProof: { kind: "queue", commitment: data.commitment },
    rosterPreview: [],
  };
}

/** The 红包, its roster, its /proof, and drand's two nodes. */
async function mock(
  page: Page,
  data: ActivityProofData,
  {
    done = true,
    nodes = "answer",
  }: { done?: boolean; nodes?: "answer" | "down" } = {},
) {
  const id = data.kind === "draw" ? data.activity.id : queueVector?.activityId;
  const proof =
    done || data.kind !== "queue"
      ? data
      : {
          ...data,
          stage: "running" as const,
          secret: null,
          queue: data.queue.filter((item) => item.claim),
        };
  const drandRequests: string[] = [];
  await page.route(/\/(drand\.cloudflare\.com|api\.drand\.sh)\//, (route) => {
    drandRequests.push(new URL(route.request().url()).host);
    return nodes === "down"
      ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({
          json: vector?.drand,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
  });
  await page.route(`**/api/activities/${id}**`, (route) => {
    const rest = new URL(route.request().url()).pathname.slice(
      `/api/activities/${id}`.length,
    );
    if (rest === "")
      return route.fulfill({ json: { activity: activityOf(data, done) } });
    if (rest === "/proof") return route.fulfill({ json: proof });
    if (rest.startsWith("/participation"))
      return route.fulfill({ json: { claim: null, registration: null } });
    if (rest.startsWith("/registrations"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (rest.startsWith("/recipients"))
      return route.fulfill({
        json: {
          items: [],
          nextCursor: null,
          titles: { highestClaimIds: [], lowestClaimIds: [] },
        },
      });
    if (rest === "/passwords")
      return route.fulfill({
        json: { passwords: [], hiddenCount: 0, canSolve: false },
      });
    return route.fulfill({ status: 404, json: { error: {} } });
  });
  return { drandRequests, path: `/🧧/${encodeActivityEmoji(id ?? "")}` };
}

/**
 * A 限时开奖 just closed, its round 3.5 s away, on its page; the viewer
 * signed up or not. Returns what makes the next read say the round came.
 */
async function drawing(page: Page, registered: boolean) {
  if (drawData.kind !== "draw") throw new Error();
  const base = activityOf(drawData, false);
  let activity = {
    ...base,
    status: "ended",
    draw: { ...base.draw, state: "settling", reason: "full" },
    drawProof: {
      kind: "draw",
      round: drawData.drand.round,
      roundAt: iso(Date.now() + 3_500),
      rosterHash: drawData.roster.hash,
    } as Record<string, unknown>,
  };
  const id = drawData.activity.id;
  await page.route(`**/api/activities/${id}**`, (route) => {
    const rest = new URL(route.request().url()).pathname.slice(
      `/api/activities/${id}`.length,
    );
    if (rest === "") return route.fulfill({ json: { activity } });
    if (rest.startsWith("/participation"))
      return route.fulfill({
        json: {
          claim: null,
          registration: registered
            ? {
                id: "reg-mine",
                activity: { id, title: activity.title, status: "ended" },
                registeredAt: iso(Date.now() - 60_000),
                status: "drawing",
                drawAt: null,
                claim: null,
              }
            : null,
        },
      });
    if (rest === "/passwords")
      return route.fulfill({
        json: { passwords: [], hiddenCount: 0, canSolve: false },
      });
    return route.fulfill({
      json: {
        items: [],
        nextCursor: null,
        titles: { highestClaimIds: [], lowestClaimIds: [] },
      },
    });
  });
  await mockSession(page, viewer);
  await openApp(page, `/🧧/${encodeActivityEmoji(id)}`);
  return () => {
    activity = {
      ...activity,
      drawProof: {
        ...activity.drawProof,
        randomness: vector?.drand.randomness,
      },
    };
  };
}

async function openRoster(page: Page, path: string) {
  await mockSession(page, viewer);
  await openApp(page, path);
  await page.locator("#roster-entry").click();
}

test.describe("开奖证明", () => {
  test("限时开奖：截止前说清用哪一轮", async ({ page }) => {
    const { path } = await mock(page, drawData, { done: false });
    await openRoster(page, path);
    await expect(
      page.getByText("截止后用 drand 第 20,000,000 轮随机数开奖"),
    ).toBeVisible();
    await page.getByRole("button", { name: /怎么开奖/ }).click();
    const how = page.getByRole("dialog", { name: "怎么开奖" });
    await expect(
      how.getByText("提前截止时，改用截止后的那一轮。"),
    ).toBeVisible();
    await expect(how.getByRole("button", { name: "自己验证" })).toHaveCount(0);
  });

  test("限时开奖：开奖后在浏览器里重算一致，两个节点都问过", async ({
    page,
  }) => {
    const { path, drandRequests } = await mock(page, drawData);
    await openRoster(page, path);
    await expect(
      page.getByText("用 drand 第 20,000,000 轮随机数开奖"),
    ).toBeVisible();
    await page.getByRole("button", { name: /开奖证明/ }).click();
    const proof = page.getByRole("dialog", { name: "开奖证明" });
    await expect(proof.getByText("7 人，截止时冻结")).toBeVisible();
    await proof.getByRole("button", { name: "自己验证" }).click();
    await expect(proof.getByText("完全一致")).toBeVisible({ timeout: 8000 });
    expect([...new Set(drandRequests)].sort()).toEqual([
      "api.drand.sh",
      "drand.cloudflare.com",
    ]);
  });

  test("一个金额改过就对不上", async ({ page }) => {
    if (drawData.kind !== "draw" || !drawData.result) throw new Error();
    const { path } = await mock(page, {
      ...drawData,
      result: {
        ...drawData.result,
        winners: drawData.result.winners.map((winner, index) =>
          index === 0
            ? { ...winner, amountMinor: winner.amountMinor + 1 }
            : winner,
        ),
      },
    });
    await openRoster(page, path);
    await page.getByRole("button", { name: /开奖证明/ }).click();
    const proof = page.getByRole("dialog", { name: "开奖证明" });
    await proof.getByRole("button", { name: "自己验证" }).click();
    await expect(proof.getByText("对不上")).toBeVisible({ timeout: 8000 });
    await expect(proof.getByText("完全一致")).toBeHidden();
  });

  test("drand 节点取不到，就说没能验证", async ({ page }) => {
    const { path } = await mock(page, drawData, { nodes: "down" });
    await openRoster(page, path);
    await page.getByRole("button", { name: /开奖证明/ }).click();
    const proof = page.getByRole("dialog", { name: "开奖证明" });
    await proof.getByRole("button", { name: "自己验证" }).click();
    await expect(proof.getByText("没能验证")).toBeVisible({ timeout: 8000 });
  });

  test("拼手气：进行中只有封存值", async ({ page }) => {
    const { path } = await mock(page, queueData, { done: false });
    await openRoster(page, path);
    await expect(page.getByText("金额和顺序已在开放时封存")).toBeVisible();
    await page.getByRole("button", { name: /怎么发的/ }).click();
    const how = page.getByRole("dialog", { name: "怎么发的" });
    await expect(
      how.getByText(`${queueVector.commitment.slice(0, 8)}…`, { exact: false }),
    ).toBeVisible();
    await expect(how.getByRole("button", { name: "自己验证" })).toHaveCount(0);
  });

  test("拼手气：结束后核对种子和每一份", async ({ page }) => {
    const { path } = await mock(page, queueData);
    await openRoster(page, path);
    await page.getByRole("button", { name: /发放证明/ }).click();
    const proof = page.getByRole("dialog", { name: "发放证明" });
    await proof.getByRole("button", { name: "自己验证" }).click();
    await expect(proof.getByText("完全一致")).toBeVisible({ timeout: 8000 });
  });

  test("🎲：全部数据、在浏览器里验证和下载", async ({ page }) => {
    const done = await mock(page, drawData);
    await openRoster(page, done.path);
    await page.getByRole("button", { name: /开奖证明/ }).click();
    await page.getByRole("link", { name: /数据和算法/ }).click();
    await expect(
      page.getByRole("heading", { name: "算法：限时开奖 v2" }),
    ).toBeVisible();
    await expect(page.getByText(vector.seed)).toBeVisible();
    await expect(page.getByText("报名者7").first()).toBeVisible();
    for (const winner of vector.winners)
      await expect(
        page.getByText(formatAmount(winner.amountMinor), { exact: true }),
      ).toBeVisible();
    await page.getByRole("button", { name: "在浏览器里验证" }).click();
    await expect(page.getByText("完全一致")).toBeVisible({ timeout: 8000 });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载全部数据" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("开奖数据.json");
    expect(JSON.parse(readFileSync(await file.path(), "utf8"))).toEqual(
      drawData,
    );
  });

  test("开奖过程：报了名的人看到名单冻结、倒数到那一轮、取到随机数", async ({
    page,
  }) => {
    const fetched = await drawing(page, true);
    await expect(
      page.getByText(
        /名单已冻结（7 人），等 drand 第 20,000,000 轮随机数，[1-4] 秒后产生。/,
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "名单已冻结（7 人），正在取 drand 第 20,000,000 轮随机数。",
      ),
    ).toBeVisible({ timeout: 6_000 });
    // The round fetched: the next read (every second while drawing) says so.
    fetched();
    await expect(
      page.getByText(
        "已取到随机数，正在算中奖名单并创建付款，结果出来后显示在这里。",
      ),
    ).toBeVisible({ timeout: 3_000 });
  });

  test("开奖过程：没报名的人在红包皮下面看到同样几步", async ({ page }) => {
    const fetched = await drawing(page, false);
    await expect(
      page.getByText(/^名单已冻结，[1-4] 秒后出随机数…$/),
    ).toBeVisible();
    // Still red, its seal turning: the draw's last step, not its end.
    await expect(page.locator("[data-hb-part=hero]")).not.toHaveClass(
      /hb-ended/,
    );
    await expect(page.locator(".hb-seal")).toHaveAttribute(
      "data-state",
      "pending",
    );
    await expect(page.getByText("已结束", { exact: true })).toHaveCount(0);
    await expect(page.getByText("正在取随机数…")).toBeVisible({
      timeout: 6_000,
    });
    fetched();
    await expect(page.getByText("已取到随机数，正在创建付款…")).toBeVisible({
      timeout: 3_000,
    });
  });

  test("🎲：报名中就公开已报名的人和要用的那一轮，刷新后看到开奖", async ({
    page,
  }) => {
    if (drawData.kind !== "draw") throw new Error();
    const registering: ActivityProofData = {
      ...drawData,
      stage: "registering",
      activity: { ...drawData.activity, closedAt: null },
      drand: { ...drawData.drand, randomness: null, signature: null },
      roster: { hash: null, entries: drawData.roster.entries.slice(0, 3) },
      seed: null,
      result: null,
    };
    const { path } = await mock(page, registering);
    await mockSession(page, viewer);
    await openApp(page, `${path}/🎲`);
    await expect(
      page.getByText(
        "还在报名。截止时冻结报名名单，再用截止后的下一轮 drand 随机数开奖。",
      ),
    ).toBeVisible();
    await expect(page.getByText("截止时算出")).toBeVisible();
    await expect(page.getByText("报名者3")).toBeVisible();
    await expect(page.getByText("报名者4")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /Cloudflare 节点/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "在浏览器里验证" }),
    ).toHaveCount(0);

    // Drawn meanwhile.
    await page.route(
      `**/api/activities/${drawData.activity.id}/proof`,
      (route) => route.fulfill({ json: drawData }),
    );
    await page.getByRole("button", { name: "刷新" }).click();
    await expect(page.getByText(vector.seed)).toBeVisible();
    await expect(page.getByText("还在报名。", { exact: false })).toBeHidden();
    await expect(page.getByRole("button", { name: "刷新" })).toHaveCount(0);
    await page.getByRole("button", { name: "在浏览器里验证" }).click();
    await expect(page.getByText("完全一致")).toBeVisible({ timeout: 8000 });

    await page.getByRole("button", { name: "回到红包" }).click();
    await expectPath(page, path);
  });

  test("🎲：拼手气发放中就公开领走的份额", async ({ page }) => {
    const { path } = await mock(page, queueData, { done: false });
    await mockSession(page, viewer);
    await openApp(page, `${path}/🎲`);
    await expect(
      page.getByText(
        "还在发放。结束后公开种子和没领的份额，就能核对整个队列。",
      ),
    ).toBeVisible();
    await expect(page.getByText("报名者4")).toBeVisible();
    await expect(page.getByText("还有 2 份，结束后公开。")).toBeVisible();
    await expect(page.getByText("没人领")).toHaveCount(0);
  });

  test("🎲：旧算法的红包没有开奖数据", async ({ page }) => {
    const id = "77777777-5555-4666-8777-888888888888";
    await mockSession(page, viewer);
    await page.route(`**/api/activities/${id}/proof`, (route) =>
      route.fulfill({ json: { kind: "none" } }),
    );
    await openApp(page, `/🧧/${encodeActivityEmoji(id)}/🎲`);
    await expect(
      page.getByText("这个红包用的是旧算法，或者没有随机的部分。"),
    ).toBeVisible();
  });
});
