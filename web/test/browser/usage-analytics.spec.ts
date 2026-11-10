import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { test } from "./fixtures";

test("the usage analysis follows the indicators' period and is readable as tables", async ({
  page,
}, info) => {
  const f = JSON.parse(
    await readFile("test-results/analytics-fixtures.json", "utf8"),
  )[info.project.name === "desktop" ? 0 : 1];
  await login(page, f.email, f.password);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  await page.goto(`/administracion/${f.tenant}/indicadores`);
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel(/Desde \(incluido\)|Desde \(incluído\)/).fill(from);
  await page.getByLabel(/Hasta \(excluido\)|Ata \(excluído\)/).fill(to);
  await page.getByRole("button", { name: /^Consultar indicadores$/ }).click();
  await expect(
    page.getByRole("region", { name: /Resultado de indicadores/ }),
  ).toBeVisible();

  let requests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/analytics")) requests++;
  });
  await page
    .getByRole("button", { name: /^(Analizar el uso|Analizar o uso)$/ })
    .click();
  const analysis = page.getByRole("region", {
    name: /^(Análisis de uso|Análise de uso)$/,
  });
  await expect(analysis).toBeVisible();
  expect(requests).toBe(1);
  await expect(
    analysis.getByRole("table", {
      name: /^(Porcentaje de los minutos ofertados|Porcentaxe dos minutos ofertados)/,
    }),
  ).toBeVisible();
  for (const day of [/^(lunes|luns)$/, /^(domingo)$/])
    await expect(analysis.getByRole("rowheader", { name: day })).toBeVisible();
  await expect(
    analysis.getByRole("rowheader", { name: "Pista 1", exact: true }),
  ).toBeVisible();
  await expect(analysis.getByText(/reservas canceladas/)).toBeVisible();
  await expect(
    analysis.getByText(/Llegadas registradas|Chegadas rexistradas/).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await analysis.screenshot({
    path: `test-results/usage-analytics-${info.project.name}.png`,
  });
  // Changing the period hides the analysis of the previous one.
  await page
    .getByLabel(/Hasta \(excluido\)|Ata \(excluído\)/)
    .fill(from.replace(/\d{2}$/, "28"));
  await expect(analysis).toHaveCount(0);
});

test("every occupancy step keeps its value readable in light and dark", async ({
  page,
}, info) => {
  const f = JSON.parse(
    await readFile("test-results/analytics-fixtures.json", "utf8"),
  )[info.project.name === "desktop" ? 0 : 1];
  // Only the analysis response is replaced, to show all five steps at once.
  await page.route("**/analytics?**", (route) =>
    route.fulfill({
      json: {
        tenantId: f.tenant,
        unitId: null,
        from: "2030-01-07",
        to: "2030-01-14",
        timeZone: "Europe/Madrid",
        asOf: "2030-01-20T00:00:00.000Z",
        weekdayHours: [0, 10, 40, 60, 90, 100].flatMap((occupancy, n) =>
          [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            hour: 8 + n,
            offeredMinutes: 60,
            reservedMinutes: (60 * occupancy) / 100,
            occupancyPercent: occupancy,
          })),
        ),
        units: [
          {
            unitId: "00000000-0000-4000-8000-000000000001",
            name: "Pista central",
            offeredMinutes: 600,
            reservedMinutes: 450,
            occupancyPercent: 75,
          },
          {
            unitId: "00000000-0000-4000-8000-000000000002",
            name: "Sala",
            offeredMinutes: 600,
            reservedMinutes: 60,
            occupancyPercent: 10,
          },
        ],
        cancellations: {
          reservations: 20,
          cancelled: 4,
          byHolder: 3,
          administrative: 1,
          cancelledPercent: 20,
        },
        leadTime: {
          lessThanOneDay: 5,
          oneToThreeDays: 6,
          threeToSevenDays: 4,
          sevenToFourteenDays: 3,
          fourteenDaysOrMore: 2,
        },
        attendance: { finished: 12, arrived: 9, arrivedPercent: 75 },
      },
    }),
  );
  await login(page, f.email, f.password);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  await page.goto(`/administracion/${f.tenant}/indicadores`);
  await page
    .getByLabel(/Desde \(incluido\)|Desde \(incluído\)/)
    .fill(new Date().toISOString().slice(0, 10));
  await page
    .getByLabel(/Hasta \(excluido\)|Ata \(excluído\)/)
    .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  await page.getByRole("button", { name: /^Consultar indicadores$/ }).click();
  await page
    .getByRole("button", { name: /^(Analizar el uso|Analizar o uso)$/ })
    .click();
  const analysis = page.getByRole("region", {
    name: /^(Análisis de uso|Análise de uso)$/,
  });
  await expect(
    analysis.getByRole("cell", { name: "90 %" }).first(),
  ).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    // Switch the theme the way a person does, through the settings menu.
    await page.getByRole("button", { name: /^(Ajustes|Axustes)$/ }).click();
    const choice = page.getByRole("menuitem", {
      name:
        theme === "light" ? /^(Modo claro)$/ : /^(Modo oscuro|Modo escuro)$/,
    });
    if (await choice.isEnabled()) await choice.click();
    else await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    expect(
      (
        await new AxeBuilder({ page })
          .include("section[aria-label]")
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await analysis.screenshot({
      path: `test-results/usage-analytics-steps-${info.project.name}-${theme}.png`,
    });
  }
});
