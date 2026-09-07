import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const port = 4179;
const systemChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: "test-results/enterprise-ui/playwright",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    launchOptions: existsSync(systemChrome)
      ? { executablePath: systemChrome }
      : undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build -w @pwa/web && npx tsx tests/e2e/task-18-server.ts",
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      TASK18_E2E_PORT: String(port),
    },
  },
});
