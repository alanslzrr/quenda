import { readFile, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { accessibilityViolations } from "./axe-scan";
import { test } from "./fixtures";

test("an administrator loads an exported catalog into an empty municipality as drafts", async ({
  page,
}, info) => {
  const f = JSON.parse(
    await readFile("test-results/import-fixtures.json", "utf8"),
  )[info.project.name === "desktop" ? 0 : 1];
  await login(page, f.email, f.password);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  // The same session downloads the source catalog, as "Descargar catálogo" does.
  const exported = await page.request.get(
    `/api/municipalities/${f.tenant}/exports/catalog`,
  );
  expect(exported.status()).toBe(200);
  // The file carries its own booking policy and appearance, applied on request.
  const document = await exported.json();
  document.municipality.bookingPolicy.advanceDays = 75;
  document.municipality.appearance = {
    lightPalette: "green",
    darkPalette: "blue",
    defaultTheme: "light",
  };
  const file = info.outputPath("quenda-catalog-v1.json");
  await writeFile(file, JSON.stringify(document));

  await page.goto(`/administracion/${f.target}`);
  const section = page.getByRole("heading", {
    name: /^(Importar un catálogo)$/,
  });
  await expect(section).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page
    .getByLabel(/^(Archivo de catálogo|Arquivo de catálogo)$/)
    .setInputFiles(file);
  const settings = page.getByRole("checkbox", {
    name: /^Aplicar (también la política de reserva y la apariencia del archivo|tamén a política de reserva e a aparencia do arquivo)/,
  });
  await settings.check();
  const posts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/imports/catalog")
    )
      posts.push(new URL(request.url()).search);
  });
  await page.getByRole("button", { name: /^Importar catálogo$/ }).click();
  await expect(
    page.getByText(
      /Importadas 1 instalaciones y 2 unidades|Importadas 1 instalacións e 2 unidades/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      /También se aplicaron la política de reserva y la apariencia del archivo|Tamén se aplicaron a política de reserva e a aparencia do arquivo/,
    ),
  ).toBeVisible();
  expect(posts).toEqual(["?settings=include"]);
  await expect(
    page.getByRole("link", { name: "Centro de proba" }).first(),
  ).toBeVisible();
  // A non-empty municipality no longer offers the import after a reload.
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Centro de proba" }).first(),
  ).toBeVisible();
  await expect(section).toHaveCount(0);
});
