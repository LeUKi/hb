// Runs inside the local workerd, in the site's place: each request is one
// judgment, handed to a Dynamic Worker built the way the site builds it
// (hb's apps/api/src/judge/sandbox.ts): main.mjs first, the runtime and
// judge.js as modules, nodejs_compat, no bindings, and no network unless
// `npm run simulate -- --live` sends it out through the gateway.
export default {
  async fetch(request, env) {
    try {
      const worker = env.LOADER.get(env.ID, () => ({
        compatibilityDate: env.COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "main.mjs",
        modules: env.MODULES,
        globalOutbound: env.LIVE ? env.GATEWAY : null,
      }));
      return await worker.getEntrypoint().fetch("http://judge/", {
        method: "POST",
        body: await request.text(),
      });
    } catch (error) {
      // The Dynamic Worker would not start (judge.js did not parse, say), or
      // workerd gave up on this judgment: sandbox.mjs's failureOf tells which.
      const detail = error instanceof Error ? error.message : String(error);
      return Response.json({ host: detail.slice(0, 500) });
    }
  },
};
