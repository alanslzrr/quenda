import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { accessibilityViolations } from "./axe-scan";
import { test } from "./fixtures";

type Fixture = {
  tenant: string;
  email: string;
  password: string;
  secret: string;
  date: string;
};
// Each test owns one account per project: [overview, view, settings, steps].
async function fixture(project: string, slot: number): Promise<Fixture> {
  return JSON.parse(
    await readFile("test-results/analytics-fixtures.json", "utf8"),
  )[slot * 2 + (project === "desktop" ? 0 : 1)];
}
async function signIn(
  page: Page,
  project: string,
  slot: number,
): Promise<Fixture> {
  const f = await fixture(project, slot);
  await login(page, f.email, f.password);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  return f;
}
const day = (offset: number) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const accessible = async (page: Page) =>
  expect(await accessibilityViolations(page)).toEqual([]);
const analyticsSettings = /^(Ajustes de la analítica|Axustes da analítica)$/;
const region = (page: Page, name: RegExp) => page.getByRole("region", { name });

test("the usage of spaces shows highlights, totals, evolution, spaces, demand and compliance at once", async ({
  page,
}, info) => {
  const f = await signIn(page, info.project.name, 0);
  // The former address leads to the new screen.
  await page.goto(`/administracion/${f.tenant}/indicadores`);
  await expect(page).toHaveURL(/\/uso-de-los-espacios$/);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /^(Uso de los espacios|Uso dos espazos)$/,
    }),
  ).toBeVisible();
  await expect(region(page, /^(Resumen|Resumo)$/)).toBeVisible();

  const requested: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/analytics")) requested.push(url.search);
  });
  // The fixture booking starts in three days; the period includes it.
  await page.goto(
    `/administracion/${f.tenant}/uso-de-los-espacios?desde=${day(-3)}&hasta=${day(6)}`,
  );
  const summary = region(page, /^(Resumen|Resumo)$/);
  await expect(summary.getByRole("article")).toHaveCount(5);
  await expect(
    region(page, /^(Lo más destacado|O máis destacado)$/).getByRole("listitem"),
  ).not.toHaveCount(0);
  // The chosen period and the one before it, each asked once.
  await expect
    .poll(() =>
      requested.filter((search) =>
        search.includes(`from=${day(-3)}&to=${day(7)}`),
      ),
    )
    .toHaveLength(1);
  await expect
    .poll(() =>
      requested.filter((search) =>
        search.includes(`from=${day(-13)}&to=${day(-3)}`),
      ),
    )
    .toHaveLength(1);

  const spaces = region(page, /^(Espacios|Espazos)$/);
  await expect(
    spaces.getByRole("rowheader", { name: /^Centro de proba$/ }),
  ).toBeVisible();
  await expect(spaces.getByRole("button", { name: /^Pista 1/ })).toBeVisible();
  await expect(
    region(page, /^(Evolución de la ocupación|Evolución da ocupación)$/),
  ).toBeVisible();
  const demand = region(
    page,
    /^(Cuándo hay más demanda|Cando hai máis demanda)$/,
  );
  for (const weekday of [/^(lunes|luns)$/, /^domingo$/])
    await expect(
      demand.getByRole("rowheader", { name: weekday }),
    ).toBeVisible();
  await expect(
    region(page, /^(¿Se cumplen las reservas\?|Cúmprense as reservas\?)$/),
  ).toBeVisible();
  // Nothing technical on screen: no time zone, no identifiers.
  await expect(page.getByText("Europe/Madrid")).toHaveCount(0);
  await expect(page.getByText(f.tenant)).toHaveCount(0);

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await accessible(page);
  await page.screenshot({
    path: `test-results/usage-analytics-${info.project.name}.png`,
    fullPage: true,
  });

  // Choosing a space from the table narrows the whole screen to it.
  await spaces.getByRole("button", { name: /^Pista 1/ }).click();
  await expect(page).toHaveURL(/espacio=/);
  await expect(
    page.getByRole("combobox", { name: /^(Espacio|Espazo)$/ }),
  ).toHaveValue("Pista 1");
  await expect(spaces.getByRole("button", { name: /^Pista 2/ })).toHaveCount(0);
});

test("personal display choices apply at once, survive a reload and can be reset", async ({
  page,
}, info) => {
  const f = await signIn(page, info.project.name, 1);
  await page.goto(
    `/administracion/${f.tenant}/uso-de-los-espacios?desde=${day(-3)}&hasta=${day(6)}`,
  );
  await expect(region(page, /^(Resumen|Resumo)$/)).toBeVisible();
  await page.getByRole("button", { name: analyticsSettings }).click();
  const dialog = page.getByRole("dialog", {
    name: /^(Ajustes de la analítica|Axustes da analítica)$/,
  });
  await expect(dialog).toBeVisible();
  // Contrast is measured once the opening animation has finished.
  await expect(dialog).toHaveCSS("opacity", "1");
  await accessible(page);
  await dialog
    .getByRole("radio", { name: /^(Tablas|Táboas)$/ })
    .or(dialog.getByRole("tab", { name: /^(Tablas|Táboas)$/ }))
    .or(dialog.getByRole("button", { name: /^(Tablas|Táboas)$/ }))
    .first()
    .click();
  await dialog
    .getByRole("checkbox", {
      name: /^(¿Se cumplen las reservas\?|Cúmprense as reservas\?)$/,
    })
    .click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const evolution = region(
    page,
    /^(Evolución de la ocupación|Evolución da ocupación)$/,
  );
  await expect(
    evolution.getByRole("columnheader", { name: "Horas ofertadas" }),
  ).toBeVisible();
  await expect(
    region(page, /^(¿Se cumplen las reservas\?|Cúmprense as reservas\?)$/),
  ).toHaveCount(0);

  await page.reload();
  await expect(
    evolution.getByRole("columnheader", { name: "Horas ofertadas" }),
  ).toBeVisible();
  await expect(
    region(page, /^(¿Se cumplen las reservas\?|Cúmprense as reservas\?)$/),
  ).toHaveCount(0);

  await page.getByRole("button", { name: analyticsSettings }).click();
  await dialog
    .getByRole("button", {
      name: /^(Restablecer mi vista|Restablecer a miña vista)$/,
    })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    region(page, /^(¿Se cumplen las reservas\?|Cúmprense as reservas\?)$/),
  ).toBeVisible();
  await expect(
    evolution.getByRole("columnheader", { name: "Horas ofertadas" }),
  ).toHaveCount(0);
});

test("the administrator changes the municipal thresholds and every reader sees them", async ({
  page,
}, info) => {
  const f = await signIn(page, info.project.name, 2);
  await page.goto(
    `/administracion/${f.tenant}/uso-de-los-espacios?desde=${day(-3)}&hasta=${day(6)}`,
  );
  const spaces = region(page, /^(Espacios|Espazos)$/);
  await expect(spaces).toBeVisible();
  await page.getByRole("button", { name: analyticsSettings }).click();
  const dialog = page.getByRole("dialog");
  const municipal = dialog.getByRole("tab", {
    name: /^(Para todo el municipio|Para todo o municipio)$/,
  });
  await municipal.click();
  const high = dialog.getByRole("spinbutton", {
    name: /^Alta demanda desde \(%\)/,
  });
  const low = dialog.getByRole("spinbutton", {
    name: /^(Poco uso por debajo de|Pouco uso por debaixo de) \(%\)/,
  });
  // A low threshold above the high one is flagged as it is typed and refused before any request.
  await low.fill("90");
  await low.press("Tab");
  await expect(
    dialog
      .locator("[aria-live=polite]")
      .getByText(/(Poco|Pouco) uso» debe ser menor/),
  ).toBeVisible();
  await dialog
    .getByRole("button", {
      name: /^(Guardar para el municipio|Gardar para o municipio)$/,
    })
    .click();
  // The submitted form reports the same refusal next to the inline warning.
  await expect(
    dialog.getByText(/(Poco|Pouco) uso» debe ser menor/),
  ).toHaveCount(2);
  await low.fill("15");
  await low.press("Tab");
  await high.fill("80");
  await high.press("Tab");
  await dialog
    .getByRole("button", {
      name: /^(Guardar para el municipio|Gardar para o municipio)$/,
    })
    .click();
  await expect(
    dialog.getByText(/^(Cambios guardados|Cambios gardados)\.$/),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(spaces.getByText(/80\s%/).first()).toBeVisible();
  await expect(spaces.getByText(/15\s%/).first()).toBeVisible();
  // Restore the defaults for any later run against the same data.
  await page.getByRole("button", { name: analyticsSettings }).click();
  await municipal.click();
  await high.fill("85");
  await high.press("Tab");
  await low.fill("20");
  await low.press("Tab");
  await dialog
    .getByRole("button", {
      name: /^(Guardar para el municipio|Gardar para o municipio)$/,
    })
    .click();
  await expect(
    dialog.getByText(/^(Cambios guardados|Cambios gardados)\.$/),
  ).toBeVisible();
});

test("every occupancy step keeps its value readable in light and dark", async ({
  page,
}, info) => {
  const f = await fixture(info.project.name, 3);
  const unit = (id: string, name: string, occupancy: number) => ({
    unitId: id,
    name,
    facilityId: "00000000-0000-4000-8000-0000000000f1",
    facilityName: "Pabellón",
    offeredMinutes: 600,
    reservedMinutes: (600 * occupancy) / 100,
    occupancyPercent: occupancy,
    reservations: 10,
    cancelled: 1,
    trend: [occupancy - 10, null, occupancy],
  });
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
        granularity: "day",
        summary: {
          reservations: { CONFIRMADA: 2, CANCELADA: 4, FINALIZADA: 14 },
          reservedMinutes: 510,
          offeredMinutes: 1200,
          occupancyPercent: 42.5,
        },
        series: [0, 1, 2].map((n) => ({
          from: `2030-01-0${7 + n}`,
          to: `2030-01-0${8 + n}`,
          offeredMinutes: n === 1 ? 0 : 600,
          reservedMinutes: n === 1 ? 0 : 300,
          occupancyPercent: n === 1 ? null : 50,
          reservations: 5,
          cancelled: 1,
        })),
        weekdayHours: [
          ...[0, 10, 40, 60, 90, 100].flatMap((occupancy, n) =>
            [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
              weekday,
              hour: 8 + n,
              offeredMinutes: 60,
              reservedMinutes: (60 * occupancy) / 100,
              occupancyPercent: occupancy,
            })),
          ),
          // A Friday booking that runs ten minutes past midnight.
          {
            weekday: 6,
            hour: 0,
            offeredMinutes: 10,
            reservedMinutes: 10,
            occupancyPercent: 100,
          },
        ],
        units: [
          unit("00000000-0000-4000-8000-000000000001", "Pista central", 90),
          unit("00000000-0000-4000-8000-000000000002", "Sala", 10),
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
  await signIn(page, info.project.name, 3);
  await page.goto(`/administracion/${f.tenant}/uso-de-los-espacios`);
  const demand = region(
    page,
    /^(Cuándo hay más demanda|Cando hai máis demanda)$/,
  );
  await expect(
    demand.getByRole("cell", { name: "90 %" }).first(),
  ).toBeVisible();
  // The hour after midnight belongs to Friday night, and an hour barely open is never named the peak.
  await expect(demand.locator('[data-cell="5:24"]')).toHaveText("100 %");
  await expect(demand.locator('[data-cell="6:0"]')).toHaveCount(0);
  await expect(
    demand.getByText(
      /^(La franja con más demanda es el lunes|A franxa con máis demanda é o luns) de 13:00 a 14:00/,
    ),
  ).toBeVisible();
  await demand.locator('[data-cell="5:24"]').focus();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText(
    /(Noche del viernes|Noite do venres) · 00:00–01:00/,
  );
  await expect(demand.locator('[data-cell="5:24"]')).toHaveAttribute(
    "aria-describedby",
    (await tip.getAttribute("id")) ?? "",
  );
  await page.keyboard.press("Home");
  await expect(page.locator(":focus")).toHaveAttribute("data-cell", "5:day");
  await expect(tip).toContainText(/(Ocupación del día|Ocupación do día)/);
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  const spaces = region(page, /^(Espacios|Espazos)$/);
  await expect(spaces.getByText("Alta demanda", { exact: true })).toBeVisible();
  await expect(spaces.getByText(/^(Poco uso|Pouco uso)$/)).toBeVisible();
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
    expect(await accessibilityViolations(page, { include: "main" })).toEqual(
      [],
    );
    await demand.screenshot({
      path: `test-results/usage-analytics-steps-${info.project.name}-${theme}.png`,
    });
  }
});
