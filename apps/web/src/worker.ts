const apiPattern = /^\/api(?:\/|$)/;
const activityImagePattern = /^\/e\/[^/]+\/live\.svg$/;

const worker: ExportedHandler<CloudflareEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (activityImagePattern.test(url.pathname)) {
      url.pathname = `/api${url.pathname}`;
      return env.API.fetch(new Request(url, request));
    }

    if (apiPattern.test(url.pathname)) {
      return env.API.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export default worker;
