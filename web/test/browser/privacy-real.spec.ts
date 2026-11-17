import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { accessibilityViolations } from "./axe-scan";
import { test } from "./fixtures";

async function select(
  page: Page,
  label: string | RegExp,
  option: string | RegExp,
) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
/** Administrators may pick a linked person; these tests type the exact reference. */
async function exact(page: Page) {
  const mode = page.getByRole("combobox", {
    name: /Cómo indicar la cuenta|Como indicar a conta/,
  });
  if (!(await mode.count())) return;
  await mode.click();
  await page
    .getByRole("option", {
      name: /Escribir el identificador exacto|Escribir o identificador exacto/,
    })
    .click();
}
async function authorize(page: Page) {
  await page
    .getByLabel("Referencia de autorización", { exact: true })
    .fill("Autorización sintética");
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Actuación sintética de prueba");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
}
async function download(page: Page, view: string, subject: string) {
  await page.goto(`${view}/descarga`);
  await exact(page);
  await page.getByLabel(/Identificador (de la cuenta|da conta)/).fill(subject);
  await authorize(page);
  const finished = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Preparar copia", exact: true })
    .click();
  const file = await finished;
  const path = await file.path();
  expect(path).not.toBeNull();
  return JSON.parse(await readFile(path as string, "utf8"));
}
async function action(
  page: Page,
  view: string,
  subject: string,
  block = false,
) {
  await page.goto(`${view}/actuacion`);
  await select(
    page,
    "Familia de datos",
    /Perfiles municipales|Perfís municipais/,
  );
  await exact(page);
  await page
    .getByLabel(/Referencia (del registro|do rexistro)/, { exact: true })
    .fill(subject);
  await select(
    page,
    "Actuación",
    block
      ? /Bloquear (y conservar restringido|e conservar restrinxido)/
      : "Suprimir",
  );
  if (block) await page.getByLabel(/Duración autorizada/).fill("4");
  await authorize(page);
  await page
    .getByRole("button", { name: /Ejecutar actuación|Executar actuación/ })
    .click();
}
test("authorized privacy staff manages policies, holds, scoped copies and all individual outcomes through real APIs", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const f = JSON.parse(
    await readFile("test-results/privacy-fixtures.json", "utf8"),
  )[info.project.name === "desktop" ? 0 : 1];
  const view = `/administracion/${f.tenant}/privacidad`;
  await login(page, f.email, f.password);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  expect(
    (
      await page.request.put("/api/me/theme", {
        data: { theme: info.project.name === "desktop" ? "light" : "dark" },
        headers: { Origin: "http://127.0.0.1:5173" },
      })
    ).status(),
  ).toBe(200);
  const copy = await download(page, view, f.subject);
  expect(copy.scope).toEqual({ kind: "MUNICIPAL", tenantId: f.tenant });
  expect(copy.completeness.status).toBe("PARTIAL");
  expect(copy.completeness.legalAccessResponseComplete).toBe(false);
  expect(
    copy.records.every((r: { tenantId: string }) => r.tenantId === f.tenant),
  ).toBe(true);
  await page.goto(`${view}/aprobar`);
  await select(page, "Familia de datos", /Comunicaciones|Comunicacións/);
  await page
    .getByLabel(/Plazo de conservación|Prazo de conservación/)
    .fill("7");
  await select(
    page,
    "Actuación",
    /Bloquear (y conservar restringido|e conservar restrinxido)/,
  );
  await page.getByLabel(/Duración autorizada/).fill("3");
  await page
    .getByLabel(/Finalidad|Finalidade/, { exact: true })
    .fill("Comunicaciones sintéticas");
  await page
    .getByLabel(/Referencia (del responsable|do responsable)/)
    .fill("Responsable de prueba");
  await page
    .getByLabel("Referencia de aprobación")
    .fill("Aprobación sintética");
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Ensayo de conservación");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  await page
    .getByRole("button", {
      name: /Registrar política|Rexistrar política/,
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText(
    /Política registrada|Política rexistrada/,
  );
  await page.getByRole("link", { name: "Políticas", exact: true }).click();
  await expect(
    page.getByText("Comunicaciones sintéticas", { exact: true }),
  ).toBeVisible();
  await page
    .locator("section")
    .filter({ hasNot: page.getByRole("navigation") })
    .filter({
      has: page.getByText("Comunicaciones sintéticas", { exact: true }),
      hasNot: page.getByRole("navigation"),
    })
    .getByRole("link", { name: "Retirar política", exact: true })
    .click();
  await page.getByLabel("Motivo", { exact: true }).fill("Retirada sintética");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  await page
    .getByRole("button", { name: "Retirar política", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    /Retirada registrada|Retirada rexistrada/,
  );
  await page.goto(`${view}/registrar-excepcion`);
  await select(
    page,
    "Familia de datos",
    /Perfiles municipales|Perfís municipais/,
  );
  await select(page, /Alcance (de la excepción|da excepción)/, "Un interesado");
  // The fixture's privacy staff also administers the municipality, so it
  // picks the subject among the people linked to it.
  await select(
    page,
    /Persona vinculada|Persoa vinculada/,
    `${f.subject} · ${f.subject}@example.test`,
  );
  await authorize(page);
  await page
    .getByRole("button", {
      name: /Registrar excepción|Rexistrar excepción/,
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText(
    /Excepción registrada|Excepción rexistrada/,
  );
  await action(page, view, f.subject);
  await expect(page.getByRole("status")).toContainText(
    /Conflicto: actuación no aplicada|Conflito: actuación non aplicada/,
  );
  await page
    .getByRole("link", {
      name: /Excepciones y conflictos|Excepcións e conflitos/,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: /Excepciones activas|Excepcións activas/,
    }),
  ).toBeVisible();
  // The scan waits for the route entrance fade, not its intermediate colours.
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.screenshot({
    path: `test-results/privacy-holds-${info.project.name}.png`,
    fullPage: true,
  });
  await page
    .locator("section")
    .filter({ hasNot: page.getByRole("navigation") })
    .filter({
      has: page.getByText(f.subject, { exact: true }),
    })
    .getByRole("link", { name: "Levantar excepción", exact: true })
    .click();
  await authorize(page);
  await page
    .getByRole("button", { name: "Levantar excepción", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    /Levantamiento registrado|Levantamento rexistrado/,
  );
  await action(page, view, f.subject, true);
  await expect(
    page.getByRole("heading", { name: "Actuación aplicada", exact: true }),
  ).toBeVisible();
  await action(page, view, f.subject);
  await expect(page.getByRole("status")).toContainText(/ausente/);
  const blocked = await download(page, view, f.subject);
  expect(blocked.completeness.restrictedCategories).toContainEqual({
    category: "MUNICIPAL_PROFILE",
    tenantId: f.tenant,
  });
  const global = await download(page, "/plataforma/privacidad", f.accountId);
  expect(global.scope).toEqual({ kind: "GLOBAL", tenantId: null });
  expect(
    global.records.every((r: { tenantId: unknown }) => r.tenantId === null),
  ).toBe(true);
});
