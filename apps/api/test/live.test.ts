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
  socket.addEventListener("close", (event) => closed.push(event.code));
  socket.accept();
  return { socket, heard, closed };
}

const claimed = (message: ActivityLiveMessage | "pong" | undefined) =>
  message && message !== "pong" && message.activity.quantity.mode === "exact"
    ? message.activity.quantity.claimed
    : null;

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
  merchantId = (
    await createMerchant(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      clientId: `live_${crypto.randomUUID()}`,
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
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(claimed(heard[0])).toBe(0);
    await claim(activity.id, await actor());
    await claim(activity.id, await actor());
    await vi.waitFor(() => expect(claimed(heard.at(-1))).toBe(2), {
      timeout: 3000,
    });
    // Two claims in a row: at most one push each, usually one for both.
    expect(heard.length).toBeLessThanOrEqual(3);
    const last = heard.at(-1);
    if (!last || last === "pong") throw new Error("no push");
    // The public read only: nothing of anyone's own.
    expect(last.activity).not.toHaveProperty("passwords");
    expect(last.activity.rosterPreview).toHaveLength(2);
  });

  it("sends the last read and closes once the 红包 is over, and lets no one in after", async () => {
    const activity = await running(1);
    const { heard, closed } = await connect(activity.id, await actor());
    await claim(activity.id, await actor());
    await vi.waitFor(() => expect(closed).toEqual([1000]), { timeout: 3000 });
    expect(claimed(heard.at(-1))).toBe(1);
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

  it("answers the keep-alive, and closes on anything else", async () => {
    const activity = await running(3);
    const { socket, heard, closed } = await connect(activity.id, await actor());
    socket.send("ping");
    await vi.waitFor(() => expect(heard).toContain("pong"));
    socket.send("hello");
    await vi.waitFor(() => expect(closed).toEqual([1008]));
  });
});
