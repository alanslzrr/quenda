import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { pickDate, pickMonth } from "./date-fields";
import { test } from "./fixtures";
import { selectValue } from "./select-value";

const tenant = "00000000-0000-4000-8000-000000000001",
  unit = "00000000-0000-4000-8000-000000000002",
  agreement = "00000000-0000-4000-8000-000000000003";
const view = `/administracion/${tenant}`,
  base = `/api/municipalities/${tenant}`;
async function fixture(
  page: Page,
  administrator = true,
  permissions: { operation: string; unitId: string | null }[] = [],
) {
  await page.route("**/api/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    let body: unknown = { items: [], nextCursor: null };
    if (path === "/api/me")
      body = {
        accountId: "reporting-actor",
        email: "actor@example.test",
        mfaVerified: true,
      };
    if (path === "/api/me/preferences") body = { locale: null };
    if (path === "/api/me/theme")
      body = {
        theme: (page.viewportSize()?.width ?? 1000) < 500 ? "dark" : "light",
      };
    if (path === "/api/me/navigation")
      body = {
        municipalities: {
          items: [{ id: tenant, name: "Oleiros", administrator, permissions }],
          nextCursor: null,
        },
        platform: { operator: false, permissions: [] },
      };
    if (path === `${base}/agreements` || path === `${base}/report-agreements`)
      body = {
        items: [
          { agreementId: agreement, name: "Convenio de pruebas", version: 1 },
        ],
        nextCursor: null,
      };
    if (path === `${base}/profiles`)
      body = {
        items: [
          {
            accountId: "recipient",
            accountLabel: {
              name: "Persona destinataria",
              email: "recipient@demo.test",
            },
          },
        ],
        nextCursor: null,
      };
    if (path.endsWith("command-policy"))
      body = { serverTime: new Date().toISOString(), retentionSeconds: 3600 };
    await r.fulfill({ json: body });
  });
}
async function period(page: Page, from = "2024-03-01", to = "2024-04-01") {
  await pickDate(page, /Desde \(incluido\)|Desde \(incluído\)/, from);
  await pickDate(page, /Hasta \(excluido\)|Ata \(excluído\)/, to);
}
async function select(
  page: Page,
  label: string | RegExp,
  option: string | RegExp,
) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
const settings = {
  version: 1,
  highDemandPercent: 85,
  lowUsePercent: 20,
  defaultPeriod: "THIS_MONTH",
};
const analytics = (offered: number) => ({
  tenantId: tenant,
  unitId: null,
  from: "2024-03-01",
  to: "2024-04-01",
  timeZone: "Europe/Madrid",
  asOf: "2024-04-02T00:00:00Z",
  granularity: "day",
  summary: {
    reservations: { CONFIRMADA: 0, CANCELADA: 0, FINALIZADA: 0 },
    reservedMinutes: 0,
    offeredMinutes: offered,
    occupancyPercent: offered ? 0 : null,
  },
  series: [],
  weekdayHours: [],
  units: [],
  cancellations: {
    reservations: 0,
    cancelled: 0,
    byHolder: 0,
    administrative: 0,
    cancelledPercent: null,
  },
  leadTime: {
    lessThanOneDay: 0,
    oneToThreeDays: 0,
    threeToSevenDays: 0,
    sevenToFourteenDays: 0,
    fourteenDaysOrMore: 0,
  },
  attendance: { finished: 0, arrived: 0, arrivedPercent: null },
});
async function analyticsRoutes(page: Page) {
  await page.route(`**${base}/analytics/settings`, (r) =>
    r.fulfill({ json: settings }),
  );
  await page.route(`**${base}/analytics/units`, (r) =>
    r.fulfill({
      json: {
        units: [
          {
            unitId: unit,
            name: "Pista autorizada",
            facilityId: agreement,
            facilityName: "Pabellón",
            withdrawn: false,
          },
        ],
        truncated: false,
      },
    }),
  );
}
test("unit grants never authorize municipal totals or exports with mismatched reading scopes", async ({
  page,
}) => {
  await fixture(page, false, [
    { operation: "REPORT_READ", unitId: unit },
    { operation: "DATA_EXPORT", unitId: unit },
    { operation: "RESERVATION_READ", unitId: agreement },
  ]);
  await analyticsRoutes(page);
  const requested: URL[] = [];
  await page.route("**/analytics?**", async (r) => {
    requested.push(new URL(r.request().url()));
    await r.fulfill({ json: { ...analytics(60), unitId: unit } });
  });
  await page.goto(`${view}/uso-de-los-espacios`);
  await expect(
    page.getByRole("region", { name: /^(Resumen|Resumo)$/ }),
  ).toBeVisible();
  await expect.poll(() => requested.length).toBeGreaterThan(0);
  // Only the authorised space is ever analysed, by name, never the municipality.
  for (const url of requested) {
    expect(url.pathname).toBe(`${base}/analytics`);
    expect(url.searchParams.get("unitId")).toBe(unit);
  }
  const space = page.getByRole("combobox", { name: /^(Espacio|Espazo)$/ });
  await expect(space).toHaveValue("Pista autorizada");
  await space.click();
  await expect(
    page.getByRole("option", { name: /Todos los espacios|Todos os espazos/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  const calls = requested.length;
  for (const section of ["exportaciones", "informes", "informes/revision"]) {
    await page.goto(`${view}/${section}`);
    await expect(
      page.getByText(/No tienes permiso|Non tes permiso/),
    ).toBeVisible();
  }
  expect(requested.length).toBe(calls);
});
test("zero offer is not applicable and invalid periods never become requests", async ({
  page,
}) => {
  await fixture(page);
  await analyticsRoutes(page);
  const requested: URL[] = [];
  await page.route("**/analytics?**", async (r) => {
    requested.push(new URL(r.request().url()));
    await r.fulfill({ json: analytics(0) });
  });
  // More than 366 days: the screen falls back to its default period.
  await page.goto(
    `${view}/uso-de-los-espacios?desde=2024-01-01&hasta=2025-01-05`,
  );
  await expect(
    page.getByText(/^(Sin horario ofertado|Sen horario ofertado)$/),
  ).toBeVisible();
  await expect(
    page.getByText(
      /No hubo horario ofertado ni reservas en este periodo|Non houbo horario ofertado nin reservas neste período/,
    ),
  ).toBeVisible();
  await expect.poll(() => requested.length).toBeGreaterThan(0);
  for (const url of requested) {
    expect(url.searchParams.get("from")).not.toBe("2024-01-01");
    const days =
      (Date.parse(url.searchParams.get("to") ?? "") -
        Date.parse(url.searchParams.get("from") ?? "")) /
      86400000;
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThanOrEqual(366);
  }
});
test("exports reject MFA and size failures without files and retain exact v3 acceptance evidence on download", async ({
  page,
}) => {
  await fixture(page);
  let status = 403,
    downloads = 0;
  const document = {
    format: "quenda.reservations",
    version: 3,
    tenantId: tenant,
    unitId: unit,
    generatedAt: "2024-04-02T00:00:00Z",
    period: {
      from: "2024-03-01",
      to: "2024-04-01",
      timeZone: "Europe/Madrid",
      selection: "overlap",
    },
    entities: ["reservations"],
    reservations: [
      {
        id: agreement,
        unitId: unit,
        usageRulesUnitId: null,
        usageRulesVersion: null,
        rulesAcceptedAt: null,
        pendingUsageRulesVersion: 2,
        pendingUsageRulesText: "Normas nuevas",
      },
    ],
  };
  await page.route("**/exports/reservations?**", async (r) => {
    const url = new URL(r.request().url());
    expect(url.searchParams.get("unitId")).toBe(unit);
    await r.fulfill(
      status === 200
        ? { json: document }
        : {
            status,
            json: {
              error: {
                code:
                  status === 403
                    ? "REAUTHENTICATION_REQUIRED"
                    : "INVALID_INPUT",
                message:
                  status === 403
                    ? "Verifica MFA"
                    : "Reduce el periodo o elige una unidad",
              },
            },
          },
    );
  });
  page.on("download", () => downloads++);
  await page.goto(`${view}/exportaciones`);
  await select(page, "Ámbito", /Una unidad reservable|Unha unidade reservable/);
  await page
    .getByLabel(/Identificador de unidad|Identificador de unidade/)
    .fill(unit);
  await period(page);
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  await page
    .getByRole("button", { name: "Descargar datos completos", exact: true })
    .click();
  await expect(page.getByText("Verifica MFA", { exact: true })).toBeVisible();
  expect(downloads).toBe(0);
  status = 400;
  await page
    .getByRole("button", { name: "Descargar datos completos", exact: true })
    .click();
  await expect(
    page.getByText("Reduce el periodo o elige una unidad", { exact: true }),
  ).toBeVisible();
  expect(downloads).toBe(0);
  status = 200;
  const ready = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Descargar datos completos", exact: true })
    .click();
  const file = await ready;
  expect(file.suggestedFilename()).toBe("quenda-reservations-v3.json");
  expect(
    JSON.parse(await readFile((await file.path()) as string, "utf8")),
  ).toEqual(document);
  expect(downloads).toBe(1);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    ),
  ).not.toContain("Normas nuevas");
});
test("monthly delivery requires an explicit action and suppression renders no metrics or inferred cause", async ({
  page,
}) => {
  await fixture(page);
  let calls = 0,
    suppressed = false;
  await page.route(
    `**${base}/agreements/${agreement}/reports/2024-03`,
    async (r) => {
      calls++;
      expect(new URL(r.request().url()).search).toBe("");
      await r.fulfill({
        json: suppressed
          ? { status: "NOT_PUBLISHABLE" }
          : {
              status: "PUBLISHABLE",
              agreementId: agreement,
              month: "2024-03",
              revision: 2,
              cutoff: "2024-04-02T00:00:00Z",
              controlVersion: 1,
              reservations: 20,
              reservedMinutes: 1200,
            },
      });
    },
  );
  await page.goto(`${view}/informes`);
  expect(calls).toBe(0);
  await selectValue(page, "agreementId", "Convenio", agreement);
  await pickMonth(page, "Mes publicado", "2024-03");
  await page
    .getByRole("button", { name: "Consultar informe", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Informe autorizado", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(calls).toBe(1);
  suppressed = true;
  await page
    .getByRole("button", { name: "Consultar informe", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /No publicable|Non publicable/ }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(calls).toBe(2);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /No publicable|Non publicable/ }),
  ).toHaveCount(0);
  expect(calls).toBe(2);
});
test("report readers choose the agreement by name without the administrator listing", async ({
  page,
}) => {
  await fixture(page, false, [{ operation: "REPORT_READ", unitId: null }]);
  const listings: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `${base}/agreements` || path === `${base}/report-agreements`)
      listings.push(path);
  });
  await page.route(
    `**${base}/agreements/${agreement}/reports/2024-03`,
    async (r) => r.fulfill({ json: { status: "NOT_PUBLISHABLE" } }),
  );
  await page.goto(`${view}/informes`);
  await expect(
    page.getByLabel(/Identificador (del convenio|do convenio)/),
  ).toHaveCount(0);
  await selectValue(page, "agreementId", "Convenio", agreement);
  await expect(
    page.getByRole("combobox", { name: "Convenio", exact: true }),
  ).toContainText("Convenio de pruebas");
  await pickMonth(page, "Mes publicado", "2024-03");
  await page
    .getByRole("button", { name: "Consultar informe", exact: true })
    .click();
  await expect(
    page.getByText("Convenio de pruebas · 2024-03", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(agreement, { exact: true })).toBeHidden();
  expect(listings).not.toContain(`${base}/agreements`);
  expect(listings).toContain(`${base}/report-agreements`);
});
async function context(page: Page, revision = "2") {
  await page.route("**/review-options", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            month: "2024-03",
            revision: Number(revision),
            participants: [{ id: tenant, name: "Oleiros" }],
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto(`${view}/informes/revision`);
  await selectValue(page, "agreementId", "Convenio", agreement);
  await selectValue(page, "month", "Mes preparado", "2024-03");
  await selectValue(
    page,
    "recipientAccountId",
    /Persona destinataria|Persoa destinataria/,
    "recipient",
  );
  await page
    .getByRole("button", {
      name: "Consultar contexto de revisión",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: /Contexto de evaluación|Contexto de avaliación/,
    }),
  ).toBeVisible();
}
async function fillReview(page: Page, correction = true) {
  await select(page, "Decisión", "Favorable");
  for (const label of [
    /Referencia de información auxiliar/,
    /Referencia de datos propios/,
    /Referencia de entregas anteriores/,
    ...(correction ? [/Referencia del riesgo|Referencia do risco/] : []),
  ])
    await page.getByLabel(label).fill("Revisión documentada");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
}
async function reviewContext(page: Page) {
  await page.route("**/review-context?**", async (r) => {
    const revision = Number(
      new URL(r.request().url()).searchParams.get("revision"),
    );
    await r.fulfill({
      json: {
        agreementId: agreement,
        month: "2024-03",
        revision,
        recipientTenantId: tenant,
        recipientAccountId: "recipient",
        historyDigest: "a".repeat(64),
      },
    });
  });
}
test("risk review binds exact context and requires correction evidence without replacing a stale digest", async ({
  page,
}) => {
  await fixture(page);
  await reviewContext(page);
  let calls = 0,
    body: Record<string, unknown> | undefined;
  await page.route("**/reports/2024-03/reviews", async (r) => {
    calls++;
    body = r.request().postDataJSON();
    await r.fulfill({
      status: 409,
      json: { error: { code: "CONFLICT", message: "El contexto ha cambiado" } },
    });
  });
  await context(page);
  await expect(
    page.getByLabel(/Referencia del riesgo|Referencia do risco/),
  ).toBeVisible();
  await fillReview(page);
  await page
    .getByRole("button", {
      name: /Registrar evaluación|Rexistrar avaliación/,
      exact: true,
    })
    .click();
  await expect(
    page.getByText("El contexto ha cambiado", { exact: true }),
  ).toBeVisible();
  expect(calls).toBe(1);
  expect(body).toMatchObject({
    revision: 2,
    recipientAccountId: "recipient",
    recipientTenantId: tenant,
    expectedHistoryDigest: "a".repeat(64),
    correctionReference: "Revisión documentada",
    decision: "APPROVE",
  });
  await page
    .getByRole("button", { name: "Consultar otro contexto" })
    .or(page.getByRole("button", { name: "Consultar outro contexto" }))
    .click();
  await expect(
    page.getByRole("combobox", { name: "Decisión", exact: true }),
  ).toHaveCount(0);
  expect(calls).toBe(1);
});
test("lost review confirmation replays the original key and context only on explicit recovery", async ({
  page,
}) => {
  await fixture(page);
  await reviewContext(page);
  const requests: { key: string | undefined; body: string | null }[] = [];
  await page.route("**/reports/2024-03/reviews", async (r) => {
    requests.push({
      key: r.request().headers()["idempotency-key"],
      body: r.request().postData(),
    });
    if (requests.length === 1) await r.abort("failed");
    else
      await r.fulfill({
        json: {
          reviewId: "7",
          agreementId: agreement,
          month: "2024-03",
          revision: 1,
          decision: "APPROVE",
        },
      });
  });
  await context(page, "1");
  await expect(
    page.getByLabel(/Referencia del riesgo|Referencia do risco/),
  ).toHaveCount(0);
  await fillReview(page, false);
  await page
    .getByRole("button", {
      name: /Registrar evaluación|Rexistrar avaliación/,
      exact: true,
    })
    .click();
  await page
    .getByRole("link", {
      name: /Hay una operación sin resultado|Hai unha operación sen resultado/,
    })
    .click();
  await expect(page).toHaveURL(/\/reservas\/recuperacion$/);
  expect(requests).toHaveLength(1);
  await page.reload();
  await page
    .getByRole("button", {
      name: /Comprobar con la misma solicitud|Comprobar coa mesma solicitude/,
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(`${view}/informes/revision`);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(JSON.parse(requests[1].body as string).correctionReference).toBeNull();
});
