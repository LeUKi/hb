// 个人令牌's statistics (docs/personal-token-design.md §8): every request with
// a token is one Analytics Engine data point (personal-token.ts), indexed by
// its account, with its kind, how it went and its token. These read them back
// through the SQL API, by hour for a day and by day for 30, for its owner and
// for the 站长. Answers are cached a minute: a page read twice asks once.

import type {
  MyPersonalTokenUsage,
  PersonalTokenRequestKind,
  PersonalTokenUsage,
  PersonalTokenUsageBucket,
} from "@hb/contracts";
import type { ApiBindings } from "../env";
import { BEIJING_OFFSET_MS, startOfBeijingDay } from "../runtime/day";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CACHE_SECONDS = 60;
const KINDS: PersonalTokenRequestKind[] = [
  "read",
  "square",
  "claim",
  "identity",
];

type Point = { at: number; kind: string; outcome: string; n: number };

function datasetOf(env: ApiBindings) {
  return env.APP_ENV === "production"
    ? "hb_token_requests_production"
    : "hb_token_requests_staging";
}

function readable(env: ApiBindings) {
  return Boolean(
    env.TOKEN_STATS_ACCOUNT_ID?.trim() && env.TOKEN_STATS_API_TOKEN?.trim(),
  );
}

/** An account id is put into the SQL as text: a UUID and nothing else. */
function accountFilter(userId?: string) {
  if (userId === undefined) return "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      userId,
    )
  )
    throw new Error("Invalid account id");
  return `AND index1 = '${userId}'`;
}

async function sql<T>(env: ApiBindings, query: string): Promise<T[]> {
  const key = new Request(
    `https://token-stats.internal/${encodeURIComponent(query)}`,
  );
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return ((await hit.json()) as { data: T[] }).data;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.TOKEN_STATS_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TOKEN_STATS_API_TOKEN}` },
      body: query,
    },
  );
  if (!response.ok)
    throw new Error(`Analytics Engine answered ${response.status}`);
  const body = (await response.json()) as { data: T[] };
  await cache
    .put(
      key,
      new Response(JSON.stringify({ data: body.data }), {
        headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` },
      }),
    )
    .catch(() => undefined);
  return body.data;
}

/** "2026-11-15 04:00:00" (UTC, as the SQL API writes it) → ms. */
function utc(value: string) {
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

async function points(
  env: ApiBindings,
  step: "HOUR" | "DAY",
  userId?: string,
): Promise<Point[]> {
  // A day from Beijing midnight: shift, bucket, shift back.
  const span = step === "HOUR" ? "INTERVAL '1' DAY" : "INTERVAL '30' DAY";
  const bucket =
    step === "HOUR"
      ? "toStartOfInterval(timestamp, INTERVAL '1' HOUR)"
      : "toStartOfInterval(timestamp + INTERVAL '8' HOUR, INTERVAL '1' DAY)";
  const rows = await sql<{
    t: string;
    kind: string;
    outcome: string;
    n: number | string;
  }>(
    env,
    `SELECT ${bucket} AS t, blob1 AS kind, blob2 AS outcome, SUM(_sample_interval) AS n
     FROM ${datasetOf(env)}
     WHERE timestamp > NOW() - ${span} ${accountFilter(userId)}
     GROUP BY t, kind, outcome ORDER BY t`,
  );
  return rows.map((row) => ({
    // Undo the query's `+ INTERVAL '8' HOUR`: days count from Beijing midnight.
    at: step === "HOUR" ? utc(row.t) : utc(row.t) - BEIJING_OFFSET_MS,
    kind: row.kind,
    outcome: row.outcome,
    n: Number(row.n) || 0,
  }));
}

/** Every hour or day of the span, zeros where nothing came. */
function buckets(
  from: number,
  count: number,
  size: number,
  found: Point[],
): PersonalTokenUsageBucket[] {
  const all = Array.from({ length: count }, (_, index) => ({
    at: new Date(from + index * size).toISOString(),
    read: 0,
    square: 0,
    claim: 0,
    identity: 0,
    limited: 0,
    paused: 0,
  }));
  for (const point of found) {
    const index = Math.round((point.at - from) / size);
    const bucket = all[index];
    if (!bucket) continue;
    if (point.outcome === "limited") bucket.limited += point.n;
    else if (point.outcome === "paused") bucket.paused += point.n;
    else if ((KINDS as string[]).includes(point.kind))
      bucket[point.kind as PersonalTokenRequestKind] += point.n;
  }
  return all;
}

function empty(): PersonalTokenUsage {
  return { available: false, hours: [], days: [] };
}

/** By hour for 24 hours and by day for 30: one account's, or everyone's. */
export async function tokenUsage(
  env: ApiBindings,
  userId?: string,
  now = Date.now(),
): Promise<PersonalTokenUsage> {
  if (!readable(env)) return empty();
  try {
    const [hours, days] = await Promise.all([
      points(env, "HOUR", userId),
      points(env, "DAY", userId),
    ]);
    const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const today = startOfBeijingDay(now);
    return {
      available: true,
      hours: buckets(thisHour - 23 * HOUR_MS, 24, HOUR_MS, hours),
      days: buckets(today - 29 * DAY_MS, 30, DAY_MS, days),
    };
  } catch (error) {
    console.error("personal_token_stats_failed", { error: String(error) });
    return empty();
  }
}

/** Someone's own, with each token's last 30 days. */
export async function myTokenUsage(
  env: ApiBindings,
  userId: string,
): Promise<MyPersonalTokenUsage> {
  const usage = await tokenUsage(env, userId);
  if (!usage.available) return { ...usage, tokens: [] };
  try {
    const rows = await sql<{ token: string; outcome: string; n: number }>(
      env,
      `SELECT blob3 AS token, blob2 AS outcome, SUM(_sample_interval) AS n
       FROM ${datasetOf(env)}
       WHERE timestamp > NOW() - INTERVAL '30' DAY ${accountFilter(userId)}
       GROUP BY token, outcome`,
    );
    const tokens = new Map<
      string,
      { id: string; calls: number; limited: number }
    >();
    for (const row of rows) {
      const entry = tokens.get(row.token) ?? {
        id: row.token,
        calls: 0,
        limited: 0,
      };
      if (row.outcome === "limited") entry.limited += Number(row.n) || 0;
      else entry.calls += Number(row.n) || 0;
      tokens.set(row.token, entry);
    }
    return { ...usage, tokens: [...tokens.values()] };
  } catch (error) {
    console.error("personal_token_stats_failed", { error: String(error) });
    return { ...usage, tokens: [] };
  }
}

/** The last 24 hours' busiest accounts (the 站长's). */
export async function busiestTokenAccounts(env: ApiBindings) {
  if (!readable(env)) return [];
  try {
    const rows = await sql<{ account: string; outcome: string; n: number }>(
      env,
      `SELECT index1 AS account, blob2 AS outcome, SUM(_sample_interval) AS n
       FROM ${datasetOf(env)}
       WHERE timestamp > NOW() - INTERVAL '1' DAY
       GROUP BY account, outcome ORDER BY n DESC LIMIT 500`,
    );
    const accounts = new Map<
      string,
      { userId: string; calls: number; limited: number }
    >();
    for (const row of rows) {
      const entry = accounts.get(row.account) ?? {
        userId: row.account,
        calls: 0,
        limited: 0,
      };
      if (row.outcome === "limited") entry.limited += Number(row.n) || 0;
      else entry.calls += Number(row.n) || 0;
      accounts.set(row.account, entry);
    }
    const top = [...accounts.values()]
      .sort((a, b) => b.calls + b.limited - (a.calls + a.limited))
      .slice(0, 20);
    if (!top.length) return [];
    const people = await env.DB.prepare(
      `SELECT id, username, display_name, avatar_url FROM users
       WHERE id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(top.map((entry) => entry.userId)))
      .all<{
        id: string;
        username: string;
        display_name: string;
        avatar_url: string | null;
      }>();
    const byId = new Map(people.results.map((person) => [person.id, person]));
    return top.map((entry) => {
      const person = byId.get(entry.userId);
      return {
        ...entry,
        username: person?.username ?? null,
        displayName: person?.display_name ?? null,
        avatarUrl: person?.avatar_url ?? null,
      };
    });
  } catch (error) {
    console.error("personal_token_stats_failed", { error: String(error) });
    return [];
  }
}
