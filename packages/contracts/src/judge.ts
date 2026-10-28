// 代码判定红包 (docs/programmable-hongbao-design.md): what the forms and the
// API agree on about a sender's code. What the code itself is given and
// returns is kit/judge.d.ts.
import { z } from "zod";
import type { PublicUserProfile } from "./profile";

/**
 * The protocol a 红包 opens with now (§4.7, §9): v2 is v1 with 联网. An
 * opened 红包 keeps the one it opened with.
 */
export const JUDGE_PROTOCOL = 2;

export const JUDGE_LIMITS = {
  promptCharacters: 40,
  codeBytes: 64 * 1024,
  testsBytes: 256 * 1024,
  tests: 200,
  inputCharacters: 200,
  messageCharacters: 100,
  stateBytes: 16 * 1024,
  /** Deployed versions a draft keeps (§5 换回). */
  versions: 10,
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

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * 版本 and 换回 (docs/programmable-hongbao-design.md §5): each new code a
 * draft deploys is 第 n 版, numbered by the form in the order deployed; a
 * code pasted back keeps its number. Kept with the code, encrypted.
 */
export const judgeVersionsSchema = z
  .strictObject({
    /** The number the next new version takes. */
    next: z.number().int().min(1),
    /** The latest deployed versions, at most ten. */
    versions: z
      .array(
        z.strictObject({
          n: z.number().int().min(1),
          fingerprint: fingerprintSchema,
          /** When it was deployed. */
          at: z.iso.datetime(),
          /** The tests.json it last ran, so a draft opened again knows. */
          testsDigest: fingerprintSchema,
          /** Those tests all passed. */
          passed: z.boolean(),
          /** The protocol that run was on; absent: 1. */
          protocol: z.number().int().min(1).max(JUDGE_PROTOCOL).optional(),
          /** 联网 (§9): the addresses that run read from the code. */
          network: z.array(z.string().max(200)).min(1).max(3).optional(),
        }),
      )
      .max(JUDGE_LIMITS.versions),
    /**
     * 换回: the latest version whose tests all passed, with its code, while
     * the code is another.
     */
    restore: z
      .strictObject({ n: z.number().int().min(1), code: codeSchema })
      .optional(),
  })
  .superRefine((value, context) => {
    const numbers = new Set(value.versions.map((version) => version.n));
    const fingerprints = new Set(
      value.versions.map((version) => version.fingerprint),
    );
    if (
      numbers.size !== value.versions.length ||
      fingerprints.size !== value.versions.length ||
      value.versions.some((version) => version.n >= value.next)
    )
      context.addIssue({
        code: "custom",
        path: ["versions"],
        message: "版本号不对",
      });
    if (
      value.restore &&
      !value.versions.some(
        (version) => version.n === value.restore?.n && version.passed,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["restore"],
        message: "只能换回测试全过的版本",
      });
  });
export type JudgeVersions = z.infer<typeof judgeVersionsSchema>;

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
  /** A draft's deployed versions; back in its sender's own read. */
  versions: judgeVersionsSchema.optional(),
});
export type JudgeInput = z.infer<typeof judgeInputSchema>;

/** 部署 (§5): the code and tests to run, saved or not. */
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

/** 部署's result: the same rules as the kit's `npm run check`. */
export type JudgeCheck = {
  fingerprint: string;
  testsDigest: string;
  /** The protocol it ran on (JUDGE_PROTOCOL). */
  protocol: number;
  passed: boolean;
  /**
   * 联网 (§9): the addresses the code exports, as it will ask them; null
   * when it exports none.
   */
  network: string[] | null;
  /** What is wrong with them, or that 联网 is off: no pass. */
  networkProblems?: string[];
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
  /**
   * `deploy`: this sender's first run of this code, a new version made
   * into a 判定器; `rerun`: its tests again on a version deployed before,
   * which counts toward no limit shown.
   */
  kind: "deploy" | "rerun";
  /** New versions this sender may still deploy today (判定器设置). */
  deploysLeft: number;
};

/** Why a claimant's share differs from what the code asked for. */
export type JudgeNote = "floor" | "cap" | "last";

/** A code-judged 红包's public side: the 代码 section of its page. */
export type PublicJudge = {
  protocol: number;
  prompt: string;
  /** Absent on a draft read by anyone but its sender: not fixed yet. */
  fingerprint?: string;
  /** 联网 (§9): the addresses its code may ask; absent without network. */
  network?: string[];
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

/**
 * 参与名单 · 挑战 (05 §7): one person the code has judged, public — how
 * many times and when last, never what they typed or what it said.
 */
export type JudgeChallenger = PublicUserProfile & {
  /** How many times the code judged them. */
  judged: number;
  /** Their latest judgment. */
  lastAt: string;
  /** One of those judgments was a share. */
  claimed: boolean;
};
/** The latest judged first, twenty at a time; `total`: how many people. */
export type JudgeChallengerList = {
  items: JudgeChallenger[];
  total: number;
  nextCursor: string | null;
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
  /**
   * 联网 (§9.4), once the 红包 is over: what each request of this judgment
   * got back — the site, the status and the body — never the request.
   */
  fetches?: JudgeFetchAnswer[];
};

/** One request's answer, as the person judged sees it once it is over. */
export type JudgeFetchAnswer = {
  host: string;
  status?: number;
  /** The body as UTF-8 text (64 KB at most). */
  response?: string;
  /** It failed: 超时, 连不上, 返回超过 64 KB. */
  error?: "timeout" | "unreachable" | "too-big";
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

/**
 * 判定器设置 (redesign/07 §10, docs/programmable-hongbao-design.md §1, §5,
 * §7): 代码判定红包's switch, 每人每天最多开放几个, 每人每天部署几次 (new
 * versions only) and 每月判定器上限 (份).
 */
export const judgeSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** 代码判定联网 (§9.7): off, code that exports network neither deploys nor opens. */
  networkEnabled: z.boolean(),
  dailyOpenLimit: z.number().int().min(1).max(1000),
  dailyDeployLimit: z.number().int().min(1).max(1000),
  monthlyLimit: z.number().int().min(1).max(1_000_000),
});
export type JudgeSettingsInput = z.infer<typeof judgeSettingsSchema>;

export const updateJudgeSettingsSchema = judgeSettingsSchema.extend({
  expectedVersion: z.number().int().positive(),
});
export type UpdateJudgeSettingsInput = z.infer<
  typeof updateJudgeSettingsSchema
>;

export type JudgeSettings = JudgeSettingsInput & {
  version: number;
  updatedAt: number;
};

/** One saved change, for “第 N 版 · 什么时候由谁修改”. */
export type JudgeSettingChange = {
  id: string;
  actorUserId: string;
  actorDisplayName: string;
  previousVersion: number;
  nextVersion: number;
  previous: JudgeSettingsInput;
  next: JudgeSettingsInput;
  createdAt: number;
};
