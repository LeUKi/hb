import { type APIResponse, expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:4193";
const immutablePolicy = "public, max-age=31536000, immutable";
const documentHeaders = {
  accept: "text/html",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

function expectHtmlRevalidation(response: APIResponse) {
  expect(response.headers()["content-type"]).toContain("text/html");
  const directives = (response.headers()["cache-control"] ?? "")
    .split(",")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "public")
    .sort();
  expect(directives).toEqual(["max-age=0", "must-revalidate"]);
}

test("HTML 首页和 SPA 深层地址始终重新验证同一构建", async ({ request }) => {
  let buildStamp: string | undefined;
  for (const path of [
    "/",
    "/square",
    "/activities/00000000-0000-4000-8000-000000000000?cache=regression",
  ]) {
    await test.step(path, async () => {
      const response = await request.get(`${origin}${path}`, {
        headers: documentHeaders,
        maxRedirects: 0,
      });
      expect(response.status()).toBe(200);
      expectHtmlRevalidation(response);
      const html = await response.text();
      const stamp = html.match(/data-build-unix-seconds="([1-9]\d*)"/)?.[1];
      expect(stamp).toBeTruthy();
      expect(html).toContain(`build @ ${stamp}`);
      buildStamp ??= stamp;
      expect(stamp).toBe(buildStamp);
    });
  }
});

test("HTML 引用的哈希 JS 和 CSS 在 GET、HEAD 和 304 中保持唯一永久缓存策略", async ({
  request,
}) => {
  const document = await request.get(origin, {
    headers: documentHeaders,
    maxRedirects: 0,
  });
  expect(document.status()).toBe(200);
  const html = await document.text();
  const assetPaths = new Set<string>();
  for (const match of html.matchAll(
    /(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g,
  )) {
    if (match[1]) assetPaths.add(match[1]);
  }
  const assets = [...assetPaths];
  expect(assets.some((path) => path.endsWith(".js"))).toBe(true);
  expect(assets.some((path) => path.endsWith(".css"))).toBe(true);

  for (const path of assets) {
    await test.step(path, async () => {
      expect(path).toMatch(/^\/assets\/.+-[A-Za-z0-9_-]{8}\.(?:js|css)$/);
      const url = `${origin}${path}`;
      const response = await request.get(url, { maxRedirects: 0 });
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe(immutablePolicy);
      expect(response.headers()["content-type"]).toMatch(
        path.endsWith(".css")
          ? /^text\/css(?:;|$)/
          : /^(?:text|application)\/javascript(?:;|$)/,
      );
      const etag = response.headers().etag;
      expect(etag).toBeTruthy();

      const head = await request.head(url, { maxRedirects: 0 });
      expect(head.status()).toBe(200);
      expect(head.headers()["cache-control"]).toBe(immutablePolicy);
      expect(head.headers().etag).toBe(etag);
      expect(await head.body()).toHaveLength(0);

      const unchanged = await request.get(url, {
        headers: { "if-none-match": etag ?? "" },
        maxRedirects: 0,
      });
      expect(unchanged.status()).toBe(304);
      expect(unchanged.headers()["cache-control"]).toBe(immutablePolicy);
      expect(unchanged.headers().etag).toBe(etag);
      expect(await unchanged.body()).toHaveLength(0);
    });
  }
});

test("不存在的资源和其 SPA HTML 回退均不会获得永久缓存", async ({
  request,
}) => {
  const url = `${origin}/assets/cache-regression-missing-00000000.js`;
  const script = await request.get(url, {
    headers: {
      accept: "*/*",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-dest": "script",
    },
    maxRedirects: 0,
  });
  expect([200, 404]).toContain(script.status());
  expect(script.headers()["cache-control"] ?? "").not.toContain("immutable");
  if (script.headers()["content-type"]?.includes("text/html"))
    expectHtmlRevalidation(script);

  const navigation = await request.get(url, {
    headers: documentHeaders,
    maxRedirects: 0,
  });
  expect(navigation.status()).toBe(200);
  expectHtmlRevalidation(navigation);
  expect(await navigation.text()).toContain('id="build-stamp"');
});

test("静态资源缓存策略保留会话 API 和 OAuth 重定向的 no-store", async ({
  request,
}) => {
  const me = await request.get(`${origin}/api/me`, { maxRedirects: 0 });
  expect(me.status()).toBe(200);
  expect(me.headers()["cache-control"]).toBe("no-store");
  expect(me.headers()["content-type"]).toContain("application/json");
  expect(await me.json()).toEqual({ user: null, csrfToken: null });

  const login = await request.get(`${origin}/api/auth/login`, {
    maxRedirects: 0,
  });
  expect(login.status()).toBe(302);
  expect(login.headers()["cache-control"]).toBe("no-store");
  const location = new URL(login.headers().location ?? "", origin);
  expect(location.origin).toBe("https://connect.linux.do");
  expect(location.pathname).toBe("/oauth2/authorize");
  expect(location.searchParams.get("state")).toBeTruthy();
  expect(login.headers()["set-cookie"]).toContain("HttpOnly");
  expect(login.headers()["set-cookie"]).toContain("SameSite=Lax");
});
