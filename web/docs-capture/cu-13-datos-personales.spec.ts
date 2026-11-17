import { randomUUID } from "node:crypto";
import { Capture, expect, latestMail, mailUrl, test } from "./capture";
import {
  newPassword,
  notice,
  registerResident,
  shot,
  signInWith,
} from "./citizen";

// CU-13 — Actualizar datos personales y correo. Cuenta nueva: el cambio de
// correo cierra sus sesiones y no debe afectar a las cuentas sembradas.
const cu = new Capture("CU-13");

test("CU-13 actualizar datos personales y correo", async ({ page }) => {
  const email = await registerResident(page, "Antía Rey Barreiro");
  const next = `antia.${randomUUID().slice(0, 8)}@demo.test`;

  // Paso 1: cambiar el nombre.
  await page.goto("/perfil/datos");
  const name = page.getByLabel("Nombre", { exact: true });
  await expect(name).toHaveValue("Antía Rey Barreiro");
  await name.fill("Antía Rey Barreiro de Lemos");
  const save = page.getByRole("button", { name: "Guardar nombre" });
  await shot(cu, page, "cambiar-nombre", { target: save });
  await save.click();
  const saved = notice(page, "Nombre actualizado.");
  await expect(saved).toBeVisible();
  await shot(cu, page, "nombre-actualizado", { target: saved });

  // Paso 1: idioma y apariencia, en el perfil y en «Ajustes».
  await page.goto("/perfil");
  const appearance = page.getByRole("radiogroup", { name: "Apariencia" });
  await expect(appearance).toBeVisible();
  await shot(cu, page, "preferencias", { target: appearance });
  const settings = page.getByRole("button", { name: "Ajustes", exact: true });
  await settings.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await shot(cu, page, "menu-ajustes", { target: menu });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Paso 2: solicitar el cambio de correo con la contraseña actual.
  await page.goto("/perfil/datos");
  const mailbox = page.getByLabel("Nuevo correo", { exact: true });
  const current = page.getByLabel("Contraseña actual");
  const request = page.getByRole("button", {
    name: "Solicitar cambio de correo",
  });
  await mailbox.fill(next);

  // Alternativa: contraseña actual incorrecta.
  await current.fill("no-es-la-contrasena");
  await request.click();
  const wrong = page.getByRole("main").getByRole("alert");
  await expect(wrong).toBeVisible();
  await shot(cu, page, "contrasena-incorrecta", { target: wrong });

  await current.fill(newPassword);
  await shot(cu, page, "solicitar-cambio-de-correo", { target: request });
  await request.click();
  const sent = notice(
    page,
    "Revisa tu correo actual para autorizar la solicitud.",
  );
  await expect(sent).toBeVisible();
  await shot(cu, page, "revisa-tu-correo-actual", { target: sent });

  // Paso 2: autorizar desde el buzón actual.
  const approval = await latestMail(email, "email-change/approve");
  await cu.mail(page, "correo-de-autorizacion", approval);
  await page.goto(mailUrl(approval));
  const authorize = page.getByRole("button", {
    name: "Autorizar cambio",
    exact: true,
  });
  await expect(authorize).toBeVisible();
  await shot(cu, page, "autorizar-cambio", { target: authorize });
  await authorize.click();
  const verifyNew = notice(
    page,
    "Revisa el nuevo correo para completar la verificación.",
  );
  await expect(verifyNew).toBeVisible();
  await shot(cu, page, "revisa-el-nuevo-correo", { target: verifyNew });

  // Paso 2: verificar el nuevo correo.
  const confirmation = await latestMail(next, "email-change/confirm");
  await cu.mail(page, "correo-de-verificacion", confirmation);
  await page.goto(mailUrl(confirmation));
  const confirm = page.getByRole("button", { name: "Confirmar nuevo correo" });
  await expect(confirm).toBeVisible();
  await shot(cu, page, "confirmar-nuevo-correo", { target: confirm });
  await confirm.click();

  // Paso 3: el correo cambia y las sesiones se cierran.
  await expect(page).toHaveURL(/notice=email-changed/);
  const changed = notice(page, "Correo actualizado");
  await expect(changed).toBeVisible();
  await shot(cu, page, "correo-actualizado", { target: changed });
  await signInWith(page, next);
  await page.goto("/perfil/datos");
  await expect(
    page.getByRole("main").getByText(next, { exact: true }).last(),
  ).toBeVisible();
  await shot(cu, page, "acceso-con-el-nuevo-correo", {
    target: page.getByRole("main").getByText(next, { exact: true }).last(),
  });
});
