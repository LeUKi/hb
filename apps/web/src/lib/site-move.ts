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
 * For index.html: pages on a moved host are static assets that never reach
 * the Worker, so the page itself goes on before anything else loads.
 */
export function siteMoveScript() {
  return `<script>(() => { const to = ${JSON.stringify(movedHosts)}[location.hostname]; if (to) location.replace(to + location.pathname + location.search + location.hash); })();</script>`;
}
