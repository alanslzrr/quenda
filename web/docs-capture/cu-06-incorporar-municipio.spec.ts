import type { Page } from "@playwright/test";
import { pickDateTime } from "../test/browser/date-fields";
import { Capture, expect, test } from "./capture";
import {
  alongside,
  closeSql,
  code,
  expireMfa,
  future,
  otherBrowser,
  register,
  seeded,
  signInAs,
  signInRole,
  tallShot,
} from "./people";

// CU-06 — Incorporar un municipio. El operador de plataforma da de alta un
// municipio nuevo con su primera invitación administrativa; la destinataria la
// acepta con verificación en dos pasos. Todo ocurre sobre municipios y cuentas
// creados aquí: Valdeira, Ribasanta y su personal no se tocan.

test.afterAll(closeSql);

const view = "/plataforma/gestion";
const deadline = () => future(3).toISOString().slice(0, 16);

async function fillMunicipality(
  page: Page,
  name: string,
  timezone: string,
  accountId: string,
) {
  await page.goto(`${view}/nuevo-municipio`);
  await page.getByLabel("Nombre del municipio").fill(name);
  await page.getByLabel("Zona horaria del municipio (IANA)").fill(timezone);
  await page.getByLabel("Identificador de cuenta").fill(accountId);
  await pickDateTime(page, "Aceptar antes de", deadline());
  await page.getByRole("checkbox", { name: /Confirmo el municipio/ }).check();
}
const register$ = (page: Page) =>
  page.getByRole("button", { name: "Registrar municipio", exact: true });

test("CU-06 incorporar un municipio", async ({ page, browser }) => {
  test.setTimeout(300000);
  const cu = new Capture("CU-06");
  // Cuentas nuevas: la futura administradora y una cuenta ajena.
  const nuria = await register(
    "Nuria Castro Méndez",
    "nuria.castro@demo.test",
    {
      mfa: true,
    },
  );
  const oscar = await register(
    "Óscar Pereira Lago",
    "oscar.pereira@demo.test",
    {
      mfa: true,
    },
  );
  const operator = await seeded("operator");
  const other = await otherBrowser(browser);
  const recipient = await other.newPage();

  // Paso 1: la destinataria consulta su identificador de cuenta y lo facilita.
  await signInAs(recipient, nuria);
  await recipient.goto("/perfil/datos");
  const reference = recipient.getByText(/Identificador de cuenta, por si/);
  await expect(reference).toContainText(nuria.accountId);
  await tallShot(cu, recipient, "identificador-destinataria", {
    target: reference,
  });

  // Paso 2: el operador entra en la administración de plataforma.
  await signInRole(page, "operator");
  await page.goto("/administracion");
  const entry = page.getByRole("link", {
    name: "Administración de plataforma",
    exact: true,
  });
  await expect(entry).toBeVisible();
  await cu.shot(page, "entrada-plataforma", { target: entry });
  await entry.click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Operadores" }),
  ).toBeVisible();
  const menu = page.getByRole("link", { name: "Incorporar municipio" });
  await cu.shot(page, "menu-incorporar", { target: menu });

  // Paso 3: datos del municipio y destinataria de la primera invitación.
  await fillMunicipality(
    page,
    "Concello de Toxeira",
    "Europe/Madrid",
    nuria.accountId,
  );
  await tallShot(cu, page, "formulario-alta", { target: register$(page) });
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/municipalities") &&
      r.request().method() === "POST",
  );
  await register$(page).click();
  const { tenantId } = await (await created).json();
  const receipt = page.getByRole("status").filter({
    hasText: "Municipio registrado. Invitación pendiente de aceptación.",
  });
  await expect(receipt).toBeVisible();
  await cu.shot(page, "alta-registrada", { target: receipt });

  // Paso 4: la destinataria acepta la invitación desde su perfil.
  await recipient.goto("/perfil/invitaciones");
  const card = recipient
    .locator("li")
    .filter({ hasText: "Concello de Toxeira" })
    .filter({ hasText: "Pendiente" });
  const accept = card.getByRole("button", { name: "Aceptar invitación" });
  await expect(accept).toBeVisible();
  await cu.shot(recipient, "invitacion-pendiente", { target: accept });
  await accept.click();
  const accepted = recipient
    .locator("li")
    .filter({ hasText: "Concello de Toxeira" })
    .filter({ hasText: "Aceptada" });
  await expect(accepted).toBeVisible();
  await cu.shot(recipient, "invitacion-aceptada", { target: accepted });

  // Paso 5: la nueva administradora ya gestiona su municipio.
  await recipient.goto("/administracion");
  const municipality = recipient.getByRole("link", {
    name: /Concello de Toxeira/,
  });
  await expect(municipality).toBeVisible();
  await cu.shot(recipient, "municipio-disponible", { target: municipality });
  await municipality.click();
  await expect(recipient).toHaveURL(new RegExp(`/administracion/${tenantId}`));
  const staff = recipient.getByRole("link", { name: "Personal y permisos" });
  await expect(staff).toBeVisible();
  await expect(
    recipient.getByRole("heading", { level: 1 }).first(),
  ).toBeVisible();
  await cu.shot(recipient, "gestion-municipal", { target: staff });

  // Alternativa: datos inválidos (zona horaria que no es IANA).
  await fillMunicipality(
    page,
    "Concello de Augasantas",
    "Madrid",
    oscar.accountId,
  );
  await register$(page).click();
  const invalid = page
    .locator("form")
    .getByRole("alert")
    .filter({ hasText: "Indica una zona horaria IANA válida." });
  await expect(invalid).toBeVisible();
  await alongside(register$(page));
  await cu.shot(page, "zona-horaria-invalida", { target: invalid });

  // Alternativa: identificador de cuenta inexistente.
  await fillMunicipality(
    page,
    "Concello de Augasantas",
    "Europe/Madrid",
    "cuenta-inexistente",
  );
  await register$(page).click();
  const unknown = page.locator("form").getByRole("alert").first();
  await expect(unknown).toBeVisible();
  await alongside(register$(page));
  await cu.shot(page, "cuenta-inexistente", { target: unknown });

  // Alternativa: la verificación en dos pasos ya no es reciente.
  await expireMfa(operator.accountId);
  await fillMunicipality(
    page,
    "Concello de Augasantas",
    "Europe/Madrid",
    oscar.accountId,
  );
  await register$(page).click();
  const notice = page.getByRole("status", {
    name: "Verificación de seguridad",
  });
  await expect(notice).toBeVisible();
  const verify = notice.getByRole("button", { name: "Verificar acceso" });
  await cu.shot(page, "verificacion-caducada", { target: verify });
  await verify.click();
  const dialog = page.getByRole("dialog", { name: "Verificar acceso" });
  await expect(dialog).toBeVisible();
  await cu.shot(page, "verificar-acceso", { target: dialog });
  // (continúa más abajo con la cuenta equivocada)
  await dialog
    .getByLabel("Código de autenticación", { exact: true })
    .fill(await code(operator.secret as string));
  await dialog.getByRole("button", { name: "Verificar acceso" }).click();
  await expect(dialog).toBeHidden();

  // Alternativa: invitación enviada a una cuenta equivocada y sustituida.
  const second = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/municipalities") &&
      r.request().method() === "POST" &&
      r.status() === 201,
  );
  await register$(page).click();
  const augasantas = (await (await second).json()).tenantId as string;
  await expect(
    page.getByRole("status").filter({ hasText: "Municipio registrado" }),
  ).toBeVisible();
  await page.goto(`${view}/invitacion-inicial`);
  await page.getByLabel("Identificador del municipio").fill(augasantas);
  await page.getByLabel("Identificador de cuenta").fill(nuria.accountId);
  await pickDateTime(page, "Aceptar antes de", deadline());
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Destinatario corregido según el acuerdo de la alcaldía");
  await page.getByRole("checkbox", { name: /Confirmo el ámbito/ }).check();
  const replace = page.getByRole("button", { name: "Sustituir invitación" });
  await tallShot(cu, page, "sustituir-invitacion", { target: replace });
  await replace.click();
  const replaced = page
    .getByRole("status")
    .filter({ hasText: "Invitación registrada" });
  await expect(replaced).toBeVisible();
  await cu.shot(page, "invitacion-sustituida", { target: replaced });
  const wrong = await other.newPage();
  await other.clearCookies();
  await signInAs(wrong, oscar);
  await wrong.goto("/perfil/invitaciones");
  const revoked = wrong
    .locator("li")
    .filter({ hasText: "Concello de Augasantas" })
    .filter({ hasText: "Revocada" });
  await expect(revoked).toBeVisible();
  await expect(
    revoked.getByRole("button", { name: "Aceptar invitación" }),
  ).toHaveCount(0);
  await cu.shot(wrong, "invitacion-revocada", { target: revoked });

  // Alternativa: tras la aceptación ya no se sustituye la invitación inicial.
  await page.goto(`${view}/invitacion-inicial`);
  await page.getByLabel("Identificador del municipio").fill(tenantId);
  await page.getByLabel("Identificador de cuenta").fill(oscar.accountId);
  await pickDateTime(page, "Aceptar antes de", deadline());
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Cambio de responsable solicitado");
  await page.getByRole("checkbox", { name: /Confirmo el ámbito/ }).check();
  await page.getByRole("button", { name: "Sustituir invitación" }).click();
  const late = page.locator("form").getByRole("alert").first();
  await expect(late).toBeVisible();
  await alongside(page.getByRole("button", { name: "Sustituir invitación" }));
  await cu.shot(page, "sustitucion-rechazada", { target: late });

  // Alternativa: el alta no da al operador acceso a los datos municipales.
  await page.goto(`/administracion/${tenantId}`);
  const denied = page.getByRole("alert").filter({
    hasText: "No tienes acceso a este municipio.",
  });
  await expect(denied).toBeVisible();
  await cu.shot(page, "operador-sin-acceso-municipal", {
    target: page.getByRole("link", { name: "Volver a Gestión" }),
  });

  // Alternativa: una cuenta sin permiso de operador no ve la plataforma.
  await wrong.goto("/plataforma");
  const forbidden = wrong.getByText("No tienes permiso para esta operación.");
  await expect(forbidden).toBeVisible();
  await cu.shot(wrong, "sin-permiso-operador", { target: forbidden });
  await other.close();
});
