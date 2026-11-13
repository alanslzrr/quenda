import { expect, test } from "@playwright/test";

const accountId = "account-test";
const tenant = "00000000-0000-4000-8000-000000000001";
const invitation = "00000000-0000-4000-8000-000000000002";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === "/api/me")
      body = { accountId, email: "ana@example.test", mfaVerified: true };
    else if (path.endsWith("/preferences")) body = { locale: "es" };
    else if (path.endsWith("/theme")) body = { theme: "light" };
    else if (path.endsWith("/get-session"))
      body = {
        user: {
          id: accountId,
          name: "Ana",
          email: "ana@example.test",
          twoFactorEnabled: true,
        },
        session: {
          token: "synthetic",
          createdAt: "2026-10-01T12:00:00Z",
          expiresAt: "2030-01-01T12:00:00Z",
        },
      };
    else if (path.endsWith("/list-sessions")) body = [];
    else if (path.endsWith("-invitations"))
      body = { items: [], nextCursor: null };
    await route.fulfill({ json: body });
  });
});
test("rejected deactivation preserves the account and shows the reservation restriction", async ({
  page,
}) => {
  await page.route("**/api/me/deactivation", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "ACCOUNT_HAS_RESERVATIONS",
          message:
            "Tienes reservas futuras o en curso. La cuenta no se ha desactivado.",
        },
      },
    }),
  );
  await page.goto("/perfil/privacidad");
  await page.getByLabel("Contraseña actual").fill("synthetic-password");
  await page
    .getByRole("checkbox", { name: "Quiero desactivar mi cuenta global" })
    .check();
  await page.getByRole("button", { name: "Confirmar baja de cuenta" }).click();
  await expect(
    page.getByText(
      "Tienes reservas futuras o en curso. La cuenta no se ha desactivado.",
    ),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/perfil\/privacidad$/);
  await page.getByRole("button", { name: /Ajustes|Axustes/ }).click();
  await expect(
    page.getByRole("menuitem", { name: "Mi cuenta", exact: true }),
  ).toHaveAttribute("href", "/perfil");
});
test("administrative MFA cannot be presented as disabled after a rejection", async ({
  page,
}) => {
  await page.route("**/api/auth/two-factor/disable", (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: {
          code: "MFA_REQUIRED",
          message:
            "Debes mantener MFA mientras tengas permisos administrativos.",
        },
      },
    }),
  );
  await page.goto("/perfil/seguridad");
  await page
    .getByRole("button", {
      name: /Gestionar verificación|Xestionar verificación/,
    })
    .click();
  const form = page.locator("form").filter({
    has: page.getByRole("button", {
      name: "Desactivar la verificación en dos pasos",
      exact: true,
    }),
  });
  await form.getByLabel("Contraseña actual").fill("synthetic-password");
  await form
    .getByRole("button", {
      name: "Desactivar la verificación en dos pasos",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      "Debes mantener MFA mientras tengas permisos administrativos.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      /^(La verificación en dos pasos está activada|A verificación en dous pasos está activada)/,
    ),
  ).toBeVisible();
});
test("an invitation exposes its scope and is accepted only by an explicit command", async ({
  page,
}) => {
  let accepted = false;
  let commands = 0;
  await page.route("**/api/me/administrator-invitations", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            invitationId: invitation,
            tenantId: tenant,
            municipality: "Oleiros",
            status: accepted ? "ACCEPTED" : "PENDING",
            expiresAt: "2030-01-01T12:00:00Z",
            roleExpiresAt: null,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(
    `**/api/municipalities/${tenant}/administrator-invitations/${invitation}/accept`,
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({});
      commands++;
      accepted = true;
      await route.fulfill({ json: {} });
    },
  );
  await page.goto("/perfil/invitaciones");
  await expect(
    page.getByRole("heading", { name: "Administración municipal" }),
  ).toBeVisible();
  await expect(page.getByText("Oleiros", { exact: true })).toBeVisible();
  expect(commands).toBe(0);
  await page.getByRole("button", { name: "Aceptar invitación" }).click();
  await expect(page.getByText("Aceptada", { exact: true })).toBeVisible();
  expect(commands).toBe(1);
});
test("expired reactivation links remain failures without an automatic mutation", async ({
  page,
}) => {
  let commands = 0;
  await page.route("**/api/account/reactivation/confirm", async (route) => {
    commands++;
    await route.fulfill({
      status: 400,
      json: {
        error: {
          code: "INVALID_INPUT",
          message: "La verificación ha vencido. Solicita un nuevo enlace.",
        },
      },
    });
  });
  await page.goto(`/account/reactivation#${"a".repeat(43)}`);
  await expect(
    page.getByRole("button", { name: "Reactivar cuenta", exact: true }),
  ).toBeVisible();
  expect(commands).toBe(0);
  await page.getByLabel("Contraseña actual").fill("synthetic-password");
  await page
    .getByRole("button", { name: "Reactivar cuenta", exact: true })
    .click();
  await expect(
    page.getByText("La verificación ha vencido. Solicita un nuevo enlace."),
  ).toBeVisible();
  expect(commands).toBe(1);
});
test("an invitation list that fails to load never reads as having no invitations", async ({
  page,
}) => {
  await page.route("**/api/me/administrator-invitations", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: "UNAVAILABLE", message: "Servicio no disponible." },
      },
    }),
  );
  await page.goto("/perfil/invitaciones");
  await expect(page.getByText("Servicio no disponible.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No tienes invitaciones" }),
  ).toHaveCount(0);
});
