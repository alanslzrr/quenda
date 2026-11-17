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
  // The appearance control is a radio group that names both themes and checks the active one.
  const appearance = page.getByRole("radiogroup", { name: "Apariencia" });
  await expect(
    appearance.getByRole("radio", { name: "Oscuro", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await appearance.getByRole("radio", { name: "Claro", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    appearance.getByRole("radio", { name: "Claro", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.emulateMedia({ colorScheme: "dark" });
  const savedSystem = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/me/theme") &&
      response.request().method() === "PUT",
  );
  await appearance.getByRole("radio", { name: "Sistema", exact: true }).click();
  expect((await savedSystem).status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(
    appearance.getByRole("radio", { name: "Sistema", exact: true }),
  ).toBeChecked();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // The account navigation lists only account settings.
  const accountNav = page.getByRole("navigation", { name: "Mi cuenta" });
  await expect(
    accountNav.getByRole("link", { name: "Preferencias" }),
  ).toBeVisible();
  await expect(
    accountNav.getByRole("link", { name: "Mis reservas" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const sessionCookies = async () =>
    (await page.context().cookies()).filter((cookie) =>
      cookie.name.endsWith("session_token"),
    );
  expect(await sessionCookies()).toHaveLength(1);
  // A rejected sign-out keeps the session and never asks to clear site data.
  const forged = await page.request.post("/api/auth/sign-out", {
    headers: { origin: "https://attacker.example" },
    data: {},
  });
  expect(forged.status()).toBe(403);
  expect(forged.headers()["clear-site-data"]).toBeUndefined();
  expect(await sessionCookies()).toHaveLength(1);
  const logoutResponse = page.waitForResponse("**/api/auth/sign-out");
  const stored = await page.evaluate(() =>
    localStorage.getItem("quenda.preferences"),
  );
  await signOut(page);
  expect((await (await logoutResponse).allHeaders())["clear-site-data"]).toBe(
    '"cookies"',
  );
  expect(await sessionCookies()).toHaveLength(0);
  expect(
    await page.evaluate(() => localStorage.getItem("quenda.preferences")),
  ).toBe(stored);
  await expect(
    page.getByRole("link", { name: "Acceder", exact: true }),
  ).toBeVisible();
  await page.goto("/perfil");
  await expect(page).toHaveURL(/\/acceso/);
});
