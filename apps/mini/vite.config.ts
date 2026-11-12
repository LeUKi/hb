import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 社区小程序 (docs/mini-app-design.md): the forum runs one IIFE app.js and
// one app.css, under a body fragment (index.html) it inserts itself. `vite`
// serves index.html here with a stand-in SDK (src/dev.tsx); `vite build`
// writes dist/web/app.js and app.css for scripts/pack.ts.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The site's own source, as the site resolves it (apps/web/vite.config.ts).
  resolve: {
    alias: [
      {
        find: "@",
        replacement: fileURLToPath(new URL("../web/src", import.meta.url)),
      },
      // What needs a session on 红包站 (its own requests, 重新发送) is not
      // built in: the parts drawn here never reach it (lib/embedded.ts), and
      // the forum allows no network but its own (docs/mini-app-design.md).
      // 三方积分's issuer words come with the mini read (off-site/points.ts).
      ...["session", "claims", "activities", "points"].map((name) => ({
        find: new RegExp(`^(?:\\.\\./)+lib/${name}$`),
        replacement: fileURLToPath(
          new URL(`./src/off-site/${name}.ts`, import.meta.url),
        ),
      })),
      // The 名单, read through the forum instead (lib/roster.ts's own).
      {
        find: /^(?:(?:\.\.\/)+lib|\.)\/roster-read$/,
        replacement: fileURLToPath(
          new URL("./src/off-site/roster-read.ts", import.meta.url),
        ),
      },
    ],
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
