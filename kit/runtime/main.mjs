// The sandbox's entry: one request is one judgment. The site (and the kit)
// sends { submission, seeds, capture } and gets back { verdict, logs } or
// { error, logs }. The secret seed never comes here, only this
// submission's two seeds (seeds.mjs).
import { begin, finish } from "./prelude.mjs";
import { createTools } from "./tools.mjs";

// The sender's code loads at the first judgment, so the prelude has always
// fixed the time, Math.random() and console before any of its lines run.
let loading;

function reply(body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function describe(error) {
  if (error instanceof Error)
    return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}

export default {
  async fetch(request) {
    const { submission, seeds, capture } = await request.json();
    let code;
    try {
      loading ??= import("./judge.js");
      code = await loading;
    } catch (error) {
      return reply({ error: { kind: "load", detail: describe(error) } });
    }
    if (typeof code.judge !== "function")
      return reply({
        error: { kind: "no-judge", detail: "judge.js 没有导出 judge 函数" },
      });
    const { tools, next } = createTools(submission, seeds);
    begin({ now: submission.now, next, capture });
    let verdict;
    try {
      verdict = await code.judge(structuredClone(submission), tools);
    } catch (error) {
      return reply({
        error: { kind: "threw", detail: describe(error) },
        logs: finish(),
      });
    }
    const logs = finish();
    try {
      return reply({ verdict, logs });
    } catch {
      return reply({
        error: { kind: "invalid", detail: "返回的值转不成 JSON" },
        logs,
      });
    }
  },
};
