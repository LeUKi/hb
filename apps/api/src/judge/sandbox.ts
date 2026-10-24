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
  | { failure: SandboxFailure; detail: string; logs?: string[] };

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
  /** Keep console output: the online check, never a claim. */
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
  // Code that loaded once (it passed the online check) only fails to load
  // again if the platform does.
  return { failure: loading ? "load" : "unavailable", detail };
}

/**
 * Runs judge() once. `loading` says whether a failure to start counts
 * against the code (the online check) or the platform (a claim).
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
    if (body.error)
      return {
        // Checked code that stops loading is the platform's failure too.
        failure:
          body.error.kind === "load" && !loading
            ? "unavailable"
            : body.error.kind,
        detail: body.error.detail,
        logs: body.logs,
      };
    return { verdict: body.verdict, logs: body.logs };
  } catch (error) {
    return classify(error, loading);
  } finally {
    clearTimeout(timer);
  }
}
