import { hashPassword } from "better-auth/crypto";
import { pickDateTime } from "../test/browser/date-fields";
import { access, Capture, expect, test } from "./capture";
import {
  alongside,
  apiSignIn,
  closeSql,
  command,
  future,
  otherBrowser,
  register,
  seeded,
  signInAs,
  signInRole,
  sql,
  tallShot,
} from "./people";

// CU-16 — Contener un compromiso y recuperar acceso. Un municipio propio
// (Concello de Lousadela) con su administradora y un gestor, todos creados
// aquí: la administradora retira al gestor por seguridad, el operador suspende
// a la administradora comprometida e invita a una sustituta, y el personal de
// operación recupera el acceso personal de esa misma administradora con el
// comando de mantenimiento, sin devolverle el permiso. No se suspende ni se
// retira a nadie sembrado. Las capturas siguen el orden de la guía: primero el
// flujo principal y después las alternativas.

test.afterAll(closeSql);

const view = "/plataforma/gestion";
const deadline = () => future(3).toISOString().slice(0, 16);

test("CU-16 contener un compromiso y recuperar acceso", async ({
  page,
  browser,
}) => {
  test.setTimeout(420000);
  const cu = new Capture("CU-16");
  const operator = await seeded("operator");
  const iria = await register("Iria Souto Barral", "iria.souto@demo.test", {
    mfa: true,
  });
  const damian = await register("Damián Rial Costa", "damian.rial@demo.test", {
    mfa: true,
  });
  const rocio = await register("Rocío Tella Vidal", "rocio.tella@demo.test", {
    mfa: true,
  });

  // Preparación: el operador incorpora Lousadela, Iria acepta la
  // administración e invita a Damián como gestor, que también acepta.
  const operatorApi = await apiSignIn(operator);
  const created = await operatorApi.post("/api/municipalities", {
    data: {
      name: "Concello de Lousadela",
      timezone: "Europe/Madrid",
      administratorEmail: iria.email,
      invitationExpiresAt: future(3).toISOString(),
    },
  });
  expect(created.status()).toBe(201);
  const { tenantId, invitationId } = await created.json();
  const iriaApi = await apiSignIn(iria);
  expect(
    (
      await iriaApi.post(
        `/api/municipalities/${tenantId}/administrator-invitations/${invitationId}/accept`,
        { data: {} },
      )
    ).status(),
  ).toBe(200);
  const invited = await iriaApi.post(
    `/api/municipalities/${tenantId}/manager-invitations`,
    {
      data: {
        email: damian.email,
        expiresAt: future(3).toISOString(),
        permissions: [
          { operation: "RESERVATION_READ", unitId: null },
          { operation: "RESERVATION_MANAGE", unitId: null },
        ],
      },
    },
  );
  expect(invited.status()).toBe(201);
  const damianApi = await apiSignIn(damian);
  expect(
    (
      await damianApi.post(
        `/api/municipalities/${tenantId}/manager-invitations/${(await invited.json()).invitationId}/accept`,
        { data: {} },
      )
    ).status(),
  ).toBe(200);

  // A. Retirada local: la administradora retira al gestor comprometido.
  const iriaContext = await otherBrowser(browser);
  const admin = await iriaContext.newPage();
  await signInAs(admin, iria);
  await admin.goto(`/administracion/${tenantId}/personal/gestores`);
  const row = admin.getByRole("row").filter({ hasText: "Damián Rial Costa" });
  await expect(row).toContainText("Aceptada");
  const tab = admin.getByRole("link", { name: "Retirada por seguridad" });
  await cu.shot(admin, "gestor-habilitado", { target: tab });
  await tab.click();
  // The administrator picks the manager among the municipal staff.
  await admin
    .getByRole("combobox", { name: "Persona o invitación", exact: true })
    .click();
  await admin
    .getByRole("option")
    .filter({ hasText: "Damián Rial Costa" })
    .filter({ hasText: "gestión" })
    .click();
  await admin
    .getByLabel("Motivo", { exact: true })
    .fill("Sesión iniciada desde un equipo desconocido");
  await admin
    .getByRole("checkbox", { name: /Confirmo la retirada por seguridad/ })
    .check();
  const withdraw = admin.getByRole("button", {
    name: "Retirar acceso por seguridad",
  });
  await tallShot(cu, admin, "retirada-local", { target: withdraw });
  await withdraw.click();
  // The whole confirmation box, beside the button that produced it.
  const saved = admin
    .locator("form [data-lumen]")
    .filter({ hasText: "Cambios guardados." });
  await expect(saved).toBeVisible();
  await alongside(withdraw);
  await cu.shot(admin, "retirada-local-registrada", { target: saved });
  await admin.goto(`/administracion/${tenantId}/personal/gestores`);
  await expect(row).toContainText("Revocada");
  await cu.shot(admin, "gestor-retirado", {
    target: row.getByRole("cell", { name: "Revocada" }),
  });

  // Alternativa: el gestor conserva su cuenta y su uso personal.
  const damianContext = await otherBrowser(browser);
  const manager = await damianContext.newPage();
  await signInAs(manager, damian);
  await manager.goto("/administracion");
  await expect(
    manager.getByText("No tienes permisos municipales vigentes."),
  ).toBeVisible();
  // His own account, named at the foot of «Mi cuenta», keeps the withdrawn
  // permission only as history.
  await manager.goto("/perfil/invitaciones");
  const withdrawn = manager
    .locator("li")
    .filter({ hasText: "Concello de Lousadela" })
    .first();
  await expect(withdrawn).toBeVisible();
  await cu.shot(manager, "gestor-sin-permisos", { target: withdrawn });
  await damianContext.close();

  // B. Suspensión global: el operador suspende a la administradora.
  await signInRole(page, "operator");
  await page.goto(`${view}/operadores`);
  const suspendLink = page.getByRole("link", { name: "Suspender identidad" });
  await cu.shot(page, "menu-suspender", { target: suspendLink });
  await suspendLink.click();
  // The operator names the compromised account by its exact email.
  await page
    .getByRole("textbox", { name: "Correo de la cuenta", exact: true })
    .fill(iria.email);
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Credenciales de la persona administradora expuestas");
  await page
    .getByRole("checkbox", { name: /Confirmo la suspensión global/ })
    .check();
  const suspend = page.getByRole("button", { name: "Suspender cuenta" });
  await tallShot(cu, page, "suspender-identidad", { target: suspend });
  await suspend.click();
  const suspended = page
    .getByRole("status")
    .filter({ hasText: "Cuenta suspendida. Las reservas se conservan." });
  await expect(suspended).toBeVisible();
  await cu.shot(page, "identidad-suspendida", { target: suspended });

  // La sesión de la administradora deja de valer y no puede volver a entrar.
  await admin.goto("/acceso");
  await admin
    .getByLabel("Correo electrónico", { exact: true })
    .fill(iria.email);
  await admin.getByLabel(/^Contraseña$/).fill(iria.password);
  await admin.getByRole("button", { name: "Entrar", exact: true }).click();
  const rejected = admin.getByRole("alert").first();
  await expect(rejected).toBeVisible();
  await cu.shot(admin, "acceso-suspendido", { target: rejected });
  await iriaContext.close();

  // C. Sin administrador habilitado: el operador invita a una sustituta.
  const recover = page.getByRole("link", { name: "Recuperar responsable" });
  await page.goto(`${view}/operadores`);
  await cu.shot(page, "menu-recuperar", { target: recover });
  await recover.click();
  await page.getByLabel("Identificador del municipio").fill(tenantId);
  await page.getByLabel("Correo del destinatario").fill(rocio.email);
  await pickDateTime(page, "Aceptar antes de", deadline());
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Relevo tras suspender a la persona administradora");
  await page
    .getByLabel("Referencia de verificación de autoridad")
    .fill("Decreto de alcaldía 2026/118");
  await page.getByRole("checkbox", { name: /Confirmo el ámbito/ }).check();
  const substitute = page.getByRole("button", {
    name: "Invitar a un sustituto",
  });
  await tallShot(cu, page, "invitar-sustituta", { target: substitute });
  await substitute.click();
  const registered = page
    .getByRole("status")
    .filter({ hasText: "Invitación registrada" });
  await expect(registered).toBeVisible();
  await cu.shot(page, "sustituta-invitada", { target: registered });

  const rocioContext = await otherBrowser(browser);
  const successor = await rocioContext.newPage();
  await signInAs(successor, rocio);
  await successor.goto("/perfil/invitaciones");
  const accept = successor
    .locator("li")
    .filter({ hasText: "Concello de Lousadela" })
    .getByRole("button", { name: "Aceptar invitación" });
  await expect(accept).toBeVisible();
  await cu.shot(successor, "sustituta-acepta", { target: accept });
  await accept.click();
  await expect(accept).toHaveCount(0);
  await successor.goto(`/administracion/${tenantId}/personal`);
  const restored = successor
    .getByRole("row")
    .filter({ hasText: "Rocío Tella Vidal" })
    .filter({ hasText: "Habilitado" });
  await expect(restored).toBeVisible();
  await cu.shot(successor, "sustituta-habilitada", {
    target: restored.getByRole("cell", { name: "Habilitado", exact: true }),
  });
  await rocioContext.close();

  // D. Recuperación del acceso personal de la administradora suspendida.
  const { databases } = await access();
  const maintenance = { MIGRATION_DATABASE_URL: databases.migration };
  const references = [
    "turno-operacion-2",
    "Comparecencia presencial con DNI, expediente SEG-2026-031",
    "Contraseña y segundo factor renovados, expediente SEG-2026-031",
    "Credenciales expuestas contenidas",
  ];
  const shownRecover = `pnpm -s account:recover ${iria.accountId} ${references
    .map((value) => (value.includes(" ") ? `"${value}"` : value))
    .join(" ")}`;
  // Con las credenciales comprometidas todavía en uso, la recuperación se
  // rechaza (la imagen se incluye entre las alternativas, más abajo).
  const early = await command(
    ["scripts/recover-account.ts", iria.accountId, ...references],
    maintenance,
    shownRecover,
  );
  expect(early.code).not.toBe(0);

  // Sustitución controlada de credenciales, sin pantalla en Quenda: contraseña
  // nueva y un segundo factor nuevo, ya verificado, con sus códigos de respaldo.
  // El segundo factor se inscribe en una cuenta auxiliar y se traslada, porque
  // su secreto se guarda cifrado con la clave del servidor.
  const enrolment = await register(
    "Renovación de credenciales",
    "renovacion.credenciales@demo.test",
    { mfa: true },
  );
  const password = `Nueva-clave-${Date.now()}`;
  await sql(
    `UPDATE auth.account SET password=$2, "updatedAt"=now() WHERE "userId"=$1 AND "providerId"='credential'`,
    [iria.accountId, await hashPassword(password)],
  );
  await sql(
    `UPDATE auth."twoFactor" t SET secret=d.secret, "backupCodes"=d."backupCodes", verified=true, "failedVerificationCount"=0, "lockedUntil"=NULL
       FROM auth."twoFactor" d WHERE t."userId"=$1 AND d."userId"=$2`,
    [iria.accountId, enrolment.accountId],
  );
  await sql(`DELETE FROM auth."twoFactor" WHERE "userId"=$1`, [
    enrolment.accountId,
  ]);
  await sql(`UPDATE auth."user" SET "twoFactorEnabled"=false WHERE id=$1`, [
    enrolment.accountId,
  ]);

  // Paso: el personal de operación recupera el acceso personal.
  const recovered = await command(
    ["scripts/recover-account.ts", iria.accountId, ...references],
    maintenance,
    shownRecover,
  );
  expect(recovered.code).toBe(0);
  await cu.terminal(
    page,
    "recuperar-cuenta",
    recovered.shown,
    recovered.output,
  );

  // Paso: la administradora vuelve a entrar, sin su permiso administrativo.
  const returnContext = await otherBrowser(browser);
  const returning = await returnContext.newPage();
  await signInAs(returning, {
    email: iria.email,
    secret: enrolment.secret,
    password,
  });
  await returning.goto("/administracion");
  await expect(
    returning.getByText("No tienes permisos municipales vigentes."),
  ).toBeVisible();
  // Her own account page, with her name and address: she is signed in again.
  await returning.goto("/perfil/datos");
  const own = returning
    .locator("section")
    .filter({
      has: returning.getByRole("heading", { name: "Correo electrónico" }),
    })
    .getByText(iria.email, { exact: true });
  await expect(own).toBeVisible();
  await tallShot(cu, returning, "acceso-recuperado", { target: own });
  await returnContext.close();

  // Alternativa: con un administrador habilitado no hay recuperación.
  await page.goto(`${view}/recuperar-responsable`);
  await page.getByLabel("Identificador del municipio").fill(tenantId);
  await page.getByLabel("Correo del destinatario").fill(damian.email);
  await pickDateTime(page, "Aceptar antes de", deadline());
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Segundo relevo solicitado");
  await page
    .getByLabel("Referencia de verificación de autoridad")
    .fill("Decreto de alcaldía 2026/119");
  await page.getByRole("checkbox", { name: /Confirmo el ámbito/ }).check();
  const again = page.getByRole("button", { name: "Invitar a un sustituto" });
  await again.click();
  const conflict = page.locator("form").getByRole("alert").first();
  await expect(conflict).toBeVisible();
  await alongside(again);
  await cu.shot(page, "recuperacion-rechazada", { target: conflict });

  // Alternativa: sin sustituir las credenciales la recuperación se rechaza.
  await cu.terminal(
    page,
    "recuperar-sin-credenciales",
    early.shown,
    early.output,
  );

  // Alternativa: la recuperación excepcional de operadores exige que no quede
  // ninguno habilitado; con el operador actual activo, se rechaza.
  const operatorRecovery = await command(
    [
      "scripts/recover-operator.ts",
      rocio.accountId,
      "turno-operacion-2",
      "Acta del comité de seguridad 2026/07",
      "Sin operadores disponibles",
    ],
    maintenance,
    `pnpm -s operator:recover ${rocio.accountId} turno-operacion-2 "Acta del comité de seguridad 2026/07" "Sin operadores disponibles"`,
  );
  expect(operatorRecovery.code).not.toBe(0);
  await cu.terminal(
    page,
    "recuperar-operador-rechazado",
    operatorRecovery.shown,
    operatorRecovery.output,
  );
  await Promise.all([operatorApi, iriaApi, damianApi].map((c) => c.dispose()));
});
