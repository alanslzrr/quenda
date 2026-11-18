import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { Capture, expect, test } from "./capture";
import {
  book,
  freeSlots,
  madridDate,
  newPassword,
  notice,
  registerResident,
  shot,
  valdeira,
} from "./citizen";

// CU-14 — Dar de baja la cuenta. Cuentas nuevas: una sin reservas recorre el
// flujo principal; otra, con una reserva futura, muestra los rechazos.
const cu = new Capture("CU-14");

function form(page: Page) {
  return {
    section: page.getByRole("heading", { name: "Dar de baja la cuenta" }),
    current: page.getByLabel("Contraseña actual"),
    wish: page.getByRole("checkbox", {
      name: "Quiero desactivar mi cuenta global",
    }),
    confirm: page.getByRole("button", { name: "Confirmar baja de cuenta" }),
  };
}

test("CU-14 dar de baja la cuenta", async ({ page }) => {
  const email = await registerResident(page, "Olalla Novoa Lema");
  const { section, current, wish, confirm } = form(page);

  // Paso 1: la sección «Privacidad y baja».
  await page.goto("/perfil/privacidad");
  await expect(section).toBeVisible();
  // The whole page, so that no paragraph above the section is cut in half.
  await shot(cu, page, "seccion-de-baja", { target: section, fullPage: true });

  // Paso 2: contraseña, casilla y confirmación.
  await current.fill(newPassword);
  await wish.check();
  await shot(cu, page, "confirmar-baja", { target: confirm });
  await confirm.click();

  // Paso 3: cuenta desactivada y sesión cerrada.
  await expect(page).toHaveURL(/notice=deactivated/);
  const done = notice(page, "Cuenta desactivada.");
  await expect(done).toBeVisible();
  await shot(cu, page, "cuenta-desactivada", { target: done });

  // Después de la baja no se puede iniciar sesión: hay que reactivarla (CU-15).
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^Contraseña$/).fill(newPassword);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  const refused = page.getByRole("main").getByRole("alert").last();
  await expect(refused).toBeVisible();
  await shot(cu, page, "acceso-tras-la-baja", { target: refused });
});

test("CU-14 bajas rechazadas", async ({ page }) => {
  await registerResident(page, "Rosalía Couto Vidal");
  const [slot] = await freeSlots(
    page,
    valdeira.id,
    valdeira.tennis,
    madridDate(28),
  );
  if (!slot) throw new Error("No free slot");
  const reservation = await book(page, valdeira.id, valdeira.tennis, slot);
  const { section, current, wish, confirm } = form(page);
  await page.goto("/perfil/privacidad");
  await expect(section).toBeVisible();

  // Alternativa: contraseña incorrecta.
  await current.fill("no-es-la-contrasena");
  await wish.check();
  await confirm.click();
  const wrong = page.getByRole("main").getByRole("alert");
  await expect(wrong).toBeVisible();
  await shot(cu, page, "contrasena-incorrecta", { target: wrong });

  // Alternativa: una reserva confirmada futura impide la baja. Formulario
  // recién cargado, sin el error anterior.
  await page.reload();
  await current.fill(newPassword);
  await wish.check();
  await confirm.click();
  const blocked = page
    .getByRole("main")
    .getByRole("alert")
    .filter({ hasText: /reserva/i });
  await expect(blocked).toBeVisible();
  await shot(cu, page, "reserva-futura-impide-la-baja", { target: blocked });

  // La cuenta sigue activa; se cancela la reserva para no dejarla ocupada.
  const cancelled = await page.request.post(
    `/api/municipalities/${valdeira.id}/reservations/${reservation.id}/cancel`,
    {
      headers: {
        "Idempotency-Key": randomUUID(),
        Origin: new URL(page.url()).origin,
      },
      data: { expectedRevision: reservation.revision },
    },
  );
  expect(cancelled.ok()).toBe(true);
});
