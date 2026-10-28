import { env } from "cloudflare:test";
import type { ClaimDetail, ClaimResult, JudgeInput } from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { paramsCommitment } from "../../../kit/runtime/index.mjs";
import { claimActivity } from "../src/activities/claim-service";
import { scheduleActivity } from "../src/activities/schedule";
import {
  createActivity,
  getPublicActivity,
  openActivity,
} from "../src/activities/service";
import { judgeRecords } from "../src/judge/records";
import { findJudgeRow } from "../src/judge/storage";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import {
  type Actor,
  actor,
  bindings,
  check,
  coded,
  give,
  judgeSettings,
  plus,
  rejects,
  settings,
} from "./code-fixtures";

// A 代码判定红包's params from opening on (docs/judge-square-design.md §3,
// §10): held to the declarations and check() as it opens, the secret ones
// sealed, every judgment given them, and the secret ones out once it is over.

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1 });
  await judgeSettings({ enabled: 1, daily_deploy_limit: 20 });
  await plus(author);
  await give(admin, author, "5.00");
});

const GUESS = `export const params = [
  { key: "max", label: "最大", type: "integer", min: 2, default: 100 },
  { key: "answer", label: "答案", type: "integer", secret: true },
];
export function check(params) {
  return params.answer > params.max
    ? [{ key: "answer", message: \`答案不能大于 \${params.max}\` }]
    : [];
}
export function judge(submission) {
  return Number(submission.input) === submission.params.answer
    ? { ok: true, amount: submission.share.min, message: "猜中了" }
    : { ok: false, message: \`不对，范围 1–\${submission.params.max}\` };
}
`;
const TESTS = JSON.stringify({
  params: { answer: 7 },
  tests: [{ name: "猜中", input: "7", expect: { ok: true } }],
});

/** Deployed into a 判定器, then a draft of it with these params. */
async function draft(params: Record<string, unknown>) {
  const code = `${GUESS}// ${crypto.randomUUID()}`;
  const made = await check(author, code, TESTS, { name: "猜数字" });
  expect(made.body.check.passed).toBe(true);
  const judge: Partial<JudgeInput> = {
    code,
    tests: TESTS,
    judgeId: made.body.check.judge?.id,
    params,
  };
  return createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: coded({}, judge),
  });
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

describe("判定器's params as it opens", () => {
  it("opens only with params as declared and past check(), and is timed only so", async () => {
    const missing = await draft({ max: 10 });
    await expect(
      openActivity(bindings, missing.id, author.id, missing.version),
    ).rejects.toMatchObject({
      code: "JUDGE_PARAMS_INVALID",
      message: "判定器的参数还没填好，草稿已保存。",
    });
    const tooBig = await draft({ max: 10, answer: 20 });
    await expect(
      openActivity(bindings, tooBig.id, author.id, tooBig.version),
    ).rejects.toMatchObject({
      code: "JUDGE_PARAMS_REJECTED",
      message: "参数没通过判定器的检查：答案不能大于 10，草稿已保存。",
    });
    await rejects(
      scheduleActivity(bindings, tooBig.id, author.id, {
        version: tooBig.version,
        at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      "JUDGE_PARAMS_REJECTED",
    );
  });

  it("seals the secret ones, gives every judgment all of them, and publishes them once it is over", async () => {
    // One left from another version is let go.
    const saved = await draft({ answer: 42, old: "x" });
    const opened = await openActivity(
      bindings,
      saved.id,
      author.id,
      saved.version,
    );
    const before = (await getPublicActivity(bindings, opened.id)).judge;
    expect(before?.judge).toMatchObject({ name: "猜数字", version: 1 });
    // Everyone sees 最大; 答案 only as a 封存值.
    expect(before?.params).toEqual([
      {
        param: {
          key: "max",
          label: "最大",
          type: "integer",
          min: 2,
          default: 100,
        },
        value: 100,
      },
    ]);
    expect(before?.sealedParams).toEqual({
      count: 1,
      commitment: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const row = await findJudgeRow(env, opened.id);
    expect(row?.paramsPublic).toBe('{"max":100}');
    // The code gets them all, as declared.
    const wrong = (await submit(opened.id, await actor(), "7")) as {
      message: string;
    };
    expect(wrong.message).toBe("不对，范围 1–100");
    const right = (await submit(opened.id, await actor(), "42")) as {
      result: string;
    };
    expect(right.result).toBe("claimed");
    expect(
      (right as unknown as ClaimResult & { claim: ClaimDetail }).claim.amount,
    ).toBe("0.01");
    // Its sender's records carry them, and the seal.
    const records = await judgeRecords(bindings, opened.id, author.id);
    expect(records.params).toEqual({ max: 100, answer: 42 });
    expect(records.paramsSealed).toEqual({
      keys: ["answer"],
      commitment: before?.sealedParams?.commitment,
      salt: null,
    });
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - 1000, opened.id)
      .run();
    const after = (await getPublicActivity(bindings, opened.id)).judge;
    expect(
      after?.params?.map(({ param, value }) => [param.key, value]),
    ).toEqual([
      ["max", 100],
      ["answer", 42],
    ]);
    const salt = after?.sealedParams?.salt ?? "";
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    // Anyone can check them: SHA-256 of the sorted JSON, a newline, the salt.
    expect(paramsCommitment({ answer: 42 }, salt)).toBe(
      before?.sealedParams?.commitment,
    );
    expect(
      (await judgeRecords(bindings, opened.id, author.id)).paramsSealed?.salt,
    ).toBe(salt);
  });
});
