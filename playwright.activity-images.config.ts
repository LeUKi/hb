import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/activity-images",
  testMatch: "**/*.flow.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  reporter: "list",
  outputDir: ".wrangler/verification/activity-images",
  use: {
    baseURL: "https://localhost:4199",
    ignoreHTTPSErrors: true,
    screenshot: "off",
    trace: "off",
  },
  projects: [
    { name: "image-chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "image-firefox",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: { "network.cookie.cookieBehavior": 0 },
        },
      },
    },
    {
      name: "image-firefox-blocked",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: { "network.cookie.cookieBehavior": 1 },
        },
      },
    },
    { name: "image-webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node scripts/full-app-server.mjs",
    url: "http://127.0.0.1:4194/ready",
    reuseExistingServer: false,
    timeout: 180_000,
    env: { HB_FULL_APP_IMAGE_HTTPS: "1" },
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
