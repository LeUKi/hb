import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/prototype",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  workers: 2,
  retries: 0,
  reporter: "list",
  outputDir: ".wrangler/verification/prototype-playwright",
  use: {
    baseURL: "http://127.0.0.1:4177",
    trace: "off",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run prototype:dev",
    url: "http://127.0.0.1:4177",
    reuseExistingServer: true,
    timeout: 60_000,
    env: { BROWSER: "none" },
  },
});
