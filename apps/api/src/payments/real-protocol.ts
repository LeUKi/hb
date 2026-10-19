import { formatAmount } from "@hb/contracts";
import type {
  AdapterResult,
  PaymentAdapter,
  PaymentAttemptContext,
  PaymentReason,
  PaymentTaskRow,
  QueryPaymentEvidence,
} from "./adapter";
import { ensureQueryEvidenceMatchesTask } from "./adapter";

const MAX_UINT64 = 18_446_744_073_709_551_615n;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_CHARACTERS = 512;
const MAX_RETRY_AFTER_MS = 86_400_000;

export type PaymentFetch = typeof fetch;

export type RealProtocolOptions = {
  /** Trusted test transport override; runtime callers use the fixed official origin. */
  baseUrl?: string;
  fetch: PaymentFetch;
  timeoutMs?: number;
};

export type RealCredentialVerificationResult = {
  status: "passed" | "rejected" | "unavailable";
  reason:
    | "not_found_after_auth"
    | "credentials"
    | "http"
    | "redirect"
    | "timeout"
    | "network"
    | "invalid_response";
  httpStatus?: number;
};

const DEFAULT_REAL_BASE_URL = "https://credit.linux.do";
const REAL_DISTRIBUTE_PATH = "/lpay/distribute";
const REAL_QUERY_PATH = "/epay/api.php";

export function assertUint64Decimal(value: string) {
  if (!/^[1-9]\d{0,19}$/.test(value)) throw new Error("Invalid uint64 id");
  if (BigInt(value) > MAX_UINT64) throw new Error("Invalid uint64 id");
  return value;
}

function assertRealTask(task: PaymentTaskRow): string {
  if (task.mode !== "real") throw new Error("Real protocol requires real task");
  assertUint64Decimal(task.recipientId);
  const username = task.recipientUsername;
  if (!username || hasControlCharacter(username))
    throw new Error("Real protocol requires recipient username snapshot");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(task.businessNo))
    throw new Error("Invalid business number");
  if (!Number.isSafeInteger(task.amountMinor) || task.amountMinor <= 0)
    throw new Error("Invalid payment amount");
  return username;
}

function hasControlCharacter(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function normalizeBaseUrl(value: string | undefined) {
  const url = new URL(value || DEFAULT_REAL_BASE_URL);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Real LDC base URL must be an HTTPS URL without credentials, query or hash",
    );
  return url.origin;
}

export function encodeDistributeBody(input: {
  userId: string;
  username: string;
  amount: string;
  outTradeNo: string;
  remark?: string;
}) {
  const userId = assertUint64Decimal(input.userId);
  const pairs = [
    `"user_id":${userId}`,
    `"username":${JSON.stringify(input.username)}`,
    `"amount":${JSON.stringify(input.amount)}`,
    `"out_trade_no":${JSON.stringify(input.outTradeNo)}`,
  ];
  if (input.remark !== undefined)
    pairs.push(`"remark":${JSON.stringify(input.remark)}`);
  return `{${pairs.join(",")}}`;
}

export function basicAuthorization(clientId: string, clientSecret: string) {
  return `Basic ${base64Utf8(`${clientId}:${clientSecret}`)}`;
}

function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function urlFor(baseUrl: string, path: string) {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

async function readTextLimited(response: Response, signal: AbortSignal) {
  const textDecoder = new TextDecoder();
  let abortListener: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => reject(new Error("timeout"));
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  });
  if (!response.body) {
    try {
      const text = await Promise.race([response.text(), abortPromise]);
      if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES)
        throw new ProtocolFailure("invalid_response");
      return text;
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const result = await Promise.race([reader.read(), abortPromise]);
      if (result.done) {
        complete = true;
        break;
      }
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        reader.cancel("response_too_large").catch(() => {});
        throw new ProtocolFailure("invalid_response");
      }
      chunks.push(result.value);
    }
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    if (!complete) reader.cancel("aborted").catch(() => {});
    reader.releaseLock();
  }
  let text = "";
  for (const chunk of chunks)
    text += textDecoder.decode(chunk, { stream: true });
  text += textDecoder.decode();
  return text;
}

function parseJsonObject(text: string) {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid_json");
  return parsed as Record<string, unknown>;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Treat upstream text as private diagnostic data, never as a log or trusted HTML. */
export function sanitizeUpstreamMessage(value: string, secrets: string[] = []) {
  const normalize = (text: string) =>
    text.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, "");
  let sanitized = normalize(value);
  const sensitive = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    const variants = [secret, JSON.stringify(secret).slice(1, -1)];
    try {
      variants.push(encodeURIComponent(secret));
    } catch {
      // Malformed surrogate input must not defeat the remaining redaction.
    }
    for (const variant of variants) {
      const normalized = normalize(variant);
      if (normalized) sensitive.add(normalized);
    }
  }
  for (const secret of [...sensitive].sort((a, b) => b.length - a.length))
    sanitized = sanitized.split(secret).join("[redacted]");
  sanitized = sanitized
    .replace(/\b(?:https?|wss?|ftp):\/\/[^\s"'<>]+/giu, "[URL]")
    .replace(/\/(?:epay|lpay)\/[^\s"'<>]*\?[^\s"'<>]*/giu, "[URL]")
    .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9+/._~=-]+/giu, "[auth]")
    .replace(
      /\b(authorization|proxy-authorization|client[_-]?secret|secret|token|key)\s*["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/giu,
      "$1=[redacted]",
    )
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(sanitized).slice(0, MAX_DIAGNOSTIC_CHARACTERS).join("");
}

export function parseRetryAfter(value: string | null, now = Date.now()) {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d{1,10}$/.test(text)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, Number(text) * 1000));
  }
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      text,
    )
  )
    return undefined;
  const date = Date.parse(text);
  if (
    !Number.isFinite(date) ||
    date <= now ||
    new Date(date).toUTCString() !== text
  )
    return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, date - now));
}

function responseMetadata(
  response: Response,
  payload: Record<string, unknown>,
  context: PaymentAttemptContext,
  clientId: string,
) {
  const message = stringField(payload.error_msg) ?? stringField(payload.msg);
  const secret = context.clientSecret;
  const secrets = secret
    ? [
        secret,
        `${clientId}:${secret}`,
        basicAuthorization(clientId, secret),
        base64Utf8(`${clientId}:${secret}`),
      ]
    : [];
  const sanitized = message ? sanitizeUpstreamMessage(message, secrets) : "";
  const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
  return {
    httpStatus: response.status,
    ...(sanitized ? { upstreamMessage: sanitized } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function distributeError(
  payload: Record<string, unknown>,
  status: number,
): AdapterResult | null {
  // util.Err always contains data:null; arbitrary message text is diagnostic
  // only. Classification requires the actual response shape and status.
  if (payload.data !== null || typeof payload.error_msg !== "string")
    return null;
  const message = payload.error_msg;
  if (
    status === 401 &&
    [
      "缺少认证信息",
      "认证格式错误",
      "认证信息解码失败",
      "认证信息格式错误",
      "认证失败",
    ].includes(message)
  )
    return {
      kind: "waiting",
      reason: "credentials",
      noOrderEvidence: "protocol_rejection_v1",
    };
  if (status !== 400) return null;
  switch (message) {
    case "余额不足":
      return {
        kind: "waiting",
        reason: "funds",
        noOrderEvidence: "protocol_rejection_v1",
      };
    case "已超过每日限额":
      return {
        kind: "waiting",
        reason: "quota",
        noOrderEvidence: "protocol_rejection_v1",
      };
    case "商户信息不存在":
      return {
        kind: "waiting",
        reason: "credentials",
        noOrderEvidence: "protocol_rejection_v1",
      };
    case "收款人不存在":
      return {
        kind: "rejected",
        reason: "recipient",
        noOrderEvidence: "protocol_rejection_v1",
      };
    case "不能转账给自己":
      return {
        kind: "rejected",
        reason: "self_payment",
        noOrderEvidence: "protocol_rejection_v1",
      };
    case "支付配置不存在":
      return {
        kind: "rejected",
        reason: "configuration",
        noOrderEvidence: "protocol_rejection_v1",
      };
    case "金额必须大于0":
    case "金额小数位数不能超过2位":
      return {
        kind: "rejected",
        reason: "validation",
        noOrderEvidence: "protocol_rejection_v1",
      };
    case "同一业务订单号的订单信息不一致":
      return { kind: "conflict", reason: "conflict" };
    case 'ERROR: duplicate key value violates unique constraint "idx_orders_client_merchant_order" (SQLSTATE 23505)':
      return { kind: "duplicate", reason: "duplicate_order" };
    default:
      return null;
  }
}

function amountMinorFromString(value: unknown) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value))
    return null;
  const [whole, decimal = ""] = value.split(".");
  const minor = BigInt(whole ?? "0") * 100n + BigInt(decimal.padEnd(2, "0"));
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

function credentialCheckBusinessNo() {
  return `hb_credential_check_${crypto.randomUUID().replaceAll("-", "")}`;
}

function statusField(value: unknown): 0 | 1 | null {
  if (value === 0 || value === "0") return 0;
  if (value === 1 || value === "1") return 1;
  return null;
}

class ProtocolFailure extends Error {
  constructor(
    readonly reason: Extract<
      PaymentReason,
      "network" | "timeout" | "invalid_response"
    >,
  ) {
    super(reason);
  }
}

function requestFailureReason(error: unknown) {
  return error instanceof ProtocolFailure ? error.reason : "network";
}

async function requestTextWithTimeout(
  options: RealProtocolOptions,
  url: string,
  init: RequestInit,
) {
  const controller = new AbortController();
  // Invoke the transport as a function, rather than with options as its receiver.
  // Workers' native fetch is receiver-sensitive; an injected transport has no
  // reason to inherit the protocol options as `this` either.
  const transport = options.fetch;
  const timeout = setTimeout(
    () => controller.abort("timeout"),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let abortListener: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(new ProtocolFailure("timeout"));
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const response = await Promise.race([
      transport(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      }),
      aborted,
    ]);
    const text = await readTextLimited(response, controller.signal);
    return { response, text };
  } catch (error) {
    if (controller.signal.aborted) throw new ProtocolFailure("timeout");
    if (error instanceof ProtocolFailure) throw error;
    throw new ProtocolFailure("network");
  } finally {
    clearTimeout(timeout);
    if (abortListener)
      controller.signal.removeEventListener("abort", abortListener);
  }
}

function redirectUnknown(response: Response): AdapterResult | null {
  if (response.status >= 300 && response.status < 400)
    return { kind: "unknown", reason: "redirect", httpStatus: response.status };
  return null;
}

export async function sendRealDistribute(
  task: PaymentTaskRow,
  context: PaymentAttemptContext,
  options: RealProtocolOptions,
): Promise<AdapterResult> {
  if (context.clientId !== undefined && context.clientId !== task.clientId)
    throw new Error("Payment credential identity mismatch");
  if (!context.clientSecret) return { kind: "unknown", reason: "credentials" };
  const username = assertRealTask(task);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const body = encodeDistributeBody({
    userId: task.recipientId,
    username,
    amount: formatAmount(task.amountMinor),
    outTradeNo: task.businessNo,
    remark: context.remark ?? "Linux DO reward",
  });
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await requestTextWithTimeout(
      options,
      urlFor(baseUrl, REAL_DISTRIBUTE_PATH),
      {
        method: "POST",
        headers: {
          Authorization: basicAuthorization(
            task.clientId,
            context.clientSecret,
          ),
          "Content-Type": "application/json",
        },
        body,
      },
    ));
  } catch (error) {
    return { kind: "unknown", reason: requestFailureReason(error) };
  }
  const redirected = redirectUnknown(response);
  if (redirected) return redirected;
  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(text);
  } catch {
    const metadata = responseMetadata(response, {}, context, task.clientId);
    if (response.status === 429)
      return {
        kind: "throttled",
        reason: "throttled",
        ...metadata,
      };
    return {
      kind: "unknown",
      // Gateways often return HTML for a temporary upstream outage. The HTTP
      // status takes precedence, while the body provides no payment evidence.
      reason:
        response.status >= 500 && response.status < 600
          ? "http"
          : "invalid_response",
      ...metadata,
    };
  }
  const metadata = responseMetadata(response, payload, context, task.clientId);
  if (response.status === 429)
    return { kind: "throttled", reason: "throttled", ...metadata };
  const error = distributeError(payload, response.status);
  if (error) return { ...error, ...metadata };
  if (response.status !== 200)
    return { kind: "unknown", reason: "http", ...metadata };
  if (payload.error_msg !== "")
    return { kind: "unknown", reason: "unknown", ...metadata };
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return {
      kind: "unknown",
      reason: "invalid_response",
      ...metadata,
    };
  const object = data as Record<string, unknown>;
  const businessNo = stringField(object.out_trade_no);
  const externalOrderId = stringField(object.trade_no);
  if (!businessNo || !externalOrderId)
    return {
      kind: "unknown",
      reason: "invalid_response",
      ...metadata,
    };
  if (businessNo !== task.businessNo)
    return {
      kind: "conflict",
      reason: "conflict",
      ...metadata,
    };
  return {
    kind: "sent",
    evidence: { source: "send", businessNo, externalOrderId },
    ...metadata,
  };
}

export async function queryRealOrder(
  task: PaymentTaskRow,
  context: PaymentAttemptContext,
  options: RealProtocolOptions,
): Promise<AdapterResult> {
  if (context.clientId !== undefined && context.clientId !== task.clientId)
    throw new Error("Payment credential identity mismatch");
  if (!context.clientSecret) return { kind: "unknown", reason: "credentials" };
  assertRealTask(task);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const url = new URL(urlFor(baseUrl, REAL_QUERY_PATH));
  url.searchParams.set("pid", task.clientId);
  url.searchParams.set("key", context.clientSecret);
  url.searchParams.set("out_trade_no", task.businessNo);
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await requestTextWithTimeout(
      options,
      url.toString(),
      {
        method: "GET",
      },
    ));
  } catch (error) {
    return { kind: "unknown", reason: requestFailureReason(error) };
  }
  const redirected = redirectUnknown(response);
  if (redirected) return redirected;
  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(text);
  } catch {
    const metadata = responseMetadata(response, {}, context, task.clientId);
    if (response.status === 429)
      return {
        kind: "throttled",
        reason: "throttled",
        ...metadata,
      };
    return {
      kind: "unknown",
      reason:
        response.status >= 500 && response.status < 600
          ? "http"
          : "invalid_response",
      ...metadata,
    };
  }
  const metadata = responseMetadata(response, payload, context, task.clientId);
  if (response.status === 429)
    return { kind: "throttled", reason: "throttled", ...metadata };
  if (
    response.status === 404 &&
    payload.code === -1 &&
    payload.msg === "订单不存在或已完成"
  )
    return {
      kind: "not_found",
      reason: "checking_not_found",
      ...metadata,
    };
  if (
    response.status === 400 &&
    payload.code === -1 &&
    payload.msg === "商户信息不存在"
  )
    return {
      kind: "unknown",
      reason: "credentials",
      ...metadata,
    };
  if (response.status !== 200)
    return { kind: "unknown", reason: "http", ...metadata };
  if (payload.code !== 1 && payload.code !== "1")
    return {
      kind: "unknown",
      reason: "invalid_response",
      ...metadata,
    };
  const status = statusField(payload.status);
  const clientId = stringField(payload.pid);
  const businessNo = stringField(payload.out_trade_no);
  const externalOrderId = stringField(payload.trade_no);
  const amountMinor = amountMinorFromString(payload.money);
  if (
    status === null ||
    !clientId ||
    !businessNo ||
    !externalOrderId ||
    amountMinor === null
  )
    return {
      kind: "unknown",
      reason: "invalid_response",
      ...metadata,
    };
  const evidence: QueryPaymentEvidence = {
    source: "query",
    clientId,
    businessNo,
    amountMinor,
    externalOrderId,
    status,
  };
  if (!ensureQueryEvidenceMatchesTask(task, evidence))
    return { kind: "conflict", reason: "conflict", evidence, ...metadata };
  if (status === 0)
    return {
      kind: "unconfirmed",
      reason: "upstream_pending",
      evidence: { ...evidence, status: 0 },
      ...metadata,
    };
  return { kind: "confirmed", evidence, ...metadata };
}

export async function verifyRealCredentials(
  input: { clientId: string; clientSecret: string },
  options: RealProtocolOptions,
): Promise<RealCredentialVerificationResult> {
  if (!input.clientId || !input.clientSecret)
    return { status: "rejected", reason: "credentials" };
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const url = new URL(urlFor(baseUrl, REAL_QUERY_PATH));
  url.searchParams.set("pid", input.clientId);
  url.searchParams.set("key", input.clientSecret);
  url.searchParams.set("out_trade_no", credentialCheckBusinessNo());
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await requestTextWithTimeout(
      options,
      url.toString(),
      { method: "GET" },
    ));
  } catch (error) {
    return { status: "unavailable", reason: requestFailureReason(error) };
  }
  if (response.status >= 300 && response.status < 400)
    return {
      status: "unavailable",
      reason: "redirect",
      httpStatus: response.status,
    };
  if (response.status === 403)
    return {
      status: "unavailable",
      reason: "http",
      httpStatus: response.status,
    };
  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(text);
  } catch {
    return {
      status: "unavailable",
      reason: "invalid_response",
      httpStatus: response.status,
    };
  }
  if (
    response.status === 404 &&
    payload.code === -1 &&
    stringField(payload.msg) === "订单不存在或已完成"
  )
    return {
      status: "passed",
      reason: "not_found_after_auth",
      httpStatus: response.status,
    };
  if (
    response.status === 400 &&
    payload.code === -1 &&
    stringField(payload.msg) === "商户信息不存在"
  )
    return {
      status: "rejected",
      reason: "credentials",
      httpStatus: response.status,
    };
  return {
    status: "unavailable",
    reason: "http",
    httpStatus: response.status,
  };
}

export function createRealPaymentAdapter(
  options: RealProtocolOptions,
): PaymentAdapter {
  return {
    mode: "real",
    send: (task, context) => sendRealDistribute(task, context, options),
    query: (task, context) => queryRealOrder(task, context, options),
  };
}

// 🐟额 转入 (docs/balance-design.md §3, §9.3): an EPay order to the
// platform app, paid by the person at Credit's cashier; then the order query
// without a recipient, since a 转入 has none.

const REAL_SUBMIT_PATH = "/epay/pay/submit.php";
const CASHIER_PATH = "/paying";

export type TopupOrderInput = {
  clientId: string;
  clientSecret: string;
  businessNo: string;
  name: string;
  amountMinor: number;
  returnUrl: string;
};

export type TopupSubmitResult =
  /** Credit's cashier for this order (never stored, never logged). */
  | { kind: "cashier"; url: string }
  /** Timeout, network or 5xx: the same parameters may be sent again. */
  | {
      kind: "retry";
      reason: "timeout" | "network" | "http";
      httpStatus?: number;
    }
  /** Turned down: what Credit said, for the caller to check the order first. */
  | {
      kind: "refused";
      reason: "credentials" | "conflict" | "closed" | "invalid";
      httpStatus: number;
    };

async function md5Hex(text: string) {
  const digest = await crypto.subtle.digest(
    "MD5",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** EPay MD5: non-empty fields by name, `k=v&…`, the key appended, lower-case hex. */
export async function epaySignature(
  params: Record<string, string>,
  secret: string,
) {
  const text = Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type" && params[key])
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return md5Hex(`${text}${secret}`);
}

function topupOrderParams(input: TopupOrderInput) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.businessNo))
    throw new Error("Invalid business number");
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new Error("Invalid topup amount");
  return {
    pid: input.clientId,
    type: "epay",
    out_trade_no: input.businessNo,
    return_url: input.returnUrl,
    name: input.name,
    money: formatAmount(input.amountMinor),
  };
}

export async function submitTopupOrder(
  input: TopupOrderInput,
  options: RealProtocolOptions,
): Promise<TopupSubmitResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const params = topupOrderParams(input);
  const form = new URLSearchParams({
    ...params,
    sign: await epaySignature(params, input.clientSecret),
    sign_type: "MD5",
  });
  let response: Response;
  try {
    ({ response } = await requestTextWithTimeout(
      options,
      urlFor(baseUrl, REAL_SUBMIT_PATH),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
    ));
  } catch (error) {
    const reason = requestFailureReason(error);
    return {
      kind: "retry",
      reason: reason === "timeout" ? "timeout" : "network",
    };
  }
  if (response.status === 302) {
    const location = response.headers.get("Location");
    try {
      const url = new URL(location ?? "");
      if (
        url.origin === baseUrl &&
        url.pathname === CASHIER_PATH &&
        url.searchParams.get("order_no")
      )
        return { kind: "cashier", url: url.toString() };
    } catch {
      // Not a URL: treated as any other unexpected answer below.
    }
    return { kind: "refused", reason: "invalid", httpStatus: 302 };
  }
  if (response.status >= 500)
    return { kind: "retry", reason: "http", httpStatus: response.status };
  if (response.status === 401)
    return { kind: "refused", reason: "credentials", httpStatus: 401 };
  if (response.status === 409)
    return { kind: "refused", reason: "conflict", httpStatus: 409 };
  if (response.status === 400)
    return { kind: "refused", reason: "closed", httpStatus: 400 };
  return { kind: "refused", reason: "invalid", httpStatus: response.status };
}

export type TopupQueryEvidence = {
  clientId: string;
  businessNo: string;
  amountMinor: number;
  externalOrderId: string;
};

export type TopupQueryResult =
  /** status 1: paid, and only then (disputed, refused or refunded are 0). */
  | { kind: "paid"; evidence: TopupQueryEvidence; httpStatus: number }
  | { kind: "unpaid"; evidence: TopupQueryEvidence; httpStatus: number }
  /** No such order (or a read replica not caught up yet). */
  | { kind: "not_found"; httpStatus: number }
  | { kind: "credentials"; httpStatus: number }
  | {
      kind: "unavailable";
      reason: "timeout" | "network" | "http" | "invalid_response";
      httpStatus?: number;
    };

export async function queryTopupOrder(
  input: { clientId: string; clientSecret: string; businessNo: string },
  options: RealProtocolOptions,
): Promise<TopupQueryResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const url = new URL(urlFor(baseUrl, REAL_QUERY_PATH));
  url.searchParams.set("pid", input.clientId);
  url.searchParams.set("key", input.clientSecret);
  url.searchParams.set("out_trade_no", input.businessNo);
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await requestTextWithTimeout(
      options,
      url.toString(),
      { method: "GET" },
    ));
  } catch (error) {
    const reason = requestFailureReason(error);
    return {
      kind: "unavailable",
      reason:
        reason === "timeout"
          ? "timeout"
          : reason === "invalid_response"
            ? "invalid_response"
            : "network",
    };
  }
  const httpStatus = response.status;
  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(text);
  } catch {
    return {
      kind: "unavailable",
      reason: httpStatus >= 500 ? "http" : "invalid_response",
      httpStatus,
    };
  }
  if (
    httpStatus === 404 &&
    payload.code === -1 &&
    payload.msg === "订单不存在或已完成"
  )
    return { kind: "not_found", httpStatus };
  if (
    httpStatus === 400 &&
    payload.code === -1 &&
    payload.msg === "商户信息不存在"
  )
    return { kind: "credentials", httpStatus };
  if (httpStatus !== 200 || (payload.code !== 1 && payload.code !== "1"))
    return { kind: "unavailable", reason: "http", httpStatus };
  const status = statusField(payload.status);
  const clientId = stringField(payload.pid);
  const businessNo = stringField(payload.out_trade_no);
  const externalOrderId = stringField(payload.trade_no);
  const amountMinor = amountMinorFromString(payload.money);
  if (
    status === null ||
    !clientId ||
    !businessNo ||
    !externalOrderId ||
    amountMinor === null
  )
    return { kind: "unavailable", reason: "invalid_response", httpStatus };
  const evidence = { clientId, businessNo, amountMinor, externalOrderId };
  return status === 1
    ? { kind: "paid", evidence, httpStatus }
    : { kind: "unpaid", evidence, httpStatus };
}
