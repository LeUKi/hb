import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assetCacheHeaders } from "../../apps/web/asset-cache";
import { inspectAssetCache } from "../release";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("fingerprinted static asset caching", () => {
  it("only grants immutable caching to exact fingerprinted asset paths", () => {
    const headers = assetCacheHeaders([
      "assets/app-ABCDEFGH.js",
      "assets/app-1234abcd.css",
      "assets/font-1234abcd.woff2",
      "index.html",
      "assets/missing.html",
      "assets/app.js",
      "api/me",
      "_headers",
    ]);
    expect(headers.split("\n").filter((line) => line.startsWith("/"))).toEqual([
      "/assets/app-1234abcd.css",
      "/assets/app-ABCDEFGH.js",
      "/assets/font-1234abcd.woff2",
    ]);
    expect(headers).not.toContain("*");
    expect(headers.match(/max-age=31536000, immutable/g)).toHaveLength(3);
    expect(() => assetCacheHeaders(["index.html"])).toThrow(
      "ASSET_CACHE_NO_FINGERPRINTED_ASSETS",
    );
  });

  it("never keeps the build a page compares itself with", () => {
    const headers = assetCacheHeaders([
      "assets/app-ABCDEFGH.js",
      "version.json",
    ]);
    expect(headers).toContain("/version.json\n  Cache-Control: no-store\n");
    expect(headers.match(/immutable/g)).toHaveLength(1);
  });

  it("fails the build instead of silently exceeding Cloudflare's rule limit", () => {
    expect(() =>
      assetCacheHeaders(
        Array.from({ length: 101 }, (_, i) => `assets/chunk${i}-1234abcd.js`),
      ),
    ).toThrow("ASSET_CACHE_RULE_LIMIT_EXCEEDED");
  });

  it("release verification rejects missing, broad or incomplete cache policies", () => {
    const directory = mkdtempSync(join(tmpdir(), "hb-asset-cache-"));
    temporary.push(directory);
    mkdirSync(join(directory, "client/assets"), { recursive: true });
    writeFileSync(
      join(directory, "client/assets/app-ABCDEFGH.js"),
      "export {};",
    );
    expect(() => inspectAssetCache(directory)).toThrow(
      "RELEASE_ASSET_CACHE_POLICY_MISMATCH",
    );
    writeFileSync(
      join(directory, "client/_headers"),
      "/*\n  Cache-Control: public, max-age=31536000, immutable\n",
    );
    expect(() => inspectAssetCache(directory)).toThrow(
      "RELEASE_ASSET_CACHE_POLICY_MISMATCH",
    );
    writeFileSync(
      join(directory, "client/_headers"),
      assetCacheHeaders(["assets/app-ABCDEFGH.js"]),
    );
    expect(() => inspectAssetCache(directory)).not.toThrow();
    writeFileSync(
      join(directory, "client/assets/later-1234abcd.css"),
      "body{}",
    );
    expect(() => inspectAssetCache(directory)).toThrow(
      "RELEASE_ASSET_CACHE_POLICY_MISMATCH",
    );
  });
});
