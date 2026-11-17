import type { Page } from "@playwright/test";
import { access, Capture, expect, test } from "./capture";
import {
  closeSql,
  command,
  otherBrowser,
  privacyMunicipality,
  profile,
  register,
  signInAs,
  tallShot,
} from "./people";

// CU-20 — Aplicar una política de conservación. Un municipio propio
// (Concello de Riomaior) con personal de privacidad y dos vecinos cuyos perfiles
// municipales llevan años sin actividad. La política solo alcanza a Riomaior:
// el worker no encuentra ninguna otra política activa en la instancia, así que
// ningún dato de Valdeira ni de Ribasanta queda afectado. Al terminar, la
// política se retira.

test.afterAll(closeSql);

async function choose(page: Page, label: string, option: string | RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function policy(
  page: Page,
  view: string,
  values: {
    days: string;
    block?: string;
    purpose: string;
    approval: string;
  },
) {
  await page.goto(`${view}/aprobar`);
  await choose(page, "Familia de datos", "Perfiles municipales");
  await page.getByLabel("Plazo de conservación (días)").fill(values.days);
  await choose(
    page,
    "Actuación",
    values.block ? "Bloquear y conservar restringido" : "Suprimir",
  );
  if (values.block)
    await page.getByLabel(/Duración autorizada/).fill(values.block);
  await page.getByLabel("Finalidad", { exact: true }).fill(values.purpose);
  await page
    .getByLabel("Referencia del responsable")
    .fill("Alcaldía de Riomaior, responsable del tratamiento");
  await page.getByLabel("Referencia de aprobación").fill(values.approval);
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Aplicación del registro de actividades de tratamiento");
  await page.getByRole("checkbox", { name: /Confirmo la política/ }).check();
}

test("CU-20 aplicar una política de conservación", async ({
  page,
  browser,
}) => {
  test.setTimeout(420000);
  const cu = new Capture("CU-20");
  const { tenantId, admin, privacy } = await privacyMunicipality(
    "Concello de Riomaior",
    ["Antía Fraga Moure", "antia.fraga@demo.test"],
    ["Lois Bermúdez Pena", "lois.bermudez@demo.test"],
  );
  // Dos vecinos sin actividad en Riomaior desde hace más de dos años.
  const carme = await register("Carme Lago Rivas", "carme.lago@demo.test", {
    mfa: false,
  });
  const xurxo = await register("Xurxo Ferro Vale", "xurxo.ferro@demo.test", {
    mfa: false,
  });
  await profile(tenantId, carme.accountId, 900);
  await profile(tenantId, xurxo.accountId, 800);
  const view = `/administracion/${tenantId}/privacidad`;

  // Paso 1: el personal de privacidad entra en «Conservación y derechos».
  await signInAs(page, privacy);
  await page.goto(`/administracion/${tenantId}`);
  const entry = page.getByRole("link", { name: "Conservación y derechos" });
  await expect(entry).toBeVisible();
  await cu.shot(page, "entrada-conservacion", { target: entry });
  await entry.click();
  await expect(page.getByText("No hay políticas registradas.")).toBeVisible();
  const approve = page.getByRole("link", { name: "Registrar política" });
  await cu.shot(page, "sin-politicas", { target: approve });

  // Paso 2: registrar la política aprobada por el responsable.
  await policy(page, view, {
    days: "730",
    block: "1825",
    purpose: "Gestión de la relación de los vecinos con el servicio deportivo",
    approval: "Resolución de alcaldía 2026/045",
  });
  const register$ = page.getByRole("button", { name: "Registrar política" });
  await tallShot(cu, page, "formulario-politica", { target: register$ });
  await register$.click();
  const registered = page
    .getByRole("status")
    .filter({ hasText: "Política registrada" });
  await expect(registered).toBeVisible();
  await cu.shot(page, "politica-registrada", { target: registered });
  await page.getByRole("link", { name: "Políticas", exact: true }).click();
  const active = page
    .locator("section, article, li")
    .filter({ hasText: "Resolución de alcaldía 2026/045" })
    .last();
  await expect(active).toContainText("Activa");
  await tallShot(cu, page, "politica-activa", { target: active });

  // Paso 3: una excepción de conservación protege a una vecina concreta.
  await page.goto(`${view}/registrar-excepcion`);
  await choose(page, "Familia de datos", "Perfiles municipales");
  await choose(page, "Alcance de la excepción", "Un interesado");
  await page.getByLabel("Identificador de la cuenta").fill(carme.accountId);
  await page
    .getByLabel("Referencia de autorización", { exact: true })
    .fill("Requerimiento judicial 311/2026");
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Procedimiento judicial en curso");
  await page.getByRole("checkbox", { name: /Confirmo la excepción/ }).check();
  const hold = page.getByRole("button", { name: "Registrar excepción" });
  await tallShot(cu, page, "formulario-excepcion", { target: hold });
  await hold.click();
  const held = page
    .getByRole("status")
    .filter({ hasText: "Excepción registrada" });
  await expect(held).toBeVisible();
  await cu.shot(page, "excepcion-registrada", { target: held });

  // Paso 4: el worker ejecuta los vencimientos (proceso de segundo plano).
  const { databases, mail } = await access();
  const origin = test.info().project.use.baseURL as string;
  const worker = await command(
    ["src/email-worker.ts", "--once"],
    {
      WORKER_DATABASE_URL: databases.worker,
      EMAIL_LOCALE: "es",
      AUTH_ORIGIN: origin,
      LOCAL_MAIL_DIR: mail,
    },
    "WORKER_DATABASE_URL=$WORKER_DATABASE_URL EMAIL_LOCALE=es AUTH_ORIGIN=$AUTH_ORIGIN node src/email-worker.ts --once",
  );
  expect(worker.code).toBe(0);
  expect(worker.output).toContain(
    '"event":"RETENTION_BATCH","examined":2,"conflicts":1,"processed":1',
  );
  await cu.terminal(page, "worker-conservacion", worker.shown, worker.output);

  // Paso 5: el conflicto queda señalado y los datos protegidos se conservan.
  await page.goto(`${view}/excepciones`);
  const conflicts = page.getByRole("heading", {
    name: "Conflictos de conservación",
  });
  await expect(conflicts).toBeVisible();
  await expect(page.getByText(carme.accountId).first()).toBeVisible();
  await tallShot(cu, page, "excepciones-y-conflictos", { target: conflicts });

  // Alternativa: una nueva aprobación sustituye a la política anterior.
  await policy(page, view, {
    days: "1095",
    purpose: "Gestión de la relación de los vecinos con el servicio deportivo",
    approval: "Resolución de alcaldía 2026/071",
  });
  await page.getByRole("button", { name: "Registrar política" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Política registrada" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Políticas", exact: true }).click();
  const superseded = page
    .locator("section, article, li")
    .filter({ hasText: "Resolución de alcaldía 2026/045" })
    .last();
  await expect(superseded).toContainText("Sustituida");
  await tallShot(cu, page, "politica-sustituida", { target: superseded });

  // Alternativa: levantar la excepción cuando deja de ser necesaria.
  await page.goto(`${view}/excepciones`);
  // The card's own action, not the section menu entry of the same name.
  const release = page.locator('a[href*="/levantar?id="]');
  await cu.shot(page, "levantar-excepcion", { target: release });
  await release.click();
  await page
    .getByLabel("Referencia de autorización", { exact: true })
    .fill("Auto de archivo 311/2026");
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Procedimiento judicial archivado");
  await page
    .getByRole("checkbox", { name: /Confirmo el levantamiento/ })
    .check();
  const lift = page.getByRole("button", { name: "Levantar excepción" });
  await tallShot(cu, page, "formulario-levantamiento", { target: lift });
  await lift.click();
  const lifted = page
    .getByRole("status")
    .filter({ hasText: "Levantamiento registrado" });
  await expect(lifted).toBeVisible();
  await cu.shot(page, "excepcion-levantada", { target: lifted });

  // Alternativa: una excepción exige un interesado o registro existente.
  await page.goto(`${view}/registrar-excepcion`);
  await choose(page, "Familia de datos", "Perfiles municipales");
  await choose(page, "Alcance de la excepción", "Un interesado");
  await page
    .getByLabel("Identificador de la cuenta")
    .fill("cuenta-que-no-existe");
  await page
    .getByLabel("Referencia de autorización", { exact: true })
    .fill("Requerimiento 12/2026");
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Conservación cautelar");
  await page.getByRole("checkbox", { name: /Confirmo la excepción/ }).check();
  await page.getByRole("button", { name: "Registrar excepción" }).click();
  const missing = page.locator("form").getByRole("alert").first();
  await expect(missing).toBeVisible();
  await cu.shot(page, "excepcion-sin-interesado", { target: missing });

  // Alternativa: retirar la política detiene nuevas actuaciones.
  await page.getByRole("link", { name: "Políticas", exact: true }).click();
  const current = page
    .locator("section, article, li")
    .filter({ hasText: "Resolución de alcaldía 2026/071" })
    .last();
  const withdraw = current.getByRole("link", { name: "Retirar política" });
  await cu.shot(page, "retirar-politica", { target: withdraw });
  await withdraw.click();
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Revocación de la aprobación por el responsable");
  await page.getByRole("checkbox", { name: /Confirmo la retirada/ }).check();
  await page.getByRole("button", { name: "Retirar política" }).click();
  const revoked = page
    .getByRole("status")
    .filter({ hasText: "Retirada registrada" });
  await expect(revoked).toBeVisible();
  await cu.shot(page, "politica-retirada", { target: revoked });

  // Alternativa: sin permisos de privacidad no se accede a estos controles.
  const adminContext = await otherBrowser(browser);
  const administrator = await adminContext.newPage();
  await signInAs(administrator, admin);
  await administrator.goto(view);
  const denied = administrator.getByText(
    "No tienes permiso para esta operación.",
  );
  await expect(denied).toBeVisible();
  await cu.shot(administrator, "administrador-sin-permiso", { target: denied });
  await adminContext.close();
});
