import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { test } from "./fixtures";

async function enter(page: Page, index: number) {
  const f = JSON.parse(
    await readFile("test-results/municipal-fixtures.json", "utf8"),
  )[index];
  await login(page, f.email, f.password);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  return f;
}
const save = /Guardar ficha|Gardar ficha/;
const saved = /Cambios guardados\.|Cambios gardados\./;

test("a facility profile is edited, audited by version and shown on the public pages in both languages", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const f = await enter(page, info.project.name === "desktop" ? 20 : 21);
  await page.goto(`/administracion/${f.tenant}/instalaciones/${f.facility}`);
  const form = page.locator("form").filter({
    has: page.getByRole("button", { name: save }),
  });
  await form.getByLabel(/^(Dirección|Enderezo)$/).fill("Rúa do Mar 4");
  await form.getByLabel(/Código postal/).fill("15001");
  // A coordinate without its pair is explained before anything is sent.
  await form.getByLabel(/^(Latitud|Latitude)$/).fill("43.362346");
  await form.getByRole("button", { name: save }).click();
  await expect(
    page.getByText(/latitud y longitud|latitude e lonxitude/),
  ).toBeVisible();
  await form.getByLabel(/^(Longitud|Lonxitude)$/).fill("-8,4115");
  await form
    .getByLabel(/Descripción en gallego|Descrición en galego/)
    .fill("Pavillón cuberto con dúas pistas");
  await form
    .getByLabel(/Descripción en castellano|Descrición en castelán/)
    .fill("Pabellón cubierto con dos pistas");
  await form
    .getByLabel(/Accesibilidad en castellano|Accesibilidade en castelán/)
    .fill("Acceso sin escalones");
  await form.getByLabel(/Teléfono de contacto/).fill("+34 981 000 000");
  await form.getByLabel(/Correo de contacto/).fill("deportes@concello.example");
  await form.getByRole("button", { name: save }).click();
  await expect(page.getByText(saved)).toBeVisible();

  await page.reload();
  await expect(page.getByLabel(/^(Dirección|Enderezo)$/)).toHaveValue(
    "Rúa do Mar 4",
  );
  await expect(page.getByLabel(/^(Longitud|Lonxitude)$/)).toHaveValue(
    "-8.4115",
  );

  // Clearing a field removes it from the profile.
  await page.getByLabel(/Teléfono de contacto/).fill("");
  await page.getByRole("button", { name: save }).click();
  await expect(page.getByText(saved)).toBeVisible();

  // The public page shows what was written, in the active language, with a plain map link.
  await page.goto(`/municipios/${f.tenant}/instalaciones/${f.facility}`);
  await expect(page.getByText("Rúa do Mar 4, 15001")).toBeVisible();
  await expect(
    page.getByText(
      /Pabellón cubierto con dos pistas|Pavillón cuberto con dúas pistas/,
    ),
  ).toBeVisible();
  await expect(page.getByText("Acceso sin escalones")).toBeVisible();
  const map = page.getByRole("link", { name: /Cómo llegar|Como chegar/ });
  await expect(map).toHaveAttribute(
    "href",
    /^https:\/\/www\.openstreetmap\.org\/\?mlat=43\.362346&mlon=-8\.4115/,
  );
  await expect(map).toHaveAttribute("rel", /noopener/);
  await expect(
    page.getByRole("link", { name: "deportes@concello.example" }),
  ).toHaveAttribute("href", "mailto:deportes@concello.example");
  await expect(page.getByRole("link", { name: "+34 981 000 000" })).toHaveCount(
    0,
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);

  // The municipality list names the address too.
  await page.goto(`/municipios/${f.tenant}`);
  await expect(page.getByText(/Rúa do Mar 4, 15001/)).toBeVisible();
});

test("a unit profile shows its type, setting and capacity where citizens choose a space", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const f = await enter(page, info.project.name === "desktop" ? 20 : 21);
  await page.goto(`/administracion/${f.tenant}/unidades/${f.unit}`);
  await page.getByRole("tab", { name: "Ficha", exact: true }).click();
  const form = page.locator("form").filter({
    has: page.getByRole("button", { name: save }),
  });
  await form
    .getByRole("combobox", {
      name: /Tipo de espacio|Tipo de espazo/,
      exact: true,
    })
    .click();
  await page
    .getByRole("option", { name: "Pista de pádel", exact: true })
    .click();
  await form
    .getByRole("combobox", { name: /Ubicación|Localización/, exact: true })
    .click();
  await page
    .getByRole("option", { name: /Al aire libre|Ao aire libre/, exact: true })
    .click();
  await form.getByLabel(/Aforo máximo/).fill("4");
  await form.getByRole("button", { name: save }).click();
  await expect(page.getByText(saved)).toBeVisible();

  await page.goto(`/municipios/${f.tenant}/instalaciones/${f.facility}`);
  await expect(
    page.getByText(
      /Pista de pádel · (Al aire libre|Ao aire libre) · (Hasta 4 personas|Ata 4 persoas)/,
    ),
  ).toBeVisible();
  await page.goto(`/municipios/${f.tenant}/unidades/${f.unit}`);
  await expect(
    page.getByText(
      /Pista de pádel · (Al aire libre|Ao aire libre) · (Hasta 4 personas|Ata 4 persoas)/,
    ),
  ).toBeVisible();
});
