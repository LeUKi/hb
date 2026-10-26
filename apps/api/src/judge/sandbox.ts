// One judgment in a 代码判定红包's sandbox: the sender's judge.js beside the
// runtime from kit/runtime, in its own Dynamic Worker with no bindings and
// no secrets (docs/programmable-hongbao-design.md §4, §7). Its network is
// none, or for a 联网 红包 the gateway (gateway.ts, §9.7).
import { JUDGE_PROTOCOL } from "@hb/contracts";
import type { FetchAnswer, Submission } from "../../../../kit/judge";
import frozenV1 from "../../../../kit/runtime/frozen/v1.json";
import { NETWORK_LIMITS } from "../../../../kit/runtime/index.mjs";
import type { ApiBindings } from "../env";
import runtime from "./runtime.generated.json";

/**
 * Protocol v2: this runtime on this compatibility date with nodejs_compat.
 * v1's runtime is kept as 红包 opened with it.
 */
export { JUDGE_PROTOCOL };

const COMPATIBILITY_DATE = "2026-09-01";
/** The sandbox is killed past about cpuMs + 2 s; the caller stops waiting first. */
const CPU_MS = 50;
export const JUDGE_WAIT_MS = 300;
/**
 * A 联网 judgment, all of it (§9.3). Its requests are waited for; the rest
 * of it still has JUDGE_WAIT_MS (session.ts's deadline).
 */
export const NETWORK_WAIT_MS = NETWORK_LIMITS.judgmentMs;

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

/** A test's requests against the answers it wrote (kit/runtime/testing.mjs). */
type Asked = {
  requests?: {
    method: string;
    url: string;
    body?: string;
    unanswered?: true;
  }[];
  unused?: { method: string; url: string }[];
};

export type SandboxOutcome = (
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
    }
) &
  Asked;

/** The kinds main.mjs itself reports. */
const REPORTED = new Set<SandboxFailure>([
  "load",
  "no-judge",
  "threw",
  "invalid",
]);

// Dynamic Workers take .js names as modules; the runtime's .mjs files say so.
const modulesOf = (copy: Record<string, string>) =>
  Object.fromEntries(Object.entries(copy).map(([name, js]) => [name, { js }]));
const runtimeModules: Record<number, Record<string, { js: string }>> = {
  1: modulesOf(frozenV1),
  [JUDGE_PROTOCOL]: modulesOf(runtime),
};

/**
 * The isolate's ID: the protocol and the code's fingerprint, so a day's
 * claims on one code share one Dynamic Worker and only code changes make a
 * new one; a 联网 红包's own after it (§9.7), so the gateway it goes out
 * through knows whose it is. `fresh` > 0 moves past an isolate stuck in a
 * slow judgment.
 */
export function sandboxId(
  fingerprint: string,
  fresh = 0,
  protocol = JUDGE_PROTOCOL,
  networkedFor?: string,
) {
  return `judge:v${protocol}:${fingerprint}${networkedFor ? `:${networkedFor}` : ""}${fresh > 0 ? `:${fresh}` : ""}`;
}

/**
 * The network a judgment has: none; a test's written answers (`mock`); or
 * out through `outbound`, the gateway made for this 红包 (`live`).
 */
export type JudgeNetwork =
  | { mode: "mock"; list: string[] | null; answers: readonly FetchAnswer[] }
  | {
      mode: "live";
      list: string[];
      activityId: string;
      outbound: Fetcher;
    };

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
  /** The protocol the 红包 runs (JUDGE_PROTOCOL for a deploy). */
  protocol?: number;
  network?: JudgeNetwork;
  /**
   * When to give up, if not after `waitMs`: a 联网 judgment's clock, which
   * stops while a request is out (session.ts).
   */
  timer?: { late: Promise<"compute" | "total">; stop: () => void };
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

/** This code's Dynamic Worker (a fresh one by `fresh`), its CPU limited. */
function judgeEntrypoint(
  env: ApiBindings,
  run: Pick<
    JudgeRun,
    "code" | "fingerprint" | "fresh" | "protocol" | "network"
  >,
) {
  const protocol = run.protocol ?? JUDGE_PROTOCOL;
  const modules = runtimeModules[protocol];
  if (!modules) throw new Error(`No runtime for protocol ${protocol}`);
  const live = run.network?.mode === "live" ? run.network : null;
  return env.LOADER.get(
    sandboxId(run.fingerprint, run.fresh, protocol, live?.activityId),
    async () => ({
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "main.mjs",
      modules: { ...modules, "judge.js": run.code },
      globalOutbound: live ? live.outbound : null,
    }),
  ).getEntrypoint(undefined, { limits: { cpuMs: CPU_MS } });
}

/**
 * Before a 部署's first judgment on a sandbox: the two requests the kit
 * makes (kit/cli/lib/sandbox.mjs), which main.mjs stops at — one it cannot
 * read starts the Dynamic Worker, an empty one imports judge.js — so the
 * start and judge.js's top level are not timed as a judgment (最慢). The
 * same Worker ID on the same day: no further 份 (§7). What they answer the
 * judgments say again; each is waited on JUDGE_WAIT_MS at most.
 */
export async function warmJudge(
  env: ApiBindings,
  run: Pick<JudgeRun, "code" | "fingerprint" | "fresh">,
) {
  const entrypoint = judgeEntrypoint(env, run);
  for (const body of ["", "{}"]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      entrypoint
        .fetch("http://judge/", { method: "POST", body })
        .then((response) => response.text())
        .catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, JUDGE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
}

/**
 * What judge.js exports as `network` (§9.2), read by main.mjs once it is
 * loaded: the value as JSON (null for none), `{ unreadable: true }` when it
 * is not JSON, or null when the sandbox could not say (it will not load).
 */
export async function describeJudge(
  env: ApiBindings,
  run: Pick<JudgeRun, "code" | "fingerprint" | "fresh">,
): Promise<{ network: unknown } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      judgeEntrypoint(env, run)
        .fetch("http://judge/", {
          method: "POST",
          body: JSON.stringify({ describe: true }),
        })
        .then((response) => response.json<{ network?: unknown }>()),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), JUDGE_WAIT_MS);
      }),
    ]);
    return answer && "network" in answer ? { network: answer.network } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
  const waitMs =
    run.waitMs ??
    (run.network?.mode === "live" ? NETWORK_WAIT_MS : JUDGE_WAIT_MS);
  const { network } = run;
  const request = judgeEntrypoint(env, run).fetch("http://judge/", {
    method: "POST",
    body: JSON.stringify({
      submission: run.submission,
      seeds: run.seeds,
      capture: run.capture === true,
      network: !network
        ? null
        : network.mode === "mock"
          ? { list: network.list, mode: "mock", answers: network.answers }
          : { list: network.list, mode: "live" },
    }),
  });
  // A judgment given up on still ends (or is killed) later: nothing waits.
  request.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = run.timer
    ? run.timer.late
    : new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), waitMs);
      });
  try {
    const response = await Promise.race([request, late]);
    if (response === "late")
      return { failure: "timeout", detail: `超过 ${waitMs} 毫秒没有判定完` };
    if (response === "compute")
      return {
        failure: "timeout",
        detail: `除了等网络，超过 ${JUDGE_WAIT_MS} 毫秒没有判定完`,
      };
    if (response === "total")
      return {
        failure: "timeout",
        detail: `超过 ${NETWORK_WAIT_MS / 1000} 秒没有判定完`,
      };
    const body = (await response.json()) as {
      verdict?: unknown;
      error?: { kind: SandboxFailure; detail: string };
      logs?: string[];
    } & Asked;
    // A test's requests (written answers only: a claim's are the gateway's
    // to keep, where the code cannot reach).
    const asked: Asked =
      network?.mode === "mock" && (body.requests?.length || body.unused?.length)
        ? { requests: body.requests ?? [], unused: body.unused ?? [] }
        : {};
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
        ...asked,
      };
    }
    return { verdict: body.verdict, logs: body.logs, ...asked };
  } catch (error) {
    return classify(error, loading);
  } finally {
    clearTimeout(timer);
    run.timer?.stop();
  }
}
