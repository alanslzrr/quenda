import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
export const password = "Synthetic-browser-password-1234!";
export async function mailLink(email: string, includes: string) {
  let url = "";
  await expect
    .poll(async () => {
      const directory = path.resolve("test-results/mail");
      for (const filename of (
        await readdir(directory).catch(() => [])
      ).reverse()) {
        const message = JSON.parse(
          await readFile(path.join(directory, filename), "utf8"),
        );
        if (message.to === email && message.text.includes(includes)) {
          url = message.text.trim().split("\n").at(-1);
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return url;
}
export async function login(page: Page, email: string, credential = password) {
  await page.goto("/acceso");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^(Contraseña|Contrasinal)$/).fill(credential);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}
export async function createAccount(page: Page) {
  const email = `account-${randomUUID()}@example.test`;
  await page.goto("/registro");
  await page.getByLabel(/^(Nombre|Nome)$/).fill("Ana de proba");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^(Contraseña|Contrasinal)$/).fill(password);
  await page.getByRole("button", { name: /Crear (cuenta|conta)/ }).click();
  await expect(
    page.getByText(/Comprueba tu correo|Comproba o teu correo/),
  ).toBeVisible();
  await page.goto(await mailLink(email, "verify-email"));
  await login(page, email);
  await expect(page).toHaveURL(/\/perfil$/);
  return email;
}
