import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import {
  createAccount,
  login,
  mailLink,
  password,
  signOut,
} from "./account-helpers";
import { test } from "./fixtures";

test("personal details, password recovery and accessible settings use the real API", async ({
  page,
}) => {
  const email = await createAccount(page);
  await page.getByRole("link", { name: /Datos perso/ }).click();
  await page.getByLabel(/^(Nombre|Nome)$/).fill("Ana Actualizada");
  await page
    .getByRole("button", { name: /Guardar nombre|Gardar nome/ })
    .click();
  await expect(
    page.getByText(/Nombre actualizado|Nome actualizado/),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/^(Nombre|Nome)$/)).toHaveValue(
    "Ana Actualizada",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await signOut(page);
  await page.goto("/recuperar");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByRole("button", { name: /Enviar instru/ }).click();
  await expect(page.getByText(/Si la solicitud|Se a solicitude/)).toBeVisible();
  await page.goto(await mailLink(email, "reset-password"));
  const changed = `${password}-changed`;
  await page.getByLabel(/Nueva contraseña|Novo contrasinal/).fill(changed);
  await page
    .getByRole("button", { name: /Guardar contraseña|Gardar contrasinal/ })
    .click();
  await expect(
    page.getByText(/Contraseña actualizada|Contrasinal actualizado/),
  ).toBeVisible();
  await login(page, email, changed);
  await expect(page).toHaveURL(/\/perfil$/);
});

test("MFA enrollment, backup sign-in and password change retain usable sessions", async ({
  page,
}) => {
  const email = await createAccount(page);
  await page
    .getByRole("link", { name: /Seguridad|Seguridade/, exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /Gestionar verificación|Xestionar verificación/,
    })
    .click();
  const enroll = page.locator("form").filter({
    has: page.getByRole("button", {
      name: "Configurar verificación",
      exact: true,
    }),
  });
  await enroll
    .getByLabel(/Contraseña actual|Contrasinal actual/)
    .fill(password);
  await enroll
    .getByRole("button", { name: "Configurar verificación", exact: true })
    .click();
  const secret = await page.getByLabel("Clave de configuración").inputValue();
  const codes =
    (await page.locator("pre").textContent())?.trim().split("\n") ?? [];
  expect(codes).toHaveLength(10);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(secret));
  await page
    .getByRole("button", { name: "Activar verificación", exact: true })
    .click();
  await expect(
    page.getByText(
      /La verificación en dos pasos está activada|A verificación en dous pasos está activada/,
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /He guardado los códigos|Gardei os códigos/ })
    .click();
  await expect(page.locator("pre")).toHaveCount(0);
  await signOut(page);
  await login(page, email);
  await page
    .getByRole("checkbox", { name: "Usar un código de respaldo" })
    .check();
  await page.getByLabel("Código de respaldo", { exact: true }).fill(codes[0]);
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  await page.goto("/perfil/seguridad");
  await page
    .getByRole("button", { name: /Cambiar contraseña|Cambiar contrasinal/ })
    .click();
  const change = page.locator("form").filter({
    has: page.getByRole("button", {
      name: /Cambiar contraseña|Cambiar contrasinal/,
    }),
  });
  await change
    .getByLabel(/Contraseña actual|Contrasinal actual/)
    .fill(password);
  await change
    .getByLabel(/Nueva contraseña|Novo contrasinal/)
    .fill(`${password}-new`);
  await change
    .getByRole("button", { name: /Cambiar contraseña|Cambiar contrasinal/ })
    .click();
  await expect(
    page.getByText(/Contraseña actualizada|Contrasinal actualizado/),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: /Cerrar las demás sesiones|Pechar as demais sesións/,
    })
    .click();
  await expect(
    page.getByText(
      /Las demás sesiones se han cerrado|As demais sesións pecháronse/,
    ),
  ).toBeVisible();
});

test("email change requires two explicit confirmations and then a new session", async ({
  page,
}) => {
  const email = await createAccount(page);
  const next = `new-${randomUUID()}@example.test`;
  await page.goto("/perfil/datos");
  await page.getByLabel(/Nuevo correo|Novo correo/, { exact: true }).fill(next);
  await page.getByLabel(/Contraseña actual|Contrasinal actual/).fill(password);
  await page
    .getByRole("button", { name: "Solicitar cambio de correo" })
    .click();
  await expect(
    page.getByText(/Revisa tu correo actual|Revisa o teu correo actual/),
  ).toBeVisible();
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("email-change/"))
      mutations.push(request.url());
  });
  await page.goto(await mailLink(email, "email-change/approve"));
  await expect(
    page.getByRole("button", { name: "Autorizar cambio", exact: true }),
  ).toBeVisible();
  expect(mutations).toHaveLength(0);
  expect(new URL(page.url()).hash).toBe("");
  await page
    .getByRole("button", { name: "Autorizar cambio", exact: true })
    .click();
  await expect(
    page.getByText(/Revisa el nuevo correo|Revisa o novo correo/),
  ).toBeVisible();
  await page.goto(await mailLink(next, "email-change/confirm"));
  await page
    .getByRole("button", {
      name: /Confirmar nuevo correo|Confirmar novo correo/,
    })
    .click();
  await expect(page).toHaveURL(/notice=email-changed/);
  await login(page, next);
  await expect(page).toHaveURL(/\/perfil$/);
});

test("privacy download, voluntary deactivation and verified reactivation remain distinct", async ({
  page,
}) => {
  const email = await createAccount(page);
  await page.goto("/perfil/privacidad");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Descargar datos perso/ }).click();
  expect((await download).suggestedFilename()).toBe(
    "quenda-personal-data.json",
  );
  await page.getByLabel(/Contraseña actual|Contrasinal actual/).fill(password);
  await page
    .getByRole("checkbox", { name: /Quiero desactivar|Quero desactivar/ })
    .check();
  await page
    .getByRole("button", { name: /Confirmar baja|Confirmar baixa/ })
    .click();
  await expect(page).toHaveURL(/notice=deactivated/);
  await page.goto("/reactivar");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/Contraseña actual|Contrasinal actual/).fill(password);
  await page.getByRole("button", { name: /Enviar instru/ }).click();
  await expect(page.getByText(/Si la solicitud|Se a solicitude/)).toBeVisible();
  await page.goto(await mailLink(email, "/account/reactivation"));
  await page.getByLabel(/Contraseña actual|Contrasinal actual/).fill(password);
  await page
    .getByRole("button", {
      name: /Reactivar cuenta|Reactivar conta/,
      exact: true,
    })
    .click();
  await expect(
    page.getByText(/Cuenta reactivada|Conta reactivada/),
  ).toBeVisible();
  await login(page, email);
  await expect(page).toHaveURL(/\/perfil$/);
});
