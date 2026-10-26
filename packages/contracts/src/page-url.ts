// 附带网页 (docs/attached-page-design.md §1): the https page a 红包 may
// carry beside its own. The rules of 代码判定联网's addresses
// (kit/runtime/network.mjs), with a path, `?` and `#` allowed; here once,
// for the form and the API.

export const PAGE_URL_MAX_CHARACTERS = 500;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Why this is not a page a 红包 may carry, or null (empty: none). */
export function pageUrlProblem(value: string): string | null {
  const text = value.trim();
  if (text === "") return null;
  if ([...text].length > PAGE_URL_MAX_CHARACTERS)
    return `最多 ${PAGE_URL_MAX_CHARACTERS} 个字`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "不是有效的地址";
  }
  if (url.protocol !== "https:") return "只能用 https:// 开头的地址";
  if (url.username || url.password) return "不能带用户名和密码";
  if (url.port) return "不能带端口";
  const host = url.hostname;
  if (host.startsWith("[") || IPV4.test(host)) return "不能写 IP 地址";
  if (host === "localhost" || host.endsWith(".localhost"))
    return "不能写 localhost";
  if (!host.includes(".") || host.endsWith("."))
    return "要写完整的域名（比如 example.com）";
  if (host === "linux.do" || host.endsWith(".linux.do"))
    return "不能用 linux.do 和它的子域名";
  if (host === "hb.lafi.sh" || host.endsWith(".hb.lafi.sh"))
    return "不能用本站的地址";
  return null;
}

/** The page as the URL standard writes it back; null when it is none. */
export function normalizePageUrl(value: string): string | null {
  const text = value.trim();
  if (text === "" || pageUrlProblem(text) !== null) return null;
  return new URL(text).href;
}

/**
 * Whether the page lets this site show it in a frame, by its own headers
 * read now (X-Frame-Options, frame-ancestors): unknown when it could not
 * be read.
 */
export type AttachedPageCheck = { embeddable: "yes" | "no" | "unknown" };

/** A 红包's page as its viewers get it. */
export type AttachedPage = { url: string; host: string };

export function attachedPageOf(url: string): AttachedPage {
  return { url, host: new URL(url).hostname };
}
