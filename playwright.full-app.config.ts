import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/full-app",
  testMatch: "**/*.flow.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  reporter: "list",
  outputDir: "test-results/full-app",
  use: {
    baseURL: "http://127.0.0.1:4193",
    trace: "off",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 15_000,
    launchOptions: {
      // Mocked requests are fulfilled before DNS. Unexpected redirected hosts
      // cannot bypass route interception and reach a real service.
      args: [
        "--no-proxy-server",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      ],
    },
  },
  projects: [
    { name: "full-app-chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node scripts/full-app-server.mjs",
    url: "http://127.0.0.1:4194/ready",
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
