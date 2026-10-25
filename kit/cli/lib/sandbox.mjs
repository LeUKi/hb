// The local sandbox (协议第 5 节, 开发包的样子): workerd started through the
// Miniflare that comes with wrangler, running judge.js in the same kind of
// Dynamic Worker as the site, with the same compatibility date, nodejs_compat,
// runtime modules and no network. Locally the CPU is not limited, so each
// judgment is cut off by the clock instead: past 1 second it is a timeout,
// and workerd is thrown away and started afresh, as the site moves to a new
// sandbox after one.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fingerprintOf, KitError } from "./files.mjs";

/** Protocol v1: this runtime on this compatibility date with nodejs_compat. */
export const PROTOCOL = 1;
export const COMPATIBILITY_DATE = "2026-09-01";
/** What runs beside judge.js, as hb's scripts/judge-runtime.ts copies it to the site. */
export const SANDBOX_MODULES = Object.freeze([
  "main.mjs",
  "prelude.mjs",
  "tools.mjs",
  "codes.mjs",
  "hash.mjs",
  "money.mjs",
  "random.mjs",
  "text.mjs",
  "time.mjs",
  "verdict.mjs",
]);
export const TIMEOUT_MS = 1000;
/** On the site a judgment has 50 ms of CPU: slower than that here may time out there. */
export const SLOW_MS = 50;

const runtimeDir = new URL("../../runtime/", import.meta.url);
const host = readFileSync(new URL("./host.mjs", import.meta.url), "utf8");
const LATE = Symbol("late");

async function loadMiniflare() {
  let wrangler;
  try {
    wrangler = createRequire(import.meta.url).resolve("wrangler/package.json");
  } catch {
    throw new KitError(
      "没找到 wrangler：先在开发包的目录里运行 npm install（本地的沙箱靠它）",
    );
  }
  const fromWrangler = createRequire(wrangler);
  return import(pathToFileURL(fromWrangler.resolve("miniflare")).href);
}

/** The modules of the Dynamic Worker: .js names are modules there. */
function modulesWith(code) {
  const modules = {};
  for (const name of SANDBOX_MODULES)
    modules[name] = { js: readFileSync(new URL(name, runtimeDir), "utf8") };
  modules["judge.js"] = code;
  return modules;
}

/** A failure the way the site's runJudge names it. */
function failureOf(detail) {
  if (/exceeded CPU time limit/i.test(detail))
    return { failure: "timeout", detail };
  if (/exceeded memory limit/i.test(detail))
    return { failure: "memory", detail };
  // workerd gives up at once on a judgment with nothing left that could
  // answer it: it never ends, so it is a timeout, and the sandbox goes on.
  if (/code had hung|never generate a response/i.test(detail))
    return {
      failure: "timeout",
      detail: "代码一直没有返回（在等一个永远不会完成的 Promise）",
    };
  return { failure: "load", detail };
}

/** workerd's answer to one request, or LATE once TIMEOUT_MS has passed. */
async function ask(runtime, body) {
  const request = runtime
    .dispatchFetch("http://judge/", { method: "POST", body })
    .then((response) => response.json());
  // A request given up on still ends (or is killed) later: nothing waits.
  request.catch(() => {});
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(LATE), TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A sandbox for this judge.js. `run(submission, seeds)` judges once, the
 * way runTest and judgeNext call it, always keeping console output;
 * `close()` stops workerd. Call close when done, or the process stays.
 */
export async function openSandbox(code) {
  const { Miniflare, convertV4MiniflareOptions } = await loadMiniflare();
  const options = convertV4MiniflareOptions({
    // Request.cf is fetched from Cloudflare and cached in the working
    // directory otherwise: nothing here needs it.
    cf: false,
    workers: [
      {
        name: "judge-host",
        // By contents: a path would be named relative to the working directory.
        modules: [{ type: "ESModule", path: "host.mjs", contents: host }],
        compatibilityDate: COMPATIBILITY_DATE,
        bindings: {
          ID: `judge:v${PROTOCOL}:${fingerprintOf(code)}`,
          COMPATIBILITY_DATE,
          MODULES: modulesWith(code),
        },
        workerLoaders: { LOADER: {} },
      },
    ],
  });
  // Before the first judgment, two requests main.mjs stops at: one it
  // cannot read starts the Dynamic Worker without importing judge.js, then
  // an empty one imports it. The second's time is judge.js's top level,
  // which the site counts in the first judgment of each sandbox; neither is
  // timed as a judgment here. What they answer, judgments say again.
  const start = async () => {
    const runtime = new Miniflare(options);
    await runtime.ready;
    await ask(runtime, "").catch(() => {});
    const began = Date.now();
    const warm = await ask(runtime, "{}").catch(() => null);
    const hung = warm === LATE;
    return { runtime, hung, loadMs: hung ? null : Date.now() - began };
  };
  let { runtime, hung, loadMs } = await start();
  let restarts = 0;

  // A judgment that will not end keeps workerd busy: start a new one.
  const restart = async () => {
    const stuck = runtime;
    ({ runtime, hung } = await start());
    restarts += 1;
    await stuck.dispose().catch(() => {});
  };

  async function run(submission, seeds) {
    // A top level that never ends blocks every judgment, as it would online:
    // no judgment is sent, and no new workerd would do better.
    if (hung)
      return {
        failure: "timeout",
        detail: `judge.js 顶层的代码超过 ${TIMEOUT_MS / 1000} 秒还没跑完`,
      };
    try {
      const body = await ask(
        runtime,
        JSON.stringify({ submission, seeds, capture: true }),
      );
      if (body === LATE) {
        await restart();
        return {
          failure: "timeout",
          detail: `超过 ${TIMEOUT_MS / 1000} 秒没有判定完`,
        };
      }
      if (typeof body.host === "string") return failureOf(body.host);
      const logs = body.logs?.length ? { logs: body.logs } : {};
      if (body.error)
        return { failure: body.error.kind, detail: body.error.detail, ...logs };
      return { verdict: body.verdict, ...logs };
    } catch (error) {
      // workerd itself went away: start it again for the next judgment.
      await restart();
      return {
        failure: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    run,
    /** How many times workerd was started afresh after a timeout. */
    get restarts() {
      return restarts;
    },
    /** How long judge.js's top level took to run, or null if it never ended. */
    loadMs,
    close: () => runtime.dispose(),
  };
}
