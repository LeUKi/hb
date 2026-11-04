// 压测 (docs/claim-capacity-design.md §3 第 0 期, §4): N people claim one
// 红包 on Stage within T seconds, each at their own moment, the way a
// popular post's readers do. The accounts come from Stage's own test login
// (apps/api/src/runtime/stage-load-test.ts), so STAGE_LOAD_TEST_KEY must be
// set in the environment, as it is on Stage. Prints each claim's time and
// the totals the design measures against: everyone answered within 90 s,
// 95% within 3 s, shares a minute.
//
//   STAGE_LOAD_TEST_KEY=… bun scripts/claim-load-test.ts --people 500 --seconds 60
//
// --base     the site (https://staging.hb.lafi.sh)
// --people   claimants (500)
// --seconds  over how long they come (60)
// --shares   the 红包's shares (as many as people)
// --funding  fish: a 🐟额红包 (default); merchant: a simulated merchant's,
//            the way production's 商户直发 goes (Stage's
//            STAGE_SIMULATED_PAYMENTS, apps/api/src/runtime/controls.ts)
// --out      a JSON file for every claim's record
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "https://staging.hb.lafi.sh" },
    people: { type: "string", default: "500" },
    seconds: { type: "string", default: "60" },
    shares: { type: "string" },
    funding: { type: "string", default: "fish" },
    out: { type: "string" },
  },
});
const base = (values.base ?? "").replace(/\/$/, "");
const people = Number(values.people);
const seconds = Number(values.seconds);
const shares = Number(values.shares ?? values.people);
const key = process.env.STAGE_LOAD_TEST_KEY;
if (!key) throw new Error("STAGE_LOAD_TEST_KEY is not set");
if (!(people >= 1 && people <= 998 && seconds > 0 && shares >= 1))
  throw new Error("--people 1–998, --seconds > 0, --shares ≥ 1");
const merchant = values.funding === "merchant";
if (!merchant && values.funding !== "fish")
  throw new Error("--funding fish or merchant");
const run = `r${Date.now().toString(36)}`;

type Account = { id: string; username: string; session: string; csrf: string };

async function stage(path: string, body: unknown) {
  const response = await fetch(`${base}/api/__stage/load-test/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Load-Test-Key": key ?? "",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

function as(account: Account, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      Cookie: `hb_session=${account.session}`,
      ...(method === "GET"
        ? {}
        : {
            Origin: base,
            "Content-Type": "application/json",
            "X-CSRF-Token": account.csrf,
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const { accounts } = (await stage("accounts", {
  run,
  count: people + 2,
})) as { accounts: Account[] };
const [author, actor, ...claimants] = accounts as [
  Account,
  Account,
  ...Account[],
];
// Each share at least 0.01, and some over for 拼手气.
const total = Math.max(shares * 0.02, 1).toFixed(2);
const merchantId = merchant
  ? (
      (await (
        await as(author, "POST", "/api/me/merchants", {
          requestId: crypto.randomUUID(),
          mode: "simulation",
          label: `压测 ${run}`,
          clientId: `loadtest_${run}`,
          secret: "simulated-only",
        })
      ).json()) as { merchant?: { id: string }; id?: string }
    ).merchant?.id
  : undefined;
if (merchant && !merchantId) throw new Error("no simulated merchant");
if (!merchant)
  await stage("fish", {
    actorId: actor.id,
    userId: author.id,
    amount: (Number(total) + 1).toFixed(2),
  });

const created = await as(author, "POST", "/api/activities", {
  requestId: crypto.randomUUID(),
  activity: {
    title: `压测 ${run}`,
    topicUrl: "",
    forceDedicated: false,
    joinSquare: false,
    deadline: { mode: "duration" },
    allocation: "random",
    passwords: [],
    quantityVisibility: "exact",
    beforeInfo: "",
    afterClaimInfo: "",
    afterEndInfo: "",
    rewardType: "ldc",
    ...(merchant
      ? { funding: "merchant", merchantId }
      : { funding: "balance", merchantId: "" }),
    participationMode: "direct",
    money: {
      mode: "random",
      totalAmount: total,
      count: shares,
      algorithm: "double_mean_v1",
    },
  },
});
if (!created.ok)
  throw new Error(`create: ${created.status} ${await created.text()}`);
const { activity } = (await created.json()) as {
  activity: { id: string; version: number };
};
const opened = await as(
  author,
  "POST",
  `/api/me/activities/${activity.id}/open`,
  {
    version: activity.version,
  },
);
if (!opened.ok)
  throw new Error(`open: ${opened.status} ${await opened.text()}`);
console.log(
  `红包 ${activity.id}: ${shares} 份, ${total} ${merchant ? "LDC (模拟商户)" : "🐟"}; ${people} 人, ${seconds} 秒内`,
);

type Record = {
  at: number;
  ms: number;
  status: number;
  result: string;
};
const started = performance.now();
const records: Record[] = await Promise.all(
  claimants.slice(0, people).map(async (account, index) => {
    // Spread evenly over the time, each a little off.
    const at = ((index + Math.random()) / people) * seconds * 1000;
    await new Promise((resolve) => setTimeout(resolve, at));
    const begin = performance.now();
    let status = 0;
    let result = "network";
    try {
      const response = await as(
        account,
        "POST",
        `/api/activities/${activity.id}/claim`,
        { participationMode: "direct", submissionId: crypto.randomUUID() },
      );
      status = response.status;
      const body = (await response.json().catch(() => ({}))) as {
        result?: string;
        error?: { code?: string };
      };
      result = body.result ?? body.error?.code ?? `http_${status}`;
    } catch {
      // Counted as a network failure.
    }
    return {
      at: begin - started,
      ms: performance.now() - begin,
      status,
      result,
    };
  }),
);
const finished = performance.now() - started;

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const times = records.map((r) => r.ms).sort((a, b) => a - b);
const outcomes: { [result: string]: number } = {};
for (const r of records) outcomes[r.result] = (outcomes[r.result] ?? 0) + 1;
const claimedEnds = records
  .filter((r) => r.result === "claimed")
  .map((r) => r.at + r.ms)
  .sort((a, b) => a - b);
const perTen: number[] = [];
for (const end of claimedEnds) {
  const slot = Math.floor(end / 10_000);
  perTen[slot] = (perTen[slot] ?? 0) + 1;
}
const lastAnswer = Math.max(...records.map((r) => r.at + r.ms));
const read = (await (
  await as(author, "GET", `/api/activities/${activity.id}`)
).json()) as { activity: { quantity: unknown } };

const summary = {
  run,
  funding: merchant ? "merchant" : "fish",
  activityId: activity.id,
  people,
  seconds,
  shares,
  outcomes,
  ms: {
    p50: Math.round(quantile(times, 0.5)),
    p90: Math.round(quantile(times, 0.9)),
    p95: Math.round(quantile(times, 0.95)),
    p99: Math.round(quantile(times, 0.99)),
    max: Math.round(times.at(-1) ?? 0),
  },
  within3s: `${((times.filter((t) => t <= 3000).length / times.length) * 100).toFixed(1)}%`,
  lastAnswerSeconds: Math.round(lastAnswer / 100) / 10,
  allWithin90s: lastAnswer <= 90_000,
  claimedPerTenSeconds: Array.from(perTen, (n) => n ?? 0),
  claimedPerMinute: Math.round(
    (claimedEnds.length /
      Math.max(1, (claimedEnds.at(-1) ?? 0) - (claimedEnds[0] ?? 0))) *
      60_000,
  ),
  quantity: read.activity.quantity,
  wallSeconds: Math.round(finished / 100) / 10,
};
console.log(JSON.stringify(summary, null, 2));
if (values.out)
  writeFileSync(values.out, JSON.stringify({ summary, records }, null, 2));
await stage("end", { run });
