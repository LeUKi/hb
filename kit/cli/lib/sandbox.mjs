// The local sandbox (协议第 5 节, 开发包的样子): workerd started through the
// Miniflare that comes with wrangler, running judge.js in the same kind of
// Dynamic Worker as the site, with the same compatibility date, nodejs_compat
// and runtime modules. Its fetch() is answered from what the test wrote
// (协议第 9 节); with `live` it goes out from this computer through a
// gateway holding the site's rules (gateway.mjs). Locally the CPU is not
// limited, so each judgment is cut off by the clock instead: past 1 second
// it is a timeout (going out with --live, past the site's 5), and workerd is
// thrown away and started afresh, as the site moves to a new sandbox after
// one.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  NETWORK_LIMITS,
  readCheckAnswer,
  readDeclarations,
  readNetwork,
  readSetup,
  VIEW_PROTOCOL,
} from "../../runtime/index.mjs";
import { fingerprintOf, KitError } from "./files.mjs";

/** Protocol v4: this runtime on this compatibility date with nodejs_compat. */
export const PROTOCOL = 4;
export const COMPATIBILITY_DATE = "2026-09-01";
/** What runs beside judge.js, as hb's scripts/judge-runtime.ts copies it to the site. */
export const SANDBOX_MODULES = Object.freeze([
  "main.mjs",
  "prelude.mjs",
  "tools.mjs",
  "codes.mjs",
  "hash.mjs",
  "money.mjs",
  "network.mjs",
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
const gateway = readFileSync(new URL("./gateway.mjs", import.meta.url), "utf8");
const networkRules = readFileSync(new URL("network.mjs", runtimeDir), "utf8");
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

/**
 * The modules of the Dynamic Worker: .js names are modules there. An
 * earlier protocol's are its runtime as 红包 opened with it, kept frozen,
 * for replaying their records.
 */
function modulesWith(code, protocol) {
  const modules = {};
  if (protocol < PROTOCOL) {
    const frozen = JSON.parse(
      readFileSync(new URL(`frozen/v${protocol}.json`, runtimeDir), "utf8"),
    );
    for (const [name, js] of Object.entries(frozen)) modules[name] = { js };
  } else
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

/** workerd's answer to one request, or LATE once `waitMs` has passed. */
async function ask(runtime, body, waitMs = TIMEOUT_MS) {
  const request = runtime
    .dispatchFetch("http://judge/", { method: "POST", body })
    .then((response) => response.json());
  // A request given up on still ends (or is killed) later: nothing waits.
  request.catch(() => {});
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(LATE), waitMs);
  });
  try {
    return await Promise.race([request, late]);
  } finally {
    clearTimeout(timer);
  }
}

const described = (answer) =>
  answer && answer !== LATE && typeof answer.host !== "string" ? answer : null;

/** What judge.js exports as `network`: `{ list }` or `{ problems }`. */
function networkOf(answer) {
  const read = described(answer);
  if (!read) return { list: null };
  // The second protocol's runtime marked it in place.
  if (read.network?.unreadable || read.unreadable?.includes("network"))
    return { problems: ["network 要是字符串数组"] };
  return readNetwork(read.network ?? null);
}

/**
 * A sandbox for this judge.js. `run(submission, seeds, answers)` judges
 * once, the way runTest and judgeNext call it, always keeping console
 * output; fetch() gets `answers` (a test's), or with `live` goes out.
 * `network` is what judge.js exports. `protocol` 1 runs the first
 * protocol's runtime, which has no network. `close()` stops workerd. Call
 * close when done, or the process stays.
 */
export async function openSandbox(
  code,
  { live = false, protocol = PROTOCOL } = {},
) {
  const { Miniflare, convertV4MiniflareOptions } = await loadMiniflare();
  // The list the gateway lets out, known once judge.js is read.
  let allowed = [];
  const options = () =>
    convertV4MiniflareOptions({
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
            ID: `judge:v${protocol}:${fingerprintOf(code)}${live ? ":live" : ""}`,
            COMPATIBILITY_DATE,
            MODULES: modulesWith(code, protocol),
            LIVE: live,
          },
          serviceBindings: { GATEWAY: "judge-gateway" },
          workerLoaders: { LOADER: {} },
        },
        {
          name: "judge-gateway",
          modules: [
            { type: "ESModule", path: "gateway.mjs", contents: gateway },
            { type: "ESModule", path: "network.mjs", contents: networkRules },
          ],
          compatibilityDate: COMPATIBILITY_DATE,
          bindings: { LIST: JSON.stringify(allowed) },
        },
      ],
    });
  // Before the first judgment, two requests main.mjs stops at: one it
  // cannot read starts the Dynamic Worker without importing judge.js, then
  // an empty one imports it. The second's time is judge.js's top level,
  // which the site counts in the first judgment of each sandbox; neither is
  // timed as a judgment here. What they answer, judgments say again.
  const start = async () => {
    const runtime = new Miniflare(options());
    await runtime.ready;
    await ask(runtime, "").catch(() => {});
    const began = Date.now();
    const warm = await ask(runtime, "{}").catch(() => null);
    const hung = warm === LATE;
    return { runtime, hung, loadMs: hung ? null : Date.now() - began };
  };
  let { runtime, hung, loadMs } = await start();
  let restarts = 0;
  // What judge.js exports besides judge: a request main.mjs answers once
  // judge.js is loaded (none in the first protocol).
  const answer =
    hung || protocol === 1
      ? null
      : await ask(runtime, JSON.stringify({ describe: true })).catch(
          () => null,
        );
  const network = networkOf(answer);
  // The third protocol's meta, params, hongbao and check; the fourth's setup.
  const declarations = readDeclarations(
    protocol >= 3 ? described(answer) : null,
  );
  const list = "list" in network ? network.list : null;
  // Going out, the gateway knows the list: workerd again, with it.
  if (live && list) {
    allowed = list;
    const first = runtime;
    ({ runtime, hung, loadMs } = await start());
    await first.dispose().catch(() => {});
  }
  // Written answers come back at once: waiting buys no time, as on the
  // site, where the clock stops while a request is out. Going out, the
  // judgment has the site's 5 seconds in all.
  const waitMs =
    live && list ? Math.max(TIMEOUT_MS, NETWORK_LIMITS.judgmentMs) : TIMEOUT_MS;

  // A judgment that will not end keeps workerd busy: start a new one.
  const restart = async () => {
    const stuck = runtime;
    ({ runtime, hung } = await start());
    restarts += 1;
    await stuck.dispose().catch(() => {});
  };

  async function run(submission, seeds, answers = []) {
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
        JSON.stringify({
          submission,
          seeds,
          capture: true,
          network:
            live && list
              ? { list, mode: "live" }
              : { list, mode: "mock", answers },
        }),
        waitMs,
      );
      if (body === LATE) {
        await restart();
        return {
          failure: "timeout",
          detail: `超过 ${waitMs / 1000} 秒没有判定完`,
        };
      }
      if (typeof body.host === "string") return failureOf(body.host);
      const logs = body.logs?.length ? { logs: body.logs } : {};
      // What the code asked of the network, when there is something to say.
      const asked =
        body.requests?.length || body.unused?.length
          ? { requests: body.requests ?? [], unused: body.unused ?? [] }
          : {};
      if (body.error)
        return {
          failure: body.error.kind,
          detail: body.error.detail,
          ...logs,
          ...asked,
        };
      return { verdict: body.verdict, ...logs, ...asked };
    } catch (error) {
      // workerd itself went away: start it again for the next judgment.
      await restart();
      return {
        failure: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * check(params, hongbao) once (协议第三版): `{ problems }`, `{ invalid }`
   * or `{ failure, detail }`, as runTest takes it.
   */
  // The same params and numbers ask check() once: tests share theirs.
  const checked = new Map();
  async function check(params, hongbao) {
    const key = JSON.stringify([params, hongbao]);
    if (!checked.has(key)) checked.set(key, await checkOnce(params, hongbao));
    return checked.get(key);
  }
  async function checkOnce(params, hongbao) {
    if (hung)
      return {
        failure: "timeout",
        detail: `judge.js 顶层的代码超过 ${TIMEOUT_MS / 1000} 秒还没跑完`,
      };
    try {
      const body = await ask(
        runtime,
        JSON.stringify({
          check: { params, hongbao, now: Date.now() },
          capture: true,
        }),
      );
      if (body === LATE) {
        await restart();
        return {
          failure: "timeout",
          detail: `check 超过 ${TIMEOUT_MS / 1000} 秒没有返回`,
        };
      }
      if (typeof body.host === "string") return failureOf(body.host);
      if (body.error)
        return { failure: body.error.kind, detail: body.error.detail };
      return readCheckAnswer(body.answer, declarations.params);
    } catch (error) {
      await restart();
      return {
        failure: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * setup(params, hongbao) once (协议第四版), at `now`, Math.random() drawn
   * from `seed`: `{ state, view, unknown, logs? }` as readSetup reads it,
   * or `{ failure, detail, logs? }`. Null before the fourth protocol.
   */
  async function setup(params, hongbao, { now, seed }) {
    if (protocol < VIEW_PROTOCOL) return null;
    if (hung)
      return {
        failure: "timeout",
        detail: `judge.js 顶层的代码超过 ${TIMEOUT_MS / 1000} 秒还没跑完`,
      };
    try {
      const body = await ask(
        runtime,
        JSON.stringify({
          setup: { params, hongbao, now, seed },
          capture: true,
        }),
      );
      if (body === LATE) {
        await restart();
        return {
          failure: "timeout",
          detail: `setup 超过 ${TIMEOUT_MS / 1000} 秒没有返回`,
        };
      }
      if (typeof body.host === "string") return failureOf(body.host);
      const logs = body.logs?.length ? { logs: body.logs } : {};
      if (body.error)
        return { failure: body.error.kind, detail: body.error.detail, ...logs };
      const reading = readSetup(body.answer);
      return "error" in reading
        ? { failure: "invalid", detail: reading.error.detail, ...logs }
        : { ...reading, ...logs };
    } catch (error) {
      await restart();
      return {
        failure: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    run,
    check,
    setup,
    /** What judge.js exports as `network`: `{ list }` or `{ problems }`. */
    network,
    /** 协议第三版: meta, params, hongbao and check, with their problems; 第四版's setup. */
    declarations,
    /** How many times workerd was started afresh after a timeout. */
    get restarts() {
      return restarts;
    },
    /** How long judge.js's top level took to run, or null if it never ended. */
    loadMs,
    close: () => runtime.dispose(),
  };
}
