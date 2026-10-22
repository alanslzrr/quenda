import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const facility = "00000000-0000-4000-8000-000000000002";
const unit = "00000000-0000-4000-8000-000000000003";
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
    else if (url.pathname.endsWith("/facilities"))
      body = {
        items: [{ id: facility, name: "Centro deportivo" }],
        nextCursor: null,
      };
    else if (url.pathname.endsWith("/units"))
      body = { items: [{ id: unit, name: "Pista 1" }], nextCursor: null };
    else if (url.pathname.endsWith(`/units/${unit}`))
      body = {
        id: unit,
        name: "Pista 1",
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
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /Reserva instala/,
  );
  await page.getByRole("link", { name: /Oleiros/ }).click();
  await expect(
    page.getByRole("heading", { name: "Oleiros", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "green");
  await page.clock.setFixedTime(new Date("2026-10-22T12:00:00Z"));
  await page.getByRole("link", { name: "Pista 1", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Pista 1", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/(No hay|Non hai) fran/)).toBeVisible();
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
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: info.outputPath("availability.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Quenda, inicio" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "neutral");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
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
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
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
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
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
