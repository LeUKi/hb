import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 论坛小程序 (docs/mini-app-design.md): the forum runs one IIFE app.js and
// one app.css, under a body fragment (index.html) it inserts itself. `vite`
// serves index.html here with a stand-in SDK (src/dev.tsx); `vite build`
// writes dist/web/app.js and app.css for scripts/pack.ts.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
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
