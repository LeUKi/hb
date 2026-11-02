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
  getManagedActivity,
  getPublicActivity,
  openActivity,
  updateActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import { sweepKeys } from "../src/judge/keys";
import { judgeRecords } from "../src/judge/records";
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
  }, 20_000);
});

describe("代码判定联网: a slow answer", () => {
  it("is waited for past the 1 s a judgment computes in", async () => {
    const opened = await open();
    answer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1300));
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

// 密钥 (docs/judge-key-design.md): the sender's, kept apart; never given
// to the code nor read back; added by the gateway to its own address only.
describe("代码判定联网: 密钥", () => {
  const KEYED = `export const network = ["${API}"];
export const params = [{ key: "ai", label: "AI 密钥", type: "key", to: "${API}check" }];
export async function judge(submission) {
  await fetch("${API}check", { method: "POST", body: "{}" });
  await fetch("${API}other", { method: "POST", body: "{}" });
  return { message: JSON.stringify(submission.params) };
}
`;
  const KEYED_TESTS = JSON.stringify({
    tests: [
      {
        name: "代码拿不到密钥",
        input: "x",
        fetch: [
          { url: `${API}check`, method: "POST", json: {} },
          { url: `${API}other`, method: "POST", json: {} },
        ],
        expect: { message: "{}" },
      },
    ],
  });

  /** The 判定器 with a 密钥, deployed, and a draft of it. */
  async function keyedDraft() {
    const code = unique(KEYED);
    const deployed = await check(author, code, KEYED_TESTS, {
      name: "AI 判定",
    });
    expect(deployed.body.check.passed).toBe(true);
    const judgeId = deployed.body.check.judge?.id ?? "";
    const draft = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: coded({}, { code, tests: KEYED_TESTS, judgeId }),
    });
    return { judgeId, draft };
  }

  const withKeys = (managed: ManagedActivity, keys: Record<string, string>) =>
    updateActivity(bindings, managed.id, author.id, {
      version: managed.version,
      activity: {
        ...managed.config,
        judge: managed.config.judge && { ...managed.config.judge, keys },
      },
    });

  it("opens only once filled; kept encrypted, read back by name only", async () => {
    const { draft } = await keyedDraft();
    const blocked = await getManagedActivity(bindings, draft.id, author.id);
    expect(blocked.openingBlockedReason).toBe("JUDGE_KEY_MISSING");
    await expect(
      openActivity(bindings, draft.id, author.id, blocked.version),
    ).rejects.toMatchObject({ message: "判定器要的密钥还没填，草稿已保存。" });
    await expect(withKeys(blocked, { other: "x" })).rejects.toMatchObject({
      code: "JUDGE_KEY_UNKNOWN",
    });
    const saved = await withKeys(blocked, { ai: " sk-first " });
    expect(saved.judgeKeys).toEqual(["ai"]);
    expect(JSON.stringify(saved)).not.toContain("sk-first");
    expect(saved.openingBlockedReason).toBeUndefined();
    const row = await env.DB.prepare(
      "SELECT names, ciphertext FROM activity_keys WHERE activity_id = ?",
    )
      .bind(draft.id)
      .first<{ names: string; ciphertext: string }>();
    expect(row?.names).toBe('["ai"]');
    expect(row?.ciphertext).not.toContain("sk-first");
  });

  it("goes to its own address only, the code never sees it, nothing shows it; changed after opening, gone once over", async () => {
    const { draft } = await keyedDraft();
    const saved = await withKeys(
      await getManagedActivity(bindings, draft.id, author.id),
      { ai: "sk-first" },
    );
    const opened = await openActivity(
      bindings,
      draft.id,
      author.id,
      saved.version,
    );
    const first = await claim(opened.id, await actor(), "x");
    expect(first.body).toMatchObject({ result: "judged" });
    expect(JSON.stringify(first.body)).not.toContain("sk-first");
    expect(
      outside.map((sent) => [sent.url, sent.headers.authorization]),
    ).toEqual([
      [`${API}check`, "Bearer sk-first"],
      [`${API}other`, undefined],
    ]);
    // The 红包 page says there is one, never what; the records neither.
    const shown = await getPublicActivity(bindings, opened.id);
    expect(shown.judge?.keys).toEqual([
      { label: "AI 密钥", to: `${API}check` },
    ]);
    expect(JSON.stringify(shown)).not.toContain("sk-first");
    expect(
      JSON.stringify(await judgeRecords(bindings, opened.id, author.id)),
    ).not.toContain("sk-first");
    // A new one, after opening: from the next request on.
    const managed = await getManagedActivity(bindings, opened.id, author.id);
    await withKeys(managed, { ai: "sk-second" });
    outside = [];
    await claim(opened.id, await actor(), "y");
    expect(outside[0]?.headers.authorization).toBe("Bearer sk-second");
    // Over: let go of.
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - 1000, opened.id)
      .run();
    await sweepKeys(bindings);
    expect(
      await env.DB.prepare("SELECT 1 FROM activity_keys WHERE activity_id = ?")
        .bind(opened.id)
        .first(),
    ).toBeNull();
  }, 20_000);

  it("is deployed only with its address in network; a text param that looks like one is pointed to it", async () => {
    const outsideList = await check(
      author,
      unique(
        KEYED.replace(`to: "${API}check"`, 'to: "https://other.example.com/"'),
      ),
      KEYED_TESTS,
    );
    expect(outsideList.body.check.passed).toBe(false);
    expect(outsideList.body.check.declarationProblems).toEqual([
      "params（ai）的 to：https://other.example.com/ 不在 network 里",
    ]);
    // The code reads every other param: its tests say so.
    const looksLike = await check(
      author,
      unique(
        KEYED.replace(
          `to: "${API}check" }]`,
          `to: "${API}check" }, { key: "api_token", label: "接口令牌", type: "text", required: false }]`,
        ),
      ),
      KEYED_TESTS.replace(
        '"message":"{}"',
        `"message":${JSON.stringify(JSON.stringify({ api_token: null }))}`,
      ),
    );
    expect(looksLike.body.check.passed).toBe(true);
    expect(looksLike.body.check.reminders).toEqual([
      'params（api_token）像是密钥：放密钥用 type: "key"，判定器代码读不到，也不会公开',
    ]);
  });
});

describe("代码判定联网: 地址参数", () => {
  // docs/judge-address-design.md: each sender's own service, its address
  // filled in at opening; the site's token to it and to an address that
  // asks for it, a 密钥 to its own address only (§12).
  const OWN = `export const network = [
  { param: "server" },
  { url: "https://api.example.com/author/", token: true },
  "https://api.example.com/plain/",
];
export const params = [
  { key: "server", label: "服务地址", type: "url" },
  { key: "token", label: "服务密钥", type: "key", to: { param: "server" } },
];
export const meta = { name: "自建", page: { param: "server", path: "play/" } };
export async function judge(submission) {
  await fetch(new URL("check", submission.params.server), { method: "POST", body: "{}" });
  await fetch("https://api.example.com/author/check");
  await fetch("https://api.example.com/plain/check");
  return { message: submission.params.server };
}
`;
  const OWN_TESTS = JSON.stringify({
    params: { server: "https://example.com/" },
    tests: [
      {
        name: "问自己填的地址",
        input: "x",
        fetch: [
          { url: "https://example.com/check", method: "POST", json: {} },
          { url: "https://api.example.com/author/check", json: {} },
          { url: "https://api.example.com/plain/check", json: {} },
        ],
        expect: { message: "https://example.com/" },
      },
    ],
  });

  /** As a service would: the published key by its kid, then the claims. */
  async function verified(token: string | undefined) {
    const [header, claims, signature] = (token ?? "").split(".");
    if (!header || !claims || !signature) return null;
    const read = (part: string) =>
      Uint8Array.from(
        atob(part.replaceAll("-", "+").replaceAll("_", "/")),
        (c) => c.charCodeAt(0),
      );
    const { keys } = (await (
      await app.request(`${origin}/api/page-identity/keys`, {}, bindings)
    ).json()) as { keys: (JsonWebKey & { kid: string })[] };
    const { kid } = JSON.parse(new TextDecoder().decode(read(header)));
    const jwk = keys.find((key) => key.kid === kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      read(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    return ok ? JSON.parse(new TextDecoder().decode(read(claims))) : null;
  }

  it("deploys with each test's own address, opens on the address filled, signs its requests there and to the address that asks, and sends its 密钥 there only", async () => {
    const code = unique(OWN);
    const deployed = await check(author, code, OWN_TESTS, { name: "自建" });
    expect(deployed.body.check).toMatchObject({
      passed: true,
      network: [
        { param: "server" },
        { url: "https://api.example.com/author/", token: true },
        "https://api.example.com/plain/",
      ],
    });
    expect(deployed.body.check.reminders ?? []).toEqual([]);
    const judgeId = deployed.body.check.judge?.id ?? "";
    // Its page under the address, as the form fills it in.
    await settings({ page_enabled: 1 });
    const draft = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: {
        ...coded(
          {},
          {
            code,
            tests: OWN_TESTS,
            judgeId,
            params: { server: "https://API.example.com/mine" },
          },
        ),
        pageUrl: "https://api.example.com/mine/play/",
      },
    });
    const managed = await getManagedActivity(bindings, draft.id, author.id);
    const saved = await updateActivity(bindings, managed.id, author.id, {
      version: managed.version,
      activity: {
        ...managed.config,
        judge: managed.config.judge && {
          ...managed.config.judge,
          keys: { token: "t-1" },
        },
      },
    });
    const opened = await openActivity(
      bindings,
      draft.id,
      author.id,
      saved.version,
    );
    const row = await env.DB.prepare(
      "SELECT network FROM activity_code WHERE activity_id = ?",
    )
      .bind(opened.id)
      .first<{ network: string }>();
    expect(JSON.parse(row?.network ?? "null")).toEqual([
      "https://api.example.com/mine/",
      "https://api.example.com/author/",
      "https://api.example.com/plain/",
    ]);
    const first = await claim(opened.id, await actor(), "x");
    expect(first.body).toMatchObject({ result: "judged" });
    expect(
      outside.map((sent) => [
        sent.url,
        sent.headers.authorization,
        Boolean(sent.headers["x-hb-token"]),
      ]),
    ).toEqual([
      ["https://api.example.com/mine/check", "Bearer t-1", true],
      ["https://api.example.com/author/check", undefined, true],
      ["https://api.example.com/plain/check", undefined, false],
    ]);
    const claims = await verified(outside[0]?.headers["x-hb-token"]);
    expect(claims).toMatchObject({
      iss: "https://hb.lafi.sh/judge",
      aud: "https://api.example.com",
      hongbao: opened.id,
      sender: author.externalId,
      // Its 判定器 (§13.1), for a server that serves only its own.
      judge: judgeId,
      judgeVersion: 1,
      jti: expect.any(String),
    });
    expect(claims.exp - claims.iat).toBe(60);
    // The page's token names them too.
    const viewer = await actor();
    const asked = await app.request(
      `${origin}/api/activities/${opened.id}/page-identity`,
      {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Cookie: viewer.cookie,
          "X-CSRF-Token": viewer.csrf,
        },
        body: "{}",
      },
      bindings,
    );
    const identity = (await asked.json()) as { token?: string };
    expect(await verified(identity.token)).toMatchObject({
      iss: origin,
      aud: "https://api.example.com",
      sub: viewer.externalId,
      hongbao: opened.id,
      sender: author.externalId,
      judge: judgeId,
      judgeVersion: 1,
    });
    const shown = await getPublicActivity(bindings, opened.id);
    expect(shown.judge).toMatchObject({
      network: [
        "https://api.example.com/mine/",
        "https://api.example.com/author/",
        "https://api.example.com/plain/",
      ],
      networkFilled: ["https://api.example.com/mine/"],
      keys: [{ label: "服务密钥", to: "https://api.example.com/mine/" }],
    });
    expect(
      shown.judge?.params?.find((item) => item.param.key === "server")?.value,
    ).toBe("https://api.example.com/mine/");
  }, 20_000);

  it("is not deployed with a { param } that names no 地址参数; one asked needs no 密钥", async () => {
    const wrong = await check(
      author,
      unique(
        OWN.replace(
          '{ param: "server" },\n  { url',
          '{ param: "other" },\n  { url',
        ),
      ),
      OWN_TESTS,
    );
    expect(wrong.body.check.passed).toBe(false);
    expect(wrong.body.check.declarationProblems).toEqual([
      "network 第 1 个：没有参数 other",
      'params（token）的 to：network 里没有 { param: "server" }',
    ]);
    const unkeyed = await check(
      author,
      unique(
        OWN.replace(
          '  { key: "token", label: "服务密钥", type: "key", to: { param: "server" } },\n',
          "",
        ),
      ),
      OWN_TESTS,
    );
    expect(unkeyed.body.check.passed).toBe(true);
    expect(unkeyed.body.check.reminders ?? []).toEqual([]);
  });
});
