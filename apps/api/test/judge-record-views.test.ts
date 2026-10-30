import { env } from "cloudflare:test";
import type {
  JudgeChallengerList,
  JudgeRecordFacts,
  JudgeRecordList,
  JudgeRecordPeople,
} from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
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

// 判定记录 (docs/judge-records-design.md): a 代码判定红包's judgments for
// its sender — the timeline with failures among them, 按人 from
// code_judge_people, one person's whole record, the numbers over it all.

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1 });
  await judgeSettings({ enabled: 1 });
  await plus(author);
  await give(admin, author, "5.00");
});

const GAME = `export function judge(s) {
  if (s.input === "boom") throw new Error("炸了");
  if (s.input === "go")
    return { ok: true, amount: 30, message: "领到了", announce: "有人领到了" };
  return { ok: false, message: "不对" };
}`;

async function open() {
  const input = coded(
    {},
    {
      code: GAME,
      tests: JSON.stringify({
        tests: [{ name: "领", input: "go", expect: { ok: true } }],
      }),
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
  await claimActivity(bindings, activityId, user.id, {
    submissionId: crypto.randomUUID(),
    participationMode: "code",
    input,
  }).catch(() => null);
  await advanceAttemptCooldown(env.DB, user.id);
}

async function get<T>(path: string, user: Actor = author) {
  const response = await app.request(
    `${origin}/api${path}`,
    { headers: { Cookie: user.cookie } },
    bindings,
  );
  return { status: response.status, body: (await response.json()) as T };
}

/** Every page of a list, by its cursor. */
async function all(path: string) {
  const items: JudgeRecordList["items"] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const read: { status: number; body: JudgeRecordList } = await get(
      cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path,
    );
    expect(read.status).toBe(200);
    items.push(...read.body.items);
    cursor = read.body.nextCursor;
    if (!cursor) break;
  }
  return items;
}

describe("判定记录", () => {
  it("lays every judgment and failure along one timeline, the newest first, with what each typed and got; filters by share, none, failure", async () => {
    const opened = await open();
    const first = await actor();
    const second = await actor();
    await submit(opened.id, first, "no 1");
    await submit(opened.id, second, "boom");
    await submit(opened.id, first, "go");
    await submit(opened.id, second, "no 2");
    const items = await all(`/me/activities/${opened.id}/judge-timeline`);
    const who = (id: string) => (id === first.id ? "甲" : "乙");
    expect(
      items.map((item) =>
        item.kind === "judged"
          ? `${who(item.user.id)}#${item.attempt} ${item.input} ${item.claimed ? item.amount : "-"} ${item.message ?? ""}`
          : `${who(item.user.id)} 出错 ${item.failure}`,
      ),
    ).toEqual([
      "乙#1 no 2 - 不对",
      "甲#2 go 0.30 领到了",
      "乙 出错 threw",
      "甲#1 no 1 - 不对",
    ]);
    const claimed = items[1];
    expect(claimed).toMatchObject({
      kind: "judged",
      announce: "有人领到了",
      amount: "0.30",
      // Protocol 5 (docs/multi-prize-design.md §4.2): what it moved.
      moved: { added: "0.30", pending: "0.30", settled: true },
    });
    const shares = await all(
      `/me/activities/${opened.id}/judge-timeline?filter=claimed`,
    );
    expect(shares.map((item) => item.kind === "judged" && item.input)).toEqual([
      "go",
    ]);
    const none = await all(
      `/me/activities/${opened.id}/judge-timeline?filter=unclaimed`,
    );
    expect(none.map((item) => item.kind === "judged" && item.input)).toEqual([
      "no 2",
      "no 1",
    ]);
    const failed = await all(
      `/me/activities/${opened.id}/judge-timeline?filter=failed`,
    );
    expect(failed.map((item) => item.kind)).toEqual(["failed"]);
  });

  it("pages twenty at a time, judgments and failures each from where it stopped: nothing twice, nothing lost", async () => {
    const opened = await open();
    const people = await Promise.all([actor(), actor(), actor()]);
    let n = 0;
    for (let round = 0; round < 9; round += 1)
      for (const person of people) {
        n += 1;
        await submit(opened.id, person, n % 7 === 0 ? "boom" : `no ${n}`);
        // Twenty a second per 红包 at most (CODE_BUSY): a pause between.
        if (n % 15 === 0) await new Promise((done) => setTimeout(done, 1100));
      }
    const items = await all(`/me/activities/${opened.id}/judge-timeline`);
    expect(items).toHaveLength(27);
    expect(items.filter((item) => item.kind === "failed")).toHaveLength(3);
    const times = items.map((item) => Date.parse(item.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const inputs = items.flatMap((item) =>
      item.kind === "judged" ? [item.input] : [],
    );
    expect(new Set(inputs).size).toBe(24);
    const read = await get<{ error: { code: string } }>(
      `/me/activities/${opened.id}/judge-timeline?cursor=nope`,
    );
    expect(read.status).toBe(400);
  });

  it("lists people from code_judge_people — the latest, the most, those with a share first — and one person's whole record, the oldest first; the numbers over it all", async () => {
    const opened = await open();
    const quick = await actor();
    const busy = await actor();
    const lucky = await actor();
    await submit(opened.id, busy, "no a");
    await submit(opened.id, quick, "no b");
    await submit(opened.id, busy, "boom");
    await submit(opened.id, busy, "no c");
    await submit(opened.id, lucky, "go");
    const names = async (sort: string) =>
      (
        await get<JudgeRecordPeople>(
          `/me/activities/${opened.id}/judge-people?sort=${sort}`,
        )
      ).body.items.map((item) => item.user.id);
    expect(await names("recent")).toEqual([lucky.id, busy.id, quick.id]);
    expect((await names("most"))[0]).toBe(busy.id);
    expect((await names("claimed"))[0]).toBe(lucky.id);
    const people = await get<JudgeRecordPeople>(
      `/me/activities/${opened.id}/judge-people`,
    );
    expect(
      people.body.items.find((item) => item.user.id === lucky.id),
    ).toMatchObject({ judged: 1, amount: "0.30", settled: true });
    const record = await all(
      `/me/activities/${opened.id}/judge-people/${busy.id}`,
    );
    expect(
      record.map((item) =>
        item.kind === "judged" ? item.input : `出错 ${item.failure}`,
      ),
    ).toEqual(["no a", "出错 threw", "no c"]);
    const facts = await get<JudgeRecordFacts>(
      `/me/activities/${opened.id}/judge-facts`,
    );
    expect(facts.body).toEqual({
      judged: 4,
      people: 3,
      claimedPeople: 1,
      paid: "0.30",
      pending: "0.00",
      failed: 1,
    });
    // 参与名单 · 挑战 reads the same table: the same people, publicly.
    const challengers = await get<JudgeChallengerList>(
      `/activities/${opened.id}/challengers`,
    );
    expect(challengers.body.total).toBe(3);
    // A failure is not a judgment: busy was judged twice.
    expect(challengers.body.items.map((item) => item.judged)).toEqual([
      1, 2, 1,
    ]);
  });

  it("is its sender's only", async () => {
    const opened = await open();
    const other = await actor();
    await submit(opened.id, other, "no");
    for (const path of [
      "judge-timeline",
      "judge-people",
      "judge-facts",
      `judge-people/${other.id}`,
    ])
      expect(
        (await get(`/me/activities/${opened.id}/${path}`, other)).status,
      ).toBe(404);
  });
});
