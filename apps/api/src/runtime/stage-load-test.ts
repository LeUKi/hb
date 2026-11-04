// 压测 (docs/claim-capacity-design.md §3 第 0 期): accounts for a load test,
// on Stage only. Without APP_ENV=staging and a STAGE_LOAD_TEST_KEY set on
// that deployment every route here answers 404, as if absent; with them, a
// request needs the key in X-Load-Test-Key. It makes only its own accounts
// (external ids "loadtest:<run>:<n>"), signs them in, and puts 🐟 in their
// 🐟额 the way an admin's 补加 does. Nothing here can reach anyone else.
import { Hono } from "hono";
import { hashSessionToken, SESSION_TTL_SECONDS } from "../auth/session";
import { adjustBalance } from "../balance/ledger";
import type { ApiContext } from "../env";
import { randomToken } from "../security/crypto";

const EXTERNAL_PREFIX = "loadtest:";
const MAX_ACCOUNTS = 1000;

/** Equal, without telling how much of it matched. */
function sameKey(given: string, expected: string) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let differ = 0;
  for (let index = 0; index < a.length; index += 1)
    differ |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return differ === 0;
}

const notFound = () =>
  Response.json(
    { error: { code: "NOT_FOUND", message: "Not found" } },
    { status: 404 },
  );

export const stageLoadTestRoutes = new Hono<ApiContext>()
  .use("/__stage/load-test/*", async (c, next) => {
    const key = c.env.STAGE_LOAD_TEST_KEY;
    if (
      c.env.APP_ENV !== "staging" ||
      !key ||
      !sameKey(c.req.header("X-Load-Test-Key") ?? "", key)
    )
      return notFound();
    c.header("Cache-Control", "no-store");
    await next();
  })
  // Accounts for one run, signed in: their session tokens and CSRF tokens.
  .post("/__stage/load-test/accounts", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      run?: unknown;
      count?: unknown;
    };
    const run = typeof body.run === "string" ? body.run : "";
    const count = Number(body.count);
    if (
      !/^[a-z0-9-]{1,32}$/.test(run) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_ACCOUNTS
    )
      return Response.json(
        { error: { code: "INVALID_REQUEST", message: "run, count 1–1000" } },
        { status: 400 },
      );
    const now = Date.now();
    const accounts: {
      id: string;
      username: string;
      session: string;
      csrf: string;
    }[] = [];
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = crypto.randomUUID();
      const username = `lt-${run}-${index}`;
      const session = await randomToken(32);
      const csrf = await randomToken(32);
      accounts.push({ id, username, session, csrf });
      statements.push(
        c.env.DB.prepare(`INSERT INTO users
          (id, provider, external_id, username, display_name, active, created_at, updated_at, last_login_at, trust_level, silenced, profile_seen_at)
          VALUES (?, 'linux_do', ?, ?, ?, 1, ?, ?, ?, 1, 0, ?)`).bind(
          id,
          `${EXTERNAL_PREFIX}${run}:${index}`,
          username,
          `压测 ${run} ${index}`,
          now,
          now,
          now,
          now,
        ),
        c.env.DB.prepare(`INSERT INTO sessions
          (token_hash, user_id, csrf_token, created_at, expires_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)`).bind(
          await hashSessionToken(session),
          id,
          csrf,
          now,
          now + SESSION_TTL_SECONDS * 1000,
          now,
        ),
      );
    }
    for (let start = 0; start < statements.length; start += 100)
      await c.env.DB.batch(statements.slice(start, start + 100));
    return Response.json({ accounts });
  })
  // 🐟 into one test account's 🐟额, recorded as another's 补加.
  .post("/__stage/load-test/fish", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      actorId?: unknown;
      userId?: unknown;
      amount?: unknown;
    };
    const ids = [body.actorId, body.userId];
    if (
      !ids.every((id) => typeof id === "string") ||
      typeof body.amount !== "string"
    )
      return Response.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "actorId, userId, amount",
          },
        },
        { status: 400 },
      );
    const tested = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?) AND external_id LIKE '${EXTERNAL_PREFIX}%'`,
    )
      .bind(body.actorId, body.userId)
      .first<number>("n");
    if (tested !== 2) return notFound();
    return Response.json(
      await adjustBalance(
        c.env,
        body.actorId as string,
        body.userId as string,
        {
          requestId: crypto.randomUUID(),
          direction: "add",
          amount: body.amount,
          reason: "压测",
        },
      ),
    );
  })
  // A run's sessions end.
  .post("/__stage/load-test/end", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { run?: unknown };
    const run = typeof body.run === "string" ? body.run : "";
    if (!/^[a-z0-9-]{1,32}$/.test(run))
      return Response.json(
        { error: { code: "INVALID_REQUEST", message: "run" } },
        { status: 400 },
      );
    const result = await c.env.DB.prepare(
      "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE external_id LIKE ?)",
    )
      .bind(`${EXTERNAL_PREFIX}${run}:%`)
      .run();
    return Response.json({ sessionsEnded: result.meta.changes });
  });
