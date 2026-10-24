// One judgment in a 代码判定红包's sandbox: the sender's judge.js beside the
// runtime from kit/runtime, in its own Dynamic Worker with no bindings, no
// secrets and no network (docs/programmable-hongbao-design.md §4, §7).
import type { Submission } from "../../../../kit/judge";
import type { ApiBindings } from "../env";
import runtime from "./runtime.generated.json";

/** Protocol v1: this runtime on this compatibility date with nodejs_compat. */
export const JUDGE_PROTOCOL = 1;
const COMPATIBILITY_DATE = "2026-09-01";
/** The sandbox is killed past about cpuMs + 2 s; the caller stops waiting first. */
const CPU_MS = 50;
export const JUDGE_WAIT_MS = 300;

export type SandboxFailure =
  /** judge.js would not load: a syntax error or a throw at its top level. */
  | "load"
  | "no-judge"
  | "threw"
  /** Its answer is not JSON (the protocol itself is read by readVerdict). */
  | "invalid"
  | "timeout"
  | "memory"
  /** Dynamic Workers failed us: not the code's fault. */
  | "unavailable";

export type SandboxOutcome =
  | { verdict: unknown; logs?: string[] }
  | {
      failure: SandboxFailure;
      detail: string;
      logs?: string[];
      /**
       * A timeout the runtime cut short at once: nothing is left running in
       * its sandbox, so the next judgment can go on in it.
       */
      hung?: true;
    };

/** The kinds main.mjs itself reports. */
const REPORTED = new Set<SandboxFailure>([
  "load",
  "no-judge",
  "threw",
  "invalid",
]);

// Dynamic Workers take .js names as modules; the runtime's .mjs files say so.
const runtimeModules = Object.fromEntries(
  Object.entries(runtime).map(([name, js]) => [name, { js }]),
);

/**
 * The isolate's ID: the protocol and the code's fingerprint, so a day's
 * claims on one code share one Dynamic Worker and only code changes make a
 * new one. `fresh` > 0 moves past an isolate stuck in a slow judgment.
 */
export function sandboxId(fingerprint: string, fresh = 0) {
  return `judge:v${JUDGE_PROTOCOL}:${fingerprint}${fresh > 0 ? `:${fresh}` : ""}`;
}

export type JudgeRun = {
  code: string;
  fingerprint: string;
  submission: Submission;
  /** This submission's and this person's seeds (kit/runtime/seeds.mjs). */
  seeds: { submission: string; user: string };
  /** Keep console output: a deploy, never a claim. */
  capture?: boolean;
  fresh?: number;
  waitMs?: number;
};

function classify(error: unknown, loading: boolean): SandboxOutcome {
  const detail = String(error instanceof Error ? error.message : error).slice(
    0,
    500,
  );
  if (/exceeded CPU time limit/i.test(detail))
    return { failure: "timeout", detail };
  if (/exceeded memory limit/i.test(detail))
    return { failure: "memory", detail };
  // The runtime gives up at once on a judgment nothing is left to answer
  // (it awaits a promise that never settles): it would never end, so it is
  // a timeout, and its sandbox goes on, as the kit has it
  // (kit/cli/lib/sandbox.mjs).
  if (/code had hung|never generate a response|runtime canceled/i.test(detail))
    return {
      failure: "timeout",
      detail: "代码一直没有返回（在等一个永远不会完成的 Promise）",
      hung: true,
    };
  // Only code that does not compile fails to start this way (workerd's
  // "Uncaught SyntaxError"); a throw at its top level comes back from
  // main.mjs. Anything else is taken as the platform failing us, and code
  // that loaded once (its deploy passed) only fails to load again if it does.
  if (loading && /Uncaught|SyntaxError/.test(detail))
    return { failure: "load", detail };
  return { failure: "unavailable", detail };
}

/**
 * Runs judge() once. `loading` says whether a failure to start counts
 * against the code (a deploy) or the platform (a claim).
 */
export async function runJudge(
  env: ApiBindings,
  run: JudgeRun,
  loading = false,
): Promise<SandboxOutcome> {
  const worker = env.LOADER.get(
    sandboxId(run.fingerprint, run.fresh),
    async () => ({
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "main.mjs",
      modules: { ...runtimeModules, "judge.js": run.code },
      globalOutbound: null,
    }),
  );
  const waitMs = run.waitMs ?? JUDGE_WAIT_MS;
  const request = worker
    .getEntrypoint(undefined, { limits: { cpuMs: CPU_MS } })
    .fetch("http://judge/", {
      method: "POST",
      body: JSON.stringify({
        submission: run.submission,
        seeds: run.seeds,
        capture: run.capture === true,
      }),
    });
  // A judgment given up on still ends (or is killed) later: nothing waits.
  request.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), waitMs);
  });
  try {
    const response = await Promise.race([request, late]);
    if (response === "late")
      return { failure: "timeout", detail: `超过 ${waitMs} 毫秒没有判定完` };
    const body = (await response.json()) as {
      verdict?: unknown;
      error?: { kind: SandboxFailure; detail: string };
      logs?: string[];
    };
    if (body.error) {
      // judge.js shares main.mjs's isolate and can forge its answer: a kind
      // main.mjs never reports (a timeout, the platform failing) is the
      // host's alone to say, and claimed by the code it is a wrong answer.
      const kind = REPORTED.has(body.error.kind) ? body.error.kind : "invalid";
      return {
        // Checked code that stops loading is the platform's failure too.
        failure: kind === "load" && !loading ? "unavailable" : kind,
        detail: String(body.error.detail ?? "").slice(0, 500),
        logs: body.logs,
      };
    }
    return { verdict: body.verdict, logs: body.logs };
  } catch (error) {
    return classify(error, loading);
  } finally {
    clearTimeout(timer);
  }
}
