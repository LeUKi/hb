// 联网 (docs/programmable-hongbao-design.md §9.3, §9.7): a 联网 红包's
// sandbox goes out only through here. The rules are kit/runtime/network.mjs,
// held again outside the sandbox, where its code cannot reach: only the
// addresses the 红包 opened with, GET and POST, 16 KB out, 3 seconds, 64 KB
// back, no redirect followed, nothing of this site's sent along. Before each
// request the 红包's Durable Object says whether a judgment is under way
// and how many it sent (session.ts); after it, it is given the record, kept
// with the judgment.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  NETWORK_LIMITS,
  NETWORK_REASONS,
  requestProblem,
} from "../../../../kit/runtime/index.mjs";
import type { ApiBindings } from "../env";
import type { FetchRecord } from "./session";

/** Fixed by the 红包's 判定器 when it is made (sandbox.ts). */
export type GatewayProps = { activityId: string; network: string[] };

const USER_AGENT = "hb.lafi.sh-judge (+https://hb.lafi.sh/help/code)";

/** Turned down: why, for the sandbox's fetch() to throw (prelude.mjs). */
const refuse = (reason: string) =>
  new Response(null, {
    status: 599,
    headers: { "x-hb-refused": encodeURIComponent(reason) },
  });

/** The answer's body, up to the limit; null past it. */
async function readUpTo(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
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

/** Asks the 红包's Durable Object about its judgment's requests. */
async function session(
  env: ApiBindings,
  activityId: string,
  body:
    | { op: "begin" }
    | { op: "finish"; index: number; record: FetchRecord }
    | { op: "broken"; index: number },
) {
  const response = await env.ACTIVITY_DO.get(
    env.ACTIVITY_DO.idFromName(activityId),
  ).fetch(
    `https://activity.internal/internal/activities/${activityId}/judge-fetch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw new Error("JUDGE_SESSION_FAILED");
  return response.json<{ index?: number; refused?: string }>();
}

/**
 * One request of a 联网 judgment. `send` is how it goes out (fetch, or a
 * test's own). Turned down, the answer carries why (x-hb-refused); the
 * gateway failing itself is said to the Durable Object, which then voids
 * the judgment (§9.3).
 */
export async function gatewayFetch(
  env: ApiBindings,
  props: GatewayProps,
  request: Request,
  send: typeof fetch = fetch,
): Promise<Response> {
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
    props.network,
  );
  if (problem) return refuse(problem);
  let begun: { index?: number; refused?: string };
  try {
    begun = await session(env, props.activityId, { op: "begin" });
  } catch {
    return refuse("本站的网关出错了");
  }
  if (begun.refused !== undefined || begun.index === undefined)
    return refuse(begun.refused ?? NETWORK_REASONS.ended);
  const index = begun.index;
  try {
    const started = Date.now();
    const headers = new Headers(request.headers);
    headers.set("user-agent", USER_AGENT);
    headers.set("x-hb-hongbao", props.activityId);
    const base: FetchRecord = {
      method: method as FetchRecord["method"],
      url: request.url,
      ...(body.length > 0 ? { body: new TextDecoder().decode(body) } : {}),
      ms: 0,
    };
    let response: Response;
    try {
      response = await send(request.url, {
        method,
        headers,
        ...(body.length > 0 ? { body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(NETWORK_LIMITS.requestMs),
      });
    } catch (error) {
      const failed =
        (error as Error)?.name === "TimeoutError" ? "timeout" : "unreachable";
      await session(env, props.activityId, {
        op: "finish",
        index,
        record: { ...base, error: failed, ms: Date.now() - started },
      });
      return refuse(NETWORK_REASONS[failed]);
    }
    let answer: Uint8Array | null;
    try {
      answer = await readUpTo(response, NETWORK_LIMITS.responseBytes);
    } catch {
      await session(env, props.activityId, {
        op: "finish",
        index,
        record: { ...base, error: "timeout", ms: Date.now() - started },
      });
      return refuse(NETWORK_REASONS.timeout);
    }
    if (answer === null) {
      await session(env, props.activityId, {
        op: "finish",
        index,
        record: { ...base, error: "too-big", ms: Date.now() - started },
      });
      return refuse(NETWORK_REASONS.responseTooBig);
    }
    const contentType = response.headers.get("content-type");
    await session(env, props.activityId, {
      op: "finish",
      index,
      record: {
        ...base,
        status: response.status,
        ...(contentType ? { contentType } : {}),
        response: new TextDecoder().decode(answer),
        ms: Date.now() - started,
      },
    });
    const back = new Headers(response.headers);
    back.delete("set-cookie");
    return new Response(
      [101, 204, 205, 304].includes(response.status)
        ? null
        : (answer as Uint8Array<ArrayBuffer>),
      {
        status: response.status,
        statusText: response.statusText,
        headers: back,
      },
    );
  } catch (error) {
    // Ours, not the code's: the judgment it is in does not count.
    console.error("judge_gateway_failed", {
      activityId: props.activityId,
      error: String(error).slice(0, 200),
    });
    await session(env, props.activityId, { op: "broken", index }).catch(
      () => {},
    );
    return refuse("本站的网关出错了");
  }
}

/** The loopback the 判定器 goes out through (ctx.exports.JudgeGateway). */
export class JudgeGateway extends WorkerEntrypoint<ApiBindings, GatewayProps> {
  override fetch(request: Request) {
    return gatewayFetch(this.env, this.ctx.props, request);
  }
}
