import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { assetCachePlugin } from "./asset-cache.ts";
import { brandHtmlPlugin } from "./brand-html.ts";
import { buildTimePlugin, buildTimeUnixSeconds } from "./build-time.ts";

const builtAtUnixSeconds = buildTimeUnixSeconds();

// This browser-only build has no Worker config, secrets or deployment output.
export default defineConfig(() => {
  const outDir = process.env.HB_FULL_APP_OUTPUT_DIR;
  if (!outDir) throw new Error("FULL_APP_TEST_OUTPUT_REQUIRED");
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    envDir: false as const,
    cacheDir: join(dirname(outDir), "vite-cache"),
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 1536 },
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    plugins: [
      brandHtmlPlugin(),
      buildTimePlugin(builtAtUnixSeconds),
      assetCachePlugin(),
      tanstackRouter({ target: "react", autoCodeSplitting: false }),
      react(),
      tailwindcss(),
    ],
  };
});
