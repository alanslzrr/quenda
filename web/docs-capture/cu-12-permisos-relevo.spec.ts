import type { Page } from "@playwright/test";
import { account, Capture, expect, roles, signIn, test } from "./capture";
import {
  ageMfaProof,
  choose,
  command,
  cookieOf,
  formWith,
  freshAccount,
  freshCode,
  localDate,
  pickDate,
  pickDateTime,
  secondBrowser,
  signInAs,
  snap,
  valdeira,
} from "./steps";

const staff = `/administracion/${valdeira}/personal`;
const row = (page: Page, email: string) =>
  page.getByRole("button", { name: new RegExp(email.replaceAll(".", "\\.")) });

// CU-12 — Delegar permisos y relevar responsables. La administradora de
// Valdeira invita a una gestora y a un segundo administrador creados para este
// escenario; las cuentas sembradas conservan sus permisos.
test("CU-12 delegar permisos y relevar responsables", async ({
  page,
  browser,
}) => {
  test.setTimeout(300000);
  const cu = new Capture("CU-12");
  const nerea = await freshAccount(
    "nerea.pazos@valdeira.demo.test",
    "Nerea Pazos Rey",
  );
  const david = await freshAccount(
    "david.mosquera@valdeira.demo.test",
    "David Mosquera Gil",
  );
  await signIn(page, "administrator");
  await page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("link", { name: "Gestión", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Gestión municipal" })
    .getByRole("link", { name: "Personal y permisos", exact: true })
    .click();
  await expect(
    page.getByRole("table", { name: "Administradores", exact: true }),
  ).toBeVisible();
  const invite = page
    .getByRole("navigation", { name: "Personal municipal" })
    .getByRole("link", { name: "Invitar", exact: true });
  await snap(cu, page, "personal", { target: invite });

  const other = await secondBrowser(browser, page);
  try {
    const recipient = await other.newPage();
    // Paso 1: la persona invitada comprueba el correo verificado de su cuenta,
    // que es lo único que necesita la administradora. La captura conserva su
    // posición para no renumerar las siguientes.
    await signInAs(recipient, nerea);
    await recipient.goto("/perfil/datos");
    const mailbox = recipient
      .locator("section")
      .filter({
        has: recipient.getByRole("heading", { name: "Correo electrónico" }),
      })
      .getByText(nerea.email, { exact: true });
    await expect(mailbox).toBeVisible();
    await snap(cu, recipient, "correo-de-la-persona", {
      fullPage: true,
      target: mailbox,
    });

    // Paso 2: la administradora registra la invitación, dirigida al correo de
    // la persona, con permisos y plazo.
    await invite.click();
    await page.getByLabel("Correo del destinatario").fill(nerea.email);
    await pickDateTime(page, "Aceptar antes de", localDate(3), "14:00");
    await choose(page, "Operación", "Consultar reservas");
    await choose(page, "Ámbito", "Todo el municipio");
    await page.getByRole("button", { name: "Añadir permiso" }).click();
    await choose(page, "Operación", "Bloquear unidades");
    await choose(page, "Ámbito", "Pista central");
    await page.getByRole("button", { name: "Añadir permiso" }).click();
    await page
      .getByRole("checkbox", {
        name: "Confirmo el correo, el alcance y la vigencia",
      })
      .check();
    const send = page.getByRole("button", {
      name: "Enviar invitación",
      exact: true,
    });
    await snap(cu, page, "invitar-gestora", { tall: true, target: send });
    await send.click();
    const registered = page.getByText("Invitación registrada", {
      exact: false,
    });
    await expect(registered.first()).toBeVisible();
    await snap(cu, page, "invitacion-registrada", {
      target: registered.first(),
    });

    // Paso 3: la destinataria la ve en su perfil y la acepta.
    await recipient
      .getByRole("navigation", { name: "Mi cuenta" })
      .getByRole("link", { name: "Invitaciones", exact: true })
      .click();
    const accept = recipient.getByRole("button", {
      name: "Aceptar invitación",
      exact: true,
    });
    await expect(accept).toHaveCount(1);
    await snap(cu, recipient, "invitacion-pendiente", {
      tall: true,
      target: accept,
    });

    await accept.click();
    await expect(accept).toHaveCount(0);
    const accepted = recipient
      .getByRole("region", { name: "Historial" })
      .getByRole("listitem")
      .first();
    await expect(accepted).toBeVisible();
    await snap(cu, recipient, "invitacion-aceptada", { target: accepted });

    // La gestora ya gestiona solo lo que se le concedió.
    await recipient
      .getByRole("navigation", { name: "Navegación principal" })
      .getByRole("link", { name: "Gestión", exact: true })
      .click();
    const sections = recipient.getByRole("navigation", {
      name: "Gestión municipal",
    });
    await expect(
      sections.getByRole("link", { name: "Agenda diaria" }),
    ).toBeVisible();
    // A day ahead, so that the agenda holds bookings whatever the hour of
    // the run: today's depend on how much of the day has passed.
    await pickDate(recipient, "Fecha de la agenda", localDate(2));
    await expect(
      recipient.getByText("No hay reservas para este día y ámbito."),
    ).toHaveCount(0);
    await snap(cu, recipient, "gestora-con-permisos", { target: sections });

    // Alternativa: una gestora no puede gestionar el personal.
    await recipient.goto(staff);
    const denied = recipient.getByText(
      "No tienes permiso para esta operación.",
    );
    await expect(denied).toBeVisible();
    await snap(cu, recipient, "gestora-sin-permiso", { target: denied });

    // La administradora consulta la concesión aceptada.
    await page
      .getByRole("navigation", { name: "Personal municipal" })
      .getByRole("link", { name: "Gestores", exact: true })
      .click();
    await row(page, nerea.email).click();
    const detail = page.getByRole("heading", {
      name: "Detalle de la invitación",
    });
    await expect(detail).toBeVisible();
    await expect(page.getByText(/^Aceptada: /)).toBeVisible();
    const revoke = formWith(page, "Revocar concesión");
    await revoke
      .getByLabel("Motivo", { exact: true })
      .fill("Fin del refuerzo de temporada");
    await revoke
      .getByRole("checkbox", { name: "Confirmo la revocación" })
      .check();
    await snap(cu, page, "revocar-concesion", {
      tall: true,
      target: revoke.getByRole("button", { name: "Revocar concesión" }),
    });

    // Retirar permisos: la concesión se revoca y la gestora pierde el acceso.
    await revoke.getByRole("button", { name: "Revocar concesión" }).click();
    await expect(revoke).toHaveCount(0);
    await recipient.goto(`/administracion/${valdeira}/agenda`);
    const gone = recipient.getByText("No tienes acceso a este municipio.");
    await expect(gone).toBeVisible();
    await snap(cu, recipient, "acceso-retirado", { target: gone });
  } finally {
    await other.close();
  }

  // Relevo: invitar a otro administrador con un permiso temporal.
  await page.goto(`${staff}/invitar`);
  await choose(page, "Tipo de invitación", "Administrador municipal");
  await page.getByLabel("Correo del destinatario").fill(david.email);
  await pickDateTime(page, "Aceptar antes de", localDate(3), "14:00");
  await pickDateTime(
    page,
    "Permiso válido hasta (opcional)",
    localDate(30),
    "14:00",
  );
  await page
    .getByRole("checkbox", {
      name: "Confirmo el correo, el alcance y la vigencia",
    })
    .check();
  const sendAdmin = page.getByRole("button", { name: "Enviar invitación" });
  await snap(cu, page, "invitar-administrador", {
    tall: true,
    target: sendAdmin,
  });
  await sendAdmin.click();
  await expect(page.getByText("Invitación registrada").first()).toBeVisible();

  let martaCookie = "";
  const successor = await secondBrowser(browser, page);
  try {
    const davidPage = await successor.newPage();
    await signInAs(davidPage, david);
    await davidPage.goto("/perfil/invitaciones");
    await davidPage
      .getByRole("button", { name: "Aceptar invitación", exact: true })
      .click();
    await expect(
      davidPage.getByRole("button", { name: "Aceptar invitación" }),
    ).toHaveCount(0);

    // Alternativa: no se puede retirar al último responsable sin caducidad.
    await page.goto(staff);
    const admins = page.getByRole("table", {
      name: "Administradores",
      exact: true,
    });
    await admins.getByRole("button", { name: /tu cuenta/ }).click();
    const leave = formWith(page, "Retirar administración");
    await leave.getByLabel("Motivo", { exact: true }).fill("Cambio de destino");
    await leave
      .getByRole("checkbox", { name: /Confirmo la retirada ordinaria/ })
      .check();
    await leave.getByRole("button", { name: "Retirar administración" }).click();
    const blocked = page.getByText(/Debe quedar otro responsable habilitado/);
    await expect(blocked).toBeVisible();
    await snap(cu, page, "retirada-sin-relevo", {
      tall: true,
      target: blocked,
    });

    // Relevo: el permiso temporal pasa a indefinido, con motivo.
    await page.goto(staff);
    await admins
      .getByRole("button", {
        name: new RegExp(david.email.replaceAll(".", "\\.")),
      })
      .click();
    const indefinite = formWith(page, "Convertir en indefinido");
    await indefinite
      .getByLabel("Motivo", { exact: true })
      .fill("Responsable permanente del servicio de deportes");
    await indefinite
      .getByRole("checkbox", { name: /Confirmo el permiso/ })
      .check();
    await snap(cu, page, "convertir-indefinido", {
      tall: true,
      target: indefinite.getByRole("button", {
        name: "Convertir en indefinido",
      }),
    });
    await indefinite
      .getByRole("button", { name: "Convertir en indefinido" })
      .click();
    await expect(indefinite).toHaveCount(0);
    const davidRow = admins.getByRole("row").filter({ hasText: david.email });
    await expect(davidRow).toContainText("Sin caducidad");
    await snap(cu, page, "dos-responsables", {
      target: davidRow.getByRole("cell", { name: "Sin caducidad" }),
    });

    // Relevo completado: Marta se retira por su cambio de destino y David
    // sigue como responsable.
    await page.goto(staff);
    await admins.getByRole("button", { name: /tu cuenta/ }).click();
    const retire = formWith(page, "Retirar administración");
    await retire
      .getByLabel("Motivo", { exact: true })
      .fill("Cambio de destino");
    await retire
      .getByRole("checkbox", { name: /Confirmo la retirada ordinaria/ })
      .check();
    await snap(cu, page, "retirada-ordinaria", {
      tall: true,
      target: retire.getByRole("button", { name: "Retirar administración" }),
    });
    await retire
      .getByRole("button", { name: "Retirar administración" })
      .click();
    await expect(page).toHaveURL(/\/administracion$/);
    const without = page.getByText(/No tienes permisos municipales/);
    await expect(without).toBeVisible();
    await snap(cu, page, "retirada-completada", { target: without });

    // Later scenarios act as the seeded administrator: David gives her the
    // administration back through an ordinary invitation, and she accepts it
    // with a fresh second factor.
    const { email } = await account(roles.administrator);
    const { invitationId } = await command(
      await cookieOf(davidPage),
      `/api/municipalities/${valdeira}/administrator-invitations`,
      {
        email,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        roleExpiresAt: null,
      },
    );
    const back = await secondBrowser(browser, page);
    const returning = await back.newPage();
    await signIn(returning, "administrator");
    martaCookie = await cookieOf(returning);
    await command(
      martaCookie,
      `/api/municipalities/${valdeira}/administrator-invitations/${invitationId}/accept`,
      {},
    );
    await back.close();
  } finally {
    await successor.close();
  }

  // Alternativa: la verificación en dos pasos ya no es reciente al aceptar.
  // The seeded administrator again, with the session she accepted with.
  await command(
    martaCookie,
    `/api/municipalities/${valdeira}/manager-invitations`,
    {
      email: nerea.email,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      permissions: [{ operation: "RESERVATION_READ", unitId: null }],
    },
  );
  const again = await secondBrowser(browser, page);
  try {
    const recipient = await again.newPage();
    await signInAs(recipient, nerea);
    await recipient.goto("/perfil/invitaciones");
    const accept = recipient.getByRole("button", {
      name: "Aceptar invitación",
      exact: true,
    });
    await expect(accept).toHaveCount(1);
    await ageMfaProof(nerea.email);
    await accept.click();
    const notice = recipient.getByText(
      "Vuelve a verificar el segundo factor para realizar esta operación.",
    );
    await expect(notice).toBeVisible();
    const reverify = recipient
      .getByRole("status", { name: "Verificación de seguridad" })
      .getByRole("button", { name: "Verificar acceso" });
    await snap(cu, recipient, "verificacion-caducada", {
      tall: true,
      target: reverify,
    });
    await reverify.click();
    const verify = recipient.getByRole("dialog");
    await verify
      .getByLabel("Código de autenticación", { exact: true })
      .fill(await freshCode(nerea));
    const confirm = verify.getByRole("button", {
      name: "Verificar acceso",
      exact: true,
    });
    await snap(cu, recipient, "verificar-de-nuevo", { target: confirm });
    await confirm.click();
    await expect(verify).toHaveCount(0);
    await accept.click();
    await expect(accept).toHaveCount(0);
  } finally {
    await again.close();
  }
});
