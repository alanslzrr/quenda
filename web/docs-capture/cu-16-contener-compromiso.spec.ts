import { hashPassword } from "better-auth/crypto";
import { pickDateTime } from "../test/browser/date-fields";
import { access, Capture, expect, test } from "./capture";
import {
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
// operación recupera el acceso personal de una vecina suspendida con el
// comando de mantenimiento. No se suspende ni se retira a nadie sembrado.

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
  const sabela = await register(
    "Sabela Quintas Lema",
    "sabela.quintas@demo.test",
    { mfa: false },
  );

  // Preparación: el operador incorpora Lousadela, Iria acepta la
  // administración e invita a Damián como gestor, que también acepta.
  const operatorApi = await apiSignIn(operator);
  const created = await operatorApi.post("/api/municipalities", {
    data: {
      name: "Concello de Lousadela",
      timezone: "Europe/Madrid",
      administratorId: iria.accountId,
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
        accountId: damian.accountId,
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
  await admin.getByLabel("Identificador de cuenta").fill(damian.accountId);
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
  const saved = admin
    .getByRole("region", { name: "Gestión municipal" })
    .getByText("Cambios guardados.");
  await expect(saved).toBeVisible();
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
  const none = manager.getByText("No tienes permisos municipales vigentes.");
  await expect(none).toBeVisible();
  await cu.shot(manager, "gestor-sin-permisos", { target: none });
  await damianContext.close();

  // B. Suspensión global: el operador suspende a la administradora.
  await signInRole(page, "operator");
  await page.goto(`${view}/operadores`);
  const suspendLink = page.getByRole("link", { name: "Suspender identidad" });
  await cu.shot(page, "menu-suspender", { target: suspendLink });
  await suspendLink.click();
  await page.getByLabel("Identificador de cuenta").fill(iria.accountId);
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Credenciales de la administradora expuestas");
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
  await page.getByLabel("Identificador de cuenta").fill(rocio.accountId);
  await pickDateTime(page, "Aceptar antes de", deadline());
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Relevo tras suspender a la administradora");
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

  // Alternativa: con un administrador habilitado no hay recuperación.
  await page.goto(`${view}/recuperar-responsable`);
  await page.getByLabel("Identificador del municipio").fill(tenantId);
  await page.getByLabel("Identificador de cuenta").fill(damian.accountId);
  await pickDateTime(page, "Aceptar antes de", deadline());
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Segundo relevo solicitado");
  await page
    .getByLabel("Referencia de verificación de autoridad")
    .fill("Decreto de alcaldía 2026/119");
  await page.getByRole("checkbox", { name: /Confirmo el ámbito/ }).check();
  await page.getByRole("button", { name: "Invitar a un sustituto" }).click();
  const conflict = page.locator("form").getByRole("alert").first();
  await expect(conflict).toBeVisible();
  await cu.shot(page, "recuperacion-rechazada", { target: conflict });

  // D. Recuperación del acceso personal por el personal de operación.
  // Una vecina con la cuenta comprometida ha sido suspendida por el operador.
  expect(
    (
      await operatorApi.post(
        `/api/platform/accounts/${sabela.accountId}/suspend`,
        { data: { reason: "Acceso desde una ubicación no reconocida" } },
      )
    ).status(),
  ).toBe(200);
  const { databases } = await access();
  const maintenance = { MIGRATION_DATABASE_URL: databases.migration };
  const recoverArgs = [
    sabela.accountId,
    "turno-operacion-2",
    "Comparecencia presencial con DNI, expediente SEG-2026-031",
    "Contraseña sustituida por la titular, expediente SEG-2026-031",
    "Suplantación contenida",
  ];
  const shownRecover = `MIGRATION_DATABASE_URL=$MIGRATION_DATABASE_URL node scripts/recover-account.ts ${sabela.accountId} turno-operacion-2 "Comparecencia presencial con DNI, expediente SEG-2026-031" "Contraseña sustituida por la titular, expediente SEG-2026-031" "Suplantación contenida"`;
  // Alternativa: sin sustituir las credenciales comprometidas no se recupera.
  const early = await command(
    ["scripts/recover-account.ts", ...recoverArgs],
    maintenance,
    shownRecover,
  );
  expect(early.code).not.toBe(0);
  await cu.terminal(
    page,
    "recuperar-sin-credenciales",
    early.shown,
    early.output,
  );

  // Sustitución de la contraseña por el procedimiento controlado (sin pantalla).
  const replacement = `Nueva-clave-${Date.now()}`;
  await sql(
    `UPDATE auth.account SET password=$2, "updatedAt"=now() WHERE "userId"=$1 AND "providerId"='credential'`,
    [sabela.accountId, await hashPassword(replacement)],
  );
  const recovered = await command(
    ["scripts/recover-account.ts", ...recoverArgs],
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

  const sabelaContext = await otherBrowser(browser);
  const resident = await sabelaContext.newPage();
  await signInAs(resident, { ...sabela, password: replacement });
  await expect(resident).toHaveURL(/\/perfil/);
  await cu.shot(resident, "acceso-recuperado");
  await sabelaContext.close();

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
    `MIGRATION_DATABASE_URL=$MIGRATION_DATABASE_URL node scripts/recover-operator.ts ${rocio.accountId} turno-operacion-2 "Acta del comité de seguridad 2026/07" "Sin operadores disponibles"`,
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
