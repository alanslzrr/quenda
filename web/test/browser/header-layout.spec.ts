import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures";

async function mock(page: Page, signedIn: boolean) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me")
      return signedIn
        ? route.fulfill({
            json: {
              accountId: "titular",
              email: "titular@example.test",
              mfaVerified: false,
            },
          })
        : route.fulfill({
            status: 401,
            json: { error: { code: "UNAUTHENTICATED", message: "Sin sesión" } },
          });
    if (path === "/api/me/preferences")
      return route.fulfill({ json: { locale: null } });
    if (path === "/api/me/theme")
      return route.fulfill({ json: { theme: "light" } });
    if (path === "/api/me/navigation")
      return route.fulfill({
        json: {
          platform: { operator: false, permissions: [] },
          municipalities: { items: [], nextCursor: null },
        },
      });
    if (path === "/api/me/calendar-subscription")
      return route.fulfill({ json: { active: false, createdAt: null } });
    const notice = /\/notices\/(privacy|legal|accessibility)$/.exec(path);
    if (notice)
      return route.fulfill({
        json: { kind: notice[1], version: 0, body: {}, publishedAt: null },
      });
    if (path === "/api/me/recommendations")
      return route.fulfill({ json: { enabled: true, items: [] } });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
}

const box = async (locator: Locator) => {
  const value = await locator.boundingBox();
  if (!value) throw new Error("Element has no box");
  return value;
};

/** No two header items may overlap, whatever the session and the phone width. */
async function expectSeparate(page: Page) {
  const header = page.locator("header").first();
  const items = [
    // The brand link keeps its accessible name even when only the mark is shown.
    header.getByRole("link", { name: /quenda/ }).first(),
    ...(await header.getByRole("navigation").getByRole("link").all()),
    ...(await header.locator(":scope > div > *").all()),
  ];
  // The brand's own content must fit its box: a clipped or overflowing wordmark would draw over the next item.
  expect(
    await items[0]?.evaluate(
      (link) => link.scrollWidth <= link.clientWidth + 1,
    ),
  ).toBe(true);
  const boxes = await Promise.all(items.map(box));
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++) {
      const [x, y] = [boxes[a], boxes[b]];
      if (!x || !y) continue;
      const overlap =
        x.x < y.x + y.width - 0.5 &&
        y.x < x.x + x.width - 0.5 &&
        x.y < y.y + y.height - 0.5 &&
        y.y < x.y + x.height - 0.5;
      expect(overlap, `header items ${a} and ${b} overlap`).toBe(false);
    }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

for (const width of [320, 360, 390, 760]) {
  test(`the header items never overlap at ${width}px, with or without a session`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await mock(page, false);
    await page.goto("/privacidad");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectSeparate(page);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mock(page, true);
    await page.goto("/reservas");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectSeparate(page);
  });
}
