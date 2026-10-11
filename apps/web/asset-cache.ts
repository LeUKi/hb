import type { Plugin } from "vite";

const fingerprintedAsset =
  /^assets\/[^/\s?#]+-[\w-]{8,}\.(?:js|css|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf)$/;

export function assetCacheHeaders(files: readonly string[]) {
  const assets = [
    ...new Set(files.filter((path) => fingerprintedAsset.test(path))),
  ].sort();
  if (assets.length === 0)
    throw new Error("ASSET_CACHE_NO_FINGERPRINTED_ASSETS");
  // Workers _headers supports at most 100 rules. Never silently drop a chunk.
  if (assets.length > 100) throw new Error("ASSET_CACHE_RULE_LIMIT_EXCEEDED");
  return assets
    .map(
      (path) =>
        `/${path}\n  Cache-Control: public, max-age=31536000, immutable\n`,
    )
    .join("\n");
}

export function assetCachePlugin(): Plugin {
  return {
    name: "hb-asset-cache",
    apply: "build",
    enforce: "post",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle(_options, bundle) {
      // Exact emitted paths avoid caching SPA fallback HTML for missing chunks.
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: assetCacheHeaders(Object.keys(bundle)),
      });
    },
  };
}
