import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// LDC query URLs carry credentials; local automatic traces ignore Wrangler redaction.
// Keep application structured console logs, but never collect these request spans.
process.env.X_LOCAL_OBSERVABILITY = "false";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

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
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
      }),
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
