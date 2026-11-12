import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { test } from "./fixtures";
import { selectValue } from "./select-value";

async function visibleNumbers(page: Page) {
  const reduced = await page.evaluate(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const counters = page.getByRole("article").locator('[class*="counter"]');
  for (const counter of await counters.all()) {
    // Reduced motion must show final digits even before entering the viewport.
    if (!reduced) await counter.scrollIntoViewIfNeeded();
    const expected = await counter.locator('[class*="srOnly"]').textContent();
    await expect
      .poll(async () =>
        (await counter.locator('[aria-hidden="true"]').innerText()).replace(
          /\s/g,
          "",
        ),
      )
      .toBe(expected?.replace(/\s/g, ""));
  }
}

async function signin(
  page: Page,
  f: { email: string; password: string; secret: string },
) {
  await login(page, f.email, f.password);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
}
async function report(
  page: Page,
  tenant: string,
  agreement: string,
  month: string,
) {
  await page.goto(`/administracion/${tenant}/informes`);
  const selector = page.getByRole("combobox", {
    name: "Convenio",
    exact: true,
  });
  const reference = page.getByLabel(/Identificador (del convenio|do convenio)/);
  await expect(selector.or(reference)).toBeVisible();
  if (await selector.count())
    await selectValue(page, "agreementId", "Convenio", agreement);
  else
    await page
      .getByLabel(/Identificador (del convenio|do convenio)/)
      .fill(agreement);
  await page.getByLabel("Mes publicado").fill(month);
  const submit = page.getByRole("button", {
    name: "Consultar informe",
    exact: true,
  });
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agreements/${agreement}/reports/${month}`) &&
      response.request().method() === "GET",
  );
  await submit.click();
  if ((await response).status() === 429) {
    // The real per-account limiter remains enabled. Respect its visible cooldown
    // and explicitly resubmit; never replay a review or a business mutation.
    await expect(page.getByRole("timer")).toBeVisible();
    await expect(page.getByRole("timer")).toHaveCount(0, { timeout: 65000 });
    await submit.click();
  }
}
async function review(
  page: Page,
  tenant: string,
  agreement: string,
  month: string,
  recipientTenant: string,
  account: string,
  decision = "Favorable",
) {
  await page.goto(`/administracion/${tenant}/informes/revision`);
  await selectValue(page, "agreementId", "Convenio", agreement);
  await selectValue(page, "month", "Mes preparado", month);
  await selectValue(
    page,
    "recipientTenantId",
    "Municipio destinatario",
    recipientTenant,
  );
  if (recipientTenant === tenant)
    await selectValue(
      page,
      "recipientAccountId",
      /Persona destinataria|Persoa destinataria/,
      account,
    );
  else
    await page
      .getByLabel(/Referencia de (cuenta|conta) facilitada/)
      .fill(account);
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
  await page.getByRole("combobox", { name: "Decisión", exact: true }).click();
  await page.getByRole("option", { name: decision, exact: true }).click();
  for (const label of [
    /Referencia de información auxiliar/,
    /Referencia de datos propios/,
    /Referencia de entregas anteriores/,
  ])
    await page.getByLabel(label).fill("Evaluación sintética verificada");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  await page
    .getByRole("button", {
      name: /Registrar evaluación|Rexistrar avaliación/,
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText(
    /Revisión registrada|Revisión rexistrada/,
  );
}
test("real reporting preserves municipal exports and jointly reviewed monthly publication", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120000);
  const index = info.project.name === "desktop" ? 0 : 1;
  const f = JSON.parse(
    await readFile("test-results/reporting-fixtures.json", "utf8"),
  )[index];
  await signin(page, f.a);
  expect(
    (
      await page.request.put("/api/me/theme", {
        data: { theme: index === 0 ? "light" : "dark" },
        headers: { Origin: "http://127.0.0.1:5173" },
      })
    ).status(),
  ).toBe(200);
  const base = `/administracion/${f.a.tenant}`;
  const end = new Date(`${f.a.date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  // The usage screen has its own specs with real data; this account keeps its
  // request budget for exports and the monthly publication.
  await page.goto(`${base}/exportaciones`);
  await page.getByLabel(/Desde \(incluido\)|Desde \(incluído\)/).fill(f.a.date);
  await page
    .getByLabel(/Hasta \(excluido\)|Ata \(excluído\)/)
    .fill(end.toISOString().slice(0, 10));
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Descargar datos completos", exact: true })
    .click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe("quenda-reservations-v3.json");
  const path = await file.path();
  expect(path).not.toBeNull();
  const data = JSON.parse(await readFile(path as string, "utf8"));
  expect(data.format).toBe("quenda.reservations");
  expect(data.version).toBe(3);
  expect(data.tenantId).toBe(f.a.tenant);
  expect(data.reservations).toHaveLength(1);
  expect(data.reservations[0].id).toBe(f.a.reservationId);
  expect(data.reservations[0].usageRulesUnitId).toBe(f.a.unit);
  expect(data.reservations[0].rulesAcceptedAt).not.toBeNull();
  await report(page, f.a.tenant, f.agreement, f.month);
  await expect(
    page.getByRole("heading", { name: /No publicable|Non publicable/ }),
  ).toBeVisible();
  await review(
    page,
    f.a.tenant,
    f.agreement,
    f.month,
    f.a.tenant,
    f.a.accountId,
  );
  await report(page, f.a.tenant, f.agreement, f.month);
  await expect(
    page.getByRole("heading", { name: /No publicable|Non publicable/ }),
  ).toBeVisible();
  const other = await browser.newContext({
    baseURL: "http://127.0.0.1:5173",
    locale: "es-ES",
    extraHTTPHeaders: {
      "x-quenda-test-client": `2001:db8:801:${index + 1}::1`,
    },
  });
  try {
    const reviewer = await other.newPage();
    await signin(reviewer, f.b);
    await review(
      reviewer,
      f.b.tenant,
      f.agreement,
      f.month,
      f.a.tenant,
      f.a.accountId,
    );
    await report(page, f.a.tenant, f.agreement, f.month);
    await expect(
      page.getByRole("heading", { name: "Informe autorizado", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("20", { exact: true })).toHaveCount(1);
    await visibleNumbers(page);
    await page.screenshot({
      path: `test-results/reporting-monthly-${info.project.name}.png`,
      fullPage: true,
    });
    await review(
      reviewer,
      f.b.tenant,
      f.agreement,
      f.month,
      f.a.tenant,
      f.a.accountId,
      "Desfavorable",
    );
    await report(page, f.a.tenant, f.agreement, f.month);
    await expect(
      page.getByRole("heading", { name: /No publicable|Non publicable/ }),
    ).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
  } finally {
    await other.close();
  }
});
