import { expect, test } from "@playwright/test";

test("a signed-in page keeps the last known theme and language when preferences cannot be read", async ({
  page,
}) => {
  let limited = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (limited && (path === "/api/me/preferences" || path === "/api/me/theme"))
      return route.fulfill({
        status: 429,
        headers: { "Retry-After": "30" },
        json: {
          error: { code: "RATE_LIMITED", message: "Demasiadas solicitudes." },
        },
      });
    const body =
      path === "/api/me"
        ? {
            accountId: "reader",
            email: "reader@example.test",
            mfaVerified: true,
          }
        : path === "/api/me/preferences"
          ? { locale: "gl" }
          : path === "/api/me/theme"
            ? { theme: "dark" }
            : path === "/api/me/notices/unread"
              ? { unread: 0 }
              : path === "/api/me/navigation"
                ? {
                    municipalities: { items: [], nextCursor: null },
                    platform: { operator: false, permissions: [] },
                  }
                : { items: [], nextCursor: null };
    await route.fulfill({ json: body });
  });
  await page.goto("/reservar");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("lang", "gl");
  limited = true;
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("lang", "gl");
});
