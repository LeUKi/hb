import { env, runDurableObjectAlarm } from "cloudflare:test";
import {
  type ActivityInput,
  type DiscoveryList,
  emptyActivityInput,
} from "@hb/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteActivity } from "../src/activities/deletion";
import {
  openScheduled,
  SCHEDULE_RETRY_MS,
  scheduleActivity,
} from "../src/activities/schedule";
import {
  createActivity,
  getPublicActivity,
  updateActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import { listRecords, readAccount } from "../src/balance/ledger";
import { createMerchant } from "../src/payments/merchants";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import {
  type Actor,
  actor,
  bindings,
  give,
  origin,
  rejects,
  settings,
} from "./code-fixtures";

// 定时开放 (docs/scheduled-opening-design.md): a draft timed to open, a
// 🐟额红包's 🐟 held from then, opened at its time (or by the first claim
// after it), or failed and given back.

const minute = 60_000;
let admin: Actor;
let author: Actor;
let merchantId: string;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1 });
  merchantId = (
    await createMerchant(bindings, author.id, {
      requestId: crypto.randomUUID(),
      clientId: `scheduled_${crypto.randomUUID().replaceAll("-", "")}`,
      label: "定时商户",
      secret: "virtual-only-secret",
    })
  ).id;
});

const input = (overrides: Partial<ActivityInput> = {}): ActivityInput => ({
  ...emptyActivityInput(),
  title: "周五定时",
  rewardType: "ldc",
  merchantId,
  passwords: ["定时口令2026"],
  money: { mode: "fixed", totalAmount: "2.00", count: 2 },
  ...overrides,
});

const fish = (overrides: Partial<ActivityInput> = {}) =>
  input({ funding: "balance", merchantId: "", ...overrides });

const draft = (activity = input()) =>
  createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity,
  });

const inMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * minute).toISOString();

/** Its time come (`ago` past it): as the clock would leave it. */
const due = (id: string, ago = 1_000) =>
  env.DB.prepare("UPDATE activities SET scheduled_open_at = ? WHERE id = ?")
    .bind(Date.now() - ago, id)
    .run();

function request(path: string, user?: Actor, method = "GET", body?: unknown) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        ...(user ? { Cookie: user.cookie } : {}),
        ...(method !== "GET"
          ? {
              Origin: origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": user?.csrf ?? "",
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}

describe("定时开放: timing a draft", () => {
  it("takes a time from 5 minutes to 30 days on, before a deadline set at a time", async () => {
    const saved = await draft();
    const at = (minutes: number) => ({
      version: saved.version,
      at: inMinutes(minutes),
    });
    await rejects(
      scheduleActivity(bindings, saved.id, author.id, at(2)),
      "SCHEDULE_TOO_SOON",
    );
    await rejects(
      scheduleActivity(bindings, saved.id, author.id, at(31 * 24 * 60)),
      "SCHEDULE_TOO_LATE",
    );
    const fixed = await draft(
      input({ deadline: { mode: "at", at: inMinutes(30) } }),
    );
    await rejects(
      scheduleActivity(bindings, fixed.id, author.id, {
        version: fixed.version,
        at: inMinutes(60),
      }),
      "SCHEDULE_AFTER_DEADLINE",
    );
    const timed = await scheduleActivity(bindings, saved.id, author.id, at(60));
    expect(timed.status).toBe("draft");
    // To the minute, as it is chosen.
    expect(Date.parse(timed.scheduledOpenAt ?? "") % minute).toBe(0);
    // Anyone with its link sees when (§6).
    const shown = await getPublicActivity(bindings, saved.id);
    expect(shown.scheduledOpenAt).toBe(timed.scheduledOpenAt);
  });

  it("changes as an opened one does once timed, and is not deleted till taken back", async () => {
    const saved = await draft();
    const timed = await scheduleActivity(bindings, saved.id, author.id, {
      version: saved.version,
      at: inMinutes(60),
    });
    // Its money is fixed now (§2).
    await expect(
      updateActivity(bindings, saved.id, author.id, {
        version: timed.version,
        activity: input({
          money: { mode: "fixed", totalAmount: "1.00", count: 2 },
        }),
      }),
    ).rejects.toMatchObject({ status: 400 });
    // Its words are not.
    const retitled = await updateActivity(bindings, saved.id, author.id, {
      version: timed.version,
      activity: input({ title: "周五晚上" }),
    });
    expect(retitled.title).toBe("周五晚上");
    expect(retitled.scheduledOpenAt).toBe(timed.scheduledOpenAt);
    await rejects(
      deleteActivity(bindings, author.id, saved.id, retitled.version),
      "ACTIVITY_SCHEDULED",
    );
    const back = await scheduleActivity(bindings, saved.id, author.id, {
      version: retitled.version,
      at: null,
    });
    expect(back.scheduledOpenAt).toBeUndefined();
    await deleteActivity(bindings, author.id, saved.id, back.version);
  });

  it("holds a 🐟额红包's 🐟 from its timing, gives it back when taken back, and holds it again", async () => {
    await give(admin, author, "5.00");
    const saved = await draft(fish());
    const timed = await scheduleActivity(bindings, saved.id, author.id, {
      version: saved.version,
      at: inMinutes(60),
    });
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 300,
      unclaimedMinor: 200,
    });
    const back = await scheduleActivity(bindings, saved.id, author.id, {
      version: timed.version,
      at: null,
    });
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 500,
      unclaimedMinor: 0,
    });
    // 明细 says why it came back (not 红包结束退回).
    const records = await listRecords(bindings, author.id, "hongbao");
    expect(
      records.items.map((item) => "hongbao" in item && item.hongbao.kind),
    ).toEqual(["untimed", "sent"]);
    // Timed again: another lock, one active at a time.
    const again = await scheduleActivity(bindings, saved.id, author.id, {
      version: back.version,
      at: inMinutes(90),
    });
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 300,
      unclaimedMinor: 200,
    });
    // Its time come: it opens on the lock it holds, not a second one.
    await due(saved.id);
    expect(await openScheduled(bindings, saved.id)).toEqual({
      kind: "opened",
    });
    const opened = await getPublicActivity(bindings, saved.id);
    expect(opened.status).toBe("active");
    expect(opened.scheduledOpenAt).toBeUndefined();
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 300,
      unclaimedMinor: 200,
    });
    expect(again.version).toBeGreaterThan(back.version);
    const locks = await env.DB.prepare(
      "SELECT status FROM balance_locks WHERE activity_id = ? ORDER BY created_at",
    )
      .bind(saved.id)
      .all<{ status: string }>();
    expect(locks.results.map((lock) => lock.status)).toEqual([
      "released",
      "active",
    ]);
  });

  it("refuses what opening would refuse now, not 🐟额 it cannot cover", async () => {
    await give(admin, author, "1.00");
    const saved = await draft(fish());
    await rejects(
      scheduleActivity(bindings, saved.id, author.id, {
        version: saved.version,
        at: inMinutes(60),
      }),
      "BALANCE_INSUFFICIENT",
    );
  });
});

describe("定时开放: its time", () => {
  it("waits before its time, opens at it, and clears the timing", async () => {
    const saved = await draft();
    await scheduleActivity(bindings, saved.id, author.id, {
      version: saved.version,
      at: inMinutes(60),
    });
    expect(await openScheduled(bindings, saved.id)).toMatchObject({
      kind: "early",
    });
    await due(saved.id);
    expect(await openScheduled(bindings, saved.id)).toEqual({
      kind: "opened",
    });
    const opened = await getPublicActivity(bindings, saved.id);
    expect(opened.status).toBe("active");
    // Counted from when it opened (the default 24 hours).
    expect(Date.parse(opened.deadlineAt ?? "") - Date.now()).toBeGreaterThan(
      23 * 60 * minute,
    );
    expect(await openScheduled(bindings, saved.id)).toEqual({ kind: "none" });
  });

  it("ends a timing that cannot open, says why and gives the 🐟 back", async () => {
    await give(admin, author, "5.00");
    const saved = await draft(fish());
    await scheduleActivity(bindings, saved.id, author.id, {
      version: saved.version,
      at: inMinutes(60),
    });
    await settings({ hongbao_enabled: 0 });
    await due(saved.id);
    expect(await openScheduled(bindings, saved.id)).toEqual({
      kind: "failed",
    });
    const own = await request(`/api/me/activities/${saved.id}`, author);
    const managed = (
      (await own.json()) as {
        activity: { status: string; scheduleFailure?: { reason: string } };
      }
    ).activity;
    expect(managed.status).toBe("draft");
    // Without its “草稿已保存” (§5).
    expect(managed.scheduleFailure?.reason).toBe("🐟额红包暂时关闭");
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 500,
      unclaimedMinor: 0,
    });
  });

  it("tries a paused site again for a while, then ends the timing", async () => {
    const sender = await actor();
    const real = await createMerchant(bindings, sender.id, {
      requestId: crypto.randomUUID(),
      clientId: `scheduled_real_${crypto.randomUUID().replaceAll("-", "")}`,
      label: "定时真实商户",
      secret: "virtual-only-secret",
      mode: "real",
    });
    const saved = await createActivity(bindings, sender.id, {
      requestId: crypto.randomUUID(),
      activity: input({ merchantId: real.id }),
    });
    // Timed while 真实 LDC was open (here it never is).
    await due(saved.id);
    expect(await openScheduled(bindings, saved.id)).toMatchObject({
      kind: "retry",
    });
    await due(saved.id, SCHEDULE_RETRY_MS + 1_000);
    expect(await openScheduled(bindings, saved.id)).toEqual({
      kind: "failed",
    });
    const row = await env.DB.prepare(
      "SELECT scheduled_open_at, schedule_failure, opened_at FROM activities WHERE id = ?",
    )
      .bind(saved.id)
      .first<{ scheduled_open_at: null; schedule_failure: string }>();
    expect(row).toMatchObject({ scheduled_open_at: null, opened_at: null });
    expect(row?.schedule_failure).not.toMatch(/草稿/);
  });

  it("is opened by its Durable Object's alarm", async () => {
    const saved = await draft();
    const timed = await request(
      `/api/me/activities/${saved.id}/schedule`,
      author,
      "POST",
      { version: saved.version, at: inMinutes(60) },
    );
    expect(timed.status).toBe(200);
    await due(saved.id);
    const stub = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(saved.id));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const opened = await getPublicActivity(bindings, saved.id);
    expect(opened.status).toBe("active");
  });

  it("has its waiters on the live channel, who hear it open; a draft not timed lets no one on", async () => {
    const viewer = await actor();
    const live = (id: string) =>
      app.request(
        `${origin}/api/activities/${id}/live`,
        {
          headers: {
            Upgrade: "websocket",
            Origin: origin,
            Cookie: viewer.cookie,
          },
        },
        bindings,
      );
    const plain = await draft();
    expect((await live(plain.id)).status).toBe(410);
    const saved = await draft();
    await request(`/api/me/activities/${saved.id}/schedule`, author, "POST", {
      version: saved.version,
      at: inMinutes(60),
    });
    const response = await live(saved.id);
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("no WebSocket");
    const heard: { type: string; activity?: { status: string } }[] = [];
    socket.addEventListener("message", (event) => {
      const data = String(event.data);
      if (data !== "pong") heard.push(JSON.parse(data));
    });
    socket.accept();
    await vi.waitFor(() =>
      expect(heard.some((message) => message.type === "viewers")).toBe(true),
    );
    expect(
      heard.find((message) => message.type === "activity")?.activity?.status,
    ).toBe("draft");
    await due(saved.id);
    const stub = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(saved.id));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await vi.waitFor(() =>
      expect(
        heard.filter((message) => message.type === "activity").at(-1)?.activity
          ?.status,
      ).toBe("active"),
    );
    socket.close();
  });

  it("opens at the first claim after its time, the alarm not in yet", async () => {
    const claimant = await actor();
    const saved = await draft();
    const timed = await request(
      `/api/me/activities/${saved.id}/schedule`,
      author,
      "POST",
      { version: saved.version, at: inMinutes(60) },
    );
    expect(timed.status).toBe(200);
    // Before its time, a claim is told it is not open.
    const early = await request(
      `/api/activities/${saved.id}/claim`,
      claimant,
      "POST",
      { submissionId: crypto.randomUUID(), password: "定时口令2026" },
    );
    expect(await early.json()).toMatchObject({ result: "draft" });
    await advanceAttemptCooldown(env.DB, claimant.id);
    await due(saved.id);
    const claimed = await request(
      `/api/activities/${saved.id}/claim`,
      claimant,
      "POST",
      { submissionId: crypto.randomUUID(), password: "定时口令2026" },
    );
    expect(await claimed.json()).toMatchObject({ result: "claimed" });
  });
});

describe("定时开放: 红包广场", () => {
  it("lists those that join it under 即将开放, nearest first, and not under 全部", async () => {
    const later = await draft(input({ title: "晚的", joinSquare: true }));
    const sooner = await draft(input({ title: "早的", joinSquare: true }));
    const unlisted = await draft(input({ title: "不进广场" }));
    for (const [saved, minutes] of [
      [later, 120],
      [sooner, 60],
      [unlisted, 30],
    ] as const)
      await scheduleActivity(bindings, saved.id, author.id, {
        version: saved.version,
        at: inMinutes(minutes),
      });
    const read = async (status: string) =>
      (await (
        await request(`/api/discovery/activities?status=${status}`)
      ).json()) as DiscoveryList;
    const upcoming = await read("upcoming");
    expect(upcoming.items.map((item) => item.title)).toEqual(["早的", "晚的"]);
    expect(upcoming.total).toBe(2);
    expect(upcoming.items[0]?.scheduledOpenAt).toBeDefined();
    expect((await read("all")).items).toEqual([]);
  });
});
