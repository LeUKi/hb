import type {
  Json,
  JudgeNote,
  JudgeRecords,
  Random,
  Submission,
  TestCase,
  Tools,
} from "../judge";

export type Fill = (bytes: Uint8Array) => void;

// hash.mjs
export function utf8(text: string): Uint8Array;
export function toHex(bytes: Uint8Array): string;
export function sha256(data: Uint8Array): Uint8Array;
export function sha1(data: Uint8Array): Uint8Array;
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array;
export function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array;
export function sha256Text(text: string): string;

// random.mjs
export function seedStream(seed: string): Fill;
export function randomIntegerInclusive(
  minimum: bigint,
  maximum: bigint,
  fill: Fill,
): bigint;
export function createRandom(seed: string): { api: Random; fill: Fill };

// seeds.mjs
export function seedCommitment(hongbaoId: string, secret: string): string;
export function submissionSeed(
  hongbaoId: string,
  secret: string,
  userId: number | string,
  attempts: number,
): string;
export function userSeed(
  hongbaoId: string,
  secret: string,
  userId: number | string,
): string;

// money.mjs
export interface Share {
  min: number;
  max: number;
  last: boolean;
}
export function shareRange(input: {
  remaining: number;
  remainingCount: number;
  minEach: number;
}): Share;
export function settle(asked: number, share: Share): number;
export function formatAmount(amount: number): string;
export function evenAmount(
  hongbao: { remaining: number; remainingCount: number },
  share: Share,
): number;
export function luckyAmount(
  kind: "double" | "bounded",
  hongbao: {
    total: number;
    count: number;
    minEach: number;
    remaining: number;
    remainingCount: number;
  },
  share: Share,
  fill: Fill,
): number;

// codes.mjs
export function crockford(bytes: Uint8Array): string;
export function normalizeCode(text: string): string;
export function sameCode(input: string, code: string): boolean;
export function personalCode(
  key: string,
  parts: readonly (string | number)[],
  length?: number,
): string;
export function base32Decode(text: string): Uint8Array;
export function totp(
  secret: string,
  options: { now: number; step?: number; digits?: number; offset?: number },
): string;
export function timeWindow(now: number, seconds: number): number;

// text.mjs
export function normalizeText(text: string): string;

// time.mjs
export function timeParts(
  ms: number,
  timeZone?: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

// tools.mjs
export function createTools(
  submission: Submission,
  seeds: { submission: string; user: string },
): { tools: Tools; next: () => number };

// verdict.mjs
export const LIMITS: Readonly<{
  codeBytes: number;
  stateBytes: number;
  stateDepth: number;
  messageCharacters: number;
  inputCharacters: number;
  promptCharacters: number;
  tests: number;
}>;
export function nestsDeeper(value: unknown, limit: number): boolean;
export type StateChange = { keep: true } | { keep: false; value: Json };
export type VerdictReading =
  | { error: { kind: "invalid"; detail: string } }
  | { ok: false; message?: string; state: StateChange; unknown: string[] }
  | {
      ok: true;
      asked: number;
      paid: number;
      note: "floor" | "cap" | "last" | null;
      message?: string;
      state: StateChange;
      unknown: string[];
    };
export function readVerdict(raw: unknown, share: Share): VerdictReading;

// imports.mjs
export const ALLOWED_MODULES: readonly string[];
export function scanImports(
  source: string,
): (
  | { kind: "static"; specifier: string; at: number }
  | { kind: "dynamic"; at: number }
)[];
export function checkSource(
  source: string,
): { line: number; message: string }[];

// testing.mjs
export const TEST_HONGBAO_ID: string;
export const TEST_SEED: string;
export const TEST_DEFAULTS: Readonly<{
  user: Readonly<Submission["user"]>;
  hongbao: Readonly<
    Pick<Submission["hongbao"], "title" | "total" | "count" | "minEach">
  >;
  now: number;
}>;
export function readTests(
  text: string,
): { tests: TestCase[] } | { problem: string };
export function sameJson(left: unknown, right: unknown): boolean;
export type SandboxFailureKind =
  | "load"
  | "no-judge"
  | "threw"
  | "invalid"
  | "timeout"
  | "memory"
  | "unavailable";
/** What the sandbox answered for one submission. */
export type SandboxAnswer =
  | { verdict: unknown; logs?: string[] }
  | { failure: SandboxFailureKind; detail: string; logs?: string[] };
export type Seeds = { submission: string; user: string };
/** What the code answered, and what was paid. */
export type TestActual = {
  ok: boolean;
  amount?: number;
  asked?: number;
  note?: JudgeNote | null;
  message?: string;
  /** The state after this judgment: what it wrote, or the one it kept. */
  state: Json;
};
export type StepRun = {
  who?: string;
  input: string;
  at: number;
  passed: boolean;
  problem?: string;
  actual?: TestActual;
  ms: number;
  logs?: string[];
};
export type TestRun = {
  passed: boolean;
  /** Every difference; for steps, the step that failed and who. */
  problem?: string;
  actual?: TestActual;
  /** All its judgments, in milliseconds. */
  ms: number;
  /** A single test's console output. */
  logs?: string[];
  /** A multi-step test: each step that ran, the failing one last. */
  steps?: StepRun[];
  /** The sandbox failed rather than the code answering. */
  failure?: { kind: SandboxFailureKind; detail: string };
  /** Run twice, and an answer differed: true randomness. */
  unstable?: true;
};
export function runTest(
  test: TestCase,
  run: (submission: Submission, seeds: Seeds) => Promise<SandboxAnswer>,
  options?: { twice?: boolean },
): Promise<TestRun>;

// scenario.mjs
export type Scenario = {
  hongbao: Omit<
    Submission["hongbao"],
    "remaining" | "remainingCount" | "title"
  > & {
    title?: string;
  };
  claims: Submission["claims"];
  paid: number;
  state: Json;
  judged: Map<number, number>;
  hongbaoId?: string;
  secret: string | null;
};
export function startScenario(input: {
  hongbao: Scenario["hongbao"];
  claims?: Submission["claims"];
  state?: Json;
  hongbaoId?: string;
  secret?: string | null;
}): Scenario;
export function refusalOf(
  scenario: Scenario,
  user: { id: number },
): "claimed" | "sold-out" | null;
export function nextSubmission(
  scenario: Scenario,
  next: {
    input: string;
    now: number;
    user: Omit<Submission["user"], "attempts"> & { attempts?: number };
    title?: string;
  },
): Submission;
export function advance(
  scenario: Scenario,
  submission: Submission,
  change: { state: StateChange; paid?: number; at?: number },
): void;
export function judgeNext(
  scenario: Scenario,
  next: {
    user: Omit<Submission["user"], "attempts"> & { attempts?: number };
    input: string;
    at: number;
  },
  run: (submission: Submission, seeds: Seeds) => Promise<SandboxAnswer>,
): Promise<
  | { refused: "claimed" | "sold-out" }
  | {
      submission: Submission;
      seeds: Seeds;
      answer: SandboxAnswer;
      ms: number;
      reading?: VerdictReading;
    }
>;

// records.mjs
export function submissionsOf(records: JudgeRecords): Submission[];
