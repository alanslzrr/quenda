import { readFile, writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
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
  const file = info.outputPath("quenda-catalog-v1.json");
  await writeFile(file, await exported.text());

  await page.goto(`/administracion/${f.target}`);
  const section = page.getByRole("heading", {
    name: /^(Importar un catálogo)$/,
  });
  await expect(section).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page
    .getByLabel(/^(Archivo de catálogo \(JSON\)|Arquivo de catálogo \(JSON\))$/)
    .setInputFiles(file);
  let posts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/imports/catalog")
    )
      posts++;
  });
  await page.getByRole("button", { name: /^Importar catálogo$/ }).click();
  await expect(
    page.getByText(
      /Importadas 1 instalaciones y 2 unidades|Importadas 1 instalacións e 2 unidades/,
    ),
  ).toBeVisible();
  expect(posts).toBe(1);
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
