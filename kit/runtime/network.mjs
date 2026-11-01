// 联网 (协议第二版，docs/programmable-hongbao-design.md §9): judge.js may
// export `network`, at most three https address prefixes, and fetch() only
// those, a few times a judgment. The rules are here once: the sandbox's
// fetch() (prelude.mjs), the site's deploy and gateway, and the kit's
// commands all read them from this file.

export const NETWORK_LIMITS = Object.freeze({
  /** Prefixes in `network`. */
  entries: 3,
  /** Characters in one prefix. */
  entryCharacters: 200,
  /** Requests in one judgment. */
  requests: 3,
  requestBytes: 16 * 1024,
  responseBytes: 64 * 1024,
  /** One request, from sending it to the end of its answer. */
  requestMs: 10_000,
  /** A judgment with network, all of it, on the site. */
  judgmentMs: 15_000,
});

export const NETWORK_METHODS = Object.freeze(["GET", "POST"]);

/** Hosts no 红包 may ask: LINUX DO's and this site's own. */
const CLOSED_HOSTS = ["linux.do", "hb.lafi.sh"];

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** An encoded slash or backslash: decoded by a server, it leaves the prefix. */
const ENCODED_SLASH = /%2f|%5c/i;

const kb = (bytes) => `${bytes / 1024} KB`;

/** What fetch() throws: the reason after 联网失败, as fetch's own TypeError. */
export function networkError(reason) {
  return new TypeError(`联网失败：${reason}`);
}

export const NETWORK_REASONS = Object.freeze({
  none: "这个红包没有联网（judge.js 没有导出 network）",
  ended: "fetch 只能在 judge 运行时用（判定结束以后也不行）",
  tooMany: `这次判定已经发了 ${NETWORK_LIMITS.requests} 个请求`,
  method: `只能用 ${NETWORK_METHODS.join(" 和 ")}`,
  requestTooBig: `请求体超过 ${kb(NETWORK_LIMITS.requestBytes)}`,
  responseTooBig: `返回超过 ${kb(NETWORK_LIMITS.responseBytes)}`,
  timeout: `超时（${NETWORK_LIMITS.requestMs / 1000} 秒）`,
  unreachable: "连不上对方",
  upgrade: "不能建 WebSocket 之类的长连接",
});

function hostProblem(host) {
  if (host.startsWith("[") || IPV4.test(host)) return "不能写 IP 地址";
  if (!host.includes(".") || host.endsWith("."))
    return "要写完整的域名（比如 api.example.com）";
  if (host === "localhost" || host.endsWith(".localhost"))
    return "不能写 localhost";
  for (const closed of CLOSED_HOSTS)
    if (host === closed || host.endsWith(`.${closed}`))
      return `不能请求 ${closed} 和它的子域名`;
  return null;
}

/**
 * One prefix as written: its canonical form, or why it is not one. Written
 * as the URL standard writes it back — https, a lowercase host, no port,
 * user, `?` or `#` — only a bare site may leave out its last `/`.
 */
export function readEntry(entry) {
  if (typeof entry !== "string" || entry.trim() === "")
    return { problem: "要是不空的字符串" };
  if ([...entry].length > NETWORK_LIMITS.entryCharacters)
    return { problem: `最多 ${NETWORK_LIMITS.entryCharacters} 个字` };
  let url;
  try {
    url = new URL(entry);
  } catch {
    return { problem: "不是有效的地址" };
  }
  if (url.protocol !== "https:") return { problem: "只能用 https://" };
  if (url.username || url.password) return { problem: "不能带用户名和密码" };
  if (url.port) return { problem: "不能带端口（只走 443）" };
  if (url.search || url.hash || /[?#]/.test(entry))
    return { problem: "不能带 ? 和 #" };
  const host = hostProblem(url.hostname);
  if (host) return { problem: host };
  if (ENCODED_SLASH.test(url.pathname))
    return { problem: "路径里不能有编码过的斜杠（%2F、%5C）" };
  const canonical = `${url.origin}${url.pathname}`;
  if (entry !== canonical && `${entry}/` !== canonical)
    return { problem: `要写成 ${canonical}` };
  return { prefix: canonical };
}

/**
 * A `network` entry naming an 地址参数 (docs/judge-address-design.md §2):
 * `{ param }`, the address its sender fills in, taken at opening.
 */
export const isParamEntry = (entry) =>
  entry !== null &&
  typeof entry === "object" &&
  !Array.isArray(entry) &&
  Object.keys(entry).length === 1 &&
  typeof entry.param === "string" &&
  entry.param !== "";

/**
 * A `network` entry to the 判定器 author's own backend that takes the
 * site's token (docs/judge-address-design.md §12.2): `{ url, token }`.
 */
const isUrlEntry = (entry) =>
  entry !== null &&
  typeof entry === "object" &&
  !Array.isArray(entry) &&
  "url" in entry &&
  Object.keys(entry).every((key) => key === "url" || key === "token");

const SHAPE =
  '要是地址，或者 { param: "地址参数的 key" }、{ url: "地址", token: true }';

/**
 * judge.js's `network` export: `{ list }` (null when it has none: no
 * network, as protocol v1) or `{ problems }`, one line each. Each entry is
 * a canonical prefix, `{ param }` or `{ url, token: true }`; that a
 * `{ param }` names an 地址参数 is checked with the params
 * (networkParamProblems).
 */
export function readNetwork(value) {
  if (value === undefined || value === null) return { list: null };
  if (!Array.isArray(value))
    return {
      problems: [
        `network 要是数组，每项${SHAPE}，比如 ["https://api.example.com/hongbao/"]`,
      ],
    };
  if (value.length === 0)
    return { problems: ["network 至少写一个地址；不联网就别导出它"] };
  if (value.length > NETWORK_LIMITS.entries)
    return { problems: [`network 最多写 ${NETWORK_LIMITS.entries} 个地址`] };
  const problems = [];
  const list = [];
  const same = (kept, address) =>
    kept === address || (typeof kept === "object" && kept.url === address);
  for (const [index, entry] of value.entries()) {
    const where = `network 第 ${index + 1} 个`;
    if (isParamEntry(entry)) {
      if (list.some((kept) => kept.param === entry.param))
        problems.push(`${where}和前面的重复了`);
      else list.push({ param: entry.param });
      continue;
    }
    if (entry !== null && typeof entry === "object" && !isUrlEntry(entry)) {
      problems.push(`${where}：${SHAPE}`);
      continue;
    }
    const url = isUrlEntry(entry) ? entry.url : entry;
    if (
      isUrlEntry(entry) &&
      entry.token !== undefined &&
      entry.token !== true
    ) {
      problems.push(`${where}：token 只能写 true`);
      continue;
    }
    const read = readEntry(url);
    if ("problem" in read)
      problems.push(
        `${where}${typeof url === "string" ? `（${url}）` : ""}：${read.problem}`,
      );
    else if (list.some((kept) => same(kept, read.prefix)))
      problems.push(`${where}和前面的重复了`);
    else
      list.push(
        isUrlEntry(entry) && entry.token
          ? { url: read.prefix, token: true }
          : read.prefix,
      );
  }
  return problems.length > 0 ? { problems } : { list };
}

/** An entry's address as written: null for a `{ param }`. */
const writtenOf = (entry) =>
  typeof entry === "string"
    ? entry
    : typeof entry?.url === "string"
      ? entry.url
      : null;

/** The addresses written out in `network`, its `{ param }` left out. */
export const fixedAddresses = (list) =>
  (list ?? []).map(writtenOf).filter((address) => address !== null);

/** An entry's address for one 红包: a `{ param }` from its params. */
const addressOf = (entry, values) => writtenOf(entry) ?? values?.[entry.param];

/**
 * The addresses one 红包 (or test) may ask: `network` with each `{ param }`
 * taken from its params — left out when not filled, once when the same as
 * another. Null with none: that 红包 is not online.
 */
export function resolveNetwork(list, values) {
  if (!Array.isArray(list)) return null;
  const resolved = [];
  for (const entry of list) {
    const address = addressOf(entry, values);
    if (
      typeof address === "string" &&
      address !== "" &&
      !resolved.includes(address)
    )
      resolved.push(address);
  }
  return resolved.length > 0 ? resolved : null;
}

/**
 * Those of them requests to which carry the site's token, X-Hb-Token
 * (docs/judge-address-design.md §12.2): each `{ param }` filled in, and
 * each `{ url, token: true }`; never one written as a plain address.
 */
export function tokenAddresses(list, values) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => typeof entry === "object" && entry !== null)
    .filter((entry) => typeof entry.param === "string" || entry.token === true)
    .map((entry) => addressOf(entry, values))
    .filter((address) => typeof address === "string" && address !== "");
}

/**
 * The kit's own (docs/judge-address-design.md §8): http on localhost or
 * 127.0.0.1, any port, for `--live` against a service run beside it. The
 * site never takes one, so never lets one in.
 */
const isLocal = (url) =>
  url.protocol === "http:" &&
  (url.hostname === "localhost" || url.hostname === "127.0.0.1");

/**
 * An 地址参数 as a sender filled it: `{ address }`, as `network` writes
 * one and ending in `/` — https://A.workers.dev is https://a.workers.dev/
 * — or `{ problem }`. `local`: the kit's `--live` also takes
 * http://localhost:8787/.
 */
export function readAddress(value, { local = false } = {}) {
  if (typeof value !== "string" || value.trim() === "")
    return { problem: "要是不空的地址" };
  const text = value.trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return { problem: "不是有效的地址" };
  }
  if (url.username || url.password) return { problem: "不能带用户名和密码" };
  if (url.search || url.hash || /[?#]/.test(text))
    return { problem: "不能带 ? 和 #" };
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  if (local && isLocal(url)) return { address: `${url.origin}${path}` };
  if (url.protocol !== "https:")
    return { problem: "只能用 https:// 开头的地址" };
  if (url.port) return { problem: "不能带端口" };
  const read = readEntry(`${url.origin}${path}`);
  return "problem" in read ? read : { address: read.prefix };
}

/**
 * Whether `network` (canonical prefixes, resolveNetwork's list) lets this
 * address be asked: https on 443, the same host, and a path under the
 * prefix's, cut at a `/` — `https://a.com/api` lets in /api, /api/x and
 * /api?x, not /apix. The address is read by the URL standard first, so
 * `..` and `%2e%2e` are gone; an encoded slash is never let in.
 */
export function allowedBy(list, address) {
  if (!Array.isArray(list) || list.length === 0) return false;
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (
    (!isLocal(url) && (url.protocol !== "https:" || url.port)) ||
    url.username ||
    url.password ||
    ENCODED_SLASH.test(url.pathname)
  )
    return false;
  return list.some((entry) => {
    const prefix = new URL(entry);
    // A local address only under a local entry, which only the kit has.
    if (prefix.protocol !== url.protocol || prefix.host !== url.host)
      return false;
    const base = prefix.pathname;
    return base.endsWith("/")
      ? url.pathname.startsWith(base)
      : url.pathname === base || url.pathname.startsWith(`${base}/`);
  });
}

/**
 * A request as fetch() was asked for it, before it goes: why it may not
 * (a reason for networkError), or null. `bodyBytes` is the body's size.
 */
export function requestProblem({ method, address, headers, bodyBytes }, list) {
  if (!NETWORK_METHODS.includes(method)) return NETWORK_REASONS.method;
  for (const name of headers) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower.startsWith("x-hb-"))
      return `不能设请求头 ${name}`;
    if (lower === "upgrade") return NETWORK_REASONS.upgrade;
  }
  if (bodyBytes > NETWORK_LIMITS.requestBytes)
    return NETWORK_REASONS.requestTooBig;
  if (!allowedBy(list, address)) return `这个地址不在白名单里：${address}`;
  return null;
}
