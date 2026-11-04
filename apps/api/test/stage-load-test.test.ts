import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";

const origin = "https://hb.example.com";
const key = "stage-load-test-key-for-tests";
const stage: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  APP_ENV: "staging",
  STAGE_LOAD_TEST_KEY: key,
};

function call(
  path: string,
  body: unknown,
  bindings: ApiBindings = stage,
  headers: Record<string, string> = { "X-Load-Test-Key": key },
) {
  return app.request(
    `${origin}/api/__stage/load-test/${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

type Account = { id: string; username: string; session: string; csrf: string };

describe("Stage load-test accounts", () => {
  it("are not there outside Stage, without its key, or with a wrong one", async () => {
    const body = { run: "absent", count: 1 };
    for (const bindings of [
      { ...env, APP_ORIGIN: origin },
      { ...stage, APP_ENV: "production" },
      { ...stage, STAGE_LOAD_TEST_KEY: undefined },
    ])
      expect((await call("accounts", body, bindings)).status).toBe(404);
    expect((await call("accounts", body, stage, {})).status).toBe(404);
    expect(
      (await call("accounts", body, stage, { "X-Load-Test-Key": `${key}x` }))
        .status,
    ).toBe(404);
    const made = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE external_id LIKE 'loadtest:absent:%'",
    ).first<number>("n");
    expect(made).toBe(0);
  });

  it("makes signed-in accounts of their own, puts 🐟 only in theirs, and ends their sessions", async () => {
    const response = await call("accounts", { run: "unit", count: 3 });
    expect(response.status).toBe(200);
    const { accounts } = (await response.json()) as { accounts: Account[] };
    expect(accounts).toHaveLength(3);
    const [author, other] = accounts as [Account, Account, Account];
    const session = await app.request(
      `${origin}/api/session`,
      { headers: { Cookie: `hb_session=${author.session}` } },
      stage,
    );
    expect(
      ((await session.json()) as { user: { username: string } }).user.username,
    ).toBe(author.username);

    const fish = await call("fish", {
      actorId: other.id,
      userId: author.id,
      amount: "10.00",
    });
    expect(fish.status).toBe(200);
    const now = new Date();
    const outsider = crypto.randomUUID();
    await createDb(env.DB).insert(users).values({
      id: outsider,
      externalId: "real-person",
      username: "real-person",
      displayName: "真人",
      createdAt: now,
      updatedAt: now,
    });
    expect(
      (
        await call("fish", {
          actorId: other.id,
          userId: outsider,
          amount: "10.00",
        })
      ).status,
    ).toBe(404);

    const ended = await call("end", { run: "unit" });
    expect(
      ((await ended.json()) as { sessionsEnded: number }).sessionsEnded,
    ).toBe(3);
    const after = await app.request(
      `${origin}/api/session`,
      { headers: { Cookie: `hb_session=${author.session}` } },
      stage,
    );
    expect(((await after.json()) as { user: unknown }).user).toBeNull();
  });
});
