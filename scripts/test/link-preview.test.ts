import { describe, expect, it } from "vitest";
import { encodeActivityEmoji } from "../../packages/contracts/src/ecoji-v2";

// Link previews (docs/link-preview-design.md): the web Worker writes each
// page's lines into index.html's head; its 红包, 打赏卡, 判定器 and 三方积分
// ask the API, and anything that is not a page goes out as it came.

const ORIGIN = "https://hb.example.com";
const PAGE = `<!doctype html><html><head>
    <!--page-meta-->
    <title>站点</title>
    <!--/page-meta-->
    <link rel="icon" href="x" />
  </head><body><div id="root"></div></body></html>`;

type MinimalWorker = {
  fetch(
    request: Request,
    env: unknown,
    context: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response>;
};

async function loadWorker() {
  const modulePath = "../../apps/web/src/worker";
  return ((await import(modulePath)) as { default: MinimalWorker }).default;
}

async function visit(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    asset?: () => Response;
    api?: (request: Request) => Response | Promise<Response>;
  } = {},
) {
  const apiCalls: string[] = [];
  const assetCalls: Request[] = [];
  const env = {
    API: {
      async fetch(request: Request) {
        apiCalls.push(new URL(request.url).pathname);
        return options.api
          ? options.api(request)
          : Response.json({ error: {} }, { status: 404 });
      },
    },
    ASSETS: {
      async fetch(request: Request) {
        assetCalls.push(request);
        return options.asset
          ? options.asset()
          : new Response(request.method === "HEAD" ? null : PAGE, {
              headers: {
                "Content-Type": "text/html",
                ETag: '"index"',
                "X-Frame-Options": "SAMEORIGIN",
              },
            });
      },
    },
  };
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: options.method ?? "GET",
      headers: options.headers,
    }),
    env,
    { waitUntil() {} },
  );
  const html = await response.text();
  const meta = (key: string) =>
    html.match(
      new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`),
    )?.[1] ?? null;
  return {
    response,
    html,
    meta,
    title: html.match(/<title>([^<]*)<\/title>/)?.[1] ?? null,
    apiCalls,
    assetCalls,
  };
}

const enc = (path: string) =>
  path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

describe("link previews", () => {
  it("writes a help page's own lines, and the site's address and picture", async () => {
    const page = await visit("/help/claim");
    expect(page.title).toBe("领红包 · lafish的红包站");
    expect(page.meta("og:title")).toBe("领红包 · 帮助中心");
    expect(page.meta("og:description")).toBe("口令、领不到、什么时候到账。");
    expect(page.meta("og:url")).toBe(`${ORIGIN}/help/claim`);
    expect(page.meta("og:image")).toBe(`${ORIGIN}/og.png`);
    expect(page.meta("twitter:card")).toBe("summary");
    expect(page.meta("robots")).toBeNull();
    // One set of lines: the site's are replaced, the rest of the head kept.
    expect(page.html.match(/<title>/g)).toHaveLength(1);
    expect(page.html).toContain('<link rel="icon" href="x" />');
    expect(page.apiCalls).toEqual([]);
    // Each address its own page: nothing to revalidate.
    expect(page.response.headers.get("ETag")).toBeNull();
    expect(page.response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("asks the API for a 红包's words, and its 🎲's", async () => {
    const code = encodeActivityEmoji("cecef876-ddbb-4ed5-93ce-9b311e3df3ea");
    const words = {
      title: "小满的红包 · 周末红包",
      description: "口令红包 · 拼手气。打开链接，输入口令领取。",
      tab: "周末红包",
    };
    const page = await visit(enc(`/🧧/${code}`), {
      api: () => Response.json(words),
    });
    expect(page.apiCalls).toEqual([enc(`/api/site/preview/activity/${code}`)]);
    expect(page.meta("og:title")).toBe(words.title);
    expect(page.meta("description")).toBe(words.description);
    expect(page.title).toBe("周末红包 · lafish的红包站");
    const draw = await visit(enc(`/🧧/${code}/🎲`));
    expect(draw.apiCalls).toEqual([enc(`/api/site/preview/draw/${code}`)]);
  });

  it("says the site's words when the API has none, fails or is slow", async () => {
    for (const api of [
      () => Response.json({ error: {} }, { status: 404 }),
      () => {
        throw new Error("down");
      },
      () => Response.json({ title: 1 }),
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(Response.json({})), 5_000),
        ),
    ]) {
      const page = await visit(enc("/☕/ABCD1234"), { api });
      expect(page.response.status).toBe(200);
      expect(page.meta("og:title")).toBe("lafish的红包站");
      expect(page.title).toBe("lafish的红包站");
    }
  }, 10_000);

  it("keeps someone's own pages out of search engines, and an invitation says no names", async () => {
    for (const path of [
      "/me",
      "/history",
      "/balance/out/x",
      "/admin/payments",
      "/new",
      "/judges/new",
      "/points/abc/edit",
      enc("/🧧/码/📝"),
      enc("/☕/ABCD1234/🧾/x"),
      "/nothing-here",
    ]) {
      const page = await visit(path);
      expect(page.meta("robots"), path).toBe("noindex");
      expect(page.apiCalls, path).toEqual([]);
    }
    const invite = await visit("/invite/token123");
    expect(invite.meta("og:title")).toBe("🐟额 PLUS 邀请");
    expect(invite.meta("robots")).toBe("noindex");
    for (const path of ["/", "/rank", "/judges", "/help"])
      expect((await visit(path)).meta("robots"), path).toBeNull();
  });

  it("leaves what is not a page as it came, and always fetches the whole page", async () => {
    const script = await visit("/x.js", {
      asset: () =>
        new Response("js", {
          headers: { "Content-Type": "text/javascript", ETag: '"js"' },
        }),
    });
    expect(script.html).toBe("js");
    expect(script.response.headers.get("ETag")).toBe('"js"');
    const head = await visit("/help", { method: "HEAD" });
    expect(head.html).toBe("");
    const conditional = await visit("/help", {
      headers: { "If-None-Match": '"index"', "If-Modified-Since": "x" },
    });
    expect(conditional.assetCalls[0]?.headers.get("If-None-Match")).toBeNull();
    expect(
      conditional.assetCalls[0]?.headers.get("If-Modified-Since"),
    ).toBeNull();
    expect(conditional.meta("og:title")).toBe("帮助中心");
  });

  it("lets anyone frame a 打赏卡's embed, with its lines written", async () => {
    const page = await visit(`${enc("/☕/ABCD1234")}?embed`, {
      api: () =>
        Response.json({
          title: "打赏 小满",
          description: "@xiaoman 的打赏卡，打开链接就能打赏。",
          tab: null,
        }),
    });
    expect(page.response.headers.get("X-Frame-Options")).toBeNull();
    expect(page.response.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors *",
    );
    expect(page.meta("og:title")).toBe("打赏 小满");
    expect(page.meta("og:url")).toBe(`${ORIGIN}${enc("/☕/ABCD1234")}`);
  });
});
