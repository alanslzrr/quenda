import type { Page } from "@playwright/test";
import { Capture, expect, test } from "./capture";
import {
  closeSql,
  code,
  expireMfa,
  privacyMunicipality,
  profile,
  register,
  signInAs,
  tallShot,
} from "./people";

// CU-21 — Ejecutar una actuación individual de privacidad. Un municipio propio
// (Concello de Pedralonga) con personal de privacidad y tres vecinos con perfil
// municipal: se suprime uno, se bloquea otro y el tercero queda protegido por
// una excepción. Nada de esto alcanza a los municipios de demostración.

test.afterAll(closeSql);

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function action(
  page: Page,
  view: string,
  target: string,
  values: { block?: string; authorization: string; reason: string },
) {
  await page.goto(`${view}/actuacion`);
  await choose(page, "Familia de datos", "Perfiles municipales");
  await page.getByLabel("Referencia del registro").fill(target);
  await choose(
    page,
    "Actuación",
    values.block ? "Bloquear y conservar restringido" : "Suprimir",
  );
  if (values.block)
    await page.getByLabel(/Duración autorizada/).fill(values.block);
  await page
    .getByLabel("Referencia de autorización", { exact: true })
    .fill(values.authorization);
  await page.getByLabel("Motivo", { exact: true }).fill(values.reason);
  await page.getByRole("checkbox", { name: /Confirmo la actuación/ }).check();
  return page.getByRole("button", { name: "Ejecutar actuación" });
}
const outcome = (page: Page, title: string) =>
  page
    .getByRole("status")
    .filter({ has: page.getByRole("heading", { name: title }) });

test("CU-21 ejecutar una actuación individual de privacidad", async ({
  page,
}) => {
  test.setTimeout(420000);
  const cu = new Capture("CU-21");
  const { tenantId, admin, privacy } = await privacyMunicipality(
    "Concello de Pedralonga",
    ["Noela Rey Paredes", "noela.rey@demo.test"],
    ["Fiz Abelenda Mato", "fiz.abelenda@demo.test"],
  );
  const residents = await Promise.all(
    [
      ["Telmo Varela Brea", "telmo.varela@demo.test"],
      ["Ledicia Pazos Rial", "ledicia.pazos@demo.test"],
      ["Olalla Moar Sixto", "olalla.moar@demo.test"],
    ].map(([name, email]) => register(name, email, { mfa: false })),
  );
  const [telmo, ledicia, olalla] = residents;
  for (const resident of residents)
    await profile(tenantId, resident.accountId, 120);
  // Una excepción vigente protege a Olalla (su alta se muestra en CU-20).
  const hold = await privacy.api.post(
    `/api/municipalities/${tenantId}/retention-holds`,
    {
      data: {
        category: "MUNICIPAL_PROFILE",
        subjectId: olalla.accountId,
        authorizationReference: "Diligencia de la inspección 88/2026",
        reason: "Inspección de servicios en curso",
      },
    },
  );
  expect(hold.status()).toBe(201);
  const view = `/administracion/${tenantId}/privacidad`;

  // Paso 1: abrir la actuación individual.
  await signInAs(page, privacy);
  await page.goto(view);
  const entry = page.getByRole("link", { name: "Actuación individual" });
  await expect(entry).toBeVisible();
  await cu.shot(page, "entrada-actuacion", { target: entry });

  // Paso 2: identificar familia, registro y actuación, con su autorización.
  const erase = await action(page, view, telmo.accountId, {
    authorization: "Solicitud de supresión RS-2026/552",
    reason: "Ejercicio del derecho de supresión",
  });
  await tallShot(cu, page, "formulario-supresion", { target: erase });
  await erase.click();

  // Paso 3: Quenda comprueba ámbito, excepciones y dependencias, y aplica.
  const applied = outcome(page, "Actuación aplicada");
  await expect(applied).toBeVisible();
  await cu.shot(page, "supresion-aplicada", { target: applied });

  // Alternativa: bloquear y conservar restringido durante un plazo autorizado.
  const block = await action(page, view, ledicia.accountId, {
    block: "1825",
    authorization: "Resolución de limitación RL-2026/014",
    reason: "Conservación restringida por reclamación pendiente",
  });
  await tallShot(cu, page, "formulario-bloqueo", { target: block });
  await block.click();
  const blocked = outcome(page, "Actuación aplicada");
  await expect(blocked).toBeVisible();
  await cu.shot(page, "bloqueo-aplicado", { target: blocked });

  // Alternativa: una excepción vigente impide la actuación (CONFLICT).
  await (
    await action(page, view, olalla.accountId, {
      authorization: "Solicitud de supresión RS-2026/560",
      reason: "Ejercicio del derecho de supresión",
    })
  ).click();
  const held = outcome(page, "Conflicto: actuación no aplicada");
  await expect(held).toBeVisible();
  await cu.shot(page, "conflicto-excepcion", { target: held });

  // Alternativa: permisos o dependencias vigentes impiden suprimir el perfil.
  await (
    await action(page, view, admin.accountId, {
      authorization: "Solicitud de supresión RS-2026/561",
      reason: "Ejercicio del derecho de supresión",
    })
  ).click();
  const dependent = outcome(page, "Conflicto: actuación no aplicada");
  await expect(dependent).toBeVisible();
  await cu.shot(page, "conflicto-dependencias", { target: dependent });

  // Alternativa: el conjunto ya no existe (ABSENT).
  await (
    await action(page, view, telmo.accountId, {
      authorization: "Solicitud de supresión RS-2026/552",
      reason: "Comprobación de la supresión",
    })
  ).click();
  const absent = outcome(
    page,
    "Conjunto operativo ausente: no se ha aplicado la actuación",
  );
  await expect(absent).toBeVisible();
  await cu.shot(page, "conjunto-ausente", { target: absent });

  // Alternativa: la verificación en dos pasos ya no es reciente.
  await expireMfa(privacy.accountId);
  const again = await action(page, view, ledicia.accountId, {
    authorization: "Solicitud de supresión RS-2026/570",
    reason: "Ejercicio del derecho de supresión",
  });
  await again.click();
  const notice = page.getByRole("status", {
    name: "Verificación de seguridad",
  });
  await expect(notice).toBeVisible();
  const verify = notice.getByRole("button", { name: "Verificar acceso" });
  await cu.shot(page, "verificacion-caducada", { target: verify });
  await verify.click();
  const dialog = page.getByRole("dialog", { name: "Verificar acceso" });
  await dialog
    .getByLabel("Código de autenticación", { exact: true })
    .fill(await code(privacy.secret as string));
  await dialog.getByRole("button", { name: "Verificar acceso" }).click();
  await expect(dialog).toBeHidden();
});
