import { runWrangler } from "./environments";

export function cloudflareToken() {
  const configured = process.env.CLOUDFLARE_API_TOKEN;
  if (configured && /^[A-Za-z0-9._~+/=-]+$/.test(configured)) return configured;
  let response: { type?: string; token?: string };
  try {
    response = JSON.parse(
      runWrangler(["auth", "token", "--json"]),
    ) as typeof response;
  } catch {
    throw new Error("CLOUDFLARE_BEARER_AUTH_REQUIRED");
  }
  if (
    !["oauth", "api_token"].includes(response.type ?? "") ||
    !response.token ||
    !/^[A-Za-z0-9._~+/=-]+$/.test(response.token)
  )
    throw new Error("CLOUDFLARE_BEARER_AUTH_REQUIRED");
  return response.token;
}

export async function cloudflareRequest(
  accountId: string,
  path: string,
  token: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
    transport?: typeof fetch;
  } = {},
) {
  const method = options.method ?? "GET";
  const readPath = /^\/queues(?:\?per_page=100|\/[a-f0-9]{32}\/metrics)?$/.test(
    path,
  );
  const sendPath = /^\/queues\/[a-f0-9]{32}\/messages$/.test(path);
  if (
    !/^[a-f0-9]{32}$/.test(accountId) ||
    !(
      (method === "GET" && readPath && options.body === undefined) ||
      (method === "POST" && sendPath)
    )
  )
    throw new Error("CLOUDFLARE_TARGET_INVALID");
  let response: Response;
  try {
    response = await (options.transport ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new Error("CLOUDFLARE_API_UNAVAILABLE");
  }
  if (!response.ok) throw new Error(`CLOUDFLARE_API_HTTP_${response.status}`);
  let payload: { success?: boolean; result?: unknown };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new Error("CLOUDFLARE_API_INVALID_RESPONSE");
  }
  if (payload.success !== true) throw new Error("CLOUDFLARE_API_REJECTED");
  return payload.result;
}

export async function readQueueMetrics(
  accountId: string,
  queueId: string,
  token: string,
  options: { transport?: typeof fetch } = {},
) {
  const result = (await cloudflareRequest(
    accountId,
    `/queues/${queueId}/metrics`,
    token,
    options,
  )) as Record<string, unknown> | null;
  const fields = [
    "backlog_count",
    "backlog_bytes",
    "oldest_message_timestamp_ms",
  ] as const;
  if (
    result === null ||
    typeof result !== "object" ||
    fields.some(
      (name) => !Number.isSafeInteger(result[name]) || Number(result[name]) < 0,
    )
  )
    throw new Error("CLOUDFLARE_QUEUE_METRICS_INVALID");
  return {
    backlogCount: result.backlog_count as number,
    backlogBytes: result.backlog_bytes as number,
    oldestMessageTimestampMs: result.oldest_message_timestamp_ms as number,
  };
}
