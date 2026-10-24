// The first module the sandbox evaluates, before the sender's code: it fixes
// what that code can lean on (协议第 4.3、4.4 节). Time and Math.random()
// only exist while judge() runs: at the top of the file they would differ
// from call to call.

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

/** Before judge(): the time, Math.random()'s stream and whether to keep console output. */
export function begin({ now, next, capture }) {
  pinned = now;
  random = next;
  sink = capture ? [] : null;
}

/** After judge(): the console output kept, if any. */
export function finish() {
  const logs = sink;
  pinned = null;
  random = null;
  sink = null;
  return logs ?? undefined;
}
