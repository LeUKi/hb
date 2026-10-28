// The sandbox's entry: one request is one judgment. The site (and the kit)
// sends { submission, seeds, capture, network } and gets back
// { verdict, logs } or { error, logs }, with a test's requests when it
// answered them (prelude.mjs). The secret seed never comes here, only this
// submission's two seeds (seeds.mjs). { describe: true } asks what
// judge.js exports besides judge — `network` (协议第 9 节), and from the
// third version `meta`, `params`, `hongbao` and whether it has `check`
// (docs/judge-square-design.md §3, §4) — for a deploy to check.
// { check: { params, hongbao, now } } runs check(params, hongbao) once.
import { begin, finish } from "./prelude.mjs";
import { createRandom } from "./random.mjs";
import { createTools } from "./tools.mjs";
import { LIMITS, nestsDeeper } from "./verdict.mjs";

/** The exports a deploy reads, as data. */
const DESCRIBED = ["network", "meta", "params", "hongbao"];
/** check() has no submission to seed it: Math.random() is the same for all. */
const CHECK_SEED = "0".repeat(64);

// The sender's code loads at the first judgment, so the prelude has always
// fixed the time, Math.random() and console before any of its lines run.
let loading;

function reply(body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function explain(error) {
  if (error instanceof Error)
    return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}

/**
 * What judge.js exports besides judge, as JSON for the site to read: each
 * of DESCRIBED (null when absent; listed in `unreadable` when it does not
 * turn into JSON) and whether `check` is a function.
 */
function exported(code) {
  const answer = { unreadable: [] };
  for (const name of DESCRIBED) {
    if (code[name] === undefined) {
      answer[name] = null;
      continue;
    }
    try {
      answer[name] = JSON.parse(JSON.stringify(code[name])) ?? null;
    } catch {
      answer[name] = null;
      answer.unreadable.push(name);
    }
  }
  answer.check =
    code.check === undefined ? null : typeof code.check === "function";
  return answer;
}

/** check(params, hongbao) once: its answer, or how it failed. */
async function runCheck(code, { params, hongbao, now }, capture) {
  if (typeof code.check !== "function") return reply({ answer: [] });
  begin({ now, next: createRandom(CHECK_SEED).api.next, capture });
  let answer;
  try {
    answer = await code.check(
      structuredClone(params),
      structuredClone(hongbao),
    );
  } catch (error) {
    const { logs } = finish();
    return reply({ error: { kind: "threw", detail: explain(error) }, logs });
  }
  const { logs } = finish();
  try {
    return reply({ answer: answer ?? null, logs });
  } catch {
    return reply({
      error: { kind: "invalid", detail: "check 返回的值转不成 JSON" },
      logs,
    });
  }
}

export default {
  async fetch(request) {
    const { submission, seeds, capture, network, describe, check } =
      await request.json();
    let code;
    try {
      loading ??= import("./judge.js");
      code = await loading;
    } catch (error) {
      return reply({ error: { kind: "load", detail: explain(error) } });
    }
    if (typeof code.judge !== "function")
      return reply({
        error: { kind: "no-judge", detail: "judge.js 没有导出 judge 函数" },
      });
    if (describe === true) return reply(exported(code));
    if (check) return runCheck(code, check, capture);
    const { tools, next } = createTools(submission, seeds);
    begin({ now: submission.now, next, capture, network: network ?? null });
    let verdict;
    try {
      verdict = await code.judge(structuredClone(submission), tools);
    } catch (error) {
      const { logs, ...asked } = finish();
      return reply({
        error: { kind: "threw", detail: explain(error) },
        logs,
        ...asked,
      });
    }
    const { logs, ...asked } = finish();
    // Too deep for JSON.stringify here on one machine and not another: the
    // same answer for all (verdict.mjs, state's depth).
    if (
      verdict !== null &&
      typeof verdict === "object" &&
      nestsDeeper(verdict, LIMITS.stateDepth + 1)
    )
      return reply({
        error: {
          kind: "invalid",
          detail: nestsDeeper(verdict.state, LIMITS.stateDepth)
            ? `state 嵌套超过 ${LIMITS.stateDepth} 层`
            : "返回的值转不成 JSON",
        },
        logs,
        ...asked,
      });
    try {
      return reply({ verdict, logs, ...asked });
    } catch {
      return reply({
        error: { kind: "invalid", detail: "返回的值转不成 JSON" },
        logs,
        ...asked,
      });
    }
  },
};
