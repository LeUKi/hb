// Addresses the site has moved away from. hb.lafi.sh replaced
// meme.442224.xyz on 2026-10-15 (docs/redesign/06-production.md §11); the old
// host stays attached to the web Worker only to send everyone to the new one.
// Pure data: the release checks and index.html read it too.

export const movedHosts: Record<string, string> = {
  "meme.442224.xyz": "https://hb.lafi.sh",
};

/** Where a request to a moved host goes now (same path), or null. */
export function movedLocation(url: URL) {
  const origin = movedHosts[url.hostname];
  return origin ? `${origin}${url.pathname}${url.search}` : null;
}

/**
 * This machine, in development: the one place plain http is meant
 * (docs/redesign/06-production.md §11).
 */
const localHost = /^(?:127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/;

/**
 * Where a plain-http request on a real host goes: the same address over
 * https, or null. Signing in only takes https (the request's origin must be
 * APP_ORIGIN), so nothing may stay on http.
 */
export function secureLocation(url: URL) {
  if (url.protocol !== "http:" || localHost.test(url.hostname)) return null;
  return `https://${url.host}${url.pathname}${url.search}`;
}

/**
 * For index.html: pages are static assets that never reach the Worker, so
 * the page itself goes on before anything else loads — off a moved host, and
 * off plain http.
 */
export function siteMoveScript() {
  return `<script>(() => { const to = ${JSON.stringify(movedHosts)}[location.hostname]; const rest = location.pathname + location.search + location.hash; if (to) location.replace(to + rest); else if (location.protocol === "http:" && !${localHost}.test(location.hostname)) location.replace("https://" + location.host + rest); })();</script>`;
}
