import type { Submission } from "../judge";
import type {
  SandboxAnswer,
  Seeds,
  StateChange,
  VerdictReading,
  ViewChange,
} from "../runtime/index.mjs";

export type Print = (line: string) => void;

export type CommandOptions = {
  /** The kit's directory: judge.js, tests.json and simulate.json are here. */
  dir: string;
  /** What follows the command, as npm passes it after `--`. */
  args?: string[];
  /** Where a file argument is read from (npm's INIT_CWD); `dir` by default. */
  cwd?: string;
  /** Each line of output; console.log by default. */
  print?: Print;
};

export const PROTOCOL: number;
export const COMPATIBILITY_DATE: string;
export const SANDBOX_MODULES: readonly string[];
export const TIMEOUT_MS: number;
export const SLOW_MS: number;
export const TESTS_BYTES: number;

export type Sandbox = {
  run(submission: Submission, seeds: Seeds): Promise<SandboxAnswer>;
  /** How many times workerd was started afresh after a timeout. */
  readonly restarts: number;
  /** How long judge.js's top level took to run, or null if it never ended. */
  readonly loadMs: number | null;
  close(): Promise<void>;
};
export function openSandbox(code: string): Promise<Sandbox>;

export function testCommand(
  options: CommandOptions,
): Promise<{ exitCode: number }>;

export function checkCommand(options: CommandOptions): Promise<{
  exitCode: number;
  fingerprint: string;
  /** Names of the tests whose two runs differed. */
  unstable: string[];
}>;

export type SimulatedSubmission = {
  who: string;
  user: Omit<Submission["user"], "attempts">;
  input: string;
  at: number;
} & (
  | { refused: "ended" | "claimed" | "sold-out" }
  | {
      submission: Submission;
      seeds: Seeds;
      answer: SandboxAnswer;
      ms: number;
      reading?: VerdictReading;
    }
);

export function simulateCommand(options: CommandOptions): Promise<{
  exitCode: number;
  simulation?: {
    hongbao: Omit<Submission["hongbao"], "remaining" | "remainingCount">;
    hongbaoId: string;
    seed: string;
    /** 协议第四版: setup()'s answer, when judge.js exports setup. */
    setup?: { state: StateChange; view: ViewChange };
    judged: SimulatedSubmission[];
  };
}>;

export function replayCommand(
  options: CommandOptions,
): Promise<{ exitCode: number }>;

export type SimulationPlan = {
  hongbao: Omit<Submission["hongbao"], "remaining" | "remainingCount">;
  seed: string;
  submissions: {
    who: string;
    user: Omit<Submission["user"], "attempts">;
    input: string;
    at: number;
  }[];
};
export function readSimulation(
  text: string,
  file?: string,
): { plan: SimulationPlan } | { problem: string };
