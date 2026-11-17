import { randomUUID } from "node:crypto";
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

// CU-14 — Dar de baja la cuenta. Cuenta nueva con una reserva futura: la
// baja se rechaza mientras la reserva siga confirmada.
const cu = new Capture("CU-14");

test("CU-14 dar de baja la cuenta", async ({ page }) => {
  const email = await registerResident(page, "Iria Novoa Lema");
  const [slot] = await freeSlots(
    page,
    valdeira.id,
    valdeira.tennis,
    madridDate(28),
  );
  if (!slot) throw new Error("No free slot");
  const reservation = await book(page, valdeira.id, valdeira.tennis, slot);

  // Paso 1: la sección «Privacidad y baja».
  await page.goto("/perfil/privacidad");
  const section = page.getByRole("heading", { name: "Dar de baja la cuenta" });
  await expect(section).toBeVisible();
  const current = page.getByLabel("Contraseña actual");
  const wish = page.getByRole("checkbox", {
    name: "Quiero desactivar mi cuenta global",
  });
  const confirm = page.getByRole("button", {
    name: "Confirmar baja de cuenta",
  });
  await section.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await shot(cu, page, "seccion-de-baja", { target: section });

  // Alternativa: contraseña incorrecta.
  await current.fill("no-es-la-contrasena");
  await wish.check();
  await confirm.click();
  const wrong = page.getByRole("main").getByRole("alert");
  await expect(wrong).toBeVisible();
  await shot(cu, page, "contrasena-incorrecta", { target: wrong });

  // Alternativa: una reserva confirmada futura impide la baja.
  await current.fill(newPassword);
  await shot(cu, page, "confirmar-baja", { target: confirm });
  await confirm.click();
  const blocked = page
    .getByRole("main")
    .getByRole("alert")
    .filter({ hasText: /reserva/i });
  await expect(blocked).toBeVisible();
  await shot(cu, page, "reserva-futura-impide-la-baja", { target: blocked });

  // Tras cancelar la reserva, la baja procede.
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
  await page.reload();
  await current.fill(newPassword);
  await wish.check();
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
