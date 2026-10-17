import { env } from "cloudflare:test";
import {
  type ActivityLiveMessage,
  emptyActivityInput,
  type LdcActivityInput,
} from "@hb/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { sha256Hex } from "../src/security/crypto";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import { resetMerchantHistory } from "./reset-merchant-history";

// A running 红包's live channel (activities/live.ts): signed-in viewers'
// WebSockets in the 红包's own ActivityDO, pushed its public read after
// each change.

const origin = "https://hb.example.com";
const bindings: ApiBindings = { ...env, APP_ORIGIN: origin };
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let merchantId: string;
let merchantClientId: string;

async function actor(): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId: id,
    username: `live_${id.slice(0, 8)}`,
    displayName: `Live ${id.slice(0, 8)}`,
    avatarUrl: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: csrf,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(Date.now() + 3600000),
  });
  return { id, cookie: `hb_session=${token}`, csrf };
}

async function running(count: number) {
  const { rewardType: _type, ...base } = emptyActivityInput();
  const input: LdcActivityInput = {
    ...base,
    title: "实时红包",
    rewardType: "ldc",
    merchantId,
    passwords: ["LivePassword"],
    allocation: "sequential",
    money: { mode: "fixed", totalAmount: `${count}.00`, count },
  };
  const saved = await createActivity(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return openActivity(bindings, saved.id, owner.id, saved.version);
}

/** A claim the way a page sends it: through the 红包's DO. */
async function claim(activityId: string, user: Actor) {
  const response = await app.request(
    `${origin}/api/activities/${activityId}/claim`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: user.cookie,
        "X-CSRF-Token": user.csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        submissionId: crypto.randomUUID(),
        password: "LivePassword",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  await advanceAttemptCooldown(env.DB, user.id);
}

function upgrade(
  activityId: string,
  user: Actor | null,
  headers: Record<string, string> = {},
) {
  return app.request(
    `${origin}/api/activities/${activityId}/live`,
    {
      headers: {
        Upgrade: "websocket",
        Origin: origin,
        ...(user ? { Cookie: user.cookie } : {}),
        ...headers,
      },
    },
    bindings,
  );
}

/** A connected socket, and what it has heard so far. */
async function connect(activityId: string, user: Actor) {
  const response = await upgrade(activityId, user);
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("no WebSocket");
  const heard: (ActivityLiveMessage | "pong")[] = [];
  const closed: number[] = [];
  socket.addEventListener("message", (event) => {
    const data = String(event.data);
    heard.push(data === "pong" ? "pong" : JSON.parse(data));
  });
  socket.addEventListener("close", (event) => {
    closed.push(event.code);
  });
  socket.accept();
  return { socket, heard, closed };
}

const claimed = (message: ActivityLiveMessage | "pong" | undefined) =>
  message &&
  message !== "pong" &&
  message.type === "activity" &&
  message.activity.quantity.mode === "exact"
    ? message.activity.quantity.claimed
    : null;

const mine = (heard: (ActivityLiveMessage | "pong")[]) =>
  heard.filter((message) => message !== "pong" && message.type === "mine")
    .length;

/** The public reads heard, without the other messages in between. */
const reads = (heard: (ActivityLiveMessage | "pong")[]) =>
  heard.filter(
    (message): message is Extract<ActivityLiveMessage, { type: "activity" }> =>
      message !== "pong" && message.type === "activity",
  );

/** The number of people watching, as last heard. */
const viewers = (heard: (ActivityLiveMessage | "pong")[]) =>
  heard
    .filter(
      (message): message is Extract<ActivityLiveMessage, { type: "viewers" }> =>
        message !== "pong" && message.type === "viewers",
    )
    .at(-1)?.count;

/** The fixture merchant's simulated upstream answers like this. */
async function upstream(scenario: "normal" | "daily_limit") {
  await env.DB.prepare(
    "UPDATE simulation_controls SET scenario=? WHERE merchant_id=?",
  )
    .bind(scenario, merchantId)
    .run();
}

/** One merchant cycle on everything due, the way its alarm runs it. */
async function payNow() {
  await env.DB.prepare(
    "UPDATE payment_tasks SET next_run_at=0 WHERE status <> 'confirmed'",
  ).run();
  const response = await env.MERCHANT_DO.get(
    env.MERCHANT_DO.idFromName(merchantClientId),
  ).fetch("https://merchant.internal/internal/payments/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchantId }),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
}

async function paymentStatus(activityId: string, user: Actor) {
  return (
    await env.DB.prepare(
      "SELECT p.status FROM payment_tasks p JOIN claims c ON c.id = p.claim_id WHERE c.activity_id = ? AND c.user_id = ?",
    )
      .bind(activityId, user.id)
      .first<{ status: string }>()
  )?.status;
}

beforeEach(async () => {
  await resetMerchantHistory(env.DB);
  await env.DB.batch(
    [
      "payment_outbox",
      "payment_attempts",
      "payment_tasks",
      "simulation_orders",
      "simulation_controls",
      "merchant_credentials",
      "attempt_events",
      "redemption_submissions",
      "claims",
      "reward_inventory",
      "activity_passwords",
      "activities",
      "merchants",
      "sessions",
      "users",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  owner = await actor();
  merchantClientId = `live_${crypto.randomUUID()}`;
  merchantId = (
    await createMerchant(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      clientId: merchantClientId,
      label: "Local fixture",
      secret: "fake-only",
    })
  ).id;
});

describe("a running 红包's live channel", () => {
  it("is only for a signed-in viewer's upgrade from this site's pages", async () => {
    const activity = await running(3);
    const viewer = await actor();
    expect((await upgrade(activity.id, viewer, { Upgrade: "" })).status).toBe(
      426,
    );
    expect(
      (await upgrade(activity.id, viewer, { Origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect((await upgrade(activity.id, null)).status).toBe(401);
    expect((await upgrade(crypto.randomUUID(), viewer)).status).toBe(404);
  });

  it("pushes the public read on connecting, then once per burst of claims", async () => {
    const activity = await running(5);
    const { heard } = await connect(activity.id, await actor());
    await vi.waitFor(() => expect(reads(heard)).toHaveLength(1));
    expect(claimed(reads(heard)[0])).toBe(0);
    await claim(activity.id, await actor());
    await claim(activity.id, await actor());
    await vi.waitFor(() => expect(claimed(reads(heard).at(-1))).toBe(2), {
      timeout: 3000,
    });
    // Two claims in a row: at most one push each, usually one for both.
    expect(reads(heard).length).toBeLessThanOrEqual(3);
    const last = reads(heard).at(-1);
    if (!last) throw new Error("no push");
    // The public read only: nothing of anyone's own.
    expect(last.activity).not.toHaveProperty("passwords");
    expect(last.activity.rosterPreview).toHaveLength(2);
  });

  it("sends the last read and closes once the 红包 is over, and lets no one in after", async () => {
    const activity = await running(1);
    const { heard, closed } = await connect(activity.id, await actor());
    await claim(activity.id, await actor());
    await vi.waitFor(() => expect(closed).toEqual([1000]), { timeout: 3000 });
    expect(claimed(reads(heard).at(-1))).toBe(1);
    expect((await upgrade(activity.id, await actor())).status).toBe(410);
  });

  it("lets one person keep four sockets: a fifth replaces the oldest", async () => {
    const activity = await running(3);
    const viewer = await actor();
    const sockets: Awaited<ReturnType<typeof connect>>[] = [];
    for (let index = 0; index < 5; index++)
      sockets.push(await connect(activity.id, viewer));
    await vi.waitFor(() => expect(sockets[0]?.closed).toEqual([4001]));
    expect(sockets.slice(1).every((each) => each.closed.length === 0)).toBe(
      true,
    );
  });

  it("keeps a claimant's line past the end until their payment is through, saying when it moves", async () => {
    await upstream("daily_limit");
    const activity = await running(1);
    const claimant = await actor();
    const watching = await connect(activity.id, claimant);
    const other = await connect(activity.id, await actor());
    await claim(activity.id, claimant);
    // The end goes out to both; only the one still waiting stays on.
    await vi.waitFor(() => expect(other.closed).toEqual([1000]), {
      timeout: 3000,
    });
    expect(claimed(reads(watching.heard).at(-1))).toBe(1);
    expect(watching.closed).toEqual([]);
    // Still waiting, they may come back on another tab; no one else may.
    const again = await connect(activity.id, claimant);
    expect((await upgrade(activity.id, await actor())).status).toBe(410);

    // The upstream holds it back: the page hears its payment moved.
    await payNow();
    await vi.waitFor(() =>
      expect(mine(watching.heard)).toBeGreaterThanOrEqual(1),
    );
    expect(await paymentStatus(activity.id, claimant)).toBe("waiting");
    expect(watching.closed).toEqual([]);

    // Through: told once more, then let go.
    await upstream("normal");
    await payNow();
    await vi.waitFor(() => expect(watching.closed).toEqual([1000]), {
      timeout: 3000,
    });
    expect(await paymentStatus(activity.id, claimant)).toBe("confirmed");
    expect(mine(watching.heard)).toBeGreaterThanOrEqual(2);
    await vi.waitFor(() => expect(again.closed).toEqual([1000]));
  });

  it("tells the sender when a payment in their 名单 moves, and no one else", async () => {
    const activity = await running(3);
    const sender = await connect(activity.id, owner);
    const bystander = await connect(activity.id, await actor());
    await claim(activity.id, await actor());
    await payNow();
    await vi.waitFor(() => expect(mine(sender.heard)).toBe(1));
    expect(mine(bystander.heard)).toBe(0);
  });

  it("pushes the end at the deadline by itself", async () => {
    const activity = await running(3);
    await env.DB.prepare("UPDATE activities SET deadline=? WHERE id=?")
      .bind(Date.now() + 400, activity.id)
      .run();
    const { heard, closed } = await connect(activity.id, await actor());
    // Nothing else happens: the DO's own alarm at the deadline ends it.
    await vi.waitFor(() => expect(closed).toEqual([1000]), { timeout: 3000 });
    const last = reads(heard).at(-1);
    if (!last) throw new Error("no push");
    expect(last.activity.status).toBe("ended");
    expect(
      (
        await env.DB.prepare(
          "SELECT end_reason AS reason FROM activities WHERE id=?",
        )
          .bind(activity.id)
          .first<{ reason: string | null }>()
      )?.reason,
    ).toBe("expired");
  });

  it("pushes a refresh only when it moved something", async () => {
    const activity = await running(3);
    const { heard } = await connect(activity.id, await actor());
    await vi.waitFor(() => expect(reads(heard)).toHaveLength(1));
    const response = await env.ACTIVITY_DO.get(
      env.ACTIVITY_DO.idFromName(activity.id),
    ).fetch(
      `https://activity.internal/internal/activities/${activity.id}/refresh`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reads(heard)).toHaveLength(1);
  });

  it("tells everyone how many people are watching, each counted once", async () => {
    const activity = await running(3);
    const first = await actor();
    const one = await connect(activity.id, first);
    await vi.waitFor(() => expect(viewers(one.heard)).toBe(1));
    const other = await connect(activity.id, await actor());
    await vi.waitFor(() => expect(viewers(other.heard)).toBe(2));
    await vi.waitFor(() => expect(viewers(one.heard)).toBe(2));
    // Another tab of someone already here: still two, said to it at once.
    const second = await connect(activity.id, first);
    await vi.waitFor(() => expect(viewers(second.heard)).toBe(2));
    // Someone leaves: the others hear it.
    other.socket.close(1000);
    await vi.waitFor(() => expect(viewers(one.heard)).toBe(1), {
      timeout: 3000,
    });
    expect(viewers(second.heard)).toBe(1);
  });

  it("answers the keep-alive, and closes on anything else", async () => {
    const activity = await running(3);
    const { socket, heard, closed } = await connect(activity.id, await actor());
    socket.send("ping");
    await vi.waitFor(() => expect(heard).toContain("pong"));
    socket.send("hello");
    await vi.waitFor(() => expect(closed).toEqual([1008]));
  });
});
