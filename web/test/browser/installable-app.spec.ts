import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) =>
    new URL(route.request().url()).pathname === "/api/me"
      ? route.fulfill({
          status: 401,
          json: { error: { code: "UNAUTHENTICATED", message: "Sin sesión" } },
        })
      : route.fulfill({ json: { items: [], nextCursor: null } }),
  );
});

test("the application can be installed and names its icons", async ({
  page,
}) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");
  const response = await page.request.get(href as string);
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    name: "Quenda",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  // Every icon decodes at the size the manifest declares.
  for (const icon of manifest.icons as { src: string; sizes: string }[]) {
    const size = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return `${image.naturalWidth}x${image.naturalHeight}`;
    }, icon.src);
    expect(size).toBe(icon.sizes);
  }
  // Chromium's own manifest parser reports no errors for the page's manifest.
  const cdp = await page.context().newCDPSession(page);
  const parsed = await cdp.send("Page.getAppManifest");
  expect(parsed.url).toMatch(/\/manifest\.webmanifest$/);
  expect(parsed.errors).toEqual([]);
});
