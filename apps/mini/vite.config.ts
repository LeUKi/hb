import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, normalizePath, type Plugin } from "vite";

// 社区小程序 (docs/mini-app-design.md): the forum runs one IIFE app.js and
// one app.css, under a body fragment (index.html) it inserts itself. `vite`
// serves index.html here with a stand-in SDK (src/dev.tsx); `vite build`
// writes dist/web/app.js and app.css for scripts/pack.ts.
export default defineConfig({
  plugins: [offSite(), react(), tailwindcss()],
  // The site's own source, as the site resolves it (apps/web/vite.config.ts).
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../web/src", import.meta.url)),
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    // 红包站, for its links: Stage for sandbox builds, as manifest.json's
    // endpoints (scripts/pack.ts writes both from MINI_APP_HB_ORIGIN).
    __HB_ORIGIN__: JSON.stringify(
      process.env.MINI_APP_HB_ORIGIN || "https://staging.hb.lafi.sh",
    ),
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    target: "es2022",
    // A debug build for the sandbox's DevTools (the forum strips maps from
    // releases).
    sourcemap: process.env.MINI_APP_DEBUG === "1" ? "inline" : false,
    cssCodeSplit: false,
    // No files beside app.js and app.css: anything else would be read
    // through the SDK as a declared asset.
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    lib: {
      entry: "src/main.tsx",
      formats: ["iife"],
      name: "HbMini",
      fileName: () => "app.js",
      cssFileName: "app",
    },
  },
});

/**
 * 红包站's own requests, with its session (重新发送, 开放时提醒我) or
 * without (the 在看 card), are not built in: the parts drawn here never
 * reach them (lib/embedded.ts, LiveViewers plain), and the forum allows no
 * network but its own (docs/mini-app-design.md). Each lib module named here
 * is built from src/off-site/<name>.ts instead: the 名单 is read through the
 * forum (lib/roster.ts's own), and 三方积分's issuer words come with the
 * mini read (off-site/points.ts).
 *
 * Swapped by the file an import resolves to, whatever its shape:
 * ../../lib/session from a component, ./session from another lib module
 * (sweep 2026-11-21: lib/notices.ts and lib/viewers.ts brought the real
 * session and API modules in through ./session and ./activities, which an
 * alias by import path never matched). contracts' own ./points is another
 * file and stays. A build that still holds one fails.
 */
function offSite(): Plugin {
  const names = [
    "session",
    "claims",
    "activities",
    "points",
    "roster-read",
    "notices",
    "viewers",
  ];
  const swaps = new Map(
    names.map((name) => [
      site(`lib/${name}.ts`),
      fileURLToPath(new URL(`./src/off-site/${name}.ts`, import.meta.url)),
    ]),
  );
  // Kept out with them: the session's own read and 红包站's API client.
  const kept = new Set([...swaps.keys(), site("lib/auth.ts"), site("api.ts")]);
  // Words only those have (the session read's, readResponse's), should one
  // come in under another file's name.
  const words = ["身份检查失败：", "请求失败：HTTP"];
  return {
    name: "hb-mini-off-site",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const name = source
        .split("/")
        .pop()
        ?.replace(/\.tsx?$/, "");
      if (!name || !names.includes(name)) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      return resolved && (swaps.get(resolved.id) ?? resolved);
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        const found = [
          ...chunk.moduleIds.filter((id) => kept.has(id)),
          ...words.filter((word) => chunk.code.includes(word)),
        ];
        if (found.length > 0)
          this.error(
            `${chunk.fileName} holds 红包站's own session or requests: ${found.join(", ")}`,
          );
      }
    },
  };
}

/** A file of 红包站's own source (apps/web/src), as the bundler names it. */
function site(path: string) {
  return normalizePath(
    fileURLToPath(new URL(`../web/src/${path}`, import.meta.url)),
  );
}
