import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { signOut } from "./account-helpers";
import { test } from "./fixtures";

test("verified account signs in and persists preferences through the real API", async ({
  page,
}, info) => {
  const email = `browser-${info.project.name}-${Date.now()}@example.test`;
  const password = "Synthetic-browser-password-1234!";
  await page.goto("/registro");
  await page.getByLabel(/^(Nombre|Nome)$/).fill("Ana de proba");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^(Contraseña|Contrasinal)$/).fill(password);
  await page.getByRole("button", { name: /Crear (cuenta|conta)/ }).click();
  await expect(
    page.getByText(/(Comprueba tu correo|Comproba o teu correo)/),
  ).toBeVisible();
  let verification = "";
  await expect
    .poll(async () => {
      const directory = path.resolve("test-results/mail");
      for (const filename of await readdir(directory).catch(() => [])) {
        const message = JSON.parse(
          await readFile(path.join(directory, filename), "utf8"),
        );
        if (message.to === email && message.text.includes("verify-email")) {
          verification = message.text.trim().split("\n").at(-1);
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  await page.goto(verification);
  await expect(page).toHaveURL(/\/acceso/);
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^(Contraseña|Contrasinal)$/).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil/);
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Ajustes|Axustes/ }).click();
  await page.getByRole("menuitem", { name: "Castellano", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Modo oscuro", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("heading", { name: "Preferencias de tu cuenta" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await signOut(page);
  await expect(
    page.getByRole("link", { name: "Acceder", exact: true }),
  ).toBeVisible();
  await page.goto("/perfil");
  await expect(page).toHaveURL(/\/acceso/);
});
