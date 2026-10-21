import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { assetCachePlugin } from "./asset-cache.ts";
import { brandHtmlPlugin } from "./brand-html.ts";
import {
  buildTimePlugin,
  buildTimeUnixSeconds,
  versionFilePlugin,
} from "./build-time.ts";

// LDC query URLs carry credentials; local automatic traces ignore Wrangler redaction.
// Keep application structured console logs, but never collect these request spans.
process.env.X_LOCAL_OBSERVABILITY = "false";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const builtAtUnixSeconds = buildTimeUnixSeconds();

export default defineConfig(({ mode }) => {
  const environment =
    mode === "typecheck" ? "local" : (process.env.HB_DEPLOY_ENV ?? "local");
  if (!["local", "staging", "production"].includes(environment)) {
    throw new Error("HB_DEPLOY_ENV must be local, staging or production");
  }
  const suffix = environment === "local" ? "" : `.${environment}`;
  return {
    build: {
      outDir: environment === "local" ? "dist" : `dist/${environment}`,
      // One bundle is deliberate: the whole app loads up front behind the
      // boot loader in index.html (docs/redesign/06-production.md §5).
      chunkSizeWarningLimit: 1536,
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    plugins: [
      brandHtmlPlugin(),
      buildTimePlugin(builtAtUnixSeconds),
      versionFilePlugin(builtAtUnixSeconds),
      assetCachePlugin(),
      react(),
      tailwindcss(),
      cloudflare({
        configPath: `wrangler${suffix}.jsonc`,
        viteEnvironment: { name: "hb_web" },
        auxiliaryWorkers: [
          {
            configPath: `../api/wrangler${suffix}.jsonc`,
            viteEnvironment: { name: "hb_api" },
          },
        ],
        persistState: { path: `${repoRoot}/.wrangler/state` },
        remoteBindings: false,
      }),
    ],
  };
});
