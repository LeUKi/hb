import {
  type PageLookup,
  type PageMeta,
  pageMetaHtml,
  pageOf,
  withPageMeta,
} from "./lib/page-meta";
import { movedLocation, secureLocation } from "./lib/site-move";

const apiPattern = /^\/api(?:\/|$)/;
// The forum image, /🧧/<code>/🖼️.svg or /🧧/<code>/🖼️ (with or without
// U+FE0F), as the percent-encoded path a request carries. The API reads the
// same path under /api.
const activityImagePattern =
  /^\/%F0%9F%A7%A7\/[^/]+\/%F0%9F%96%BC(?:%EF%B8%8F)?(?:\.svg)?$/i;

// A 打赏卡's own page, /☕/<卡号>, as the percent-encoded path a request carries.
const tipCardPattern = /^\/%E2%98%95\/[^/]+\/?$/i;

/** How long a page waits for its preview's words before using the site's. */
const PREVIEW_WAIT_MS = 1500;
/** How long those words are kept at the edge. */
const PREVIEW_KEEP_S = 60;

const worker: ExportedHandler<CloudflareEnv> = {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    // The site moved: what reaches the Worker on the old host goes there.
    const moved = movedLocation(url);
    if (moved) return Response.redirect(moved, 301);
    // Plain http goes to https, the same request (308 keeps its method).
    const secure = secureLocation(url);
    if (secure) return Response.redirect(secure, 308);

    if (activityImagePattern.test(url.pathname)) {
      url.pathname = `/api${url.pathname}`;
      return env.API.fetch(new Request(url, request));
    }

    if (apiPattern.test(url.pathname)) {
      return env.API.fetch(request);
    }

    const page = await withPreview(request, env, context, url);

    // A 打赏卡 embedded in another site (docs/tip-design.md §7): this one
    // address may be framed by anyone; every other page stays unframeable.
    if (tipCardPattern.test(url.pathname) && url.searchParams.has("embed")) {
      const headers = new Headers(page.headers);
      headers.delete("X-Frame-Options");
      headers.set("Content-Security-Policy", "frame-ancestors *");
      return new Response(page.body, {
        status: page.status,
        statusText: page.statusText,
        headers,
      });
    }
    return page;
  },
};

/**
 * A page with its link-preview lines (docs/link-preview-design.md): every
 * page is index.html, its head written for its address. Anything else the
 * assets answer goes out as it came.
 */
async function withPreview(
  request: Request,
  env: CloudflareEnv,
  context: ExecutionContext,
  url: URL,
) {
  // Always the whole page: one answer per address, so nothing to revalidate.
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const response = await env.ASSETS.fetch(new Request(request, { headers }));
  if (
    request.method !== "GET" ||
    response.status !== 200 ||
    !response.headers.get("Content-Type")?.startsWith("text/html")
  )
    return response;
  const page = pageOf(url.pathname);
  const meta = "kind" in page ? await lookUp(env, context, url, page) : page;
  const html = withPageMeta(
    await response.text(),
    pageMetaHtml(meta, { origin: url.origin, pathname: url.pathname }),
  );
  const out = new Headers(response.headers);
  out.delete("ETag");
  out.delete("Content-Length");
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers: out,
  });
}

/**
 * A 红包's (or 打赏卡's, 判定器's, 三方积分's) words, from the API, kept at
 * the edge a minute; the site's when it has none or is slow.
 */
async function lookUp(
  env: CloudflareEnv,
  context: ExecutionContext,
  url: URL,
  page: PageLookup,
): Promise<PageMeta> {
  const key = new Request(
    `${url.origin}/api/site/preview/${page.kind}/${encodeURIComponent(page.key)}`,
  );
  const cache = typeof caches === "undefined" ? null : caches.default;
  try {
    let body = await (await cache?.match(key))?.text();
    if (body === undefined) {
      const answer = await Promise.race([
        env.API.fetch(key),
        new Promise<null>((resolve) =>
          setTimeout(resolve, PREVIEW_WAIT_MS, null),
        ),
      ]);
      if (!answer?.ok) return page.fallback;
      body = await answer.text();
      // Kept here a minute (the API's own answers are all no-store).
      if (cache)
        context.waitUntil(
          cache.put(
            key,
            new Response(body, {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": `public, max-age=${PREVIEW_KEEP_S}`,
              },
            }),
          ),
        );
    }
    const words = JSON.parse(body) as Partial<PageMeta>;
    if (
      typeof words.title !== "string" ||
      typeof words.description !== "string"
    )
      return page.fallback;
    return {
      title: words.title,
      description: words.description,
      tab: typeof words.tab === "string" ? words.tab : null,
    };
  } catch {
    return page.fallback;
  }
}

export default worker;
