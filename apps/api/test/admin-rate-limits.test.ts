import { env } from "cloudflare:test";
import type { AttemptRateLimitsResponse } from "@hb/contracts";
import { describe, expect, it } from "vitest";
import { isAdministrator } from "../src/admin/authorization";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
async function actor() {
  const id = crypto.randomUUID();
  const externalId = BigInt(
    `0x${id.replaceAll("-", "").slice(0, 12)}`,
  ).toString();
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB).insert(users).values({
    id,
    externalId,
    username: "lafish",
    displayName: "Admin test",
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
  return { id, externalId, cookie: `hb_session=${token}`, csrf };
}
type Actor = Awaited<ReturnType<typeof actor>>;
function request(
  path: string,
  account?: Actor,
  init?: RequestInit,
  allowlist?: string,
) {
  const headers = new Headers(init?.headers);
  if (account) headers.set("Cookie", account.cookie);
  return app.request(`${origin}${path}`, { ...init, headers }, {
    ...env,
    APP_ORIGIN: origin,
    ADMIN_LINUX_DO_IDS: allowlist,
  } satisfies ApiBindings);
}
async function config(account: Actor) {
  const response = await request(
    "/api/admin/rate-limits",
    account,
    undefined,
    account.externalId,
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<AttemptRateLimitsResponse>;
}
function update(
  account: Actor,
  expectedVersion: number,
  home: number,
  activity: number,
  csrf: string = account.csrf,
) {
  return request(
    "/api/admin/rate-limits",
    account,
    {
      method: "PATCH",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({
        expectedVersion,
        homeIntervalSeconds: home,
        activityIntervalSeconds: activity,
      }),
    },
    account.externalId,
  );
}

describe("administrator rate limits", () => {
  it("uses the fixed immutable identity, denies malformed allowlists, and keeps session lightweight", async () => {
    expect(
      isAdministrator(
        { ...env, ADMIN_LINUX_DO_IDS: "332940" },
        "linux_do",
        "332940",
      ),
    ).toBe(true);
    expect(
      isAdministrator(
        { ...env, ADMIN_LINUX_DO_IDS: "332940,no" },
        "linux_do",
        "332940",
      ),
    ).toBe(false);
    expect(
      isAdministrator(
        { ...env, ADMIN_LINUX_DO_IDS: "332940" },
        "other",
        "332940",
      ),
    ).toBe(false);
    const account = await actor();
    expect((await request("/api/admin/rate-limits")).status).toBe(401);
    expect((await request("/api/admin/rate-limits", account)).status).toBe(403);
    expect(
      (await request("/api/admin/rate-limits", account, undefined, "332940"))
        .status,
    ).toBe(403);
    const session = await request(
      "/api/session",
      account,
      undefined,
      account.externalId,
    );
    const body = (await session.json()) as {
      user: { isAdmin: boolean; email?: string };
      attemptCooldown: { revision: number; nextAllowedAt: number };
    };
    expect(session.headers.get("Cache-Control")).toContain("no-store");
    expect(body.user).toMatchObject({ isAdmin: true });
    expect(body.user).not.toHaveProperty("email");
    expect(body.attemptCooldown).toMatchObject({
      revision: 0,
      nextAllowedAt: 0,
    });
    const revoked = await request("/api/session", account);
    expect(await revoked.json()).toMatchObject({ user: { isAdmin: false } });
  });

  it("validates seconds and CSRF without changing configuration or creating audit entries", async () => {
    const account = await actor();
    const before = await config(account);
    expect(
      (await update(account, before.config.version, 3, 1, "bad")).status,
    ).toBe(403);
    for (const value of [0, 3601, 1.5])
      expect(
        (await update(account, before.config.version, value, 2)).status,
      ).toBe(400);
    expect(await config(account)).toEqual(before);
  });

  it("commits one version and audit under concurrent saves and leaves existing cooldown deadlines unchanged", async () => {
    const account = await actor();
    const before = await config(account);
    const until = Date.now() + 30_000;
    await env.DB.prepare(`INSERT INTO account_attempt_cooldowns
      (user_id,revision,accepted_at,next_allowed_at,origin,attempt_id) VALUES (?,1,?,?,'home',?)`)
      .bind(account.id, Date.now(), until, crypto.randomUUID())
      .run();
    const responses = await Promise.all([
      update(account, before.config.version, 3, 1),
      update(account, before.config.version, 7, 4),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const after = await config(account);
    expect(after.config.version).toBe(before.config.version + 1);
    expect(after.recentChanges[0]).toMatchObject({
      actorUserId: account.id,
      previousVersion: before.config.version,
      nextVersion: after.config.version,
      homeIntervalSeconds: after.config.homeIntervalSeconds,
      activityIntervalSeconds: after.config.activityIntervalSeconds,
    });
    expect(
      after.recentChanges.filter(
        (change) => change.nextVersion === after.config.version,
      ),
    ).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT next_allowed_at FROM account_attempt_cooldowns WHERE user_id=?",
      )
        .bind(account.id)
        .first(),
    ).toEqual({ next_allowed_at: until });
  });
});
