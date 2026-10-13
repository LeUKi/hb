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

describe("web worker activity image routing", () => {
  it("forwards emoji live image GET and HEAD requests to the API binding", async () => {
    const path = `/e/${ENCODED_EMOJI}/live.svg?fallback=public`;
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
    expect(new URL(getRequest?.url ?? "").pathname).toBe(
      `/api/e/${ENCODED_EMOJI}/live.svg`,
    );
    expect(new URL(getRequest?.url ?? "").search).toBe("?fallback=public");
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
      `/api/e/${ENCODED_EMOJI}/live.svg`,
    );
    expect(new URL(head.api[0]?.request.url ?? "").search).toBe(
      "?fallback=public",
    );
  });

  it("keeps ordinary emoji activity pages on assets and existing API routes unchanged", async () => {
    const activityPage = await route(`/e/${ENCODED_EMOJI}`);
    expect(activityPage.api).toHaveLength(0);
    expect(activityPage.assets).toHaveLength(1);
    expect(new URL(activityPage.assets[0]?.request.url ?? "").pathname).toBe(
      `/e/${ENCODED_EMOJI}`,
    );
    expect(activityPage.response.headers.get("set-cookie")).toBe(
      "assets=1; Path=/",
    );

    const apiRoute = await route(`/api/e/${ENCODED_EMOJI}/live.svg?x=1`, {
      headers: { Cookie: "hb_session=direct" },
    });
    expect(apiRoute.assets).toHaveLength(0);
    expect(apiRoute.api).toHaveLength(1);
    const forwarded = apiRoute.api[0]?.request;
    expect(new URL(forwarded?.url ?? "").pathname).toBe(
      `/api/e/${ENCODED_EMOJI}/live.svg`,
    );
    expect(new URL(forwarded?.url ?? "").search).toBe("?x=1");
    expect(forwarded?.headers.get("cookie")).toBe("hb_session=direct");
  });
});
