import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: true,
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
      url: "http://127.0.0.1:3000/health/ready",
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: "pnpm dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
    },
  ],
});
