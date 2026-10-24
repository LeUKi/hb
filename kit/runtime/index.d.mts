import type {
  Json,
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
  messageCharacters: number;
  inputCharacters: number;
  promptCharacters: number;
  tests: number;
}>;
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
export function testSubmission(test: TestCase):
  | {
      submission: Submission;
      seeds: { submission: string; user: string };
    }
  | { problem: string };
export function sameJson(left: unknown, right: unknown): boolean;
export type TestResult = {
  passed: boolean;
  problem?: string;
  actual?: { ok: boolean; amount?: number; message?: string; state: Json };
  unknown?: string[];
};
export function judgeTest(
  test: TestCase,
  submission: Submission,
  outcome: { verdict: unknown } | { failure: string; detail: string },
): TestResult;

// records.mjs
export function submissionsOf(records: JudgeRecords): Submission[];
