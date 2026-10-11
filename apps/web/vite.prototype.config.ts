import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { buildTimePlugin, buildTimeUnixSeconds } from "./build-time.ts";

const startedAt = buildTimeUnixSeconds();
export default defineConfig({
  root: fileURLToPath(new URL("./prototype", import.meta.url)),
  publicDir: false,
  plugins: [react(), buildTimePlugin(startedAt)],
  server: { host: "127.0.0.1", port: 4177, strictPort: true },
  preview: { host: "127.0.0.1", port: 4177, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL("./dist/prototype", import.meta.url)),
    emptyOutDir: true,
  },
});
