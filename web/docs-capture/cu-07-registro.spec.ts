import { randomUUID } from "node:crypto";
import {
  account,
  Capture,
  expect,
  latestMail,
  mailUrl,
  roles,
  test,
} from "./capture";
import {
  dayLabel,
  madridDate,
  newPassword,
  notice,
  pickDay,
  ribasanta,
  shot,
} from "./citizen";

// CU-07 — Crear una cuenta y utilizar un servicio municipal. Una vecina
// nueva se registra, verifica el correo, accede y reserva por primera vez en
// un municipio.
const cu = new Capture("CU-07");

test("CU-07 crear una cuenta y reservar por primera vez", async ({ page }) => {
  const email = `noelia.${randomUUID().slice(0, 8)}@demo.test`;
  const name = page.getByLabel("Nombre", { exact: true });
  const mailbox = page.getByLabel("Correo electrónico", { exact: true });
  const secret = page.getByLabel(/^Contraseña$/);
  const create = page.getByRole("button", {
    name: "Crear cuenta",
    exact: true,
  });

  // Paso 1: el formulario de registro, desde «Crear una cuenta».
  await page.goto("/acceso");
  const link = page.getByRole("link", {
    name: "Crear una cuenta",
    exact: true,
  });
  await shot(cu, page, "enlace-crear-cuenta", { target: link });
  await link.click();
  await expect(
    page.getByRole("heading", { name: "Crea tu cuenta" }),
  ).toBeVisible();

  // Alternativa: la contraseña no cumple el mínimo.
  await name.fill("Noelia Varela Souto");
  await mailbox.fill(email);
  await secret.fill("corta");
  await create.click();
  await expect(secret).toBeFocused();
  await expect(secret).toHaveAttribute("aria-invalid", "true");
  // El globo nativo del navegador sale en el idioma de su interfaz, no en el
  // de la página: se retira el foco para que desaparezca y queda el campo
  // marcado como erróneo junto a su indicación «Mínimo 8 caracteres».
  await secret.blur();
  await page.waitForTimeout(1000);
  // Sin recuadro: el borde rojo del campo es lo que hay que ver.
  await shot(cu, page, "contrasena-demasiado-corta");

  await secret.fill(newPassword);
  await shot(cu, page, "datos-de-registro", { target: create });
  await create.click();
  const check = notice(page, "Comprueba tu correo para verificar la cuenta.");
  await expect(check).toBeVisible();
  await shot(cu, page, "comprueba-tu-correo", { target: check });

  // Paso 2: el correo de verificación.
  const verification = await latestMail(email, "verify-email");
  await cu.mail(page, "correo-de-verificacion", verification);

  // Alternativa: un enlace alterado o caducado no verifica la cuenta.
  const link1 = new URL(mailUrl(verification));
  link1.searchParams.set("token", `${link1.searchParams.get("token")}x`);
  await page.goto(link1.toString());
  const failed = notice(page, "No se ha podido verificar el enlace");
  await expect(failed).toBeVisible();
  await shot(cu, page, "enlace-no-valido", { target: failed });

  // Paso 2: abrir el enlace verifica el correo y lleva al acceso (CU-09).
  await page.goto(mailUrl(verification));
  await expect(page).toHaveURL(/\/acceso/);
  await expect(
    page.getByRole("heading", { name: "Accede a tu cuenta" }),
  ).toBeVisible();
  await mailbox.fill(email);
  await secret.fill(newPassword);
  const enter = page.getByRole("button", { name: "Entrar", exact: true });
  await shot(cu, page, "acceder-con-la-cuenta", { target: enter });
  await enter.click();
  await expect(page).toHaveURL(/\/perfil$/);
  await expect(
    page.getByRole("heading", { name: "Preferencias de tu cuenta" }),
  ).toBeVisible();
  await shot(cu, page, "cuenta-creada");

  // Paso 3: la primera reserva en Ribasanta no pide ningún perfil adicional.
  const date = madridDate(8);
  await page.goto(
    `/municipios/${ribasanta.id}/unidades/${ribasanta.sportsCourt}`,
  );
  await pickDay(page, date);
  const free = page.getByRole("region", { name: "Horarios libres" });
  await expect(free.getByText(dayLabel(date), { exact: false })).toBeVisible();
  await free.getByRole("link").first().click();
  await expect(
    page.getByRole("heading", { name: "Revisa tu reserva" }),
  ).toBeVisible();
  const accept = page.getByRole("checkbox", {
    name: "He leído y acepto las normas de uso y las condiciones de cancelación.",
  });
  await accept.check();
  const confirm = page.getByRole("button", {
    name: "Confirmar reserva",
    exact: true,
  });
  await shot(cu, page, "primera-reserva", { target: confirm });
  await confirm.click();
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  await shot(cu, page, "primera-reserva-confirmada");
});

test("CU-07 registro con un correo ya registrado", async ({ page }) => {
  // Alternativa: quien ya tiene cuenta en la instancia usa la misma; el
  // registro no revela si el correo existe.
  const { email } = await account(roles.citizen);
  await page.goto("/registro");
  await page.getByLabel("Nombre", { exact: true }).fill("Lucía Pereira Castro");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^Contraseña$/).fill(newPassword);
  await page.getByRole("button", { name: "Crear cuenta", exact: true }).click();
  const same = notice(page, "Comprueba tu correo para verificar la cuenta.");
  await expect(same).toBeVisible();
  await shot(cu, page, "correo-ya-registrado", { target: same });
});
