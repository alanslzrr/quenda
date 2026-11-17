import { Capture, expect, latestMail, mailUrl, test } from "./capture";
import {
  newPassword,
  notice,
  registerResident,
  shot,
  signInWith,
} from "./citizen";

// CU-15 — Reactivar una cuenta. Cuenta nueva dada de baja voluntariamente
// antes del escenario (CU-14), sin capturas de esa parte.
const cu = new Capture("CU-15");

test("CU-15 reactivar una cuenta", async ({ page }) => {
  const email = await registerResident(page, "Uxío Barreiro Pena");
  await page.goto("/perfil/privacidad");
  await page.getByLabel("Contraseña actual").fill(newPassword);
  await page
    .getByRole("checkbox", { name: "Quiero desactivar mi cuenta global" })
    .check();
  await page.getByRole("button", { name: "Confirmar baja de cuenta" }).click();
  await expect(page).toHaveURL(/notice=deactivated/);

  // Paso 1: «Reactivar mi cuenta» desde el acceso.
  await page.goto("/acceso");
  const link = page.getByRole("link", { name: "Reactivar mi cuenta" });
  await shot(cu, page, "enlace-reactivar", { target: link });
  await link.click();
  await expect(
    page.getByRole("heading", { name: "Reactivar tu cuenta" }),
  ).toBeVisible();
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel("Contraseña actual").fill(newPassword);
  const send = page.getByRole("button", { name: "Enviar instrucciones" });
  await shot(cu, page, "solicitar-reactivacion", { target: send });
  await send.click();

  // Paso 2: la respuesta no revela si la cuenta existe.
  const sent = notice(
    page,
    "Si la solicitud es válida, recibirás un correo con las instrucciones.",
  );
  await expect(sent).toBeVisible();
  await shot(cu, page, "solicitud-enviada", { target: sent });

  const message = await latestMail(email, "/account/reactivation");
  await cu.mail(page, "correo-de-reactivacion", message);

  // Paso 2: confirmar con la contraseña. Alternativa: contraseña incorrecta.
  await page.goto(mailUrl(message));
  const current = page.getByLabel("Contraseña actual");
  const reactivate = page.getByRole("button", {
    name: "Reactivar cuenta",
    exact: true,
  });
  await current.fill("no-es-la-contrasena");
  await reactivate.click();
  const wrong = page.getByRole("main").getByRole("alert");
  await expect(wrong).toBeVisible();
  await shot(cu, page, "contrasena-incorrecta", { target: wrong });

  await current.fill(newPassword);
  await shot(cu, page, "confirmar-reactivacion", { target: reactivate });
  await reactivate.click();
  const done = notice(page, /Cuenta reactivada/);
  await expect(done).toBeVisible();
  await shot(cu, page, "cuenta-reactivada", { target: done });

  // Paso 3: nueva sesión.
  await signInWith(page, email);
  await expect(page).toHaveURL(/\/perfil$/);
  await shot(cu, page, "sesion-nueva");

  // Alternativa: el enlace ya utilizado no reactiva otra vez.
  await page.context().clearCookies();
  await page.goto(mailUrl(message));
  await page.getByLabel("Contraseña actual").fill(newPassword);
  await page
    .getByRole("button", { name: "Reactivar cuenta", exact: true })
    .click();
  const used = page.getByRole("main").getByRole("alert");
  await expect(used).toBeVisible();
  await shot(cu, page, "enlace-ya-utilizado", { target: used });
});
