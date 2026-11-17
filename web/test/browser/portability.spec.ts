import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { accessibilityViolations } from "./axe-scan";
import { pickDate } from "./date-fields";
import { test } from "./fixtures";

async function enter(page: Page, index: number) {
  const fixtures = JSON.parse(
    await readFile("test-results/municipal-fixtures.json", "utf8"),
  );
  const f = fixtures.find(
    (item: { email: string }) =>
      item.email === `municipal-${index}@example.test`,
  );
  await login(page, f.email, f.password);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  return f;
}

test("an administrator downloads the catalog as a versioned JSON file without reservations or personal data", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const f = await enter(page, info.project.name === "desktop" ? 49 : 50);
  await page.goto(`/administracion/${f.tenant}`);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: /^Descargar catálogo|^Descargar catalogo/ })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("quenda-catalog-v1.json");
  const document = JSON.parse(
    await readFile((await file.path()) as string, "utf8"),
  );
  expect(document.format).toBe("quenda.catalog");
  expect(document.version).toBe(1);
  expect(document.tenantId).toBe(f.tenant);
  expect(document.facilities.map((x: { id: string }) => x.id)).toContain(
    f.facility,
  );
  const unit = document.units.find((x: { id: string }) => x.id === f.unit);
  expect(unit.calendar.weekly.length).toBeGreaterThan(0);
  expect(unit.usageRules.text.length).toBeGreaterThan(0);
  const text = JSON.stringify(document);
  expect(text).not.toContain(f.email);
  expect(text).not.toContain("reservations");
  expect(await accessibilityViolations(page)).toEqual([]);
});

test("reservations download as a CSV table with one row per reservation", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const f = await enter(page, info.project.name === "desktop" ? 49 : 50);
  await page.goto(`/administracion/${f.tenant}/exportaciones`);
  const end = new Date(`${f.date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 2);
  await pickDate(page, /Desde \(incluido\)|Desde \(incluído\)/, f.date);
  await pickDate(
    page,
    /Hasta \(excluido\)|Ata \(excluído\)/,
    end.toISOString().slice(0, 10),
  );
  await page.getByRole("combobox", { name: "Formato", exact: true }).click();
  await page
    .getByRole("option", { name: /^(Hoja|Folla) de c[aá]lculo$/ })
    .click();
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: /^Descargar (hoja|folla) de cálculo$/ })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("quenda-reservations-v3.csv");
  const csv = await readFile((await file.path()) as string, "utf8");
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = csv.slice(1).trimEnd().split("\r\n");
  expect(lines[0]).toMatch(/^id,unitId,accountId,startsAt,/);
  expect(lines.some((line) => line.startsWith(`${f.reservationId},`))).toBe(
    true,
  );
});
