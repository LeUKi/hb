import { env } from "cloudflare:test";
import type { RankPage, RankVisibility } from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { rankPage } from "../src/rank/service";
import { sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
const day = 24 * 60 * 60 * 1000;
type Actor = { id: string; cookie: string; csrf: string };

async function person(username: string): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id,
      externalId: BigInt(`0x${id.replaceAll("-", "").slice(0, 12)}`).toString(),
      username,
      displayName: `${username} 昵称`,
      avatarUrl: `https://example.com/${username}.png`,
      createdAt: now,
      updatedAt: now,
    });
  await createDb(env.DB)
    .insert(sessions)
    .values({
      tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
      userId: id,
      csrfToken: csrf,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
  return { id, cookie: `hb_session=${token}`, csrf };
}

function request(
  path: string,
  actor?: Actor,
  init: { method?: string; body?: unknown; csrf?: string } = {},
) {
  return app.request(
    `${origin}${path}`,
    {
      method: init.method ?? "GET",
      headers: {
        ...(actor ? { Cookie: actor.cookie } : {}),
        ...(init.method && init.method !== "GET"
          ? {
              Origin: origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": init.csrf ?? actor?.csrf ?? "",
            }
          : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    },
    { ...env, APP_ORIGIN: origin } satisfies ApiBindings,
  );
}

async function page(path: string, actor?: Actor) {
  const response = await request(path, actor);
  expect(response.status, path).toBe(200);
  return (await response.json()) as RankPage;
}

/** A 口令红包 by `author`, each claim worth its cents, taken at its time. */
async function hongbao(
  author: Actor,
  claims: { by: Actor; minor: number; at: number }[],
) {
  const id = crypto.randomUUID();
  const passwordId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO activities
      (id,author_id,creation_request_id,creation_digest,title,force_dedicated,
       participation_mode,join_square,deleted_at,allocation,config,total_count,
       claimed_count,registered_count,reward_type,payment_mode,created_at,updated_at)
      VALUES (?,?,?,'digest','排行榜红包',0,'password',0,NULL,'sequential','{}',?,?,0,'ldc','simulation',?,?)`).bind(
      id,
      author.id,
      `rank-${id}`,
      claims.length,
      claims.length,
      now - 30 * day,
      now - 30 * day,
    ),
    env.DB.prepare(
      "INSERT INTO activity_passwords(id,activity_id,digest,ciphertext,position,created_at) VALUES(?,?,?,'CIPHERTEXT',0,?)",
    ).bind(passwordId, id, `digest-${id}`, now - 30 * day),
    ...claims.flatMap((claim, position) => {
      const inventoryId = crypto.randomUUID();
      return [
        env.DB.prepare(
          "INSERT INTO reward_inventory(id,activity_id,position,kind,amount_minor,created_at) VALUES (?,?,?,'ldc',?,?)",
        ).bind(inventoryId, id, position, claim.minor, now - 30 * day),
        env.DB.prepare(
          "INSERT INTO claims(id,activity_id,user_id,inventory_id,password_id,claimed_at) VALUES (?,?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          id,
          claim.by.id,
          inventoryId,
          passwordId,
          claim.at,
        ),
      ];
    }),
  ]);
}

beforeEach(async () => {
  await env.DB.batch(
    [
      "rank_snapshots",
      "claims",
      "activity_passwords",
      "reward_inventory",
      "activities",
      "sessions",
      "users",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});

describe("排行榜", () => {
  it("adds up what was taken, ranks ties alike, and shows only those who chose to be", async () => {
    const now = Date.now();
    const [aqing, laozhou, xiaoman, nanfeng, viewer] = await Promise.all(
      ["aqing", "laozhou", "xiaoman", "nanfeng", "viewer"].map(person),
    );
    if (!aqing || !laozhou || !xiaoman || !nanfeng || !viewer)
      throw new Error("people");
    // 阿青 sent 3 claims this week and one 10 days ago; 老周 one this week.
    await hongbao(aqing, [
      { by: xiaoman, minor: 300, at: now - day },
      { by: nanfeng, minor: 300, at: now - 2 * day },
      { by: viewer, minor: 50, at: now - 3 * day },
    ]);
    await hongbao(aqing, [{ by: xiaoman, minor: 1000, at: now - 10 * day }]);
    await hongbao(laozhou, [{ by: viewer, minor: 400, at: now - day }]);
    // 老周 would rather not be named; 小满 would like to be.
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET rank_sent_visible=0 WHERE id=?").bind(
        laozhou.id,
      ),
      env.DB.prepare(
        "UPDATE users SET rank_received_visible=1 WHERE id=?",
      ).bind(xiaoman.id),
    ]);

    const sentAll = await page("/api/rank?board=sent&range=all", viewer);
    expect(sentAll.total).toBe(2);
    expect(sentAll.items).toEqual([
      {
        position: 0,
        rank: 1,
        person: {
          username: "aqing",
          displayName: "aqing 昵称",
          avatarUrl: "https://example.com/aqing.png",
        },
        me: false,
        amount: "16.50",
        activities: 2,
        claims: 4,
      },
      {
        position: 1,
        rank: 2,
        person: null,
        me: false,
        amount: "4.00",
        activities: 1,
        claims: 1,
      },
    ]);
    // 匿名 says nothing of who it is.
    expect(JSON.stringify(sentAll)).not.toContain(laozhou.id);
    expect(JSON.stringify(sentAll)).not.toContain("laozhou");
    expect(sentAll.me).toMatchObject({ rank: null, visible: true });

    // 近 7 天 leaves out what was taken 10 days ago.
    const sentWeek = await page("/api/rank?board=sent&range=week");
    expect(sentWeek.items.map((item) => item.amount)).toEqual(["6.50", "4.00"]);
    expect(sentWeek.me).toBeNull();

    // 领到: 小满 13.00, the one reading 4.50, 南风 3.00.
    const receivedAll = await page(
      "/api/rank?board=received&range=all",
      viewer,
    );
    expect(
      receivedAll.items.map((item) => [
        item.rank,
        item.person?.username ?? null,
        item.me,
        item.amount,
      ]),
    ).toEqual([
      [1, "xiaoman", false, "13.00"],
      // The one reading is 匿名 by default, and told it is them.
      [2, null, true, "4.50"],
      [3, null, false, "3.00"],
    ]);
    expect(receivedAll.me).toEqual({
      rank: 2,
      position: 1,
      amount: "4.50",
      activities: 2,
      claims: 2,
      visible: false,
    });
    // This week 小满 and 南风 took 3.00 each: the same rank.
    const receivedWeek = await page("/api/rank?board=received&range=week");
    expect(receivedWeek.items.map((item) => [item.rank, item.amount])).toEqual([
      [1, "4.50"],
      [2, "3.00"],
      [2, "3.00"],
    ]);
  });

  it("keeps a snapshot for 5 minutes, but a changed switch counts at once", async () => {
    const now = Date.now();
    const [author, taker] = await Promise.all(["author", "taker"].map(person));
    if (!author || !taker) throw new Error("people");
    await hongbao(author, [{ by: taker, minor: 100, at: now - day }]);
    const query = { board: "received", range: "all" } as const;
    const first = await rankPage(env, query, null, now);
    expect(first.items.map((item) => item.amount)).toEqual(["1.00"]);
    expect(first.items[0]?.person).toBeNull();

    await hongbao(author, [{ by: taker, minor: 200, at: now - day }]);
    const patched = await request("/api/me/rank-visibility", taker, {
      method: "PATCH",
      body: { board: "received", visible: true },
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()) as RankVisibility).toEqual({
      sent: true,
      received: true,
    });
    // Within 5 minutes: the same order, but shown by name now.
    const soon = await rankPage(env, query, null, now + 4 * 60 * 1000);
    expect(soon.computedAt).toBe(now);
    expect(soon.items.map((item) => item.amount)).toEqual(["1.00"]);
    expect(soon.items[0]?.person?.username).toBe("taker");
    // Older than that: worked out again.
    const later = await rankPage(env, query, null, now + 5 * 60 * 1000);
    expect(later.computedAt).toBe(now + 5 * 60 * 1000);
    expect(later.items.map((item) => item.amount)).toEqual(["3.00"]);
  });

  it("lists everyone 20 at a time, each once", async () => {
    const now = Date.now();
    const author = await person("author");
    const takers = await Promise.all(
      Array.from({ length: 25 }, (_, index) => person(`taker-${index}`)),
    );
    await hongbao(
      author,
      takers.map((by, index) => ({ by, minor: 100 + index, at: now - day })),
    );
    const first = await page("/api/rank?board=received&range=all");
    expect(first.total).toBe(25);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBe("20");
    const second = await page(
      `/api/rank?board=received&range=all&cursor=${first.nextCursor}`,
    );
    expect(second.items.map((item) => item.position)).toEqual([
      20, 21, 22, 23, 24,
    ]);
    expect(second.nextCursor).toBeNull();
    expect(
      [...first.items, ...second.items].map((item) => item.amount),
    ).toEqual(takers.map((_, index) => (1.24 - index / 100).toFixed(2)));
  });

  it("reads and changes one's own switches only, with the CSRF token", async () => {
    const someone = await person("someone");
    expect((await request("/api/me/rank-visibility")).status).toBe(401);
    expect(
      await (await request("/api/me/rank-visibility", someone)).json(),
    ).toEqual({ sent: true, received: false });
    expect(
      (
        await request("/api/me/rank-visibility", someone, {
          method: "PATCH",
          body: { board: "sent", visible: false },
          csrf: "wrong",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/me/rank-visibility", someone, {
          method: "PATCH",
          body: { board: "sent", visible: "no" },
        })
      ).status,
    ).toBe(400);
    expect(
      await (
        await request("/api/me/rank-visibility", someone, {
          method: "PATCH",
          body: { board: "sent", visible: false },
        })
      ).json(),
    ).toEqual({ sent: false, received: false });
    for (const bad of [
      "board=gifts",
      "range=month",
      "cursor=-1",
      "cursor=abc",
      "extra=1",
    ])
      expect((await request(`/api/rank?${bad}`)).status, bad).toBe(400);
  });
});
