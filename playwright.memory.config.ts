import { defineConfig } from "@playwright/test";

const port = 4183;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "memory.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "line",
  outputDir: "test-results/memory/playwright",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    viewport: { width: 1440, height: 1100 },
    launchOptions: {
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run build -w @pwa/web && npx tsx tests/e2e/memory-server.ts",
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { MEMORY_E2E_PORT: String(port) },
  },
});
