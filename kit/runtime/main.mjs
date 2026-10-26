// The sandbox's entry: one request is one judgment. The site (and the kit)
// sends { submission, seeds, capture, network } and gets back
// { verdict, logs } or { error, logs }, with a test's requests when it
// answered them (prelude.mjs). The secret seed never comes here, only this
// submission's two seeds (seeds.mjs). { describe: true } asks what
// judge.js exports as `network` (协议第 9 节), for a deploy to check.
import { begin, finish } from "./prelude.mjs";
import { createTools } from "./tools.mjs";
import { LIMITS, nestsDeeper } from "./verdict.mjs";

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

/** The `network` export as JSON, for the site to read; or why it is not. */
function exported(value) {
  if (value === undefined) return { network: null };
  try {
    return { network: JSON.parse(JSON.stringify(value)) ?? null };
  } catch {
    return { network: { unreadable: true } };
  }
}

export default {
  async fetch(request) {
    const { submission, seeds, capture, network, describe } =
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
    if (describe === true) return reply(exported(code.network));
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
