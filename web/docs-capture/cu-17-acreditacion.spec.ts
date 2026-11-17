import type { Page } from "@playwright/test";
import { Capture, expect, signIn, test } from "./capture";
import {
  accountId,
  activeAgreement,
  checkout,
  chooseValue,
  closeAgreement,
  freeSlot,
  localDate,
  pickDateTime,
  secondBrowser,
  signInResident,
  snap,
  units,
  valdeira,
} from "./steps";

const accredited = "xian.lopez@demo.test";
const other = "noa.fernandez@demo.test";

/** Accepts the rules and confirms the reservation on the checkout page. */
async function confirm(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Revisa tu reserva" }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: /He leído y acepto las normas de uso/ })
    .check();
  const button = page.getByRole("button", {
    name: "Confirmar reserva",
    exact: true,
  });
  await button.click();
  return button;
}

// CU-17 — Gestionar una acreditación de uso. Valdeira es el municipio emisor
// de un convenio que exige acreditación. Al terminar, el convenio se suspende
// y las pistas vuelven a estar abiertas para los demás escenarios.
test("CU-17 gestionar una acreditación de uso", async ({ page, browser }) => {
  test.setTimeout(300000);
  const cu = new Capture("CU-17");
  await signIn(page, "administrator");
  const ribasantaBrowser = await secondBrowser(browser, page);
  const residents = await secondBrowser(browser, page);
  try {
    const xoan = await ribasantaBrowser.newPage();
    await signIn(xoan, "partner");
    const { agreementId, path } = await activeAgreement(
      page,
      xoan,
      "Programa de deporte adaptado",
      { accreditation: true },
    );

    // Paso 1: desde «Acreditaciones de uso», ir al convenio que las exige.
    await page.goto(`/administracion/${valdeira}`);
    await page
      .getByRole("navigation", { name: "Gestión municipal" })
      .getByRole("link", { name: "Acreditaciones de uso", exact: true })
      .click();
    const fromAgreement = page.getByRole("link", {
      name: "Emitir desde un convenio",
    });
    await snap(cu, page, "acreditaciones", { target: fromAgreement });
    await page.goto(path);
    const issue = page.getByRole("link", {
      name: "Emitir acreditación",
      exact: true,
    });
    await expect(issue).toBeVisible();
    await snap(cu, page, "convenio-con-acreditacion", {
      tall: true,
      target: issue,
    });

    // Paso 1: registrar cuenta, vigencia y referencia de la verificación.
    await issue.click();
    await chooseValue(
      page,
      "accountId",
      "Persona beneficiaria",
      await accountId(accredited),
    );
    await pickDateTime(page, "Inicio de acreditación", localDate(0), "00:00");
    await pickDateTime(page, "Fin de acreditación", localDate(60), "23:59");
    await page
      .getByLabel("Referencia de verificación", { exact: true })
      .fill("Expediente de Servicios Sociales 2026/318");
    await page
      .getByRole("checkbox", {
        name: "Confirmo la verificación y la vigencia indicadas",
      })
      .check();
    const send = page.getByRole("button", {
      name: "Emitir acreditación",
      exact: true,
    });
    await snap(cu, page, "emitir", { tall: true, target: send });
    await send.click();

    // Paso 2: Quenda conserva la acreditación y su emisor.
    const issued = page.getByText(/Acreditación emitida\./);
    await expect(issued).toBeVisible();
    await snap(cu, page, "emitida", { tall: true, target: issued });

    // Paso 3: al reservar, la acreditación cubre todo el intervalo.
    const resident = await residents.newPage();
    await signInResident(resident, accredited);
    await resident.goto(
      checkout(valdeira, units.tennis, await freeSlot(valdeira, units.tennis)),
    );
    await confirm(resident);
    const booked = resident.getByRole("heading", {
      name: "Reserva confirmada",
      exact: true,
    });
    await expect(booked).toBeVisible();
    await snap(cu, resident, "reserva-con-acreditacion", { target: booked });

    // Alternativa: sin acreditación no se confirma la reserva.
    const neighbour = await (await secondBrowser(browser, page)).newPage();
    await signInResident(neighbour, other);
    await neighbour.goto(
      checkout(
        valdeira,
        units.tennis,
        await freeSlot(valdeira, units.tennis, 3),
      ),
    );
    await confirm(neighbour);
    const refused = neighbour.getByRole("alert").first();
    await expect(refused).toBeVisible();
    await snap(cu, neighbour, "reserva-sin-acreditacion", {
      fullPage: true,
      target: refused,
    });
    await neighbour.context().close();

    // Alternativa: el emisor revoca la acreditación.
    await page
      .getByRole("navigation", { name: "Gestión municipal" })
      .getByRole("link", { name: "Acreditaciones de uso", exact: true })
      .click();
    const credential = page.getByRole("combobox", {
      name: "Acreditación emitida",
    });
    await expect(credential).toBeEnabled();
    await credential.click();
    await page.getByRole("option").first().click();
    await page
      .getByLabel("Motivo", { exact: true })
      .fill("La persona ya no cumple los requisitos del programa");
    await page
      .getByRole("checkbox", { name: "Confirmo la revocación", exact: true })
      .check();
    const revoke = page.getByRole("button", {
      name: "Revocar acreditación",
      exact: true,
    });
    await snap(cu, page, "revocar", { tall: true, target: revoke });
    await revoke.click();
    const revoked = page.getByText(/Revocación registrada/);
    await expect(revoked).toBeVisible();
    await snap(cu, page, "revocada", { tall: true, target: revoked });

    // Tras la revocación no se confirman reservas nuevas con ella.
    await resident.goto(
      checkout(
        valdeira,
        units.tennis,
        await freeSlot(valdeira, units.tennis, 4),
      ),
    );
    await confirm(resident);
    const after = resident.getByRole("alert").first();
    await expect(after).toBeVisible();
    await snap(cu, resident, "reserva-tras-revocar", {
      fullPage: true,
      target: after,
    });

    await closeAgreement(page, xoan, agreementId);
  } finally {
    await residents.close();
    await ribasantaBrowser.close();
  }
});
