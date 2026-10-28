import type {
  FetchAnswer,
  HongbaoRules,
  Json,
  JudgeNote,
  JudgeRecords,
  Meta,
  ParamDeclaration,
  ParamProblem,
  Params,
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

// network.mjs
export const NETWORK_LIMITS: Readonly<{
  entries: number;
  entryCharacters: number;
  requests: number;
  requestBytes: number;
  responseBytes: number;
  requestMs: number;
  judgmentMs: number;
}>;
export const NETWORK_METHODS: readonly ("GET" | "POST")[];
export const NETWORK_REASONS: Readonly<
  Record<
    | "none"
    | "ended"
    | "tooMany"
    | "method"
    | "requestTooBig"
    | "responseTooBig"
    | "timeout"
    | "unreachable"
    | "upgrade",
    string
  >
>;
export function networkError(reason: string): TypeError;
export function readNetwork(
  value: unknown,
): { list: string[] | null } | { problems: string[] };
export function allowedBy(
  list: readonly string[] | null,
  address: string,
): boolean;
export function requestProblem(
  request: {
    method: string;
    address: string;
    headers: readonly string[];
    bodyBytes: number;
  },
  list: readonly string[] | null,
): string | null;

// params.mjs
export const PARAM_TYPES: readonly ParamDeclaration["type"][];
export const COLUMN_TYPES: readonly ("text" | "integer" | "money")[];
export const PARAM_LIMITS: Readonly<{
  params: number;
  keyCharacters: number;
  labelCharacters: number;
  hintCharacters: number;
  textCharacters: number;
  textareaCharacters: number;
  minOptions: number;
  maxOptions: number;
  optionValueCharacters: number;
  items: number;
  rows: number;
  columns: number;
  bytes: number;
  checkProblems: number;
  checkMessageCharacters: number;
}>;
export const META_LIMITS: Readonly<{ name: number; description: number }>;
export const HONGBAO_LIMITS: Readonly<{
  count: number;
  promptCharacters: number;
}>;
export function readParams(
  value: unknown,
): { list: ParamDeclaration[] } | { problems: string[] };
export function paramValues(
  list: readonly ParamDeclaration[],
  given: unknown,
): { values: Params } | { problems: ParamProblem[] };
export function secretKeys(list: readonly ParamDeclaration[]): string[];
export function readCheckAnswer(
  value: unknown,
  list: readonly ParamDeclaration[],
): { problems: ParamProblem[] } | { invalid: string };
export function readHongbaoRules(
  value: unknown,
): { rules: HongbaoRules | null } | { problems: string[] };
export function hongbaoRuleProblems(
  rules: HongbaoRules | null | undefined,
  numbers: {
    count?: number | null;
    total?: number | null;
    minEach?: number | null;
  },
): { field: "count" | "total" | "minEach"; message: string }[];
export function readMeta(
  value: unknown,
): { meta: Meta | null } | { problems: string[] };
export function paramLine(item: ParamDeclaration): string;
export type Declarations = {
  meta: Meta | null;
  params: ParamDeclaration[];
  hongbao: HongbaoRules | null;
  check: boolean;
  problems: string[];
};
export function readDeclarations(answer: unknown): Declarations;
export function sortedJson(value: unknown): string;
export function splitParams(
  list: readonly ParamDeclaration[],
  values: Params,
): { shown: Params; secret: Params };
export function paramsCommitment(secret: Params, salt: string): string;

// testing.mjs
export function fetchProblem(list: unknown): string | null;
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
/** A request the code made, answered from what a test wrote. */
export type AskedRequest = {
  method: string;
  url: string;
  body?: string;
  /** No answer was written for it: fetch() threw. */
  unanswered?: true;
};
/** What answering from written answers left: what was asked, what went unused. */
export type AskedNetwork = {
  requests?: AskedRequest[];
  unused?: { method: string; url: string }[];
};
/** What the sandbox answered for one submission. */
export type SandboxAnswer = (
  | { verdict: unknown; logs?: string[] }
  | { failure: SandboxFailureKind; detail: string; logs?: string[] }
) &
  AskedNetwork;
/** The sandbox: one judgment, its requests answered from `answers`. */
export type RunSandbox = (
  submission: Submission,
  seeds: Seeds,
  answers?: readonly FetchAnswer[],
) => Promise<SandboxAnswer>;
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
/** check(params, hongbao) run once: what it said, or how it failed. */
export type RunCheck = (
  params: Params,
  hongbao: Pick<Submission["hongbao"], "title" | "total" | "count" | "minEach">,
) => Promise<
  | { problems: ParamProblem[] }
  | { invalid: string }
  | { failure: SandboxFailureKind; detail: string }
>;
export function runTest(
  test: TestCase,
  run: RunSandbox,
  options?: {
    twice?: boolean;
    /** 协议第三版: the declared params, each test's checked against them. */
    params?: readonly ParamDeclaration[];
    check?: RunCheck;
  },
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
  /** 协议第三版: submission.params. */
  params?: Params;
};
export function startScenario(input: {
  hongbao: Scenario["hongbao"];
  claims?: Submission["claims"];
  state?: Json;
  hongbaoId?: string;
  secret?: string | null;
  params?: Params;
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
    fetch?: readonly FetchAnswer[];
  },
  run: RunSandbox,
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
export function answersOf(
  judgment: JudgeRecords["judgments"][number],
): FetchAnswer[];
