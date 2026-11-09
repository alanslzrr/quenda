import { defineConfig, devices } from "@playwright/test";

// Another local service may already hold 3000; the harness API port can be moved without touching the web port.
const apiPort = Number(process.env.QUENDA_TEST_API_PORT ?? 3000);
export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: true,
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], locale: "es-ES" } },
    {
      name: "mobile-dark",
      use: {
        ...devices["iPhone 13"],
        defaultBrowserType: "chromium",
        locale: "gl-ES",
        colorScheme: "dark",
        reducedMotion: "reduce",
      },
    },
  ],
  webServer: [
    {
      command: "cd .. && node test/helpers/web-server.ts",
      url: `http://127.0.0.1:${apiPort}/health/ready`,
      reuseExistingServer: false,
      timeout: 60000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
    },
    {
      command: "pnpm dev",
      env: { QUENDA_API: `http://127.0.0.1:${apiPort}` },
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
    },
  ],
});
