import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.use({ timezoneId: "America/Los_Angeles" });

const tenant = "00000000-0000-4000-8000-000000000001";
const facility = "00000000-0000-4000-8000-000000000002";
const unit = "00000000-0000-4000-8000-000000000003";
const emptyFacility = "00000000-0000-4000-8000-000000000004";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    let status = 200;
    if (url.pathname === "/api/me") {
      status = 401;
      body = {
        error: { code: "UNAUTHENTICATED", message: "Sesión requerida" },
      };
    } else if (url.pathname === "/api/public/municipalities")
      body = {
        items: [{ id: tenant, name: "Oleiros", timeZone: "Europe/Madrid" }],
        nextCursor: null,
      };
    else if (url.pathname === `/api/public/municipalities/${tenant}`)
      body = { id: tenant, name: "Oleiros", timeZone: "Europe/Madrid" };
    else if (url.pathname.endsWith("/appearance"))
      body = {
        version: 1,
        lightPalette: "blue",
        darkPalette: "green",
        defaultTheme: "dark",
      };
    else if (url.pathname.endsWith("/booking-durations"))
      body = { durations: [60, 90, 120], hasMore: false, recommended: 60 };
    else if (url.pathname.endsWith("/availability-search"))
      body = {
        items: [
          {
            id: unit,
            name: "Pista 1",
            facilityId: facility,
            facilityName: "Centro deportivo",
            timeZone: "Europe/Madrid",
            slots: [
              {
                start: {
                  utc: "2026-10-22T16:00:00.000Z",
                  local: "2026-10-22T18:00:00",
                },
                end: {
                  utc: "2026-10-22T17:00:00.000Z",
                  local: "2026-10-22T19:00:00",
                },
              },
            ],
          },
        ],
        nextCursor: null,
      };
    else if (url.pathname.endsWith("/facilities"))
      body = {
        items: [
          { id: facility, name: "Centro deportivo", units: 1 },
          { id: emptyFacility, name: "Piscina", units: 0 },
        ],
        nextCursor: null,
      };
    else if (url.pathname.endsWith("/units"))
      body = {
        items: [
          {
            id: unit,
            name: "Pista 1",
            facilityId: facility,
            minimumMinutes: 60,
            maximumMinutes: 120,
          },
        ],
        nextCursor: null,
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
          weekly: [],
          exceptions: [],
        },
      };
    else if (url.pathname.endsWith("/availability"))
      body = {
        unitId: unit,
        date: url.searchParams.get("date"),
        timeZone: "Europe/Madrid",
        calculatedAt: new Date().toISOString(),
        calendarVersion: 1,
        slots: [],
      };
    else {
      status = 404;
      body = { error: { code: "NOT_FOUND", message: "No encontrado" } };
    }
    await route.fulfill({ status, json: body });
  });
});
test("public catalog uses municipal scope and restores Quenda theme on exit", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-10-22T12:00:00Z"));
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /^(¿Dónde quieres|Onde queres) reservar\?$/,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: /^Oleiros/ }).click();
  await expect(page).toHaveURL(new RegExp(`/municipios/${tenant}$`));
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /^(Elige una|Escolle unha) instalación$/,
    }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "green");
  await expect(page.getByRole("link", { name: /^Piscina/ })).toHaveCount(0);
  await expect(
    page.getByText(
      /^(Sin espacios reservables por ahora|Sen espazos reservables polo de agora)$/,
    ),
  ).toBeVisible();
  await page.getByRole("link", { name: /^Centro deportivo/ }).click();
  const unitStep = page.getByRole("heading", {
    level: 1,
    name: /^(Elige un espacio|Escolle un espazo)$/,
  });
  await expect(unitStep).toBeVisible();
  await page.getByRole("link", { name: /^Pista 1/ }).click();
  await expect(
    page.getByRole("heading", { name: "Pista 1", exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: /^Duración$/ }).click();
  await page.getByRole("option", { name: "1 h 30 min", exact: true }).click();
  await expect(page).toHaveURL(/duracion=90/);
  const steps = page.getByRole("navigation", {
    name: /^Pasos d(e la|a) reserva$/,
  });
  await expect(steps.locator('[aria-current="step"]')).toContainText(
    /Día (y|e) hora/,
  );
  await steps
    .getByRole("button", { name: /^Esp(acio|azo), completado/ })
    .click();
  await expect(unitStep).toBeVisible();
  await expect(page).toHaveURL(/duracion=90/);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Pista 1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: /^Duración$/ }),
  ).toContainText("1 h 30 min");
  await expect(page.getByText(/(No|Non) quedan horarios/)).toBeVisible();
  await page.getByRole("button", { name: /^Día \S+,/ }).click();
  await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
  await expect(
    page.getByRole("grid", {
      name:
        info.project.use.locale === "gl-ES" ? "outubro 2026" : "octubre 2026",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: info.outputPath("availability.png"),
    fullPage: true,
  });
  const brand = page.getByRole("banner").getByRole("link", { name: /Oleiros/ });
  await expect(brand).toHaveAccessibleName(/^(quenda\s*)?Oleiros$/);
  await brand.click();
  await expect(page).toHaveURL(new RegExp(`/municipios/${tenant}$`));
  await page.getByRole("link", { name: "Acceder", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "neutral");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});
test("a favourite municipality becomes the booking entry without hiding the change", async ({
  page,
}) => {
  await page.goto("/reservar");
  const reserve = page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("link", { name: "Reservar", exact: true });
  await expect(reserve).toHaveAttribute("href", "/reservar");
  await page
    .getByRole("button", { name: "Marcar Oleiros como favorito", exact: true })
    .click();
  const toggle = page.getByRole("button", {
    name: "Quitar Oleiros de favoritos",
    exact: true,
  });
  await expect(toggle).toBeFocused();
  await expect(
    page.getByRole("heading", { name: /^(Tu|O teu) municipio favorito$/ }),
  ).toBeVisible();
  await expect(reserve).toHaveAttribute("href", `/municipios/${tenant}`);
  await page.reload();
  await reserve.click();
  await expect(page).toHaveURL(new RegExp(`/municipios/${tenant}$`));
  await page
    .getByRole("link", { name: "Cambiar municipio", exact: true })
    .click();
  await expect(page).toHaveURL(/\/reservar$/);
});
test("a municipality without bookable spaces explains the dead end", async ({
  page,
}) => {
  await page.route("**/api/public/municipalities/*/facilities*", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto(`/municipios/${tenant}`);
  await expect(
    page.getByText(/Oleiros (todavía no ofrece|aínda non ofrece)/),
  ).toBeVisible();
  await page
    .getByRole("link", { name: /^(Elegir otro|Escoller outro) municipio$/ })
    .click();
  await expect(page).toHaveURL(/\/reservar$/);
});
test("settings preserve explicit language and theme across reloads", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Ajustes|Axustes/ }).click();
  await page.getByRole("menuitem", { name: "Castellano", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Modo oscuro", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: info.outputPath("directory-dark.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("catalog failure does not appear as an empty municipality list", async ({
  page,
}) => {
  await page.route("**/api/public/municipalities", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: "UNAVAILABLE", message: "Servicio no disponible" },
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("Servicio no disponible")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Reintentar|Tentar de novo/ }),
  ).toBeVisible();
});
test("sign-in has localized controls and accessible keyboard navigation", async ({
  page,
}, info) => {
  await page.goto("/acceso");
  await expect(
    page.getByLabel("Correo electrónico", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Correo electrónico", { exact: true })
    .fill("ana@example.test");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel(/^(Contraseña|Contrasinal)$/)).toBeFocused();
  await page.getByRole("button", { name: /Mostrar contr/ }).click();
  await expect(page.getByLabel(/^(Contraseña|Contrasinal)$/)).toHaveAttribute(
    "type",
    "text",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: info.outputPath("sign-in.png"),
    fullPage: true,
  });
});

test("public navigation and date controls fit a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/municipios/${tenant}/unidades/${unit}`);
  await expect(
    page.getByRole("heading", { name: "Pista 1", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("current-day marker follows the municipality rather than browser timezone", async ({
  page,
}, info) => {
  await page.clock.setFixedTime(new Date("2026-10-22T22:30:00Z"));
  await page.goto(`/municipios/${tenant}/unidades/${unit}`);
  await page.getByRole("button", { name: /^Día \S+,/ }).click();
  await expect(
    page.getByRole("gridcell", {
      name:
        info.project.use.locale === "gl-ES"
          ? "venres, 23 de outubro de 2026"
          : "viernes, 23 de octubre de 2026",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "date");
});
