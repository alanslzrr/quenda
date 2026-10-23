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
  if ((page.viewportSize()?.width ?? 1000) < 500) {
    await page.getByRole("button", { name: /Ajustes|Axustes/ }).click();
    await page
      .getByRole("menuitem", { name: /Modo oscuro|Modo escuro/ })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  }

  await page
    .getByRole("link", { name: "Administración municipal", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Oleiros de proba", exact: true })
    .click();
  await expect(page).toHaveURL(`/administracion/${f.tenant}`);
  return f;
}
async function select(
  page: Page,
  name: RegExp | string,
  option: RegExp | string,
) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
test("municipal catalog and versioned configuration use the real API", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await enter(page, info.project.name === "desktop" ? 0 : 1);
  const create = page.locator("form").filter({
    has: page.getByRole("button", { name: "Crear instalación", exact: true }),
  });
  await create.getByLabel(/Nombre|Nome/).fill("Centro novo");
  await create
    .getByRole("button", { name: "Crear instalación", exact: true })
    .click();
  await page.getByRole("link", { name: "Centro novo", exact: true }).click();
  const publish = page.locator("form").filter({
    has: page.getByRole("button", {
      name: "Publicar instalación",
      exact: true,
    }),
  });
  await publish.getByLabel("Motivo").fill("Apertura del centro");
  await publish
    .getByRole("button", { name: "Publicar instalación", exact: true })
    .click();
  await expect(page.getByText("Publicada", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Catálogo", exact: true }).click();
  const center = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Centro novo", exact: true }),
  });
  await center.getByRole("link", { name: /Crear uni/ }).click();
  await expect(
    page.getByRole("heading", {
      name: /Nueva unidad reservable|Nova unidade reservable/,
    }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: /^(Nombre|Nome)$/ })
    .fill("Sala nova");
  await page.getByRole("button", { name: /Crear uni/ }).click();
  await page
    .getByRole("link", { name: /Volver al catálogo|Volver ao catálogo/ })
    .click();
  await page.getByRole("link", { name: "Sala nova", exact: true }).click();
  await page.getByRole("button", { name: /Publicar uni/ }).click();
  await expect(
    page.getByText(/Añade las normas|Engade as normas/),
  ).toBeVisible();
  await page.getByRole("button", { name: /^(Cerrar|Pechar)$/ }).click();
  await page.getByRole("tab", { name: "Normas", exact: true }).click();
  const rules = page.locator("form").filter({
    has: page.getByRole("button", { name: /Guardar normas|Gardar normas/ }),
  });
  await rules
    .getByLabel(/Texto de las normas|Texto das normas/)
    .fill("Uso deportivo. Respeta el horario reservado.");
  await rules.getByLabel("Motivo").fill("Normas iniciales");
  await rules
    .getByRole("button", { name: /Guardar normas|Gardar normas/ })
    .click();
  await page.getByRole("tab", { name: "Horarios", exact: true }).click();
  const calendar = page.locator("form").filter({
    has: page.getByRole("button", {
      name: /Guardar horarios|Gardar horarios/,
    }),
  });
  await calendar
    .getByRole("button", {
      name: /Añadir franja semanal|Engadir franxa semanal/,
    })
    .click();
  await calendar
    .getByRole("button", { name: /Añadir excepción|Engadir excepción/ })
    .click();
  await calendar.getByLabel(/^(Fecha|Data)$/).fill("2030-01-01");
  await calendar.getByLabel("Motivo").fill("Horario inicial");
  await calendar
    .getByRole("button", { name: /Guardar horarios|Gardar horarios/ })
    .click();
  await expect(
    calendar.getByText(/Cambios guardados|Cambios gardados/),
  ).toHaveText(/Cambios guardados|Cambios gardados/);
  await page.getByRole("button", { name: /Publicar uni/ }).click();
  const unitPublish = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: /Publicar uni/ }) });
  await unitPublish.getByLabel("Motivo").fill("Apertura de la sala");
  await unitPublish.getByRole("checkbox").check();
  await unitPublish.getByRole("button", { name: /Publicar uni/ }).click();
  await expect(page.getByText("Publicada", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Normas", exact: true }).click();
  await expect(
    page.getByLabel(/Texto de las normas|Texto das normas/),
  ).toHaveValue("Uso deportivo. Respeta el horario reservado.");
  await page.getByRole("tab", { name: "Horarios", exact: true }).click();
  await expect(page.getByLabel(/^(Fecha|Data)$/)).toHaveValue("2030-01-01");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/municipal-catalog-${info.project.name}.png`,
    fullPage: true,
  });
});

test("municipal policy and appearance persist without changing the administrative theme", async ({
  page,
}, info) => {
  await enter(page, info.project.name === "desktop" ? 2 : 3);
  if ((page.viewportSize()?.width ?? 1280) < 768)
    await page
      .getByRole("button", {
        name: /Gestión municipal|Xestión municipal/,
        exact: true,
      })
      .click();
  await page
    .getByRole("link", { name: /Condiciones de reserva|Condicións de reserva/ })
    .click();
  await page.getByLabel(/Antelación máxima/).fill("35");
  await page.getByLabel("Motivo").fill("Ampliación de antelación");
  await page
    .getByRole("button", { name: /Guardar condiciones|Gardar condicións/ })
    .click();
  await expect(
    page.getByText(/Cambios guardados|Cambios gardados/),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Antelación máxima/)).toHaveValue("35");
  if ((page.viewportSize()?.width ?? 1280) < 768)
    await page
      .getByRole("button", {
        name: /Gestión municipal|Xestión municipal/,
        exact: true,
      })
      .click();
  await page.getByRole("link", { name: /^Apariencia$|^Aparencia$/ }).click();
  const rootAccent = await page
    .locator("html")
    .evaluate((el) => getComputedStyle(el).getPropertyValue("--accent"));
  await select(page, "Paleta clara", "Azul");
  await select(page, /Paleta oscura|Paleta escura/, "Verde");
  const preview = page.getByRole("region", { name: "Vista previa pública" });
  await expect(preview).toHaveCSS("background-color", "rgb(249, 251, 255)");
  expect(
    await page
      .locator("html")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--accent")),
  ).toBe(rootAccent);
  await page
    .getByRole("button", { name: /Guardar apariencia|Gardar aparencia/ })
    .click();
  await expect(
    page.getByText(/Cambios guardados|Cambios gardados/),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Paleta clara", exact: true }),
  ).toContainText("Azul");
  await select(page, "Modo de vista previa", /Oscuro|Escuro/);
  await expect(preview).toHaveCSS("background-color", "rgb(21, 37, 29)");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/municipal-appearance-${info.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Restaurar valores predeterminados" })
    .click();
  await page
    .getByRole("button", { name: /Guardar apariencia|Gardar aparencia/ })
    .click();
  await expect(
    page.getByText(/Cambios guardados|Cambios gardados/),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Paleta clara", exact: true }),
  ).toContainText("Neutro");
});

test("calendar changes preserve confirmed reservations and withdrawal preserves history", async ({
  page,
}, info) => {
  const f = await enter(page, info.project.name === "desktop" ? 4 : 5);
  await page.goto(`/administracion/${f.tenant}/unidades/${f.unit}`);
  await page.getByRole("tab", { name: "Horarios", exact: true }).click();
  // Existing reservations prevent closing all opening intervals.
  const existingCalendar = page.locator("form").filter({
    has: page.getByRole("button", {
      name: /Guardar horarios|Gardar horarios/,
    }),
  });
  await expect(
    existingCalendar.getByRole("button", {
      name: /Quitar franja|Quitar franxa/,
    }),
  ).toHaveCount(7);
  while (
    await existingCalendar
      .getByRole("button", { name: /Quitar franja|Quitar franxa/ })
      .count()
  )
    await existingCalendar
      .getByRole("button", { name: /Quitar franja|Quitar franxa/ })
      .first()
      .click();
  await existingCalendar.getByLabel("Motivo").fill("Cierre incompatible");
  await existingCalendar
    .getByRole("button", { name: /Guardar horarios|Gardar horarios/ })
    .click();
  await expect(existingCalendar.getByRole("alert").first()).toBeVisible();
  await page
    .getByRole("button", { name: /Retirar del catálogo|Retirar do catálogo/ })
    .click();
  const withdraw = page.locator("form").filter({
    has: page.getByRole("button", { name: "Retirar", exact: true }),
  });
  await withdraw.getByLabel("Motivo").fill("Retirada de la unidad");
  await withdraw.getByRole("checkbox").check();
  await withdraw.getByRole("button", { name: "Retirar", exact: true }).click();
  await expect(
    page.getByText(
      /Retirada del catálogo público|Retirada do catálogo público/,
    ),
  ).toBeVisible();
  await page.goto(`/administracion/${f.tenant}/reservas/${f.reservationId}`);
  await expect(page.getByText("CONFIRMADA", { exact: true })).toBeVisible();
});

test("daily agenda relocates without accepting rules and cancels explicitly", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const f = await enter(page, info.project.name === "desktop" ? 6 : 7);
  if ((page.viewportSize()?.width ?? 1280) < 768)
    await page
      .getByRole("button", {
        name: /Gestión municipal|Xestión municipal/,
        exact: true,
      })
      .click();
  await page.getByRole("link", { name: /Agenda diaria|Axenda diaria/ }).click();
  await page.getByLabel(/Fecha de la agenda|Data da axenda/).fill(f.date);
  await page
    .getByRole("table", { name: /Reservas del día|Reservas do día/ })
    .getByRole("link")
    .first()
    .click();
  await select(page, /Unidad de destino|Unidade de destino/, "Pista 2");
  await page.getByLabel(/Nueva fecha|Nova data/).fill(f.date);
  await page
    .getByRole("combobox", { name: /Franja disponible|Franxa dispoñible/ })
    .click();
  await page.getByRole("option").first().click();
  const relocation = page.locator("form").filter({
    has: page.getByRole("button", {
      name: "Confirmar reubicación",
      exact: true,
    }),
  });
  await relocation.getByLabel("Motivo").fill("Mantenimiento en pista 1");
  await relocation.getByRole("checkbox").check();
  await relocation
    .getByRole("button", { name: "Confirmar reubicación", exact: true })
    .click();
  await expect(
    page.getByText(
      /titular tiene normas pendientes|titular ten normas pendentes/,
    ),
  ).toBeVisible();
  const cancel = page.locator("form").filter({
    has: page.getByRole("button", { name: "Cancelar administrativamente" }),
  });
  await cancel.getByLabel("Motivo").fill("Resolución municipal");
  await cancel.getByRole("checkbox").check();
  await cancel
    .getByRole("button", { name: "Cancelar administrativamente" })
    .click();
  await expect(page.getByText("CANCELADA", { exact: true })).toBeVisible();
});

test("blocks survive reload and release through the daily agenda", async ({
  page,
}, info) => {
  const f = await enter(page, info.project.name === "desktop" ? 8 : 9);

  if ((page.viewportSize()?.width ?? 1280) < 768)
    await page
      .getByRole("button", {
        name: /Gestión municipal|Xestión municipal/,
        exact: true,
      })
      .click();
  await page
    .getByRole("link", { name: /Agenda diaria|Axenda diaria/ })
    .first()
    .click();
  await page.getByLabel(/Fecha de la agenda|Data da axenda/).fill(f.date);
  const block = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Crear bloqueo" }) });
  await select(
    page,
    /Unidad a bloquear|Unidade que se vai bloquear/,
    "Pista 1",
  );
  await block
    .getByLabel(/Inicio del bloqueo|Inicio do bloqueo/)
    .fill(`${f.date}T12:00`);
  await block
    .getByLabel(/Fin del bloqueo|Fin do bloqueo/)
    .fill(`${f.date}T13:00`);
  await block.getByLabel("Motivo").fill("Revisión del pavimento");
  await block.getByRole("checkbox").check();
  await block.getByRole("button", { name: "Crear bloqueo" }).click();
  await expect(
    page.getByText("Revisión del pavimento", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel(/Fecha de la agenda|Data da axenda/).fill(f.date);
  const release = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Liberar bloqueo" }) });
  await release.getByLabel("Motivo").fill("Revisión finalizada");
  await release.getByRole("checkbox").check();
  await release.getByRole("button", { name: "Liberar bloqueo" }).click();
  await expect(page.getByText("Liberado", { exact: true })).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/municipal-agenda-${info.project.name}.png`,
    fullPage: true,
  });
});
