import { describe, expect, it } from "vitest";
import { encodeActivityEmoji } from "../../packages/contracts/src/ecoji-v2";

const ORIGIN = "https://hb.example.com";
const ACTIVITY_ID = "cecef876-ddbb-4ed5-93ce-9b311e3df3ea";
const EMOJI = encodeActivityEmoji(ACTIVITY_ID);
const ENCODED_EMOJI = encodeURIComponent(EMOJI);

type FetchCall = { request: Request };
type MinimalFetcher = { fetch(request: Request): Promise<Response> | Response };
type MinimalEnv = { API: MinimalFetcher; ASSETS: MinimalFetcher };
type MinimalContext = {
  passThroughOnException(): void;
  waitUntil(promise: Promise<unknown>): void;
};
type MinimalWorker = {
  fetch(
    request: Request,
    env: MinimalEnv,
    context: MinimalContext,
  ): Promise<Response> | Response;
};

let workerModule: Promise<MinimalWorker> | undefined;

async function loadWorker() {
  workerModule ??= (async () => {
    const modulePath = "../../apps/web/src/worker";
    const module = (await import(modulePath)) as { default: MinimalWorker };
    return module.default;
  })();
  return workerModule;
}

function binding(name: "api" | "assets") {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetcher: {
      async fetch(request: Request) {
        calls.push({ request });
        return new Response(request.method === "HEAD" ? null : name, {
          headers: {
            "Set-Cookie": `${name}=1; Path=/`,
            "X-Upstream": name,
          },
        });
      },
    },
  };
}

function context() {
  return {
    passThroughOnException() {},
    waitUntil() {},
  };
}

async function route(path: string, init: RequestInit = {}) {
  const api = binding("api");
  const assets = binding("assets");
  const env = {
    API: api.fetcher,
    ASSETS: assets.fetcher,
  };
  const worker = await loadWorker();
  const fetch = worker.fetch;
  const request = new Request(`${ORIGIN}${path}`, init);
  const response = await fetch(request, env, context());
  return { response, api: api.calls, assets: assets.calls };
}

const RED_PACKET = encodeURIComponent("🧧");

function imagePath(file = "🖼️.svg") {
  return `/${RED_PACKET}/${ENCODED_EMOJI}/${encodeURIComponent(file)}`;
}

describe("web worker activity image routing", () => {
  it("forwards forum image GET and HEAD requests to the API binding", async () => {
    const path = `${imagePath()}?tz=UTC`;
    const headers = {
      Accept: "image/svg+xml,*/*",
      Cookie: "hb_session=abc; pref=1",
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
    };

    const get = await route(path, { headers });
    expect(get.assets).toHaveLength(0);
    expect(get.api).toHaveLength(1);
    expect(get.response.headers.get("set-cookie")).toBe("api=1; Path=/");
    expect(get.response.headers.get("x-upstream")).toBe("api");
    const getRequest = get.api[0]?.request;
    expect(getRequest?.method).toBe("GET");
    expect(new URL(getRequest?.url ?? "").pathname).toBe(`/api${imagePath()}`);
    expect(new URL(getRequest?.url ?? "").search).toBe("?tz=UTC");
    expect(getRequest?.headers.get("cookie")).toBe("hb_session=abc; pref=1");
    expect(getRequest?.headers.get("accept")).toBe("image/svg+xml,*/*");
    expect(getRequest?.headers.get("sec-fetch-dest")).toBe("image");
    expect(getRequest?.headers.get("sec-fetch-mode")).toBe("no-cors");

    const head = await route(path, { method: "HEAD", headers });
    expect(head.assets).toHaveLength(0);
    expect(head.api).toHaveLength(1);
    expect(head.response.headers.get("set-cookie")).toBe("api=1; Path=/");
    expect(head.api[0]?.request.method).toBe("HEAD");
    expect(new URL(head.api[0]?.request.url ?? "").pathname).toBe(
      `/api${imagePath()}`,
    );
  });

  it("accepts the address with or without U+FE0F and .svg, in either hex case", async () => {
    for (const path of [
      imagePath("🖼️.svg"),
      imagePath("🖼.svg"),
      imagePath("🖼️"),
      imagePath("🖼"),
      imagePath().toLowerCase(),
    ]) {
      const result = await route(path);
      expect(result.assets).toHaveLength(0);
      expect(result.api).toHaveLength(1);
      expect(new URL(result.api[0]?.request.url ?? "").pathname).toBe(
        `/api${path}`,
      );
    }
  });

  it("keeps 红包 pages, other emoji paths and retired image addresses on assets", async () => {
    for (const path of [
      `/${RED_PACKET}/${ENCODED_EMOJI}`,
      `/${RED_PACKET}/${ENCODED_EMOJI}/${encodeURIComponent("📝")}`,
      `${imagePath()}/extra`,
      `/${RED_PACKET}/${ENCODED_EMOJI}/live.svg`,
      `/e/${ENCODED_EMOJI}/live.svg`,
      `/e/${ENCODED_EMOJI}`,
    ]) {
      const result = await route(path);
      expect(result.api).toHaveLength(0);
      expect(result.assets).toHaveLength(1);
      expect(new URL(result.assets[0]?.request.url ?? "").pathname).toBe(path);
      expect(result.response.headers.get("set-cookie")).toBe(
        "assets=1; Path=/",
      );
    }

    const apiRoute = await route(`/api${imagePath()}?x=1`, {
      headers: { Cookie: "hb_session=direct" },
    });
    expect(apiRoute.assets).toHaveLength(0);
    expect(apiRoute.api).toHaveLength(1);
    const forwarded = apiRoute.api[0]?.request;
    expect(new URL(forwarded?.url ?? "").pathname).toBe(`/api${imagePath()}`);
    expect(new URL(forwarded?.url ?? "").search).toBe("?x=1");
    expect(forwarded?.headers.get("cookie")).toBe("hb_session=direct");
  });
});

describe("the move to hb.lafi.sh", () => {
  async function routeOn(origin: string, path: string) {
    const api = binding("api");
    const assets = binding("assets");
    const worker = await loadWorker();
    const response = await worker.fetch(
      new Request(`${origin}${path}`),
      { API: api.fetcher, ASSETS: assets.fetcher },
      context(),
    );
    return { response, upstream: api.calls.length + assets.calls.length };
  }

  it("sends what reaches the Worker on the old host to the same path there", async () => {
    for (const path of ["/api/session?x=1", imagePath()]) {
      const { response, upstream } = await routeOn(
        "https://meme.442224.xyz",
        path,
      );
      expect(response.status).toBe(301);
      expect(response.headers.get("Location")).toBe(
        `https://hb.lafi.sh${path}`,
      );
      expect(upstream).toBe(0);
    }
  });

  it("serves the new host and any other host as before", async () => {
    for (const origin of ["https://hb.lafi.sh", "https://staging.hb.lafi.sh"]) {
      const { response, upstream } = await routeOn(origin, "/api/session");
      expect(response.status).toBe(200);
      expect(upstream).toBe(1);
    }
  });

  it("moves pages too, before anything else loads (index.html's script)", async () => {
    const { siteMoveScript } = await import("../../apps/web/src/lib/site-move");
    const code =
      /<script>([\s\S]*)<\/script>/.exec(siteMoveScript())?.[1] ?? "";
    const visit = (href: string) => {
      const url = new URL(href);
      const replaced: string[] = [];
      new Function("location", code)({
        hostname: url.hostname,
        pathname: url.pathname,
        search: url.search,
        hash: url.hash,
        replace: (to: string) => replaced.push(to),
      });
      return replaced;
    };
    expect(visit("https://meme.442224.xyz/history?tab=joined#top")).toEqual([
      "https://hb.lafi.sh/history?tab=joined#top",
    ]);
    expect(visit("https://hb.lafi.sh/history")).toEqual([]);
  });
});
