import { defineConfig, devices } from "@playwright/test";

// Documentation captures: one ordered pass over a freshly seeded demo dataset.
// Not part of `pnpm validate` or CI; run with `pnpm docs:capture`.
const apiPort = Number(process.env.QUENDA_CAPTURE_API_PORT ?? 3200);
const webPort = Number(process.env.QUENDA_CAPTURE_WEB_PORT ?? 5175);
export default defineConfig({
  testDir: "./docs-capture",
  // Scenarios change shared demo state (reservations, staff, policies), so
  // they run in file order on one worker.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180000,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${webPort}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "cd .. && node test/docs-capture/server.ts",
      url: `http://127.0.0.1:${apiPort}/health/ready`,
      reuseExistingServer: false,
      timeout: 300000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      env: { QUENDA_API: `http://127.0.0.1:${apiPort}` },
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
    },
  ],
});
