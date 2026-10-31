import { env } from "cloudflare:test";
import type { ActivityInput, ActivityLiveMessage } from "@hb/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { judgeBatch, type QueuedJudgment } from "../src/judge/batch";
import { admitCodeClaim } from "../src/judge/claims";
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
} from "./code-fixtures";

// 一批一起写 (docs/programmable-hongbao-design.md §3): a protocol 5 红包's
// waiting submissions judged together, as one at a time would, and
// written at once.

const GAME = `export function judge(s) {
  const [verb, arg] = s.input.split(" ");
  const n = Number(arg ?? 0);
  if (verb === "boom") throw new Error("炸了");
  if (verb === "add")
    return { add: n, state: { last: s.user.username, count: (s.state?.count ?? 0) + 1 } };
  if (verb === "seat") {
    const waiting = s.state?.waiting;
    if (!waiting) return { add: n, state: { waiting: s.user.id } };
    return { add: n, settle: true, state: null, others: [{ id: waiting, add: 5, settle: true, message: "开桌了" }] };
  }
  return { message: "看看" };
}`;
const TESTS = JSON.stringify({
  tests: [{ name: "加", input: "add 10", expect: { pending: 10 } }],
});

let author: Actor;

beforeEach(async () => {
  const admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1 });
  await judgeSettings({ enabled: 1 });
  await plus(author);
  await give(admin, author, "5.00");
});

async function open(extra: Partial<ActivityInput> = {}) {
  const input = { ...coded({}, { code: GAME, tests: TESTS }), ...extra };
  await check(author, input.judge?.code, input.judge?.tests);
  const saved = await createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return openActivity(bindings, saved.id, author.id, saved.version);
}

/** Let in as the Durable Object lets them in, before the queue. */
async function queued(
  activityId: string,
  people: [Actor, string][],
  arrivedAt = Date.now(),
) {
  const items: QueuedJudgment[] = [];
  for (const [person, input] of people) {
    const admitted = await admitCodeClaim(
      bindings,
      activityId,
      person.id,
      {
        submissionId: crypto.randomUUID(),
        participationMode: "code",
        input,
      },
      false,
      arrivedAt,
    );
    if (!("item" in admitted)) throw new Error("NOT_QUEUED");
    items.push(admitted.item);
  }
  return items;
}

const part = (activityId: string, user: Actor) =>
  env.DB.prepare(
    "SELECT pending_minor AS pending, settled_minor AS settled FROM code_judge_people WHERE activity_id = ? AND user_id = ?",
  )
    .bind(activityId, user.id)
    .first<{ pending: number; settled: number | null }>();

describe("一批一起写", () => {
  it("judges in order, the state and each pending carried on: two at a table settle each other; one that fails is noted and the rest go on", async () => {
    const opened = await open();
    const [first, second, third, fourth] = [
      await actor(),
      await actor(),
      await actor(),
      await actor(),
    ];
    const items = await queued(opened.id, [
      [first, "seat 10"],
      [third, "boom"],
      [second, "seat 20"],
      [fourth, "add 7"],
    ]);
    const outcomes = await judgeBatch(bindings, opened.id, items);
    expect(outcomes).toEqual([
      {
        result: { result: "judged", moved: { added: "0.10", pending: "0.10" } },
      },
      {
        error: expect.objectContaining({ code: "JUDGE_FAILED" }),
      },
      {
        result: {
          result: "judged",
          moved: { added: "0.20", pending: "0.20" },
          settled: { claim: expect.objectContaining({ amount: "0.20" }) },
        },
      },
      {
        result: { result: "judged", moved: { added: "0.07", pending: "0.07" } },
      },
    ]);
    // The first, by the second's judgment in the same batch: 0.10 + 0.05.
    expect(await part(opened.id, first)).toEqual({ pending: 0, settled: 15 });
    expect(await part(opened.id, second)).toEqual({ pending: 0, settled: 20 });
    expect(await part(opened.id, fourth)).toEqual({
      pending: 7,
      settled: null,
    });
    const sequences = await env.DB.prepare(
      "SELECT sequence, user_id AS userId FROM code_judgments WHERE activity_id = ? ORDER BY sequence",
    )
      .bind(opened.id)
      .all<{ sequence: number; userId: string }>();
    expect(sequences.results).toEqual([
      { sequence: 0, userId: first.id },
      { sequence: 1, userId: second.id },
      { sequence: 2, userId: fourth.id },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT kind FROM code_failures WHERE activity_id = ?",
      )
        .bind(opened.id)
        .first<string>("kind"),
    ).toBe("threw");
    // Everyone's pending together, as the triggers keep it.
    expect(
      await env.DB.prepare(
        "SELECT pending_minor FROM activity_code WHERE activity_id = ?",
      )
        .bind(opened.id)
        .first<number>("pending_minor"),
    ).toBe(7);
  });

  it("writes a batch of ten at once", async () => {
    const opened = await open();
    const people = await Promise.all(Array.from({ length: 10 }, () => actor()));
    const items = await queued(
      opened.id,
      people.map((person, index) => [person, `add ${index + 1}`]),
    );
    const batch = vi.spyOn(bindings.DB, "batch");
    try {
      const outcomes = await judgeBatch(bindings, opened.id, items);
      expect(outcomes.every((outcome) => "result" in outcome)).toBe(true);
      expect(batch).toHaveBeenCalledTimes(1);
    } finally {
      batch.mockRestore();
    }
    // Each one judged after the one before: the shared state counted them.
    const pending = await env.DB.prepare(
      "SELECT pending_minor FROM activity_code WHERE activity_id = ?",
    )
      .bind(opened.id)
      .first<number>("pending_minor");
    expect(pending).toBe(55);
  });

  // 热点 (§3): how long each waited is told from when it came.
  it("keeps when each came as the submission's created_at, the write's time beside it", async () => {
    const opened = await open();
    const [one, two] = [await actor(), await actor()];
    const came = Date.now() - 4_000;
    const items = await queued(
      opened.id,
      [
        [one, "add 1"],
        [two, "add 2"],
      ],
      came,
    );
    await judgeBatch(bindings, opened.id, items);
    const rows = await env.DB.prepare(
      "SELECT created_at AS came, validated_at AS judged, finished_at AS written FROM redemption_submissions WHERE activity_id = ?",
    )
      .bind(opened.id)
      .all<{ came: number; judged: number; written: number }>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) {
      expect(row.came).toBe(came);
      expect(row.written).toBeGreaterThanOrEqual(came + 4_000 - 50);
      expect(row.judged).toBe(row.written);
    }
  });

  it("leaves those after the pool is taken to be judged on their own", async () => {
    const opened = await open();
    const [taker, late] = [await actor(), await actor()];
    const items = await queued(opened.id, [
      [taker, "add 100"],
      [late, "add 1"],
    ]);
    const outcomes = await judgeBatch(bindings, opened.id, items);
    expect(outcomes[0]).toMatchObject({
      result: { settled: { claim: { amount: "1.00" } } },
    });
    expect(outcomes[1]).toEqual({ alone: true });
  });
});

describe("一批一起写, through the 红包's Durable Object", () => {
  async function send(activityId: string, user: Actor, input: string) {
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
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  it("judges everyone sent at once, each once, in one order", async () => {
    const opened = await open();
    const people = await Promise.all(Array.from({ length: 12 }, () => actor()));
    const answers = await Promise.all(
      people.map((person) => send(opened.id, person, "add 3")),
    );
    expect(answers.map((answer) => answer.status)).toEqual(
      people.map(() => 200),
    );
    expect(answers.every((answer) => answer.body.result === "judged")).toBe(
      true,
    );
    const judged = await env.DB.prepare(
      "SELECT COUNT(DISTINCT sequence) AS sequences, MAX(sequence) AS last, COUNT(DISTINCT user_id) AS people FROM code_judgments WHERE activity_id = ?",
    )
      .bind(opened.id)
      .first<{ sequences: number; last: number; people: number }>();
    expect(judged).toEqual({ sequences: 12, last: 11, people: 12 });
    expect(
      await env.DB.prepare(
        "SELECT pending_minor FROM activity_code WHERE activity_id = ?",
      )
        .bind(opened.id)
        .first<number>("pending_minor"),
    ).toBe(36);
  });

  it("takes one person once a batch: a second submission at once waits its turn and meets the attempt interval", async () => {
    const opened = await open();
    const player = await actor();
    const [one, two] = await Promise.all([
      send(opened.id, player, "add 1"),
      send(opened.id, player, "add 2"),
    ]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([200, 429]);
    expect(await part(opened.id, player)).toMatchObject({
      pending: one.status === 200 ? 1 : 2,
    });
    await advanceAttemptCooldown(env.DB, player.id);
  });

  // 热点 (§3, multi-prize §4.3): a judgment that only moves the pool
  // pushes it with the count; the whole 红包 when someone is paid.
  it("pushes the pool with the count, and the whole 红包 only when someone is paid", async () => {
    const opened = await open();
    const viewer = await actor();
    const response = await app.request(
      `${origin}/api/activities/${opened.id}/live`,
      {
        headers: {
          Upgrade: "websocket",
          Origin: origin,
          Cookie: viewer.cookie,
        },
      },
      bindings,
    );
    const socket = response.webSocket;
    if (!socket) throw new Error("no WebSocket");
    const heard: ActivityLiveMessage[] = [];
    socket.addEventListener("message", (event) => {
      const data = String(event.data);
      if (data !== "pong") heard.push(JSON.parse(data));
    });
    socket.accept();
    await vi.waitFor(() => expect(heard[0]?.type).toBe("activity"));
    const [first, second, third] = [
      await actor(),
      await actor(),
      await actor(),
    ];
    // The first after connecting may send it whole once (nothing pushed yet).
    expect((await send(opened.id, first, "add 10")).status).toBe(200);
    await vi.waitFor(() =>
      expect(heard).toContainEqual(
        expect.objectContaining({ type: "judged", count: 1 }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    heard.length = 0;
    expect((await send(opened.id, second, "add 20")).status).toBe(200);
    await vi.waitFor(() =>
      expect(heard).toContainEqual({
        type: "judged",
        count: 2,
        unclaimed: "0.70",
        seq: expect.any(Number),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(heard.filter((message) => message.type === "activity")).toEqual([]);
    // Two at a table: one settles the other, so the 名单 changes.
    expect((await send(opened.id, third, "seat 5")).status).toBe(200);
    await advanceAttemptCooldown(env.DB, first.id);
    expect((await send(opened.id, first, "seat 5")).status).toBe(200);
    await vi.waitFor(
      () =>
        expect(heard).toContainEqual(
          expect.objectContaining({
            type: "activity",
            activity: expect.objectContaining({
              quantity: { mode: "pool", left: "0.55" },
              rosterPreview: [expect.anything(), expect.anything()],
            }),
          }),
        ),
      { timeout: 3000 },
    );
    socket.close();
  });

  it("answers those after the pool is taken that it has ended", async () => {
    const opened = await open();
    const [taker, late] = [await actor(), await actor()];
    const [taken, after] = await Promise.all([
      send(opened.id, taker, "add 100"),
      send(opened.id, late, "add 1"),
    ]);
    const answers = [taken, after].map((answer) => answer.body.result);
    expect(answers).toContain("judged");
    expect(
      answers.filter((answer) => answer === "ended").length +
        answers.filter((answer) => answer === "judged").length,
    ).toBe(2);
  });
});
