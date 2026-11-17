import type { Page } from "@playwright/test";
import { Capture, expect, signIn, test } from "./capture";
import {
  choose,
  localDate,
  pickDateTime,
  ribasanta,
  secondBrowser,
  snap,
  units,
  valdeira,
} from "./steps";

const approve = async (page: Page) => {
  await page
    .getByRole("checkbox", { name: "Confirmo esta versión y mis unidades" })
    .check();
  return page.getByRole("button", { name: "Aprobar versión", exact: true });
};

/** Withdraws the restrictive binding a unit keeps after the agreement ends. */
async function reopen(page: Page, tenant: string, unit: string) {
  await page.goto(
    `/administracion/${tenant}/convenios/unidades/${unit}/reapertura`,
  );
  await page.getByLabel("Motivo", { exact: true }).fill("Reapertura municipal");
  await page
    .getByRole("checkbox", {
      name: "Confirmo la retirada de esta vinculación",
    })
    .check();
  const release = page.getByRole("button", {
    name: "Retirar vinculación",
    exact: true,
  });
  return release;
}

// CU-10 — Gestionar un convenio. Valdeira propone un convenio con Ribasanta,
// ambos municipios lo aprueban y Valdeira lo activa. Después Ribasanta lo
// suspende y ambos retiran la vinculación de sus pistas, de modo que el resto
// de escenarios encuentran las unidades abiertas como en el sembrado.
test("CU-10 gestionar un convenio", async ({ page, browser }) => {
  test.setTimeout(300000);
  const cu = new Capture("CU-10");
  await signIn(page, "administrator");
  await page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("link", { name: "Gestión", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Gestión municipal" })
    .getByRole("link", { name: "Convenios", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Convenios intermunicipales" }),
  ).toBeVisible();
  const create = page.getByRole("link", { name: "Nuevo convenio" });
  await snap(cu, page, "convenios", { target: create });

  // Paso 1: registrar la versión con participantes, unidades y condiciones.
  await create.click();
  await page
    .getByLabel("Nombre del convenio", { exact: true })
    .fill("Red deportiva Valdeira–Ribasanta");
  await pickDateTime(page, "Inicio de vigencia", localDate(0), "00:00");
  await pickDateTime(page, "Fin de vigencia", localDate(120), "23:59");
  await page
    .getByLabel("Finalidad", { exact: true })
    .fill("Compartir pistas entre las dos poblaciones en horario de tarde.");
  await page
    .getByLabel("Base jurídica", { exact: true })
    .fill("Convenio de colaboración intermunicipal aprobado en pleno.");
  await page
    .getByLabel("Responsabilidades", { exact: true })
    .fill(
      "Cada municipio gestiona sus instalaciones y atiende sus incidencias.",
    );
  await page
    .getByLabel("Conservación acordada", { exact: true })
    .fill("Un año después del fin de la vigencia.");
  await page
    .getByLabel("Máximo de reservas por cuenta y semana (opcional)")
    .fill("2");
  await choose(page, "Añadir unidad municipal", "Pista de tenis");
  await page
    .getByRole("button", { name: "Añadir unidad", exact: true })
    .click();
  await page.getByRole("button", { name: "Añadir participante" }).click();
  await page.getByLabel("Municipio 2", { exact: true }).fill(ribasanta);
  await page
    .getByLabel("Unidades: un identificador por línea · 2", { exact: true })
    .fill(units.sportsCourt);
  await page
    .getByRole("checkbox", { name: "Confirmo la configuración del borrador" })
    .check();
  const draft = page.getByRole("button", {
    name: "Crear borrador",
    exact: true,
  });
  await snap(cu, page, "nuevo-convenio", { tall: true, target: draft });
  await draft.click();
  await expect(page).toHaveURL(/\/convenios\/[\da-f-]+\/versiones\/1$/);
  const version = new URL(page.url()).pathname;
  const agreement = version.split("/convenios/")[1]?.split("/")[0] ?? "";
  await expect(page.getByText("BORRADOR", { exact: true })).toBeVisible();

  // Paso 2: Valdeira aprueba esta versión y sus unidades.
  const approval = await approve(page);
  await snap(cu, page, "aprobar-valdeira", { tall: true, target: approval });
  await approval.click();
  await expect(approval).toHaveCount(0);

  const other = await secondBrowser(browser, page);
  try {
    const xoan = await other.newPage();
    await signIn(xoan, "partner");
    // Paso 2: Ribasanta aprueba la misma versión y su unidad.
    await xoan.goto(`/administracion/${ribasanta}/convenios`);
    const listed = xoan.getByRole("link", { name: /Red deportiva/ }).first();
    await expect(listed).toBeVisible();
    await snap(cu, xoan, "convenio-en-ribasanta", { target: listed });
    await listed.click();
    const theirs = await approve(xoan);
    await snap(cu, xoan, "aprobar-ribasanta", { tall: true, target: theirs });
    await theirs.click();
    await expect(theirs).toHaveCount(0);

    // Paso 3: con la revisión jurídica registrada, Valdeira activa la versión.
    await page.reload();
    await expect(page.getByText("APROBADO", { exact: true })).toBeVisible();
    await page
      .getByLabel("Referencia de revisión jurídica", { exact: true })
      .fill("Informe de Secretaría 2026/114");
    await page
      .getByRole("checkbox", { name: "Confirmo la activación de esta versión" })
      .check();
    const activate = page.getByRole("button", {
      name: "Activar versión",
      exact: true,
    });
    await snap(cu, page, "activar", { tall: true, target: activate });
    await activate.click();
    const active = page.getByText("ACTIVADO", { exact: true });
    await expect(active).toBeVisible();
    await snap(cu, page, "activado", { target: active });

    // Alternativa: un participante suspende el convenio con motivo.
    await xoan.reload();
    await expect(xoan.getByText("ACTIVADO", { exact: true })).toBeVisible();
    await xoan
      .getByLabel("Motivo", { exact: true })
      .fill("Obras en el polideportivo durante el invierno");
    await xoan
      .getByRole("checkbox", { name: "Confirmo la suspensión del convenio" })
      .check();
    const suspend = xoan.getByRole("button", {
      name: "Suspender convenio",
      exact: true,
    });
    await snap(cu, xoan, "suspender", { tall: true, target: suspend });
    await suspend.click();
    const suspended = xoan.getByText("SUSPENDIDO", { exact: true });
    await expect(suspended).toBeVisible();
    await snap(cu, xoan, "suspendido", { tall: true, target: suspended });

    // Alternativa: la unidad no vuelve sola al acceso abierto.
    await xoan.getByRole("link", { name: "Consultar vinculación" }).click();
    await xoan
      .getByLabel("Motivo", { exact: true })
      .fill("Reapertura de la pista al público general");
    await xoan
      .getByRole("checkbox", {
        name: "Confirmo la retirada de esta vinculación",
      })
      .check();
    const release = xoan.getByRole("button", {
      name: "Retirar vinculación",
      exact: true,
    });
    await snap(cu, xoan, "vinculacion", { tall: true, target: release });
    await release.click();
    const open = xoan.getByText("Sin vinculación restrictiva registrada.", {
      exact: true,
    });
    await expect(open).toBeVisible();
    await snap(cu, xoan, "vinculacion-retirada", { target: open });
  } finally {
    await other.close();
  }

  // Alternativa: reactivar exige una nueva versión con sus aprobaciones.
  await page.goto(version);
  await expect(page.getByText("SUSPENDIDO", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Crear nueva versión" }).click();
  await page
    .getByRole("checkbox", { name: "Confirmo la configuración del borrador" })
    .check();
  const next = page.getByRole("button", { name: "Crear versión", exact: true });
  await snap(cu, page, "nueva-version", { tall: true, target: next });
  await next.click();
  await expect(page).toHaveURL(/\/versiones\/2$/);
  const nextVersion = new URL(page.url()).pathname;
  const second = page.getByText("BORRADOR", { exact: true });
  await expect(second).toBeVisible();
  await snap(cu, page, "version-2-borrador", { tall: true, target: second });
  await page.goto(`/administracion/${valdeira}/convenios`);
  const history = page.getByRole("table", { name: "Versiones del convenio" });
  await expect(history.getByRole("row")).toHaveCount(3);
  await snap(cu, page, "versiones", {
    target: history.getByRole("link", { name: /versión 2/ }),
  });

  // Alternativa: aprobar no activa; falta la aprobación del otro municipio.
  await page.goto(nextVersion);
  const approveNext = await approve(page);
  await approveNext.click();
  await expect(approveNext).toHaveCount(0);
  const pending = page.getByText("Sin aprobación registrada.");
  await expect(pending).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Activar versión" }),
  ).toHaveCount(0);
  await snap(cu, page, "falta-aprobacion", { tall: true, target: pending });

  // Limpieza: Valdeira también reabre su pista al público.
  const reopened = await reopen(page, valdeira, units.tennis);
  await reopened.click();
  await expect(
    page.getByText("Sin vinculación restrictiva registrada.", { exact: true }),
  ).toBeVisible();
  expect(agreement).not.toBe("");
});
