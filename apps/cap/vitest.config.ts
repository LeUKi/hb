import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          CAP_MASTER_SECRET: "test-cap-master-secret-0123456789",
          // test/cap.test.ts solves these: few, easy puzzles.
          CAP_SITES: JSON.stringify([
            {
              key: "plain",
              name: "plain",
              // SHA-256 of "plain-secret"
              secretHash:
                "cc0e7608b73ea73b08fd28b582c21ba4ce5a0b1c9202bf7d2dcc85366205b622",
              origins: ["https://page.test"],
              challengeCount: 3,
              difficulty: 2,
              instrumentation: false,
            },
            {
              key: "checked",
              secretHash:
                "cc0e7608b73ea73b08fd28b582c21ba4ce5a0b1c9202bf7d2dcc85366205b622",
              challengeCount: 3,
              difficulty: 2,
            },
          ]),
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
