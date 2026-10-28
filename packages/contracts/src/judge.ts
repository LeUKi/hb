// 代码判定红包 (docs/programmable-hongbao-design.md): what the forms and the
// API agree on about a sender's code. What the code itself is given and
// returns is kit/judge.d.ts.
import { z } from "zod";
import type {
  HongbaoRules,
  Meta,
  ParamDeclaration,
  ParamProblem,
  Params,
} from "../../../kit/judge";
import type { PublicUserProfile } from "./profile";

/** 协议第三版 (docs/judge-square-design.md §3, §4), as kit/judge.d.ts has them. */
export type {
  HongbaoRules as JudgeHongbaoRules,
  Meta as JudgeMeta,
  ParamDeclaration as JudgeParam,
  ParamProblem as JudgeParamProblem,
  Params as JudgeParams,
};

/** What a v3 judge.js exports besides judge, as its deploy read it. */
export type JudgeDeclarations = {
  meta: Meta | null;
  params: ParamDeclaration[];
  hongbao: HongbaoRules | null;
  /** It exports check(params, hongbao). */
  check: boolean;
};

/**
 * The protocol a 红包 opens with now (§4.7, §9; docs/judge-square-design.md
 * §5): v2 is v1 with 联网, v3 is v2 with params. An opened 红包 keeps the
 * one it opened with.
 */
export const JUDGE_PROTOCOL = 3;

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

/** 判定器's name and line (docs/judge-square-design.md §1, §14.4). */
export const JUDGE_NAME_LIMITS = { name: 20, description: 60 } as const;
export const judgeNameSchema = z
  .string()
  .trim()
  .refine((value) => value !== "", "先给判定器起个名字")
  .refine(
    (value) => characters(value) <= JUDGE_NAME_LIMITS.name,
    `名字最多 ${JUDGE_NAME_LIMITS.name} 个字`,
  );
export const judgeDescriptionSchema = z
  .string()
  .trim()
  .refine(
    (value) => characters(value) <= JUDGE_NAME_LIMITS.description,
    `说明最多 ${JUDGE_NAME_LIMITS.description} 个字`,
  );

/** The params a sender filled (§3): checked against the version it opens with. */
const paramsSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => bytes(JSON.stringify(value)) <= 16 * 1024,
    "参数一共最多 16 KB",
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
  /**
   * A draft's deployed versions: its 判定器's, back in its sender's own read
   * (a draft no longer keeps its own; sent back, they are not read).
   */
  versions: judgeVersionsSchema.optional(),
  /**
   * 判定器 (docs/judge-square-design.md §1): the one this code is deployed
   * into or picked from; its name and line as typed, saved onto it.
   */
  judgeId: z.uuid().optional(),
  name: judgeNameSchema.optional(),
  description: judgeDescriptionSchema.optional(),
  /** The params filled (§3); checked against its version at opening. */
  params: paramsSchema.optional(),
  /**
   * Another's 判定器 picked from the 广场 (§15.3): the version used. Its
   * code and tests come from that version; the tests are never sent here,
   * nor read back.
   */
  version: z.number().int().positive().optional(),
  /** 联网 (§7): the addresses its sender confirmed (这个判定器会联网). */
  networkAck: z.array(z.string().max(200)).max(3).optional(),
});
export type JudgeInput = z.infer<typeof judgeInputSchema>;

/**
 * Another's 判定器 a draft uses (§15.4), as its sender's form shows it:
 * whose, whether it is still in the 广场 or taken down, a newer version
 * others use, and what the draft's version declares.
 */
export type JudgeSource = {
  author: JudgePerson;
  featured: boolean;
  bySiteOwner: boolean;
  /** 基于 @作者: whose it was copied from. */
  basedOn: string | null;
  listed: boolean;
  takenDown: boolean;
  newer: number | null;
  declarations: JudgeDeclarations | null;
  network: string[] | null;
};

/**
 * 部署 (§5): the code and tests to run, saved or not, into a 判定器
 * (docs/judge-square-design.md §1): one of the sender's, or a new one by
 * this name.
 */
export const judgeCheckInputSchema = z.strictObject({
  code: codeSchema,
  tests: testsSchema,
  judge: z
    .union([
      z.strictObject({ id: z.uuid() }),
      z.strictObject({
        name: judgeNameSchema,
        description: judgeDescriptionSchema.optional(),
        /** 复制一份来改 (§8): the 判定器 it was copied from. */
        basedOn: z.uuid().optional(),
      }),
    ])
    .optional(),
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
  /** 协议第三版: meta, params, hongbao and check, as declared. */
  declarations: JudgeDeclarations;
  /** What is wrong with them: no pass. */
  declarationProblems?: string[];
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
  /**
   * The 判定器 it was deployed into (docs/judge-square-design.md §1): its
   * name, which version this code is, and its versions as a draft shows them.
   */
  judge?: {
    id: string;
    name: string;
    description: string;
    version: number;
    versions: JudgeVersions;
  };
};

/** One version of a sender's own 判定器 (docs/judge-square-design.md §1). */
export type MyJudgeVersion = {
  n: number;
  fingerprint: string;
  deployedAt: string;
  /** Its last run: when, on which protocol, of which tests, and how. */
  checkedAt: string;
  protocol: number;
  testsDigest: string;
  passed: boolean;
  network: string[] | null;
  declarations: JudgeDeclarations | null;
  /** 红包 opened with it. */
  opened: number;
};

/** A sender's own 判定器, as 我的判定器 lists it. */
export type MyJudge = {
  id: string;
  name: string;
  description: string;
  codePublic: "ended" | "always";
  createdAt: string;
  updatedAt: string;
  /** The last version deployed. */
  latest: { n: number; deployedAt: string; passed: boolean } | null;
  /**
   * The newest version a 红包 can open with now: tests passed on the
   * current protocol.
   */
  usable: {
    n: number;
    declarations: JudgeDeclarations | null;
    network: string[] | null;
  } | null;
  /** 红包 opened with it, any version. */
  opened: number;
  /** 判定器广场 (docs/judge-square-design.md §8): in it now. */
  listed: boolean;
  /** 允许站长选入精选. */
  featurable: boolean;
  /** 站长撤下: when, and why. */
  takenDown: { at: string; reason: string } | null;
  /** The version 站长精选 has, if it has one. */
  featured: number | null;
  /** Its numbers, as the 广场 shows them (§8). */
  stats: JudgeStats;
};

export type MyJudgeDetail = MyJudge & {
  versions: MyJudgeVersion[];
  /** The version others use in the 广场 (§15.3), if any. */
  publicN: number | null;
};

/**
 * A 判定器's numbers (§8 卡片): 红包 opened with it (not those the 站长
 * stopped), its judgments, and claims, worked out every few minutes.
 */
export type JudgeStats = { hongbao: number; judged: number; claimed: number };

/** Whoever made a 判定器, as the 广场 names them. */
export type JudgePerson = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

/** A 判定器 as the 广场 lists it (§8 卡片, §15.4). */
export type SquareJudge = {
  id: string;
  name: string;
  description: string;
  author: JudgePerson;
  /** 复制一份来改 (§8): whose it was, and whether that one is in the 广场. */
  basedOn: (JudgePerson & { id: string; listed: boolean }) | null;
  /** In 站长精选 (§9). */
  featured: boolean;
  /** Made by the 站长: with basedOn, a 精选 改进后选入 (§9). */
  bySiteOwner: boolean;
  /** The version others use goes online (§7). */
  network: boolean;
  stats: JudgeStats;
};

export type SquareJudgeList = {
  items: SquareJudge[];
  nextCursor: string | null;
};

/** One version of another's 判定器, as its page lists it (§8 版本). */
export type JudgePageVersion = {
  n: number;
  deployedAt: string;
  opened: number;
};

/**
 * 判定器页 for anyone it is open to (§8, §15.3): the version others use,
 * its code when public, and the versions that opened a 红包.
 */
export type JudgePage = SquareJudge & {
  own: boolean;
  /** In the 广场 now. */
  listed: boolean;
  /** Code public all along (§2): what others see of it. */
  codePublic: "ended" | "always";
  version: {
    n: number;
    fingerprint: string;
    deployedAt: string;
    declarations: JudgeDeclarations | null;
    network: string[] | null;
    /** Only when its code is public. */
    code: string | null;
  } | null;
  versions: JudgePageVersion[];
  /** For the 站长 only: taken down, when and why. */
  takenDown?: { at: string; reason: string };
};

/** 加入判定器广场 and 允许站长选入精选 (§8, §15.4). */
export const judgeListingSchema = z.strictObject({
  listed: z.boolean(),
  featurable: z.boolean(),
});
export type JudgeListingInput = z.infer<typeof judgeListingSchema>;

/** The 红包 a 判定器 is tried on (§3 check, §6 试一试), in 分. */
const triedHongbaoSchema = z.strictObject({
  title: z.string().max(100),
  total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  count: z.number().int().min(1).max(1000),
  minEach: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** check(params, hongbao) on a version (docs/judge-square-design.md §3). */
export const judgeParamsCheckSchema = z.strictObject({
  params: paramsSchema,
  hongbao: triedHongbaoSchema,
});
export type JudgeParamsCheckInput = z.infer<typeof judgeParamsCheckSchema>;
/** What it said, item by item; or that it failed (and why). */
export type JudgeParamsCheck =
  | { problems: ParamProblem[] }
  | { failure: string };

/** 试一试 (§6): one judgment with these params, no money, no record. */
export const judgeTrySchema = z.strictObject({
  params: paramsSchema,
  hongbao: triedHongbaoSchema,
  input: judgeAnswerSchema,
});
export type JudgeTryInput = z.infer<typeof judgeTrySchema>;
export type JudgeTry =
  | { ok: true; amount: number; message?: string }
  | { ok: false; message?: string }
  | { failure: "timeout" | "error"; detail: string };

/** 判定器页's settings (docs/judge-square-design.md §2, §14.4). */
export const updateJudgeSchema = z.strictObject({
  name: judgeNameSchema,
  description: judgeDescriptionSchema,
  /** Only ever from 结束后公开 to 一直公开. */
  codePublic: z.enum(["ended", "always"]),
});
export type UpdateJudgeInput = z.infer<typeof updateJudgeSchema>;

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
  /**
   * Its 判定器 (docs/judge-square-design.md §10): name, version, whose.
   * Absent for one with none (sent before 判定器 and not read since).
   */
  judge?: {
    id: string;
    name: string;
    version: number | null;
    author: { username: string; displayName: string };
    /** In the 广场 (its page opens to anyone): the name is a link. */
    listed: boolean;
    /** 站长精选 (§10): as chosen, or the 站长's copy of another's. */
    featured: boolean;
    bySiteOwner: boolean;
    basedOn: string | null;
  };
  /**
   * Its params from opening (§3): the ones everyone sees, as declared, and
   * once it is over the secret ones too (marked).
   */
  params?: { param: ParamDeclaration; value: unknown }[];
  /** 保密参数 (§3): how many, their 封存值 from opening, the salt once over. */
  sealedParams?: { count: number; commitment: string; salt?: string };
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
 * versions only; another number for 🐟额 PLUS and the 站长) and 每月判定器上限
 * (份).
 */
export const judgeSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** 代码判定联网 (§9.7): off, code that exports network neither deploys nor opens. */
  networkEnabled: z.boolean(),
  dailyOpenLimit: z.number().int().min(1).max(1000),
  dailyDeployLimit: z.number().int().min(1).max(1000),
  dailyDeployLimitPlus: z.number().int().min(1).max(1000),
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
