const apiPattern = /^\/api(?:\/|$)/;

const worker: ExportedHandler<CloudflareEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (apiPattern.test(url.pathname)) {
      return env.API.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export default worker;
