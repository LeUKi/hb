import { env } from "cloudflare:test";
import type {
  CodeMoney,
  JudgeInput,
  ManagedActivity,
  MyJudgmentList,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createActivity,
  getPublicActivity,
  openActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import { NetworkSession } from "../src/judge/session";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import {
  type Actor,
  actor,
  bindings,
  check,
  coded,
  give,
  judgeSettings,
  origin,
  plus,
  settings,
  unique,
} from "./code-fixtures";

// 代码判定联网 (docs/programmable-hongbao-design.md §9): code that exports
// network asks only those addresses, through the gateway, and what it asked
// and got is kept with its judgment.

const API = "https://api.example.com/hb/";
const NETWORKED = `export const network = ["${API}"];
export async function judge(submission) {
  const response = await fetch("${API}check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: submission.input }),
  });
  const answer = await response.json();
  return answer.right
    ? { ok: true, amount: 30, message: answer.say }
    : { ok: false, message: answer.say };
}
`;
const NETWORKED_TESTS = JSON.stringify({
  tests: [
    {
      name: "对",
      input: "x",
      fetch: [
        {
          url: `${API}check`,
          method: "POST",
          json: { right: true, say: "服务器说对" },
        },
      ],
      expect: { ok: true, amount: 30, message: "服务器说对" },
    },
  ],
});

let admin: Actor;
let author: Actor;
const realFetch = globalThis.fetch;
type Sent = {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
};
/** What reached "the internet", and how it answers. */
let outside: Sent[] = [];
let answer: (request: Request) => Promise<Response> = async () =>
  Response.json({ right: false, say: "不对" });

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1 });
  await judgeSettings({ enabled: 1, network_enabled: 1 });
  await plus(author);
  await give(admin, author, "5.00");
  outside = [];
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.startsWith("https://api.example.com/")) {
      outside.push({
        method: request.method,
        url: request.url,
        body: await request.clone().text(),
        headers: Object.fromEntries(request.headers),
      });
      return answer(request);
    }
    return fallback(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function open(
  judge: Partial<JudgeInput> = {},
  money: Partial<CodeMoney> = {},
) {
  const input = coded(money, {
    code: unique(NETWORKED),
    tests: NETWORKED_TESTS,
    ...judge,
  });
  const passed = await check(author, input.judge?.code, input.judge?.tests);
  expect(passed.body.check).toMatchObject({
    passed: true,
    network: [API],
    protocol: 5,
  });
  const saved = await createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return openActivity(bindings, saved.id, author.id, saved.version);
}

async function claim(activityId: string, user: Actor, input: string) {
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
        participationMode: "code",
        input,
      }),
    },
    bindings,
  );
  await advanceAttemptCooldown(env.DB, user.id);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("代码判定联网", () => {
  it("asks the address through the gateway and keeps what it got", async () => {
    const opened = await open();
    expect((await getPublicActivity(bindings, opened.id)).judge).toMatchObject({
      protocol: 5,
      network: [API],
    });
    answer = async () => Response.json({ right: true, say: "服务器说对" });
    const claimant = await actor();
    const result = await claim(opened.id, claimant, "flag");
    expect(result.status).toBe(200);
    // Protocol 5: judged, and settled at once ({ ok: true, amount }).
    expect(result.body).toMatchObject({
      result: "judged",
      settled: { claim: { amount: "0.30" } },
    });
    expect(outside).toHaveLength(1);
    const sent = outside[0] as Sent;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe(`${API}check`);
    expect(JSON.parse(sent.body)).toEqual({ input: "flag" });
    expect(sent.headers["x-hb-hongbao"]).toBe(opened.id);
    expect(sent.headers["user-agent"]).toContain("hb.lafi.sh-judge");
    const stored = await env.DB.prepare(
      "SELECT fetches_ciphertext AS f FROM code_judgments WHERE activity_id = ?",
    )
      .bind(opened.id)
      .first<{ f: string | null }>();
    expect(stored?.f).toBeTruthy();
    const mine = await app.request(
      `${origin}/api/activities/${opened.id}/judgments`,
      { headers: { Cookie: claimant.cookie } },
      bindings,
    );
    const list = (await mine.json()) as MyJudgmentList;
    expect(list.items[0]?.fetches).toBeUndefined();
  });

  it("shows the claimant what came back once it is over, and gives the sender all of it", async () => {
    // The pool taken at once: settled, it is over.
    const opened = await open({}, { totalAmount: "0.30" });
    answer = async () =>
      Response.json({ right: true, say: "服务器说对" }, { status: 201 });
    const claimant = await actor();
    expect((await claim(opened.id, claimant, "flag")).body).toMatchObject({
      result: "judged",
      settled: { claim: { amount: "0.30" } },
    });
    const mine = await app.request(
      `${origin}/api/activities/${opened.id}/judgments`,
      { headers: { Cookie: claimant.cookie } },
      bindings,
    );
    expect(((await mine.json()) as MyJudgmentList).items[0]?.fetches).toEqual([
      {
        host: "api.example.com",
        status: 201,
        response: JSON.stringify({ right: true, say: "服务器说对" }),
      },
    ]);
    const records = await app.request(
      `${origin}/api/me/activities/${opened.id}/judge-records`,
      { headers: { Cookie: author.cookie } },
      bindings,
    );
    const body = (await records.json()) as {
      protocol: number;
      network: string[];
      judgments: { fetches?: Record<string, unknown>[] }[];
    };
    expect(body.protocol).toBe(5);
    expect(body.network).toEqual([API]);
    expect(body.judgments[0]?.fetches).toEqual([
      expect.objectContaining({
        method: "POST",
        url: `${API}check`,
        body: JSON.stringify({ input: "flag" }),
        status: 201,
        response: JSON.stringify({ right: true, say: "服务器说对" }),
      }),
    ]);
  });

  it("asks nothing outside the list, nothing past three, and says why", async () => {
    const tries = `export const network = ["${API}"];
export async function judge(submission) {
  const said = [];
  for (const address of submission.input.split(" ")) {
    try {
      const response = await fetch(address);
      said.push(String(response.status));
    } catch (error) {
      said.push(error.message);
    }
  }
  return { ok: false, message: said.join("|").slice(0, 100) };
}
`;
    const tests = JSON.stringify({
      tests: [{ name: "不发", input: "x", expect: { ok: false } }],
    });
    const opened = await open({ code: unique(tries), tests });
    answer = async () => new Response("ok");
    const claimant = await actor();
    const outsideList = await claim(
      opened.id,
      claimant,
      "https://api.example.com/other https://evil.example.com/hb/",
    );
    expect(outsideList.body).toMatchObject({ result: "judged" });
    expect(String(outsideList.body.message)).toContain(
      "联网失败：这个地址不在白名单里",
    );
    expect(outside).toHaveLength(0);
    const four = await claim(
      opened.id,
      claimant,
      [1, 2, 3, 4].map((n) => `${API}${n}`).join(" "),
    );
    expect(String(four.body.message)).toBe(
      "200|200|200|联网失败：这次判定已经发了 3 个请求",
    );
    expect(outside).toHaveLength(3);
  });

  it("tells a failed request from an answer: unreachable, too big, a redirect", async () => {
    const tries = `export const network = ["${API}"];
export async function judge(submission) {
  try {
    const response = await fetch("${API}" + submission.input);
    return { ok: false, message: String(response.status) };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}
`;
    const tests = JSON.stringify({
      tests: [
        {
          name: "不发",
          input: "x",
          fetch: [{ url: `${API}x`, status: 302 }],
          expect: { ok: false, message: "302" },
        },
      ],
    });
    const opened = await open({ code: unique(tries), tests });
    answer = async (request) => {
      if (request.url.endsWith("down")) throw new TypeError("refused");
      if (request.url.endsWith("big")) return new Response("x".repeat(70_000));
      return new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example.com/" },
      });
    };
    const claimant = await actor();
    expect((await claim(opened.id, claimant, "down")).body.message).toBe(
      "联网失败：连不上对方",
    );
    expect((await claim(opened.id, claimant, "big")).body.message).toBe(
      "联网失败：返回超过 64 KB",
    );
    expect((await claim(opened.id, claimant, "moved")).body.message).toBe(
      "302",
    );
    // Only the three asked, no redirect followed.
    expect(outside.map((sent) => sent.url)).toEqual(
      ["down", "big", "moved"].map((end) => `${API}${end}`),
    );
  });

  it("neither deploys nor opens code that goes online while 联网 is off", async () => {
    const input = coded(
      {},
      { code: unique(NETWORKED), tests: NETWORKED_TESTS },
    );
    expect(
      (await check(author, input.judge?.code, input.judge?.tests)).body.check,
    ).toMatchObject({ passed: true });
    const saved = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: input,
    });
    await judgeSettings({ network_enabled: 0 });
    const blocked = await app.request(
      `${origin}/api/me/activities/${saved.id}`,
      { headers: { Cookie: author.cookie } },
      bindings,
    );
    expect(
      ((await blocked.json()) as { activity: ManagedActivity }).activity
        .openingBlockedReason,
    ).toBe("CODE_NETWORK_PAUSED");
    await expect(
      openActivity(bindings, saved.id, author.id, saved.version),
    ).rejects.toMatchObject({ code: "CODE_NETWORK_PAUSED" });
    const again = await check(author, unique(NETWORKED), NETWORKED_TESTS);
    expect(again.body.check).toMatchObject({
      passed: false,
      networkProblems: ["代码判定暂时不能联网。"],
    });
  });
});

// The clock of a 联网 judgment (session.ts): waiting on a request buys no
// time to compute.
describe("代码判定联网: the judgment's clock", () => {
  const after = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("gives up after the budget with no request out", async () => {
    const session = new NetworkSession();
    const started = Date.now();
    const timer = session.deadline(60, 1000);
    expect(await timer.late).toBe("compute");
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(Date.now() - started).toBeLessThan(400);
    timer.stop();
  });

  it("stops while a request is out, and goes on after", async () => {
    const session = new NetworkSession();
    const timer = session.deadline(100, 2000);
    let late: string | null = null;
    void timer.late.then((reason) => {
      late = reason;
    });
    await after(40);
    const begun = session.begin();
    if (!("index" in begun)) throw new Error("Refused");
    // Out for longer than the whole budget: not late.
    await after(250);
    expect(late).toBeNull();
    session.finish(begun.index, { method: "GET", url: API, ms: 250 });
    await after(30);
    expect(late).toBeNull();
    // The rest of the budget, about 30 ms more.
    await after(120);
    expect(late).toBe("compute");
    timer.stop();
  });

  it("gives up at the cap even with a request that never comes back", async () => {
    const session = new NetworkSession();
    const timer = session.deadline(50, 200);
    session.begin();
    expect(await timer.late).toBe("total");
    timer.stop();
    const records = await session.close();
    expect(records).toEqual([]);
    expect(session.broken).toBe(true);
  }, 10_000);
});

describe("代码判定联网: a slow answer", () => {
  it("is waited for past the 300 ms a judgment computes in", async () => {
    const opened = await open();
    answer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return Response.json({ right: true, say: "慢慢来" });
    };
    const claimant = await actor();
    const result = await claim(opened.id, claimant, "flag");
    // Protocol 5: judged, and settled at once ({ ok: true, amount }).
    expect(result.body).toMatchObject({
      result: "judged",
      settled: { claim: { amount: "0.30" } },
    });
  });
});
