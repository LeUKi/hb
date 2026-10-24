// 代码判定红包 (docs/programmable-hongbao-design.md): what the forms and the
// API agree on about a sender's code. What the code itself is given and
// returns is kit/judge.d.ts.
import { z } from "zod";
import type { PublicUserProfile } from "./profile";

export const JUDGE_LIMITS = {
  promptCharacters: 40,
  codeBytes: 64 * 1024,
  testsBytes: 256 * 1024,
  tests: 200,
  inputCharacters: 200,
  messageCharacters: 100,
  stateBytes: 16 * 1024,
} as const;

const characters = (value: string) => Array.from(value).length;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

const codeSchema = z
  .string()
  .refine((value) => value.trim() !== "", "请粘贴代码")
  .refine(
    (value) => bytes(value) <= JUDGE_LIMITS.codeBytes,
    `代码超过 ${JUDGE_LIMITS.codeBytes / 1024} KB`,
  );
const testsSchema = z
  .string()
  .refine(
    (value) => bytes(value) <= JUDGE_LIMITS.testsBytes,
    `测试超过 ${JUDGE_LIMITS.testsBytes / 1024} KB`,
  );

/** Step 3 of 发红包 (代码): the prompt, judge.js and tests.json as pasted. */
export const judgeInputSchema = z.strictObject({
  prompt: z
    .string()
    .trim()
    .refine(
      (value) => characters(value) <= JUDGE_LIMITS.promptCharacters,
      `领取时的提示最多 ${JUDGE_LIMITS.promptCharacters} 个字`,
    ),
  code: codeSchema,
  tests: testsSchema,
});
export type JudgeInput = z.infer<typeof judgeInputSchema>;

/** 在线检查: the code and tests to run, saved or not. */
export const judgeCheckInputSchema = z.strictObject({
  code: codeSchema,
  tests: testsSchema,
});
export type JudgeCheckInput = z.infer<typeof judgeCheckInputSchema>;

/** What a claimant submits: one line, ends trimmed, 1–200 characters. */
export const judgeAnswerSchema = z
  .string()
  .trim()
  .refine((value) => !/[\r\n]/.test(value), "只能输入一行")
  .refine(
    (value) =>
      characters(value) >= 1 &&
      characters(value) <= JUDGE_LIMITS.inputCharacters,
    `请输入 1–${JUDGE_LIMITS.inputCharacters} 个字`,
  );

/** One test as the check ran it. */
export type JudgeTestOutcome = {
  name: string;
  passed: boolean;
  /** Why it did not pass: a differing field, or how the code failed. */
  problem?: string;
  /**
   * What the code answered and what was paid: `amount` paid, `asked` the
   * code's own number, `note` why they differ (null when they do not).
   */
  actual?: {
    ok: boolean;
    amount?: number;
    asked?: number;
    note?: JudgeNote | null;
    message?: string;
    state?: unknown;
  };
  ms?: number;
};

/** 在线检查's result: the same rules as the kit's `npm run check`. */
export type JudgeCheck = {
  fingerprint: string;
  testsDigest: string;
  passed: boolean;
  /** Found without running the code: imports, size. */
  problems: { line: number; message: string }[];
  /** tests.json itself: not JSON, or an entry the protocol does not have. */
  testsProblem?: string;
  /** The code would not load, or exports no judge. */
  loadProblem?: string;
  tests: JudgeTestOutcome[];
  /** Answers that differ between two runs: true randomness, no replay. */
  unstable: string[];
  slowestMs: number | null;
  checkedAt: string;
  /** Checks left today (网站设置: 在线检查每人每天几次). */
  remainingToday: number;
};

/** Why a claimant's share differs from what the code asked for. */
export type JudgeNote = "floor" | "cap" | "last";

/** A code-judged 红包's public side: the 代码 section of its page. */
export type PublicJudge = {
  protocol: number;
  prompt: string;
  fingerprint: string;
  /** Published at opening (null on a draft). */
  seedCommitment: string | null;
  /** How many times the code gave a verdict, paid or not (05 §3). */
  judged: number;
  /** The code failed five judgments running: claims wait. */
  paused?: true;
  /** 站长 stopped it. */
  stopped?: true;
  /** Once it is over: the code and the seed, to check the fingerprints. */
  code?: string;
  seed?: string;
};

/** 我的提交 (05 §3): one of the viewer's own judged submissions. */
export type MyJudgment = {
  /** 第 N 次, from 1. */
  attempt: number;
  at: string;
  /** What they typed, as the code got it. */
  input: string;
  /** 代码的回复, if it gave one. */
  message?: string;
  /** Paid: how much, as "0.30". */
  amount?: string;
  /** Paid, not what the code asked: 按上限发, 按每份至少发, 最后一份. */
  note?: JudgeNote;
};
export type MyJudgmentList = {
  /** Newest first, twenty at a time. */
  items: MyJudgment[];
  total: number;
  nextCursor: string | null;
};

/** A judgment the code failed (出错记录); nothing of it counted. */
export type CodeFailure = {
  at: string;
  kind: "threw" | "timeout" | "invalid" | "memory";
  detail: string;
  user: PublicUserProfile;
};
export type CodeFailureList = {
  /** The latest fifty, newest first. */
  items: CodeFailure[];
  failuresInRow: number;
  pausedAt: string | null;
};
