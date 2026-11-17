import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";

const tenant = "00000000-0000-4000-8000-000000000095";

async function mock(page: Page, signed: boolean) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { items: [], nextCursor: null };
    if (path === "/api/me") {
      if (!signed) {
        await route.fulfill({
          status: 401,
          json: { error: { code: "UNAUTHENTICATED", message: "Sesión" } },
        });
        return;
      }
      body = {
        accountId: "operador",
        email: "operador@example.test",
        mfaVerified: true,
      };
    } else if (path === "/api/me/preferences") body = { locale: null };
    else if (path === "/api/me/theme") body = { theme: "light" };
    else if (path === "/api/me/navigation")
      body = {
        municipalities: { items: [], nextCursor: null },
        platform: { operator: true, permissions: [] },
      };
    else if (path === "/api/public/municipalities")
      body = {
        items: [{ id: tenant, name: "Oleiros", timeZone: "Europe/Madrid" }],
        nextCursor: null,
      };
    await route.fulfill({ json: body });
  });
}
async function axis(page: Page, path: string) {
  await page.goto(path);
  const heading = page.locator("main h1").first();
  await expect(heading).toBeVisible();
  return {
    left: Math.round((await heading.boundingBox())?.x ?? -1),
    overflow: await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  };
}

test("sign-in, errors and notices share the booking axis", async ({ page }) => {
  await mock(page, false);
  const reference = await axis(page, "/reservar");
  for (const path of ["/acceso", "/registro", "/no-existe"])
    expect(await axis(page, path), path).toEqual(reference);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, true);
  // Platform management has its own frame, like municipal management, so it is not on this axis.
  expect(await axis(page, "/avisos"), "/avisos").toEqual(reference);
});
