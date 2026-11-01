import { expect, type Page, test } from "@playwright/test";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const facility = "00000000-0000-4000-8000-000000000003";
const unit = "00000000-0000-4000-8000-000000000004";
const day = "2026-10-26";
const preferences = `?fecha=${day}&duracion=90`;
const unitPath = (tenant: string) => `/municipios/${tenant}/unidades/${unit}`;
const reviewPath = `${unitPath(first)}/reservar?inicio=2026-10-26T08%3A00%3A00.000Z&fin=2026-10-26T09%3A30%3A00.000Z`;

test.beforeEach(async ({ page }, info) => {
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:00Z"));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const tenant = path.split("/")[4];
    const name = tenant === second ? "Ribasanta" : "Valdeira";
    let body: unknown;
    let status = 200;
    if (path === "/api/me")
      body = {
        accountId: "citizen",
        email: "citizen@demo.test",
        mfaVerified: false,
      };
    else if (path === "/api/me/preferences") body = { locale: null };
    else if (path === "/api/me/theme")
      body = {
        theme: info.project.use.colorScheme === "dark" ? "dark" : "light",
      };
    else if (path === "/api/me/navigation")
      body = {
        municipalities: { items: [], nextCursor: null },
        platform: { operator: false, permissions: [] },
      };
    else if (path === "/api/public/municipalities")
      body = {
        items: [
          { id: first, name: "Valdeira", timeZone: "Europe/Madrid" },
          { id: second, name: "Ribasanta", timeZone: "Europe/Madrid" },
        ],
        nextCursor: null,
      };
    else if (/^\/api\/public\/municipalities\/[^/]+$/.test(path))
      body = { id: tenant, name, timeZone: "Europe/Madrid" };
    else if (path.endsWith("/appearance"))
      body = {
        version: 1,
        lightPalette: "neutral",
        darkPalette: "neutral",
        defaultTheme: "light",
      };
    else if (path.endsWith("/facilities"))
      body = {
        items: [{ id: facility, name: `Sede ${name}`, units: 1 }],
        nextCursor: null,
      };
    else if (path.endsWith("/units"))
      body = {
        items: [
          {
            id: unit,
            name: `Pista ${name}`,
            facilityId: facility,
            minimumMinutes: 60,
            maximumMinutes: tenant === second ? 60 : 120,
          },
        ],
        nextCursor: null,
      };
    else if (path.endsWith(`/units/${unit}`))
      body = {
        id: unit,
        name: `Pista ${name}`,
        facilityId: facility,
        facilityName: `Sede ${name}`,
        timeZone: "Europe/Madrid",
        municipalAdvanceDays: 30,
        cancellationMinutes: 1440,
        bookingPolicyVersion: 1,
        usageRulesVersion: 1,
        calendarVersion: 1,
        calendar: {
          minimumMinutes: 60,
          maximumMinutes: tenant === second ? 60 : 120,
          stepMinutes: 30,
          advanceDays: null,
        },
      };
    else if (path.endsWith("/availability"))
      body = {
        unitId: unit,
        date: url.searchParams.get("date"),
        timeZone: "Europe/Madrid",
        calculatedAt: new Date().toISOString(),
        slots: [],
      };
    else if (path.endsWith("/usage-rules"))
      body = { version: 1, text: "Respeta el horario reservado." };
    else if (path === "/api/public/reservation-command-policy")
      body = { retentionSeconds: 3600, serverTime: "2026-10-24T12:00:00Z" };
    else {
      status = 404;
      body = { error: { code: "NOT_FOUND", message: "No encontrado" } };
    }
    await route.fulfill({ status, json: body });
  });
});

async function returnToMunicipality(page: Page) {
  await page.goto(reviewPath);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /^Revisa (tu|a túa) reserva$/,
    }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: /^Pasos d(e la|a) reserva$/ })
    .getByRole("button", { name: /^Municipio, completado/ })
    .click();
  await expect(page).toHaveURL(`/reservar${preferences}`);
}

async function choosePlace(page: Page, tenant: string, name: string) {
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page).toHaveURL(`/municipios/${tenant}${preferences}`);
  await page.getByRole("link", { name: new RegExp(`^Sede ${name}`) }).click();
  await expect(page).toHaveURL(
    `/municipios/${tenant}/instalaciones/${facility}${preferences}`,
  );
  await page.getByRole("link", { name: new RegExp(`^Pista ${name}`) }).click();
  await expect(page).toHaveURL(`${unitPath(tenant)}${preferences}`);
}

test("review can return through the same municipality without losing date or duration", async ({
  page,
}) => {
  await returnToMunicipality(page);
  await page.reload();
  await choosePlace(page, first, "Valdeira");
  await expect(page.getByRole("combobox", { name: "Duración" })).toContainText(
    "1 h 30 min",
  );
  await expect(
    page.getByRole("button", { name: "Día", exact: true }),
  ).toContainText("26");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Duración" })).toContainText(
    "1 h 30 min",
  );
  await page.goBack();
  await expect(page).toHaveURL(
    `/municipios/${first}/instalaciones/${facility}${preferences}`,
  );
  await page.goForward();
  await expect(page).toHaveURL(`${unitPath(first)}${preferences}`);
  await expect(page.getByRole("combobox", { name: "Duración" })).toContainText(
    "1 h 30 min",
  );
});

test("changing municipality retains preferences but revalidates the selected space", async ({
  page,
}) => {
  await returnToMunicipality(page);
  await choosePlace(page, second, "Ribasanta");
  await expect(page.getByRole("combobox", { name: "Duración" })).toContainText(
    "1 h",
  );
  await expect(
    page.getByText(/(Hemos ajustado tu selección|Axustamos a túa selección)/),
  ).toBeVisible();
  await expect(
    page.getByText(/(No admite|Non admite) reservas de 1 h 30 min/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Día", exact: true }),
  ).toContainText("26");
  await expect(
    page.getByRole("link", { name: /^Cambiar esp(acio|azo)$/ }),
  ).toHaveAttribute(
    "href",
    `/municipios/${second}/instalaciones/${facility}?fecha=${day}&duracion=60`,
  );
});

test("change municipality links carry only preferences and fresh booking discards them", async ({
  page,
}) => {
  await page.goto(
    `/municipios/${first}${preferences}&instalacion=old&unidad=old&inicio=old&fin=old`,
  );
  await page
    .getByRole("link", { name: "Cambiar municipio", exact: true })
    .click();
  await expect(page).toHaveURL(`/reservar${preferences}`);
  await expect(
    page.getByRole("link", { name: "Ribasanta", exact: true }),
  ).toHaveAttribute("href", `/municipios/${second}${preferences}`);
  await page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("link", { name: "Reservar", exact: true })
    .click();
  await expect(page).toHaveURL("/reservar");
  await expect(
    page.getByRole("link", { name: "Valdeira", exact: true }),
  ).toHaveAttribute("href", `/municipios/${first}`);
});

test("an unavailable municipality preserves preferences on the recovery route", async ({
  page,
}) => {
  await page.route(`**/api/public/municipalities/${first}`, (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "No encontrado" } },
    }),
  );
  await page.goto(`/municipios/${first}${preferences}`);
  await page
    .getByRole("link", { name: /^(Elegir|Escoller) municipio$/ })
    .click();
  await expect(page).toHaveURL(`/reservar${preferences}`);
  await expect(
    page.getByRole("link", { name: "Ribasanta", exact: true }),
  ).toHaveAttribute("href", `/municipios/${second}${preferences}`);
});

test("an impossible URL date is explained and never sent to availability", async ({
  page,
}) => {
  const requestedDates: (string | null)[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/availability"))
      requestedDates.push(url.searchParams.get("date"));
  });
  await page.goto(`${unitPath(first)}?fecha=2026-10-32&duracion=90`);
  await expect(
    page.getByText(/(El día elegido no es válido|O día elixido non é válido)/),
  ).toBeVisible();
  await expect(page.getByText(/(No|Non) quedan horarios libres/)).toBeVisible();
  expect(requestedDates.length).toBeGreaterThan(0);
  expect(requestedDates.every((date) => date === "2026-10-24")).toBe(true);
  await expect(
    page.getByRole("link", { name: /^Cambiar esp(acio|azo)$/ }),
  ).toHaveAttribute(
    "href",
    `/municipios/${first}/instalaciones/${facility}?fecha=2026-10-24&duracion=90`,
  );
});

test("municipal appearance retries on re-entry only after its rate-limit deadline", async ({
  page,
}) => {
  await page.route("**/api/me/theme", (route) =>
    route.fulfill({ json: { theme: null } }),
  );
  let attempts = 0;
  let available = false;
  await page.route(
    `**/api/public/municipalities/${first}/appearance`,
    (route) => {
      attempts++;
      return route.fulfill(
        available
          ? {
              json: {
                version: 1,
                lightPalette: "blue",
                darkPalette: "green",
                defaultTheme: "dark",
              },
            }
          : {
              status: 429,
              headers: { "Retry-After": "30" },
              json: { error: { code: "RATE_LIMITED", message: "Espera." } },
            },
      );
    },
  );
  const limited = page.waitForResponse(
    (response) =>
      response.url().endsWith("/appearance") && response.status() === 429,
  );
  await page.goto(`/municipios/${first}`);
  await limited;
  const facilitiesHeading = page.getByRole("heading", {
    level: 1,
    name: /^(Elige una|Escolle unha) instalación$/,
  });
  await expect(facilitiesHeading).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const baseline = attempts;
  const changeMunicipality = page.getByRole("link", {
    name: "Cambiar municipio",
    exact: true,
  });
  await changeMunicipality.click();
  await expect(page).toHaveURL("/reservar");
  const municipalityChoice = page
    .getByRole("region", { name: "Municipios", exact: true })
    .getByRole("link", { name: "Valdeira", exact: true });
  await municipalityChoice.click();
  await expect(facilitiesHeading).toBeVisible();
  expect(attempts).toBe(baseline);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await changeMunicipality.click();
  await expect(page).toHaveURL("/reservar");
  available = true;
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:31Z"));
  await municipalityChoice.click();
  await expect(facilitiesHeading).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "green");
  expect(attempts).toBeGreaterThan(baseline);
});
