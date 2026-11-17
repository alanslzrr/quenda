import { totp } from "../../test/helpers/auth-client";
import {
  access,
  account,
  Capture,
  expect,
  latestMail,
  mailUrl,
  roles,
  test,
} from "./capture";
import { around, newPassword, notice, registerResident, shot } from "./citizen";

// CU-09 — Iniciar o cerrar sesión. Un único Capture para que la
// recuperación de contraseña continúe la numeración.
const cu = new Capture("CU-09");

test("CU-09 iniciar y cerrar sesión", async ({ page }) => {
  const { password } = await access();
  const citizen = await account(roles.citizen);
  const staff = await account(roles.manager);

  await page.goto("/");
  await shot(cu, page, "inicio-sin-sesion", {
    target: page.getByRole("link", { name: /^(Acceder|Entrar)$/ }).first(),
  });

  await page.goto("/acceso");
  const email = page.getByLabel("Correo electrónico", { exact: true });
  const secret = page.getByLabel(/^Contraseña$/);
  const enter = page.getByRole("button", { name: "Entrar", exact: true });
  const verify = page.getByRole("button", { name: "Verificar", exact: true });
  const code = page.getByLabel("Código de autenticación", { exact: true });
  await shot(cu, page, "formulario-de-acceso");

  // Paso principal: credenciales correctas.
  await email.fill(citizen.email);
  await secret.fill(password);
  await shot(cu, page, "credenciales-completas", { target: enter });
  await enter.click();
  await expect(page).not.toHaveURL(/\/acceso/);
  await shot(cu, page, "sesion-iniciada");

  // Cierre de sesión desde el menú de ajustes.
  const settings = page.getByRole("button", { name: /^Ajustes$/ });
  await settings.click();
  const signOut = page.getByRole("menuitem", { name: /^Cerrar sesión$/ });
  await shot(cu, page, "menu-cerrar-sesion", { target: signOut });
  await signOut.click();
  await expect(
    page.getByRole("link", { name: /^(Acceder|Entrar)$/ }).first(),
  ).toBeVisible();
  await shot(cu, page, "sesion-cerrada");

  // Alternativa: credenciales inválidas, en un formulario recién abierto.
  await page.goto("/acceso");
  await email.fill(citizen.email);
  await secret.fill("contraseña-equivocada");
  await enter.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await shot(cu, page, "credenciales-invalidas", {
    target: page.getByRole("alert"),
  });

  // Alternativa: cuenta con permisos de gestión, segundo factor obligatorio.
  await page.goto("/acceso");
  await email.fill(staff.email);
  await secret.fill(password);
  await enter.click();
  await expect(code).toBeVisible();
  await shot(cu, page, "segundo-factor-solicitado", {
    target: around(code),
  });
  await code.fill(totp(staff.secret ?? ""));
  await shot(cu, page, "codigo-introducido", { target: verify });
  await verify.click();
  await expect(page).not.toHaveURL(/\/acceso/);
  await shot(cu, page, "acceso-con-segundo-factor");
});

test("CU-09 código de verificación incorrecto", async ({ page }) => {
  // Alternativa: código incorrecto. Cliente nuevo para no sumar intentos de
  // acceso a los anteriores; el código erróneo no consume ningún código válido.
  const { password } = await access();
  const staff = await account(roles.manager);
  const code = page.getByLabel("Código de autenticación", { exact: true });
  await page.goto("/acceso");
  await page
    .getByLabel("Correo electrónico", { exact: true })
    .fill(staff.email);
  await page.getByLabel(/^Contraseña$/).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(code).toBeVisible();
  await code.fill("000000");
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await shot(cu, page, "codigo-incorrecto", {
    target: page.getByRole("alert"),
  });
});

test("CU-09 recuperar la contraseña olvidada", async ({ page }) => {
  // Cuenta nueva: la recuperación cambia la contraseña.
  const email = await registerResident(page, "Sara Lema Pazos");
  await page.context().clearCookies();
  const changed = `${newPassword}-nueva`;

  // Alternativa: «He olvidado mi contraseña» desde el acceso.
  await page.goto("/acceso");
  const forgot = page.getByRole("link", { name: "He olvidado mi contraseña" });
  await shot(cu, page, "olvide-mi-contrasena", { target: forgot });
  await forgot.click();
  await expect(
    page.getByRole("heading", { name: "Recuperar contraseña" }),
  ).toBeVisible();
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  const send = page.getByRole("button", { name: "Enviar instrucciones" });
  await shot(cu, page, "solicitar-recuperacion", { target: send });
  await send.click();
  const sent = notice(
    page,
    "Si la solicitud es válida, recibirás un correo con las instrucciones.",
  );
  await expect(sent).toBeVisible();
  await shot(cu, page, "solicitud-enviada", { target: sent });

  const message = await latestMail(email, "reset-password");
  await cu.mail(page, "correo-de-recuperacion", message);

  await page.goto(mailUrl(message));
  const field = page.getByLabel("Nueva contraseña");
  await field.fill(changed);
  const save = page.getByRole("button", { name: "Guardar contraseña" });
  await shot(cu, page, "nueva-contrasena", { target: save });
  await save.click();
  const done = notice(page, /Contraseña actualizada/);
  await expect(done).toBeVisible();
  await shot(cu, page, "contrasena-actualizada", { target: done });

  // Alternativa: el enlace ya usado no vuelve a servir.
  await page.goto(mailUrl(message));
  const used = notice(page, "El enlace no es válido. Solicita uno nuevo.");
  await expect(used).toBeVisible();
  await shot(cu, page, "enlace-ya-usado", { target: used });
});
