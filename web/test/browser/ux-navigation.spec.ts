import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";

const tenant = "00000000-0000-4000-8000-000000000091";
async function fixture(page: Page, { expired = false, staff = true } = {}) {
  let verified = !expired,
    writes = 0,
    logout = 0,
    signedIn = true;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { items: [], nextCursor: null };
    if (path === "/api/me") {
      if (!signedIn)
        return route.fulfill({
          status: 401,
          json: { error: { code: "UNAUTHENTICATED", message: "Accede" } },
        });
      body = {
        accountId: "admin",
        email: "maria@demo.test",
        mfaVerified: true,
      };
    }
    if (path === "/api/me/preferences") body = { locale: "es" };
    if (path === "/api/me/theme") body = { theme: "dark" };
    if (path.endsWith("/appearance"))
      body = {
        version: 1,
        lightPalette: "neutral",
        darkPalette: "neutral",
        defaultTheme: "light",
      };
    if (path === "/api/me/navigation")
      body = {
        municipalities: {
          items: staff
            ? [
                {
                  id: tenant,
                  name: "Valdeira",
                  administrator: true,
                  permissions: [],
                },
              ]
            : [],
          nextCursor: null,
        },
        platform: { operator: false, permissions: [] },
      };
    if (path === "/api/auth/sign-out") {
      logout++;
      signedIn = false;
      body = { success: true };
    }
    if (path === "/api/auth/two-factor/verify-totp") {
      verified = true;
      body = {};
    }
    if (
      path === `/api/municipalities/${tenant}/facilities` &&
      route.request().method() === "POST"
    ) {
      writes++;
      body = { id: "fixture" };
    }
    if (
      [
        `/api/municipalities/${tenant}/facilities`,
        `/api/municipalities/${tenant}/units`,
      ].includes(path) &&
      !verified
    )
      return route.fulfill({
        status: 403,
        json: {
          error: {
            code: "REAUTHENTICATION_REQUIRED",
            message: "Verifica el segundo factor.",
          },
        },
      });
    if (path === `/api/municipalities/${tenant}/administrators`)
      body = {
        items: [
          {
            accountId: "admin",
            accountLabel: { name: "María Pérez", email: "maria@demo.test" },
            active: true,
            expiresAt: null,
            revokedAt: null,
            grantedAt: "2026-01-01T00:00:00Z",
            invitationId: tenant,
          },
        ],
        nextCursor: null,
      };
    if (path === `/api/public/municipalities/${tenant}`)
      body = { id: tenant, name: "Valdeira", timezone: "Europe/Madrid" };
    if (path === `/api/public/municipalities/${tenant}/facilities`)
      body = {
        items: [{ id: tenant, name: "Polideportivo", units: 1 }],
        nextCursor: null,
      };
    await route.fulfill({ json: body });
  });
  return { writes: () => writes, logout: () => logout };
}
test("navigation groups personal destinations, preserves native links and respects management scope", async ({
  page,
}) => {
  await fixture(page, { staff: false });
  await page.goto("/reservas");
  const primary = page.getByRole("navigation", {
    name: "Navegación principal",
  });
  await expect(primary.getByRole("link")).toHaveCount(1);
  await expect(
    primary.getByRole("link", { name: "Reservar", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Tus reservas" })
      .getByRole("link", { name: "Mis reservas" }),
  ).toBeVisible();
  const settings = page.getByRole("button", { name: "Ajustes", exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "Mi cuenta", exact: true }),
  ).toHaveAttribute("href", "/perfil");
  await expect(
    page.getByRole("menuitem", { name: "Avisos", exact: true }),
  ).toHaveAttribute("href", "/avisos");
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
});
test("multiple expired administrative reads share one MFA notice and preserve drafts without writing", async ({
  page,
}, info) => {
  const state = await fixture(page, { expired: true });
  await page.goto(`/administracion/${tenant}`);
  await expect(
    page.getByRole("button", { name: "Verificar acceso", exact: true }),
  ).toHaveCount(1);
  await page
    .getByLabel("Nombre", { exact: true })
    .fill("Borrador que se conserva");
  await page
    .getByRole("button", { name: "Verificar acceso", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Verificar acceso" });
  await dialog
    .getByLabel("Código de autenticación", { exact: true })
    .fill("123456");
  await dialog
    .getByRole("button", { name: "Verificar acceso", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Verificar acceso", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Nombre", { exact: true })).toHaveValue(
    "Borrador que se conserva",
  );
  expect(state.writes()).toBe(0);
  await expect(page.locator("#content")).toBeFocused();
  await page.screenshot({
    path: `test-results/ux-mfa-${info.project.name}.png`,
    fullPage: true,
  });
});
test("staff identity is readable and management settings can sign out", async ({
  page,
}, info) => {
  const state = await fixture(page);
  await page.goto(`/administracion/${tenant}/personal`);
  await expect(page.getByRole("button", { name: /María Pérez/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /María Pérez/ })).toContainText(
    "maria@demo.test",
  );
  await page.getByRole("button", { name: /María Pérez/ }).click();
  await expect(
    page.getByRole("heading", { name: /Administración de la cuenta/ }),
  ).toContainText("María Pérez");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/ux-personal-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Cerrar sesión", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Acceder", exact: true }),
  ).toBeVisible();
  expect(state.logout()).toBe(1);
});
test("booking composition shares a centered axis without horizontal overflow", async ({
  page,
}, info) => {
  await fixture(page);
  await page.goto(`/municipios/${tenant}`);
  await expect(
    page.getByRole("heading", { name: "Elige una instalación", exact: true }),
  ).toBeVisible();
  const geometry = await page.locator("main").evaluate((main) => {
    const box = main.getBoundingClientRect();
    const section = main.querySelector('[class*="sections"]');
    if (!section) throw new Error("Missing booking section");
    const content = section.getBoundingClientRect();
    return {
      left: box.left,
      right: document.documentElement.clientWidth - box.right,
      contentLeft: content.left,
      contentRight: document.documentElement.clientWidth - content.right,
      overflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    };
  });
  expect(Math.abs(geometry.left - geometry.right)).toBeLessThan(2);
  expect(Math.abs(geometry.contentLeft - geometry.contentRight)).toBeLessThan(
    2,
  );
  expect(geometry.overflow).toBe(false);
  await page.screenshot({
    path: `test-results/ux-booking-${info.project.name}.png`,
    fullPage: true,
  });
});
