import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000071";
const facility = "00000000-0000-4000-8000-000000000072";
const unit = "00000000-0000-4000-8000-000000000073";
const selected = `/municipios/${tenant}/unidades/${unit}?fecha=2026-10-26&duracion=90`;
const retryName = /^(Reintentar|Tentar de novo)$/;

test.use({ reducedMotion: "reduce" });

async function mockCatalog(page: Page, dark: boolean) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname === "/api/me") {
      await route.fulfill({
        status: 401,
        json: {
          error: { code: "UNAUTHENTICATED", message: "Sesión requerida" },
        },
      });
      return;
    }
    if (url.pathname === "/api/public/municipalities")
      body = {
        items: [{ id: tenant, name: "Oleiros", timeZone: "Europe/Madrid" }],
        nextCursor: null,
      };
    else if (url.pathname.endsWith(`/municipalities/${tenant}`))
      body = { id: tenant, name: "Oleiros", timeZone: "Europe/Madrid" };
    else if (url.pathname.endsWith("/appearance"))
      body = {
        version: 1,
        theme: "neutral",
        light: {},
        dark: {},
        font: "inter",
        corners: "round",
        defaultTheme: dark ? "dark" : "light",
      };
    else if (url.pathname.endsWith("/branding"))
      body = {
        version: 1,
        name: "Oleiros",
        officialName: "Oleiros",
        logos: { light: false, dark: false },
      };
    else if (url.pathname.endsWith(`/units/${unit}`))
      body = {
        id: unit,
        name: "Pista 1",
        facilityId: facility,
        facilityName: "Centro deportivo",
        timeZone: "Europe/Madrid",
        municipalAdvanceDays: 30,
        cancellationMinutes: 1440,
        bookingPolicyVersion: 1,
        usageRulesVersion: 1,
        calendarVersion: 1,
        calendar: {
          minimumMinutes: 60,
          maximumMinutes: 120,
          stepMinutes: 30,
          advanceDays: null,
        },
      };
    else throw new Error(`Unexpected request: ${url.pathname}`);
    await route.fulfill({ json: body });
  });
}

test("rate-limited availability waits, resets a new deadline, then recovers without losing selection", async ({
  page,
}, info) => {
  // Keep query notification timers running while controlling the deadline clock.
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:00Z"));
  await mockCatalog(page, info.project.name.includes("dark"));
  let stage = 0;
  const requests: string[] = [];
  await page.route("**/availability?**", async (route) => {
    requests.push(route.request().url());
    if (stage < 2)
      await route.fulfill({
        status: 429,
        headers: { "Retry-After": stage === 0 ? "5" : "2" },
        json: {
          error: { code: "RATE_LIMITED", message: "Demasiadas solicitudes." },
        },
      });
    else
      await route.fulfill({
        json: {
          unitId: unit,
          date: "2026-10-26",
          timeZone: "Europe/Madrid",
          calculatedAt: "2026-10-24T12:00:00Z",
          slots: [
            {
              start: {
                utc: "2026-10-26T09:00:00.000Z",
                local: "2026-10-26T10:00:00",
              },
              end: {
                utc: "2026-10-26T10:30:00.000Z",
                local: "2026-10-26T11:30:00",
              },
            },
          ],
        },
      });
  });
  await page.goto(selected);
  const retry = page.getByRole("button", { name: retryName });
  await expect(retry).toBeDisabled();
  await expect(page.getByRole("timer")).toHaveAttribute("aria-live", "off");
  const baseline = requests.length;
  await page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("link", { name: "Reservar", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: /reservar\?/ }),
  ).toBeVisible();
  await page.goBack();
  await expect(retry).toBeDisabled();
  expect(requests).toHaveLength(baseline);
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:03Z"));
  await expect(page.getByRole("timer")).toContainText("2 s.");
  await expect(retry).toBeDisabled();
  expect(requests).toHaveLength(baseline);
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:05.500Z"));
  await expect(retry).toBeEnabled();
  await expect(page.getByRole("status")).toContainText(/(Ya puedes|Xa podes)/);
  expect(requests).toHaveLength(baseline);
  stage = 1;
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(page.getByRole("timer")).toContainText("2 s.");
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:08Z"));
  await expect(retry).toBeEnabled();
  stage = 2;
  await retry.click();
  await expect(
    page.getByRole("link", { name: "10:00–11:30", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(selected);
  await expect(
    page.getByRole("combobox", { name: "Duración", exact: true }),
  ).toContainText("1 h 30 min");
  expect(
    requests.every((request) => {
      const params = new URL(request).searchParams;
      return (
        params.get("date") === "2026-10-26" &&
        params.get("durationMinutes") === "90"
      );
    }),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const header of [undefined, "invalid"])
  test(`availability recovers from ${header === undefined ? "missing" : "invalid"} Retry-After after a finite fallback`, async ({
    page,
  }, info) => {
    await page.clock.setFixedTime(new Date("2026-10-24T12:00:00Z"));
    await mockCatalog(page, info.project.name.includes("dark"));
    await page.route("**/availability?**", (route) =>
      route.fulfill({
        status: 429,
        headers: header ? { "Retry-After": header } : {},
        json: {
          error: { code: "RATE_LIMITED", message: "Demasiadas solicitudes." },
        },
      }),
    );
    await page.goto(selected);
    const retry = page.getByRole("button", { name: retryName });
    await expect(retry).toBeDisabled();
    await page.clock.setFixedTime(new Date("2026-10-24T12:01:01Z"));
    await expect(retry).toBeEnabled();
    await expect(page).toHaveURL(selected);
  });
