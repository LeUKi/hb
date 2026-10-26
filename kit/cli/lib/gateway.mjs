// `npm run simulate -- --live` (协议第 9 节): the sandbox's fetch() goes out
// from this computer through here, held to the site's rules (network.mjs):
// only the addresses judge.js lists, GET and POST, 16 KB out, 3 seconds,
// 64 KB back, no redirect followed. The site's gateway also counts each
// judgment's requests; here the sandbox's own fetch() does.
import { NETWORK_LIMITS, NETWORK_REASONS, requestProblem } from "./network.mjs";

const USER_AGENT = "hb.lafi.sh-judge (+https://hb.lafi.sh/help/code)";

/** Turned down: why, for the sandbox's fetch() to throw. */
const refuse = (reason) =>
  new Response(null, {
    status: 599,
    headers: { "x-hb-refused": encodeURIComponent(reason) },
  });

/** The answer's body, up to the limit; null past it. */
async function readUpTo(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return body;
}

export default {
  async fetch(request, env) {
    const list = JSON.parse(env.LIST);
    const method = request.method.toUpperCase();
    const body =
      method === "GET"
        ? new Uint8Array(0)
        : new Uint8Array(await request.arrayBuffer());
    const problem = requestProblem(
      {
        method,
        address: request.url,
        headers: [...request.headers.keys()],
        bodyBytes: body.length,
      },
      list,
    );
    if (problem) return refuse(problem);
    const headers = new Headers(request.headers);
    headers.set("user-agent", USER_AGENT);
    headers.set("x-hb-hongbao", "local");
    let response;
    try {
      response = await fetch(request.url, {
        method,
        headers,
        ...(body.length > 0 ? { body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(NETWORK_LIMITS.requestMs),
      });
    } catch (error) {
      return refuse(
        error?.name === "TimeoutError"
          ? NETWORK_REASONS.timeout
          : NETWORK_REASONS.unreachable,
      );
    }
    let answer;
    try {
      answer = await readUpTo(response, NETWORK_LIMITS.responseBytes);
    } catch {
      return refuse(NETWORK_REASONS.timeout);
    }
    if (answer === null) return refuse(NETWORK_REASONS.responseTooBig);
    const back = new Headers(response.headers);
    back.delete("set-cookie");
    return new Response(
      [101, 204, 205, 304].includes(response.status) ? null : answer,
      {
        status: response.status,
        statusText: response.statusText,
        headers: back,
      },
    );
  },
};
