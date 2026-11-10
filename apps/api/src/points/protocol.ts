// 三方积分's issuer protocol (docs/third-party-points-design.md §3): three
// POSTs under the issuer's base, JSON both ways, the sender's key as a
// bearer token. Only the answer's `result` counts; anything without one in
// 10 s and 64 KB, or a redirect, is no answer at all.
import {
  POINTS_LIMITS,
  POINTS_PROTOCOL,
  pointsTransferResultSchema,
} from "@hb/contracts";

export type PointsFetch = typeof fetch;

export type PointsCallKind = "balance" | "transfer" | "query";

/** Why there was no answer. */
export type PointsMiss =
  | "timeout"
  | "network"
  | "redirect"
  | "too_large"
  | "invalid";

export type PointsCall =
  | {
      answered: true;
      result: string;
      body: Record<string, unknown>;
      httpStatus: number;
      ms: number;
    }
  | { answered: false; miss: PointsMiss; httpStatus?: number; ms: number };

export type PointsCallOptions = {
  fetch?: PointsFetch;
  timeoutMs?: number;
  now?: () => number;
};

class Missed extends Error {
  constructor(readonly miss: PointsMiss) {
    super(miss);
  }
}

async function readLimited(response: Response, signal: AbortSignal) {
  const limit = POINTS_LIMITS.responseBytesMax;
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit)
      throw new Missed("too_large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Missed("timeout"));
    signal.addEventListener("abort", () => reject(new Missed("timeout")), {
      once: true,
    });
  });
  for (;;) {
    const chunk = await Promise.race([reader.read(), aborted]);
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      reader.cancel("too_large").catch(() => {});
      throw new Missed("too_large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** One call to the issuer: an answer with its `result`, or a miss. */
export async function callIssuer(
  baseUrl: string,
  kind: PointsCallKind,
  key: string,
  body: Record<string, unknown>,
  options: PointsCallOptions = {},
): Promise<PointsCall> {
  const now = options.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("timeout"),
    options.timeoutMs ?? POINTS_LIMITS.timeoutMs,
  );
  const transport = options.fetch ?? ((input, init) => fetch(input, init));
  let httpStatus: number | undefined;
  try {
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        "abort",
        () => reject(new Missed("timeout")),
        { once: true },
      ),
    );
    const response = await Promise.race([
      transport(`${baseUrl}/${kind}`, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Hb-Points-Protocol": String(POINTS_PROTOCOL),
        },
        body: JSON.stringify(body),
      }),
      aborted,
    ]);
    httpStatus = response.status;
    if (response.status >= 300 && response.status < 400) {
      response.body?.cancel().catch(() => {});
      throw new Missed("redirect");
    }
    const text = await readLimited(response, controller.signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Missed("invalid");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof (parsed as { result?: unknown }).result !== "string"
    )
      throw new Missed("invalid");
    const answer = parsed as Record<string, unknown>;
    return {
      answered: true,
      result: answer.result as string,
      body: answer,
      httpStatus: response.status,
      ms: now() - started,
    };
  } catch (error) {
    const miss: PointsMiss =
      error instanceof Missed
        ? error.miss
        : controller.signal.aborted
          ? "timeout"
          : error instanceof TypeError &&
              /decode|encoding/i.test(String(error.message))
            ? "invalid"
            : "network";
    return { answered: false, miss, httpStatus, ms: now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const AMOUNT = /^(0|[1-9]\d{0,19})$/;

/** A whole-分 amount string, capped at the safe range (额度 above it is the cap). */
export function readAmount(value: unknown, cap = true) {
  if (typeof value !== "string" || !AMOUNT.test(value)) return null;
  const big = BigInt(value);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (big > max) return cap ? Number.MAX_SAFE_INTEGER : null;
  return Number(big);
}

/** A LINUX DO numeric ID, as a number or its decimal string. */
export function readUserId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value))
    return Number.isSafeInteger(Number(value)) ? value : null;
  return null;
}

function text(value: unknown, max: number) {
  return typeof value === "string" && value.length >= 1 && value.length <= max
    ? value
    : null;
}

export type BalanceAnswer =
  | {
      kind: "ok";
      accountId: string;
      accountUsername: string;
      available: number;
    }
  | { kind: "key_invalid" }
  | { kind: "bad_answer"; result: string }
  | { kind: "missed"; miss: PointsMiss };

/** 额度 (§3): whose account the key pays from, and how much is available. */
export function readBalance(call: PointsCall): BalanceAnswer {
  if (!call.answered) return { kind: "missed", miss: call.miss };
  if (call.result === "key_invalid") return { kind: "key_invalid" };
  if (call.result !== "ok") return { kind: "bad_answer", result: call.result };
  const account = call.body.account as Record<string, unknown> | undefined;
  const accountId = readUserId(account?.id);
  const accountUsername = text(account?.username, 64);
  const available = readAmount(call.body.available);
  if (!accountId || !accountUsername || available === null)
    return { kind: "bad_answer", result: "ok" };
  return { kind: "ok", accountId, accountUsername, available };
}

export type TransferAnswer =
  | { kind: "ok"; tradeNo: string; amount: number; toId: string }
  | {
      kind: Exclude<(typeof pointsTransferResultSchema.options)[number], "ok">;
    }
  | { kind: "bad_answer"; result: string }
  | { kind: "missed"; miss: PointsMiss };

function readOrder(body: Record<string, unknown>) {
  const tradeNo = text(body.trade_no, 128);
  const amount = readAmount(body.amount, false);
  const to = body.to as Record<string, unknown> | undefined;
  const toId = readUserId(to?.id);
  if (!tradeNo || amount === null || !toId) return null;
  return { tradeNo, amount, toId };
}

/** 发放 (§3): one of seven results; an ok carries the order. */
export function readTransfer(call: PointsCall): TransferAnswer {
  if (!call.answered) return { kind: "missed", miss: call.miss };
  const result = pointsTransferResultSchema.safeParse(call.result);
  if (!result.success) return { kind: "bad_answer", result: call.result };
  if (result.data !== "ok") return { kind: result.data };
  const order = readOrder(call.body);
  if (!order) return { kind: "bad_answer", result: "ok" };
  return { kind: "ok", ...order };
}

export type QueryAnswer =
  | { kind: "ok"; tradeNo: string; amount: number; toId: string }
  | { kind: "not_found" }
  | { kind: "key_invalid" }
  | { kind: "bad_answer"; result: string }
  | { kind: "missed"; miss: PointsMiss };

/** 查单 (§3): the order, or not_found. */
export function readQuery(call: PointsCall): QueryAnswer {
  if (!call.answered) return { kind: "missed", miss: call.miss };
  if (call.result === "not_found") return { kind: "not_found" };
  if (call.result === "key_invalid") return { kind: "key_invalid" };
  if (call.result !== "ok") return { kind: "bad_answer", result: call.result };
  const order = readOrder(call.body);
  if (!order) return { kind: "bad_answer", result: "ok" };
  return { kind: "ok", ...order };
}

/** "sk_live_abcd…wxyz": a key as logs and records may show it. */
export function maskKey(key: string) {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
