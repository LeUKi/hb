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
          // test/setup.ts answers for this drand node.
          DRAND_URLS: "https://drand.test",
          CONNECT_CLIENT_ID: "",
          CONNECT_CLIENT_SECRET: "",
          ENCRYPTION_KEYS: JSON.stringify({
            test: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          }),
          ENCRYPTION_KEY_VERSION: "test",
          PASSWORD_DIGEST_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          // 附带网页认人: a key for tests only, never used anywhere else.
          PAGE_IDENTITY_KEYS: JSON.stringify([
            {
              kid: "test",
              kty: "EC",
              crv: "P-256",
              x: "m1XJhR6Y54HlCfN9TMZN8k7qiINV70tR_lzRA315V4o",
              y: "BSXDROpgS1G6Ag9IuS3U6QI5Ta7JkbSR_ondCD5D9cI",
              d: "BlBsp0Or0nloxTUphy5bAOi3z76fFn22fcl1SuchufY",
            },
          ]),
          // Cloudflare's always-pass test key: it needs no secret (human-check.ts).
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
          TURNSTILE_SECRET_KEY: "",
          // Cap (docs/cap-design.md): tests answer for the service themselves.
          CAP_ORIGIN: "https://cap.test",
          CAP_SITE_KEY: "hb-test",
          CAP_SECRET_KEY: "test-cap-secret",
        },
        serviceBindings: {
          CAP: () =>
            Response.json(
              { success: false, error: "no_cap_in_tests" },
              { status: 503 },
            ),
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
