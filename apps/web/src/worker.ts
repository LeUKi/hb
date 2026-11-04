import { movedLocation, secureLocation } from "./lib/site-move";

const apiPattern = /^\/api(?:\/|$)/;
// The forum image, /🧧/<code>/🖼️.svg or /🧧/<code>/🖼️ (with or without
// U+FE0F), as the percent-encoded path a request carries. The API reads the
// same path under /api.
const activityImagePattern =
  /^\/%F0%9F%A7%A7\/[^/]+\/%F0%9F%96%BC(?:%EF%B8%8F)?(?:\.svg)?$/i;

// A 打赏卡's own page, /☕/<卡号>, as the percent-encoded path a request carries.
const tipCardPattern = /^\/%E2%98%95\/[^/]+\/?$/i;

const worker: ExportedHandler<CloudflareEnv> = {
  async fetch(request, env) {
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

    // A 打赏卡 embedded in another site (docs/tip-design.md §7): this one
    // address may be framed by anyone; every other page stays unframeable.
    if (tipCardPattern.test(url.pathname) && url.searchParams.has("embed")) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.delete("X-Frame-Options");
      headers.set("Content-Security-Policy", "frame-ancestors *");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return env.ASSETS.fetch(request);
  },
};

export default worker;
