import { env } from "cloudflare:test";
import type {
  ActivityInput,
  ActivityLiveMessage,
  ClaimDetail,
  ClaimResult,
  JudgeInput,
  MyJudgmentList,
  PublicRecipientList,
} from "@hb/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRandom,
  seedCommitment,
  submissionSeed,
  userSeed,
} from "../../../kit/runtime/index.mjs";
import { claimActivity } from "../src/activities/claim-service";
import { endActivity } from "../src/activities/lifecycle";
import {
  createActivity,
  getPublicActivity,
  openActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import { readAccount } from "../src/balance/ledger";
import type { ApiBindings } from "../src/env";
import { findJudgeRow } from "../src/judge/storage";
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
  rejects,
  settings,
} from "./code-fixtures";

// Claims on a 代码判定红包 (docs/programmable-hongbao-design.md §2–§4, §6):
// judged one at a time, paid within each share's range, paused by failing
// code, and its code and seed published once it is over.

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1, code_hongbao_enabled: 1 });
  await plus(author);
  await give(admin, author, "5.00");
});

async function open(
  judge: Partial<JudgeInput> = {},
  total = "1.00",
  extra: Partial<ActivityInput> = {},
) {
  const input = { ...coded({ totalAmount: total }, judge), ...extra };
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
  });
  await advanceAttemptCooldown(env.DB, user.id);
  return result;
}

const detail = (result: ClaimResult) =>
  (result as { claim: ClaimDetail }).claim;

describe("代码判定红包: claims", () => {
  it("pays what the code says to a right answer, and turns a wrong one down with its reply", async () => {
    const opened = await open();
    expect((await getPublicActivity(bindings, opened.id)).judge?.judged).toBe(
      0,
    );
    const claimant = await actor();
    expect(await submit(opened.id, claimant, "nope")).toEqual({
      result: "rejected",
      message: "不对",
    });
    const claimed = await submit(opened.id, claimant, "flag{ok}");
    expect(claimed.result).toBe("claimed");
    expect(detail(claimed)).toMatchObject({
      amount: "0.30",
      judge: { input: "flag{ok}", message: "对了" },
    });
    expect((await readAccount(bindings, claimant.id)).availableMinor).toBe(30);
    expect((await readAccount(bindings, author.id)).unclaimedMinor).toBe(70);
    // 已判定 2 次: the turn-down and the payment.
    expect((await getPublicActivity(bindings, opened.id)).judge?.judged).toBe(
      2,
    );
    // The roster says, for everyone, on which judgment it came.
    expect(detail(claimed).judge?.attempt).toBe(2);
    const recipients = await app.request(
      `${origin}/api/activities/${opened.id}/recipients`,
      {},
      bindings,
    );
    expect(
      ((await recipients.json()) as PublicRecipientList).items.map(
        (item) => item.attempt,
      ),
    ).toEqual([2]);
    // Once claimed, again is the same claim; the sender cannot claim.
    expect((await submit(opened.id, claimant, "flag{ok}")).result).toBe(
      "already_claimed",
    );
    await rejects(
      submit(opened.id, author, "flag{ok}"),
      "SELF_CLAIM_FORBIDDEN",
    );
    // Both inputs are in the sender's 尝试统计, the claim's marked.
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n, COUNT(claim_id) AS claimed FROM attempt_events WHERE activity_id = ?",
      )
        .bind(opened.id)
        .first(),
    ).toEqual({ n: 2, claimed: 1 });
  });

  it("gives the code each person's attempts, the claims so far and its own state", async () => {
    const opened = await open({
      code: `export function judge(s) {
  const seen = (s.state?.seen ?? 0) + 1;
  const reply = \`第\${s.user.attempts}次 \${s.claims.length} 人领过 看过\${seen}次 Lv\${s.user.level}\`;
  if (s.input === "go") return { ok: true, amount: 10, message: reply, state: { seen } };
  return { ok: false, message: reply, state: { seen } };
}`,
      tests: JSON.stringify({
        tests: [{ name: "领", input: "go", expect: { ok: true, amount: 10 } }],
      }),
    });
    const first = await actor();
    const second = await actor();
    expect(await submit(opened.id, first, "no")).toMatchObject({
      message: "第0次 0 人领过 看过1次 Lv2",
    });
    expect(await submit(opened.id, first, "no")).toMatchObject({
      message: "第1次 0 人领过 看过2次 Lv2",
    });
    expect(detail(await submit(opened.id, first, "go")).judge).toMatchObject({
      message: "第2次 0 人领过 看过3次 Lv2",
    });
    expect(await submit(opened.id, second, "no")).toMatchObject({
      message: "第0次 1 人领过 看过4次 Lv2",
    });
  });

  it("pulls what the code asks into each share's range, the last taking what is left", async () => {
    const opened = await open({
      code: `export const judge = () => ({ ok: true, amount: 5000 });`,
      tests: JSON.stringify({
        tests: [
          { name: "要 50.00", input: "x", expect: { ok: true, amount: 5000 } },
        ],
      }),
    });
    const people = [await actor(), await actor(), await actor()];
    const paid = [];
    for (const person of people) {
      const claim = detail(await submit(opened.id, person, "x"));
      paid.push([claim.amount, claim.judge?.note]);
    }
    // 1.00 in 3, at least 0.01 each: 0.98 (封顶), 0.01 (封顶), 0.01 (最后一份).
    expect(paid).toEqual([
      ["0.98", "cap"],
      ["0.01", "cap"],
      ["0.01", "last"],
    ]);
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 400,
      lockedMinor: 0,
    });
    const asked = await env.DB.prepare(
      "SELECT asked_minor AS asked, paid_minor AS paid FROM code_judgments WHERE activity_id = ? ORDER BY judged_at",
    )
      .bind(opened.id)
      .all();
    expect(asked.results).toEqual([
      { asked: 5000, paid: 98 },
      { asked: 5000, paid: 1 },
      { asked: 5000, paid: 1 },
    ]);
    expect((await getPublicActivity(bindings, opened.id)).status).toBe("ended");
  });

  it("does not count a failing judgment, and pauses after five in a row", async () => {
    const opened = await open({
      code: `export function judge(s) {
  if (s.input === "boom") throw new Error("炸了");
  if (s.input === "bad") return { ok: true };
  return { ok: false, message: "再试" };
}`,
      tests: JSON.stringify({
        tests: [{ name: "错", input: "x", expect: { ok: false } }],
      }),
    });
    const claimant = await actor();
    await rejects(submit(opened.id, claimant, "boom"), "JUDGE_FAILED");
    await rejects(submit(opened.id, claimant, "bad"), "JUDGE_FAILED");
    // A good judgment in between starts the count again.
    expect((await submit(opened.id, claimant, "x")).result).toBe("rejected");
    for (let failures = 0; failures < 4; failures += 1)
      await rejects(submit(opened.id, claimant, "boom"), "JUDGE_FAILED");
    expect((await getPublicActivity(bindings, opened.id)).judge?.paused).toBe(
      undefined,
    );
    await rejects(submit(opened.id, claimant, "bad"), "JUDGE_FAILED");
    expect((await getPublicActivity(bindings, opened.id)).judge?.paused).toBe(
      true,
    );
    await rejects(submit(opened.id, claimant, "x"), "CODE_PAUSED");
    // Failures were not judgments: only the one turn-down counts.
    expect((await getPublicActivity(bindings, opened.id)).judge?.judged).toBe(
      1,
    );
    const failures = await env.DB.prepare(
      "SELECT kind, detail FROM code_failures WHERE activity_id = ? ORDER BY created_at",
    )
      .bind(opened.id)
      .all<{ kind: string; detail: string }>();
    expect(failures.results.map((row) => row.kind)).toEqual([
      "threw",
      "invalid",
      "threw",
      "threw",
      "threw",
      "threw",
      "invalid",
    ]);
    expect(failures.results[0]?.detail).toContain("炸了");
  });

  it("keeps each claimant's own judged submissions for them to look back on, and no one else's", async () => {
    const opened = await open({
      code: `export function judge(s) {
  if (s.input === "boom") throw new Error("炸了");
  if (s.input === "flag{ok}") return { ok: true, amount: 30, message: "对了" };
  if (s.input === "quiet") return { ok: false };
  return { ok: false, message: "不对" };
}`,
      tests: JSON.stringify({
        tests: [{ name: "错", input: "x", expect: { ok: false } }],
      }),
    });
    const claimant = await actor();
    const other = await actor();
    const read = async (user: Actor, cursor?: string) => {
      const response = await app.request(
        `${origin}/api/activities/${opened.id}/judgments${cursor ? `?cursor=${cursor}` : ""}`,
        { headers: { Cookie: user.cookie } },
        bindings,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as MyJudgmentList;
    };
    for (let index = 0; index < 20; index += 1)
      await submit(opened.id, claimant, `guess ${index}`);
    // Twenty a second is all one 红包 takes.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await rejects(submit(opened.id, claimant, "boom"), "JUDGE_FAILED");
    await submit(opened.id, claimant, "quiet");
    await submit(opened.id, claimant, "flag{ok}");
    await submit(opened.id, other, "nope");
    const first = await read(claimant);
    expect(first.total).toBe(22);
    expect(first.items).toHaveLength(20);
    // Newest first; a failure was no judgment, so it is not here.
    expect(first.items.slice(0, 3)).toEqual([
      {
        attempt: 22,
        at: expect.any(String),
        input: "flag{ok}",
        message: "对了",
        amount: "0.30",
      },
      { attempt: 21, at: expect.any(String), input: "quiet" },
      {
        attempt: 20,
        at: expect.any(String),
        input: "guess 19",
        message: "不对",
      },
    ]);
    expect(first.nextCursor).toBe("3");
    const rest = await read(claimant, first.nextCursor ?? "");
    expect(rest.items.map((item) => item.input)).toEqual([
      "guess 1",
      "guess 0",
    ]);
    expect(rest.nextCursor).toBeNull();
    const theirs = await read(other);
    expect(theirs.total).toBe(1);
    expect(theirs.items.map((item) => item.input)).toEqual(["nope"]);
    expect(
      (
        await app.request(
          `${origin}/api/activities/${opened.id}/judgments`,
          {},
          bindings,
        )
      ).status,
    ).toBe(401);
  });

  it("tells its live viewers how many times the code has judged, at most once a second", async () => {
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
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("no WebSocket");
    const heard: { message: ActivityLiveMessage; at: number }[] = [];
    socket.addEventListener("message", (event) => {
      const data = String(event.data);
      if (data !== "pong")
        heard.push({ message: JSON.parse(data), at: Date.now() });
    });
    socket.accept();
    await vi.waitFor(() =>
      expect(heard[0]?.message).toMatchObject({
        type: "activity",
        activity: { judge: { judged: 0 } },
      }),
    );
    const counts = () =>
      heard.flatMap(({ message, at }) =>
        message.type === "judged" ? [{ count: message.count, at }] : [],
      );
    const claimant = await actor();
    for (const input of ["a", "b", "flag{ok}"]) {
      const claimed = await app.request(
        `${origin}/api/activities/${opened.id}/claim`,
        {
          method: "POST",
          headers: {
            Origin: origin,
            Cookie: claimant.cookie,
            "X-CSRF-Token": claimant.csrf,
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
      expect(claimed.status).toBe(200);
      await advanceAttemptCooldown(env.DB, claimant.id);
      // Turn-downs alone are pushed: nothing else public moved for them.
      if (input === "b")
        await vi.waitFor(() => expect(counts().at(-1)?.count).toBe(2), {
          timeout: 3000,
        });
    }
    await vi.waitFor(() => expect(counts().at(-1)?.count).toBe(3), {
      timeout: 3000,
    });
    // Each count larger than the last, a second or so apart however busy.
    for (const [index, { count, at }] of counts().entries()) {
      const before = counts()[index - 1];
      if (!before) continue;
      expect(count).toBeGreaterThan(before.count);
      expect(at - before.at).toBeGreaterThanOrEqual(900);
    }
    socket.close();
  });

  it("moves to another sandbox after a judgment runs too long", async () => {
    const opened = await open();
    // A sandbox that never answers, as one stuck in a loop would not.
    const stuck: ApiBindings = {
      ...bindings,
      LOADER: {
        get: () => ({
          getEntrypoint: () => ({
            fetch: () => new Promise<Response>(() => {}),
          }),
        }),
      } as unknown as ApiBindings["LOADER"],
    };
    const claimant = await actor();
    await expect(
      claimActivity(stuck, opened.id, claimant.id, {
        submissionId: crypto.randomUUID(),
        participationMode: "code",
        input: "flag{ok}",
      }),
    ).rejects.toMatchObject({ code: "JUDGE_FAILED" });
    expect(await findJudgeRow(bindings, opened.id)).toMatchObject({
      sandbox: 1,
      failuresInRow: 1,
    });
    expect(
      await env.DB.prepare(
        "SELECT kind FROM code_failures WHERE activity_id = ?",
      )
        .bind(opened.id)
        .first("kind"),
    ).toBe("timeout");
    // The next one runs in the next sandbox and pays.
    expect(detail(await submit(opened.id, claimant, "flag{ok}")).amount).toBe(
      "0.30",
    );
  });

  it("asks for the human check at every submission, before the code runs", async () => {
    const opened = await open({}, "1.00", { humanCheck: true });
    const claimant = await actor();
    const input = (text: string) => ({
      submissionId: crypto.randomUUID(),
      participationMode: "code" as const,
      input: text,
    });
    await rejects(
      claimActivity(bindings, opened.id, claimant.id, input("nope")),
      "HUMAN_CHECK_REQUIRED",
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM code_judgments WHERE activity_id = ?",
      )
        .bind(opened.id)
        .first("n"),
    ).toBe(0);
    expect(
      await claimActivity(
        bindings,
        opened.id,
        claimant.id,
        input("nope"),
        undefined,
        true,
      ),
    ).toMatchObject({ result: "rejected" });
    await advanceAttemptCooldown(env.DB, claimant.id);
    // A turn-down passed the check once; the next try asks again.
    await rejects(
      claimActivity(bindings, opened.id, claimant.id, input("flag{ok}")),
      "HUMAN_CHECK_REQUIRED",
    );
  });

  it("may end early once paused, with claims in, and gives back the rest", async () => {
    const opened = await open({
      code: `export function judge(s) {
  if (s.input === "boom") throw new Error("炸了");
  return { ok: true, amount: 20 };
}`,
      tests: JSON.stringify({
        tests: [{ name: "领", input: "x", expect: { ok: true, amount: 20 } }],
      }),
    });
    expect(detail(await submit(opened.id, await actor(), "x")).amount).toBe(
      "0.20",
    );
    await rejects(
      endActivity(bindings, opened.id, author.id, opened.version),
      "INVALID_ACTIVITY",
    );
    const claimant = await actor();
    for (let failures = 0; failures < 5; failures += 1)
      await rejects(submit(opened.id, claimant, "boom"), "JUDGE_FAILED");
    const version = await env.DB.prepare(
      "SELECT version FROM activities WHERE id = ?",
    )
      .bind(opened.id)
      .first<number>("version");
    const ended = await endActivity(
      bindings,
      opened.id,
      author.id,
      version ?? 0,
    );
    expect(ended.status).toBe("ended");
    expect(await readAccount(bindings, author.id)).toMatchObject({
      availableMinor: 480,
      lockedMinor: 0,
    });
  });

  it("publishes the code and the seed once it is over, and they check out", async () => {
    const opened = await open({
      code: `export function judge(s, tools) {
  return { ok: false, message: \`\${tools.random.int(1, 1000000)} \${tools.userRandom.int(1, 1000000)} \${Math.random()}\` };
}`,
      tests: JSON.stringify({
        tests: [{ name: "随", input: "x", expect: { ok: false } }],
      }),
    });
    const before = await getPublicActivity(bindings, opened.id);
    expect(before.judge).toMatchObject({
      protocol: 1,
      prompt: "输入 flag",
      seedCommitment: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(before.judge?.code).toBeUndefined();
    expect(before.judge?.seed).toBeUndefined();
    const claimant = await actor();
    const replies = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await submit(opened.id, claimant, "x");
      replies.push((result as { message: string }).message);
    }
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - 1000, opened.id)
      .run();
    const after = await getPublicActivity(bindings, opened.id);
    const seed = after.judge?.seed ?? "";
    expect(after.judge?.code).toContain("tools.random.int");
    expect(seedCommitment(opened.id, seed)).toBe(before.judge?.seedCommitment);
    expect(after.judge?.fingerprint).toBe(before.judge?.fingerprint);
    // With the seed out, the claimant can work out what they drew.
    const user = await env.DB.prepare(
      "SELECT external_id FROM users WHERE id = ?",
    )
      .bind(claimant.id)
      .first<string>("external_id");
    const expected = [0, 1].map((attempts) => {
      const random = createRandom(
        submissionSeed(opened.id, seed, Number(user), attempts),
      ).api;
      const fixed = createRandom(userSeed(opened.id, seed, Number(user))).api;
      return `${random.int(1, 1000000)} ${fixed.int(1, 1000000)} ${random.next()}`;
    });
    expect(replies).toEqual(expected);
    // Written out once.
    const row = await findJudgeRow(bindings, opened.id);
    expect(row?.revealedAt).not.toBeNull();
    expect(row?.code).toBe(after.judge?.code);
    // Nothing anyone typed is on the page.
    expect(JSON.stringify(after)).not.toContain('"x"');
  });
});
