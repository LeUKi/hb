// The first module the sandbox evaluates, before the sender's code: it fixes
// what that code can lean on (协议第 4.3、4.4、9 节). Time, Math.random()
// and fetch() only exist while judge() runs: at the top of the file they
// would differ from call to call.
import {
  NETWORK_LIMITS,
  NETWORK_REASONS,
  networkError,
  requestProblem,
} from "./network.mjs";

const RealDate = Date;
let pinned = null;
let random = null;
let sink = null;

function notYet(what) {
  throw new Error(`${what} 只能在 judge 里用`);
}

class JudgeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0 && pinned === null)
      throw new Error("new Date() 只能在 judge 里用");
    if (args.length > 0) super(...args);
    else super(pinned);
  }

  static now() {
    return pinned === null ? notYet("Date.now()") : pinned;
  }
}
globalThis.Date = JudgeDate;
Math.random = () => (random === null ? notYet("Math.random()") : random());

// Data could pass between 红包 through the cache: there is none here.
try {
  delete globalThis.caches;
} catch {}
if ("caches" in globalThis) {
  try {
    Object.defineProperty(globalThis, "caches", { value: undefined });
  } catch {}
}

function show(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// On the site console output is dropped; the kit asks for it.
for (const name of [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
  "dir",
  "table",
])
  console[name] = (...args) => {
    if (sink && sink.length < 200)
      sink.push(
        `${name === "log" ? "" : `${name}: `}${args.map(show).join(" ")}`.slice(
          0,
          2000,
        ),
      );
  };

// fetch() (协议第 9 节): only to the addresses in `network`, a few times a
// judgment. On the site it goes out through the gateway, which holds the
// same rules again where the code cannot reach; in tests it is answered
// from what the test wrote, never the network. Failing, it throws as
// fetch does, a TypeError saying why.
const realFetch = globalThis.fetch.bind(globalThis);
/** During judge(): null, or `{ list, mode, answers, used, requests }`. */
let net = null;
let judging = false;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** A written answer (tests.json's `fetch`) to the request it fits. */
function sameRequest(answer, method, address) {
  try {
    return (
      (answer.method ?? "GET") === method &&
      new URL(answer.url).href === address
    );
  } catch {
    return false;
  }
}

function answered(answer) {
  if (answer.error === "timeout") throw networkError(NETWORK_REASONS.timeout);
  if (answer.error === "unreachable")
    throw networkError(NETWORK_REASONS.unreachable);
  if (answer.error === "too-big")
    throw networkError(NETWORK_REASONS.responseTooBig);
  const json = Object.hasOwn(answer, "json");
  const body = json
    ? JSON.stringify(answer.json)
    : typeof answer.text === "string"
      ? answer.text
      : "";
  if (encoder.encode(body).length > NETWORK_LIMITS.responseBytes)
    throw networkError(NETWORK_REASONS.responseTooBig);
  const headers = new Headers(answer.headers ?? {});
  if (json && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const status = answer.status ?? 200;
  // A body is not allowed with these statuses.
  const empty = [101, 204, 205, 304].includes(status);
  return new Response(empty ? null : body, { status, headers });
}

async function judgeFetch(input, init) {
  if (!judging) throw networkError(NETWORK_REASONS.ended);
  if (net === null || net.list === null)
    throw networkError(NETWORK_REASONS.none);
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  const address = request.url;
  const body =
    method === "GET" || method === "HEAD"
      ? new Uint8Array(0)
      : new Uint8Array(await request.arrayBuffer());
  const problem = requestProblem(
    {
      method,
      address,
      headers: [...request.headers.keys()],
      bodyBytes: body.length,
    },
    net.list,
  );
  if (problem) throw networkError(problem);
  if (net.requests.length >= NETWORK_LIMITS.requests)
    throw networkError(NETWORK_REASONS.tooMany);
  const asked = {
    method,
    url: address,
    ...(body.length > 0 ? { body: decoder.decode(body) } : {}),
  };
  net.requests.push(asked);
  if (net.mode === "mock") {
    const index = net.answers.findIndex(
      (answer, at) => !net.used.has(at) && sameRequest(answer, method, address),
    );
    if (index < 0) {
      asked.unanswered = true;
      throw networkError(`测试里没写这个请求的返回：${method} ${address}`);
    }
    net.used.add(index);
    if (request.signal.aborted) throw request.signal.reason;
    return answered(net.answers[index]);
  }
  const response = await realFetch(address, {
    method,
    headers: request.headers,
    ...(body.length > 0 ? { body } : {}),
    redirect: "manual",
    signal: request.signal,
  });
  // The gateway turned it down: why, in its words.
  const refused = response.headers.get("x-hb-refused");
  if (refused !== null) throw networkError(decodeURIComponent(refused));
  return response;
}

// Wherever fetch is found, it is this one.
for (
  let scope = globalThis;
  scope !== null;
  scope = Object.getPrototypeOf(scope)
)
  if (Object.hasOwn(scope, "fetch"))
    try {
      Object.defineProperty(scope, "fetch", {
        value: judgeFetch,
        writable: false,
        configurable: false,
      });
    } catch {}

/**
 * Before judge(): the time, Math.random()'s stream, whether to keep console
 * output, and the network: null, or the list judge.js exports (null when it
 * exports none) with the mode — `mock` answering from `answers` (a
 * test's), `live` going out.
 */
export function begin({ now, next, capture, network = null }) {
  pinned = now;
  random = next;
  sink = capture ? [] : null;
  net =
    network === null
      ? null
      : {
          list: network.list,
          mode: network.mode,
          answers: network.answers ?? [],
          used: new Set(),
          requests: [],
        };
  judging = true;
}

/**
 * After judge(): the console output kept, if any, and with a test's
 * answers what was asked (`requests`, those with no answer marked
 * `unanswered`) and which answers went unused.
 */
export function finish() {
  const logs = sink;
  const asked = net?.mode === "mock" ? net : null;
  pinned = null;
  random = null;
  sink = null;
  net = null;
  judging = false;
  return {
    logs: logs ?? undefined,
    ...(asked
      ? {
          requests: asked.requests,
          unused: asked.answers
            .map((answer, index) => ({ answer, index }))
            .filter(({ index }) => !asked.used.has(index))
            .map(({ answer }) => ({
              method: answer.method ?? "GET",
              url: answer.url,
            })),
        }
      : {}),
  };
}
