import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// A separate run with its own server and database; it uses the fixtures of the
// non-desktop project. Its results stay apart from the desktop and phone run.
export default defineConfig({
  ...base,
  outputDir: "test-results/tablet",
  projects: [
    {
      name: "tablet",
      use: {
        ...devices["iPad (gen 7)"],
        defaultBrowserType: "chromium",
        locale: "gl-ES",
      },
    },
  ],
});
