import { env } from "cloudflare:test";
import type { LoginSettingsResponse } from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { oauthAttempts, sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
type Actor = { id: string; externalId: string; cookie: string; csrf: string };
let admin: Actor;
let member: Actor;

async function actor(): Promise<Actor> {
  const id = crypto.randomUUID();
  const externalId = BigInt(
    `0x${id.replaceAll("-", "").slice(0, 12)}`,
  ).toString();
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId,
    username: id,
    displayName: id,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: csrf,
    loginProvider: "liteauth",
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  });
  return { id, externalId, cookie: `hb_session=${token}`, csrf };
}

function request(account?: Actor, body?: unknown, csrf = account?.csrf) {
  return app.request(
    `${origin}/api/admin/login-settings`,
    {
      method: body === undefined ? "GET" : "PATCH",
      headers: {
        ...(account ? { Cookie: account.cookie } : {}),
        ...(body === undefined
          ? {}
          : {
              Origin: origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": csrf ?? "",
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {
      ...env,
      APP_ORIGIN: origin,
      ADMIN_LINUX_DO_IDS: admin.externalId,
    } satisfies ApiBindings,
  );
}

async function read() {
  const response = await request(admin);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  return response.json() as Promise<LoginSettingsResponse>;
}

beforeEach(async () => {
  admin = await actor();
  member = await actor();
});

describe("administrator login settings", () => {
  it("defaults enabled and protects both reads and writes with the fixed admin identity and CSRF", async () => {
    const before = await read();
    expect(typeof before.config.liteauthEnabled).toBe("boolean");
    expect(before.config).toMatchObject({ version: 1, liteauthEnabled: true });
    expect((await request()).status).toBe(401);
    expect((await request(member)).status).toBe(403);
    const input = {
      expectedVersion: before.config.version,
      liteauthEnabled: false,
    };
    expect((await request(member, input)).status).toBe(403);
    expect((await request(admin, input, "bad")).status).toBe(403);
    for (const body of [
      { ...input, liteauthEnabled: "false" },
      { ...input, expectedVersion: 0 },
      { ...input, allowRealSend: true },
    ])
      expect((await request(admin, body)).status).toBe(400);
    expect(await read()).toEqual(before);
  });

  it("disables atomically with audit and invalidates only unfinished LiteAUTH authorizations", async () => {
    const db = createDb(env.DB);
    const now = new Date();
    const liteState = crypto.randomUUID();
    const officialState = crypto.randomUUID();
    await db.insert(oauthAttempts).values(
      ["liteauth", "connect"].map((provider) => ({
        stateHash: provider === "liteauth" ? liteState : officialState,
        cookieHash: crypto.randomUUID(),
        loginProvider: provider as "liteauth" | "connect",
        returnTo: "/account",
        createdAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
        pkceVerifierCiphertext:
          provider === "liteauth" ? "encrypted-test-state" : null,
      })),
    );
    const untouchedBefore = await env.DB.batch([
      env.DB.prepare("SELECT * FROM sessions ORDER BY token_hash"),
      env.DB.prepare("SELECT * FROM attempt_rate_limits ORDER BY id"),
      env.DB.prepare("SELECT * FROM platform_controls ORDER BY id"),
    ]);
    const before = await read();
    const response = await request(admin, {
      expectedVersion: before.config.version,
      liteauthEnabled: false,
    });
    expect(response.status).toBe(200);
    const after = await read();
    expect(after.config).toMatchObject({
      version: before.config.version + 1,
      liteauthEnabled: false,
      updatedByUserId: admin.id,
    });
    expect(after.recentChanges[0]).toMatchObject({
      actorUserId: admin.id,
      previousVersion: before.config.version,
      nextVersion: after.config.version,
      previousLiteauthEnabled: before.config.liteauthEnabled,
      liteauthEnabled: false,
    });
    expect(
      await env.DB.prepare(
        "SELECT state_hash FROM oauth_attempts WHERE state_hash IN (?,?)",
      )
        .bind(liteState, officialState)
        .all(),
    ).toMatchObject({ results: [{ state_hash: officialState }] });
    const untouchedAfter = await env.DB.batch([
      env.DB.prepare("SELECT * FROM sessions ORDER BY token_hash"),
      env.DB.prepare("SELECT * FROM attempt_rate_limits ORDER BY id"),
      env.DB.prepare("SELECT * FROM platform_controls ORDER BY id"),
    ]);
    expect(untouchedAfter.map((r) => r.results)).toEqual(
      untouchedBefore.map((r) => r.results),
    );
    const enabled = await request(admin, {
      expectedVersion: after.config.version,
      liteauthEnabled: true,
    });
    expect(enabled.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT state_hash FROM oauth_attempts WHERE state_hash=?",
      )
        .bind(liteState)
        .first(),
    ).toBeNull();
  });

  it("accepts one concurrent version and leaves no audit or authorization deletion from a losing save", async () => {
    const before = await read();
    const responses = await Promise.all([
      request(admin, {
        expectedVersion: before.config.version,
        liteauthEnabled: true,
      }),
      request(admin, {
        expectedVersion: before.config.version,
        liteauthEnabled: false,
      }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = await read();
    expect(after.config.version).toBe(before.config.version + 1);
    expect(
      after.recentChanges.filter((r) => r.nextVersion === after.config.version),
    ).toHaveLength(1);
    const conflict = responses.find((r) => r.status === 409);
    expect(await conflict?.json()).toMatchObject({
      error: { code: "LOGIN_SETTINGS_CONFLICT" },
    });
    const now = new Date();
    const stateHash = crypto.randomUUID();
    await createDb(env.DB)
      .insert(oauthAttempts)
      .values({
        stateHash,
        cookieHash: crypto.randomUUID(),
        loginProvider: "liteauth",
        returnTo: "/",
        createdAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
      });
    expect(
      (
        await request(admin, {
          expectedVersion: before.config.version,
          liteauthEnabled: false,
        })
      ).status,
    ).toBe(409);
    expect(
      await env.DB.prepare(
        "SELECT state_hash FROM oauth_attempts WHERE state_hash=?",
      )
        .bind(stateHash)
        .first(),
    ).not.toBeNull();
    expect(await read()).toEqual(after);
  });

  it("returns only the latest 20 changes with boolean values and descending versions", async () => {
    let current = await read();
    for (let i = 0; i < 21; i++) {
      const response = await request(admin, {
        expectedVersion: current.config.version,
        liteauthEnabled: !current.config.liteauthEnabled,
      });
      expect(response.status).toBe(200);
      current = (await response.json()) as LoginSettingsResponse;
    }
    expect(current.recentChanges).toHaveLength(20);
    expect(current.recentChanges.map((r) => r.nextVersion)).toEqual(
      Array.from({ length: 20 }, (_, i) => current.config.version - i),
    );
    expect(
      current.recentChanges.every(
        (r) =>
          typeof r.previousLiteauthEnabled === "boolean" &&
          typeof r.liteauthEnabled === "boolean",
      ),
    ).toBe(true);
  });
});
