import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        d1Databases: { TEST_LEGACY_DB: "hb-test-legacy-migration" },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          // Tests must never inherit real OAuth credentials from .dev.vars.
          APP_ORIGIN: "",
          APP_ENV: "local",
          LDC_NETWORK_MODE: "disabled",
          LDC_ACCEPTANCE_ID: "",
          LDC_TIMED_DRAW_ENABLED: "true",
          CONNECT_CLIENT_ID: "",
          CONNECT_CLIENT_SECRET: "",
          ENCRYPTION_KEYS: JSON.stringify({
            test: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          }),
          ENCRYPTION_KEY_VERSION: "test",
          PASSWORD_DIGEST_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          CLAIM_ATTEMPTS_PER_MINUTE: "10",
          // Cloudflare's always-pass test key: it needs no secret (human-check.ts).
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
          TURNSTILE_SECRET_KEY: "",
        },
      },
    }),
  ],
  test: {
    // Each file starts an isolated Workers runtime and applies every migration.
    // Keep concurrent fixtures bounded as the integration suite grows.
    maxWorkers: 4,
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
