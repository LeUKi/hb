import { env } from "cloudflare:test";
import type {
  ActivityStatistics,
  AdminActivityDetail,
  CodeFailureList,
  CodeJudgmentList,
  JudgeInput,
} from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { JudgeRecords } from "../../../kit/judge";
import { submissionsOf } from "../../../kit/runtime/index.mjs";
import { claimActivity } from "../src/activities/claim-service";
import {
  createActivity,
  getPublicActivity,
  openActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import { readAccount } from "../src/balance/ledger";
import type { ApiBindings } from "../src/env";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import {
  type Actor,
  actor,
  bindings,
  check,
  coded,
  give,
  origin,
  plus,
  settings,
} from "./code-fixtures";

// What a 代码判定红包's sender (and the 站长) see of it
// (docs/programmable-hongbao-design.md §1, §6): 判定记录, 出错记录, the full
// records that replay, 尝试统计, and 停用.

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1, code_hongbao_enabled: 1 });
  await plus(author);
  await give(admin, author, "5.00");
});

// It tells each claimant what it was given, so a replay can be checked.
const ECHO = `export function judge(s) {
  if (s.input === "boom") throw new Error("炸了");
  const seen = (s.state?.seen ?? 0) + 1;
  const said = [s.claims.map((c) => c.input).join(","), s.hongbao.remaining,
    s.hongbao.remainingCount, s.share.max, s.user.attempts, JSON.stringify(s.state)].join("|");
  if (s.input.startsWith("go")) return { ok: true, amount: 5000, message: said, state: { seen } };
  return { ok: false, message: said, ...(seen % 2 ? { state: { seen } } : {}) };
}`;
const echo = (s: {
  claims: { input: string }[];
  hongbao: { remaining: number; remainingCount: number };
  share: { max: number };
  user: { attempts: number };
  state: unknown;
}) =>
  [
    s.claims.map((c) => c.input).join(","),
    s.hongbao.remaining,
    s.hongbao.remainingCount,
    s.share.max,
    s.user.attempts,
    JSON.stringify(s.state),
  ].join("|");

async function open(judge: Partial<JudgeInput> = {}) {
  const input = coded(
    {},
    {
      code: ECHO,
      tests: JSON.stringify([
        { name: "领", input: "go", expect: { ok: true } },
      ]),
      ...judge,
    },
  );
  const passed = await check(author, input.judge?.code, input.judge?.tests);
  expect(passed.body.check.passed).toBe(true);
  const saved = await createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return openActivity(bindings, saved.id, author.id, saved.version);
}

async function submit(activityId: string, user: Actor, input: string) {
  const result = await claimActivity(bindings, activityId, user.id, {
    submissionId: crypto.randomUUID(),
    participationMode: "code",
    input,
  }).catch((error: unknown) => error);
  await advanceAttemptCooldown(env.DB, user.id);
  return result;
}

async function get<T>(
  path: string,
  user: Actor,
  extra: Partial<ApiBindings> = {},
) {
  const response = await app.request(
    `${origin}/api${path}`,
    { headers: { Cookie: user.cookie } },
    { ...bindings, ...extra },
  );
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as T,
  };
}

describe("代码判定红包: records", () => {
  it("lists every judgment for its sender, with what was typed and both amounts", async () => {
    const opened = await open();
    const first = await actor();
    const second = await actor();
    await submit(opened.id, first, "nope");
    await submit(opened.id, first, "go 1");
    await submit(opened.id, second, "boom");
    await submit(opened.id, second, "go 2");
    const list = await get<CodeJudgmentList>(
      `/me/activities/${opened.id}/judgments`,
      author,
    );
    expect(list.status).toBe(200);
    expect(
      list.body.items.map(
        ({ sequence, input, ok, asked, paid, note, claimed }) => ({
          sequence,
          input,
          ok,
          asked,
          paid,
          note,
          claimed,
        }),
      ),
    ).toEqual([
      {
        sequence: 2,
        input: "go 2",
        ok: true,
        asked: "50.00",
        paid: "0.01",
        note: "cap",
        claimed: true,
      },
      {
        sequence: 1,
        input: "go 1",
        ok: true,
        asked: "50.00",
        paid: "0.98",
        note: "cap",
        claimed: true,
      },
      {
        sequence: 0,
        input: "nope",
        ok: false,
        asked: undefined,
        paid: undefined,
        note: undefined,
        claimed: undefined,
      },
    ]);
    expect(list.body.items[2]?.user.username).toMatch(/^code_/);
    // Only its sender.
    expect(
      (await get(`/me/activities/${opened.id}/judgments`, first)).status,
    ).toBe(404);

    const failures = await get<CodeFailureList>(
      `/me/activities/${opened.id}/code-failures`,
      author,
    );
    expect(failures.body).toMatchObject({
      items: [{ kind: "threw", detail: expect.stringContaining("炸了") }],
      failuresInRow: 0,
      pausedAt: null,
    });

    // 尝试统计 groups what was typed, as for 口令.
    const statistics = await get<ActivityStatistics>(
      `/me/activities/${opened.id}/statistics`,
      author,
    );
    expect(statistics.body).toMatchObject({
      totalAttempts: 3,
      matchedAttempts: 2,
      successfulClaims: 2,
      validPasswords: [],
    });
  });

  it("downloads records that replay to what the code was given", async () => {
    const opened = await open();
    const people = [await actor(), await actor(), await actor()];
    for (const [index, person] of people.entries()) {
      await submit(opened.id, person, `try ${index}`);
      await submit(opened.id, person, `try ${index} again`);
      await submit(opened.id, person, `go ${index}`);
    }
    const download = await get<JudgeRecords>(
      `/me/activities/${opened.id}/judge-records`,
      author,
    );
    expect(download.headers.get("Content-Disposition")).toContain(
      `judge-records-${opened.id}.json`,
    );
    const records = download.body;
    expect(records.judgments).toHaveLength(9);
    expect(records.hongbao).toMatchObject({
      id: opened.id,
      total: 100,
      count: 3,
      minEach: 1,
      // Over (all three claimed): the seed is out too.
      seed: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const rebuilt = submissionsOf(records);
    expect(rebuilt.map(echo)).toEqual(
      records.judgments.map((judgment) => judgment.verdict.message),
    );
    expect(rebuilt[8]).toMatchObject({
      input: "go 2",
      claims: [
        { input: "go 0", amount: 98 },
        { input: "go 1", amount: 1 },
      ],
      share: { min: 1, max: 1, last: true },
    });
    expect(
      (
        await get(
          `/me/activities/${opened.id}/judge-records`,
          people[0] as Actor,
        )
      ).status,
    ).toBe(404);
  });

  it("lets the 站长 stop one: claims stop, the rest goes back, and it says who", async () => {
    const opened = await open();
    await submit(opened.id, await actor(), "go");
    const asAdmin = { ADMIN_LINUX_DO_IDS: admin.externalId };
    const stop = (user: Actor) =>
      app.request(
        `${origin}/api/admin/activities/${opened.id}/stop-code`,
        {
          method: "POST",
          headers: {
            Cookie: user.cookie,
            Origin: origin,
            "X-CSRF-Token": user.csrf,
          },
        },
        { ...bindings, ...asAdmin },
      );
    expect((await stop(author)).status).toBe(403);
    const stopped = await stop(admin);
    expect(stopped.status).toBe(200);
    expect((await stop(admin)).status).toBe(200);
    const page = await getPublicActivity(bindings, opened.id);
    expect(page.status).toBe("ended");
    expect(page.judge).toMatchObject({ stopped: true, code: ECHO });
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 402,
      lockedMinor: 0,
    });
    const late = await submit(opened.id, await actor(), "go");
    expect(late).toMatchObject({ result: "ended" });
    const detail = await get<{ activity: AdminActivityDetail }>(
      `/admin/activities/${opened.id}`,
      admin,
      asAdmin,
    );
    expect(detail.body.activity).toMatchObject({
      participationMode: "code",
      code: {
        fingerprint: page.judge?.fingerprint,
        stoppedAt: expect.any(Number),
        stoppedBy: expect.stringMatching(/^Code /),
      },
    });
  });
});
