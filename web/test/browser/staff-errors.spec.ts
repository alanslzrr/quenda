import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { fieldValue, pickDateTime } from "./date-fields";
import { test } from "./fixtures";

const tenant = "00000000-0000-4000-8000-000000000001",
  unit = "00000000-0000-4000-8000-000000000003";
const root = `/api/municipalities/${tenant}`;
const invitation = {
  invitationId: "00000000-0000-4000-8000-000000000005",
  accountId: "destinatario",
  accountLabel: {
    name: "Persona destinataria",
    email: "destinatario@demo.test",
  },
  invitedBy: "responsable",
  expiresAt: "2090-01-01T00:00:00Z",
  roleExpiresAt: null,
  acceptedAt: null,
  revokedAt: null,
};
async function fixture(page: Page, administrator = true) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { items: [], nextCursor: null };
    if (path === "/api/me")
      body = {
        accountId: "responsable",
        email: "admin@example.test",
        mfaVerified: true,
      };
    if (path === "/api/me/preferences") body = { locale: null };
    if (path === "/api/me/theme")
      body = {
        theme: (page.viewportSize()?.width ?? 1000) < 500 ? "dark" : "light",
      };
    if (path === "/api/me/navigation")
      body = {
        municipalities: {
          items: [
            {
              id: tenant,
              name: "Oleiros",
              administrator,
              permissions: administrator
                ? []
                : [{ operation: "RESERVATION_MANAGE", unitId: unit }],
            },
          ],
          nextCursor: null,
        },
        platform: { operator: false, permissions: [] },
      };
    if (path === `${root}/agenda/units`)
      body = { items: [{ id: unit, name: "Pista 1" }], nextCursor: null };
    await route.fulfill({ json: body });
  });
}
async function fill(page: Page) {
  await page.goto(`/administracion/${tenant}/personal/invitar`);
  await page.getByLabel(/Identificador de (cuenta|conta)/).fill("destinatario");
  await pickDateTime(page, "Aceptar antes de", "2080-01-01T10:00");
  await page
    .getByRole("checkbox", { name: /Confirmo (la cuenta|a conta)/ })
    .check();
}
async function select(page: Page, name: string, option: string | RegExp) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("delegated managers cannot read or mutate municipal personnel through direct routes", async ({
  page,
}) => {
  await fixture(page, false);
  let reads = 0;
  await page.route("**/manager-invitations", async (route) => {
    reads++;
    await route.fulfill({
      status: 403,
      json: { error: { code: "FORBIDDEN", message: "Sin permiso" } },
    });
  });
  await page.goto(`/administracion/${tenant}/personal/gestores`);
  await expect(
    page.getByText(/No tienes permiso|Non tes permiso/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Personal y permisos|Persoal e permisos/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Enviar invitación" }),
  ).toHaveCount(0);
  expect(reads).toBe(0);
});

test("permission selection preserves exact scope and explicit privacy grants", async ({
  page,
}, info) => {
  await fixture(page);
  let sent: Record<string, unknown> | undefined;
  let failNext = false;
  await page.route(`**${root}/manager-invitations`, async (route) => {
    if (failNext) {
      await route.abort("failed");
      return;
    }
    sent = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      json: { tenantId: tenant, invitationId: invitation.invitationId },
    });
  });
  await fill(page);
  await page.getByRole("button", { name: "Enviar invitación" }).click();
  await expect(
    page.getByText(/Revisa los permisos|Revisa os permisos/),
  ).toBeVisible();
  expect(sent).toBeUndefined();
  await select(page, "Ámbito", "Pista 1");
  await page
    .getByRole("button", { name: /Añadir permiso|Engadir permiso/ })
    .click();
  await expect(
    page.getByRole("button", { name: /Añadir permiso|Engadir permiso/ }),
  ).toBeDisabled();
  await select(
    page,
    "Operación",
    /Consultar datos personales|Consultar datos persoais/,
  );
  await expect(
    page.getByRole("combobox", { name: "Ámbito", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Ámbito", exact: true }),
  ).toContainText(/Todo el municipio|Todo o municipio/);
  await page
    .getByRole("button", { name: /Añadir permiso|Engadir permiso/ })
    .click();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/staff-invite-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Enviar invitación" }).click();
  await expect(
    page.getByText(/Invitación registrada|Invitación rexistrada/),
  ).toBeVisible();
  expect(sent?.permissions).toEqual([
    { operation: "RESERVATION_READ", unitId: unit },
    { operation: "PRIVACY_READ", unitId: null },
  ]);
  expect(sent?.roleExpiresAt).toBeNull();
  expect(sent?.accountId).toBe("destinatario");
  failNext = true;
  await page.getByLabel(/Identificador de (cuenta|conta)/).fill("otra-cuenta");
  await pickDateTime(page, "Aceptar antes de", "2080-01-01T10:00");
  await page
    .getByRole("button", { name: /Añadir permiso|Engadir permiso/ })
    .click();
  await page
    .getByRole("checkbox", { name: /Confirmo (la cuenta|a conta)/ })
    .check();
  await page.getByRole("button", { name: "Enviar invitación" }).click();
  await expect(
    page.getByText(/No se recibió confirmación|Non se recibiu confirmación/),
  ).toBeVisible();
  await expect(
    page.getByText(/Invitación registrada|Invitación rexistrada/),
  ).toHaveCount(0);
});

test("MFA expiry keeps the invitation draft and does not retry the write", async ({
  page,
}) => {
  await fixture(page);
  let attempts = 0;
  await page.route(`**${root}/manager-invitations`, async (route) => {
    attempts++;
    await route.fulfill({
      status: 403,
      json: {
        error: {
          code: "REAUTHENTICATION_REQUIRED",
          message: "Verifica de nuevo el segundo factor.",
        },
      },
    });
  });
  await fill(page);
  await page
    .getByRole("button", { name: /Añadir permiso|Engadir permiso/ })
    .click();
  await page.getByRole("button", { name: "Enviar invitación" }).click();
  await expect(
    page.getByText("Verifica de nuevo el segundo factor."),
  ).toBeVisible();
  await expect(page.getByLabel(/Identificador de (cuenta|conta)/)).toHaveValue(
    "destinatario",
  );
  await expect(fieldValue(page, "Aceptar antes de")).toHaveValue("2080-01-01");
  await expect(
    page.getByRole("textbox", { name: "Aceptar antes de · hora", exact: true }),
  ).toHaveValue("10:00");
  await expect(
    page.getByRole("button", { name: "Quitar permiso 1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Verificar acceso/ })
    .last()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Verificar acceso" }),
  ).toBeVisible();
  expect(attempts).toBe(1);
});

test("an unconfirmed invitation cannot be silently resubmitted or displayed as accepted", async ({
  page,
}) => {
  await fixture(page);
  let attempts = 0;
  await page.route(`**${root}/manager-invitations`, async (route) => {
    attempts++;
    await route.abort("failed");
  });
  await fill(page);
  await page
    .getByRole("button", { name: /Añadir permiso|Engadir permiso/ })
    .click();
  await page.getByRole("button", { name: "Enviar invitación" }).click();
  await expect(
    page.getByText(/No se recibió confirmación|Non se recibiu confirmación/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enviar invitación" }),
  ).toBeDisabled();
  await expect(
    page.getByText(/Invitación registrada|Invitación rexistrada/),
  ).toHaveCount(0);
  expect(attempts).toBe(1);
});

test("a successful security withdrawal empties the reason without marking it invalid", async ({
  page,
}) => {
  await fixture(page);
  const sent: unknown[] = [];
  await page.route(
    `**${root}/accounts/destinatario/revoke-access-for-security`,
    async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: {} });
    },
  );
  await page.goto(`/administracion/${tenant}/personal/seguridad`);
  await page.getByLabel(/Identificador de (cuenta|conta)/).fill("destinatario");
  const reason = page.getByLabel("Motivo", { exact: true });
  await reason.fill("Contención del compromiso local");
  await page
    .getByRole("checkbox", {
      name: /Confirmo la retirada por seguridad|Confirmo a retirada por seguridade/,
    })
    .check();
  const submit = page.getByRole("button", {
    name: /Retirar acceso por seguridad|Retirar acceso por seguridade/,
  });
  await submit.click();
  await expect(
    page.getByRole("main").getByText(/Cambios guardados|Cambios gardados/),
  ).toBeVisible();
  expect(sent).toEqual([{ reason: "Contención del compromiso local" }]);
  // The cleared field is neutral: neither the browser's :user-invalid nor aria-invalid flags it.
  await expect(reason).toHaveValue("");
  await expect(reason).toHaveAttribute("aria-invalid", "false");
  expect(await reason.evaluate((field) => field.matches(":user-invalid"))).toBe(
    false,
  );
  await reason.focus();
  await reason.blur();
  await expect(reason).toHaveAttribute("aria-invalid", "false");
  // A new attempt without a reason is still rejected and flagged.
  await submit.click();
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  expect(await reason.evaluate((field) => field.matches(":user-invalid"))).toBe(
    true,
  );
  expect(sent).toHaveLength(1);
});

test("staff history paginates without claiming accepted grants are currently authorized", async ({
  page,
}, info) => {
  await fixture(page);
  const queries: string[] = [];
  let revoke: unknown;
  await page.route(`**${root}/administrator-invitations**`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST") {
      revoke = route.request().postDataJSON();
      await route.fulfill({
        json: { tenantId: tenant, invitationId: invitation.invitationId },
      });
      return;
    }
    queries.push(url.search);
    await route.fulfill({
      json: url.searchParams.has("after")
        ? {
            items: [
              {
                ...invitation,
                invitationId: unit,
                accountId: "segunda",
                accountLabel: {
                  name: "Segunda persona",
                  email: "segunda@demo.test",
                },
                acceptedAt: "2025-01-01T00:00:00Z",
              },
            ],
            nextCursor: null,
          }
        : { items: [invitation], nextCursor: invitation.invitationId },
    });
  });
  await page.goto(`/administracion/${tenant}/personal`);
  await page.getByRole("button", { name: /Cargar más|Cargar máis/ }).click();
  await page.getByRole("button", { name: /Segunda persona/ }).click();
  await expect(
    page.getByText(
      /Revocar una invitación aceptada no retira|Revogar unha invitación aceptada non retira/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Revocar invitación|Revogar invitación/ }),
  ).toHaveCount(0);
  expect(queries).toContain(`?after=${invitation.invitationId}`);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/staff-history-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: /Persona destinataria/ }).click();
  await page
    .getByRole("checkbox", {
      name: /Confirmo la revocación|Confirmo a revogación/,
    })
    .check();
  await page
    .getByRole("button", { name: /Revocar invitación|Revogar invitación/ })
    .click();
  await expect.poll(() => revoke).toEqual({});
});
