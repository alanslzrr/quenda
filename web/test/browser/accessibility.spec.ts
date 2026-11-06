import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return path === "/api/me"
      ? route.fulfill({
          status: 401,
          json: { error: { code: "UNAUTHENTICATED", message: "Sin sesión" } },
        })
      : route.fulfill({ json: { items: [], nextCursor: null } });
  });
});

test("the current navigation item is distinguishable in forced-colors mode", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  const current = page.locator('nav [aria-current="page"]').first();
  await expect(current).toBeVisible();
  const style = await current.evaluate((node) => {
    const computed = getComputedStyle(node);
    return { style: computed.outlineStyle, width: computed.outlineWidth };
  });
  expect(style.style).toBe("solid");
  expect(style.width).toBe("2px");
});

test("a request for more contrast strengthens muted text and control borders", async ({
  page,
}) => {
  await page.goto("/");
  const read = () =>
    page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        border: style.getPropertyValue("--border-strong").trim(),
        muted: style.getPropertyValue("--text-muted").trim(),
        foreground: style.getPropertyValue("--foreground").trim(),
        secondary: style.getPropertyValue("--text-secondary").trim(),
      };
    });
  const normal = await read();
  expect(normal.border).not.toBe(normal.foreground);
  await page.emulateMedia({ contrast: "more" });
  const more = await read();
  expect(more.border).toBe(more.foreground);
  expect(more.muted).toBe(more.secondary);
});
