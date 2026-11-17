import { expect, type Page } from "@playwright/test";
import { accessibilityViolations } from "./axe-scan";
import { pickDateTime } from "./date-fields";
import { test } from "./fixtures";

const view = "/plataforma/gestion";
const id = "00000000-0000-4000-8000-000000000001";
async function fixture(page: Page, operator = true) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { items: [], nextCursor: null };
    if (path === "/api/me")
      body = {
        accountId: "operator",
        email: "operator@example.test",
        mfaVerified: true,
      };
    if (path === "/api/me/preferences") body = { locale: null };
    if (path === "/api/me/theme")
      body = {
        theme: (page.viewportSize()?.width ?? 1000) < 500 ? "dark" : "light",
      };
    if (path === "/api/me/navigation")
      body = {
        municipalities: { items: [], nextCursor: null },
        platform: { operator, permissions: ["PRIVACY_READ"] },
      };
    await route.fulfill({ json: body });
  });
}
const future = () => new Date(Date.now() + 86400000).toISOString().slice(0, 16);
async function invite(page: Page, privacy = false) {
  await page.goto(
    `${view}/${privacy ? "invitar-privacidad" : "invitar-operador"}`,
  );
  await page
    .getByLabel(/Correo del destinatario|Correo do destinatario/)
    .fill(" Recipient@Example.test ");
  await pickDateTime(page, "Aceptar antes de", future());
  await page
    .getByRole("checkbox", { name: /Confirmo el correo|Confirmo o correo/ })
    .check();
}
test("municipal or privacy authority cannot open operator controls or query platform lists", async ({
  page,
}) => {
  await fixture(page, false);
  let reads = 0;
  await page.route("**/api/platform/**", async (r) => {
    reads++;
    await r.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/administracion");
  await expect(
    page.getByRole("link", { name: "Administración de plataforma" }),
  ).toHaveCount(0);
  for (const section of [
    "operadores",
    "nuevo-municipio",
    "suspender",
    "privacidad",
  ]) {
    await page.goto(`${view}/${section}`);
    await expect(
      page.getByText(/No tienes permiso|Non tes permiso/),
    ).toBeVisible();
  }
  expect(reads).toBe(0);
});
test("operator invitation preserves draft after MFA rejection and never adds a role expiry", async ({
  page,
}, info) => {
  await fixture(page);
  let body: Record<string, unknown> | undefined;
  await page.route("**/api/platform/operator-invitations", async (r) => {
    body = r.request().postDataJSON();
    await r.fulfill({
      status: 403,
      json: {
        error: {
          code: "REAUTHENTICATION_REQUIRED",
          message: "MFA reciente requerido",
        },
      },
    });
  });
  await invite(page);
  await expect(page.getByLabel(/Permiso válido/)).toHaveCount(0);
  expect(await accessibilityViolations(page)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/platform-invite-${info.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Enviar invitación", exact: true })
    .click();
  await expect(
    page.getByText("MFA reciente requerido", { exact: true }),
  ).toBeVisible();
  // The draft survives; an email field drops the surrounding spaces typed
  // into it, so the kept value is the sanitized address.
  await expect(
    page.getByLabel(/Correo del destinatario|Correo do destinatario/),
  ).toHaveValue("Recipient@Example.test");
  // Addressed to the trimmed email, never to an account identifier.
  expect(body?.email).toBe("Recipient@Example.test");
  expect(Object.keys(body ?? {}).sort()).toEqual(["email", "expiresAt"]);
  await expect(
    page.getByRole("button", { name: "Enviar invitación" }),
  ).toBeEnabled();
});
test("privacy grants require explicit independent permissions and omit unchecked operations", async ({
  page,
}) => {
  await fixture(page);
  let sent: Record<string, unknown> | undefined;
  await page.route("**/api/platform/privacy-invitations", async (r) => {
    sent = r.request().postDataJSON();
    await r.fulfill({ status: 201, json: { invitationId: id } });
  });
  await invite(page, true);
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Autorización específica");
  await page.getByRole("button", { name: "Enviar invitación" }).click();
  await expect(
    page.getByText(/Selecciona (al menos un permiso|polo menos un permiso)/),
  ).toBeVisible();
  expect(sent).toBeUndefined();
  await page
    .getByRole("checkbox", {
      name: /Consultar datos de privacidad|Consultar datos de privacidade/,
    })
    .check();
  await page.getByRole("button", { name: "Enviar invitación" }).click();
  await expect(page.getByRole("status")).toContainText(
    /Invitación registrada|Invitación rexistrada/,
  );
  expect(sent).toMatchObject({
    permissions: ["PRIVACY_READ"],
    roleExpiresAt: null,
    email: "Recipient@Example.test",
    reason: "Autorización específica",
  });
  expect(sent).not.toHaveProperty("accountId");
});
test("lost platform responses stay blocked across reload and never persist the payload", async ({
  page,
}) => {
  await fixture(page);
  let attempts = 0;
  await page.route("**/api/platform/operator-invitations", async (r) => {
    attempts++;
    await r.abort("failed");
  });
  await invite(page);
  await page.getByRole("button", { name: "Enviar invitación" }).click();
  await expect(
    page.getByRole("button", { name: "Enviar invitación" }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Enviar invitación" }),
  ).toBeDisabled();
  expect(attempts).toBe(1);
  const stored = await page.evaluate(() =>
    JSON.stringify({ ...sessionStorage }),
  );
  expect(stored).toContain("pending");
  expect(stored).not.toContain("Example.test");
  expect(stored).not.toContain("expiresAt");
  await page.getByRole("checkbox", { name: /He comprobado|Comprobei/ }).check();
  await page
    .getByRole("button", { name: /Cerrar comprobación|Pechar comprobación/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Enviar invitación" }),
  ).toBeEnabled();
  expect(attempts).toBe(1);
});
test("operator pagination encodes account cursors and rejects the last ordinary withdrawal without false success", async ({
  page,
}) => {
  await fixture(page);
  const cursor = "account/a?b&c";
  let after: string | null = null;
  await page.route("**/api/platform/operators**", async (r) => {
    const url = new URL(r.request().url());
    if (r.request().method() === "POST") {
      await r.fulfill({
        status: 409,
        json: {
          error: {
            code: "ACCOUNT_HANDOVER_REQUIRED",
            message: "Debe permanecer otro operador habilitado.",
          },
        },
      });
      return;
    }
    after = url.searchParams.get("after");
    await r.fulfill({
      json: {
        items: [
          {
            accountId: after ? "next-operator" : "operator",
            grantedAt: new Date().toISOString(),
            revokedAt: null,
            active: true,
          },
        ],
        nextCursor: after ? null : cursor,
      },
    });
  });
  await page.goto("/plataforma");
  await page.getByRole("button", { name: /Cargar más|Cargar máis/ }).click();
  await expect(
    page.getByRole("heading", { name: "next-operator", exact: true }),
  ).toBeVisible();
  expect(after).toBe(cursor);
  await page.goto(`${view}/retirar-operador?id=operator`);
  await expect(page.getByText(/Estás retirando/)).toBeVisible();
  await page.getByLabel("Motivo", { exact: true }).fill("Relevo");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  await page.getByRole("button", { name: /^Revocar$|^Revogar$/ }).click();
  await expect(
    page.getByText("Debe permanecer otro operador habilitado.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
});
test("municipal replacement and recovery send exact scopes and a distinct verified-authority reference", async ({
  page,
}) => {
  await fixture(page);
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/municipalities/**", async (r) => {
    sent.push({
      path: new URL(r.request().url()).pathname,
      body: r.request().postDataJSON(),
    });
    await r.fulfill({ status: 201, json: { tenantId: id, invitationId: id } });
  });
  for (const recovery of [false, true]) {
    await page.goto(
      `${view}/${recovery ? "recuperar-responsable" : "invitacion-inicial"}`,
    );
    await page
      .getByLabel(/Identificador (del municipio|do municipio)/)
      .fill(id);
    await page
      .getByLabel(/Correo del destinatario|Correo do destinatario/)
      .fill("  Recipient@Example.test ");
    await pickDateTime(page, "Aceptar antes de", future());
    await page.getByLabel("Motivo", { exact: true }).fill("Relevo autorizado");
    if (recovery)
      await page.getByLabel(/Referencia de verificación/).fill("Acto 27");
    await page.getByRole("checkbox", { name: /Confirmo/ }).check();
    await page
      .getByRole("button", {
        name: recovery
          ? /Invitar a un sustituto|Invitar a un substituto/
          : /Sustituir invitación|Substituír invitación/,
        exact: true,
      })
      .click();
    await expect(page.getByRole("status")).toContainText(
      /Invitación registrada|Invitación rexistrada/,
    );
  }
  expect(sent[0].path).toBe(
    `/api/municipalities/${id}/initial-administrator-invitation/replace`,
  );
  expect(sent[0].body).not.toHaveProperty("verificationReference");
  // Both are addressed to the trimmed email, never to an account identifier.
  for (const { body } of sent) {
    expect(body.email).toBe("Recipient@Example.test");
    expect(body).not.toHaveProperty("accountId");
  }
  expect(sent[1].path).toBe(
    `/api/municipalities/${id}/administrator-recovery-invitations`,
  );
  expect(sent[1].body.verificationReference).toBe("Acto 27");
});
test("suspending the current identity by its email warns before confirmation and exits after session revocation", async ({
  page,
}) => {
  await fixture(page);
  let suspended = false;
  await page.route("**/api/me", async (r) => {
    await r.fulfill(
      suspended
        ? {
            status: 401,
            json: {
              error: { code: "UNAUTHORIZED", message: "Sesión revocada" },
            },
          }
        : {
            json: {
              accountId: "operator",
              email: "operator@example.test",
              mfaVerified: true,
            },
          },
    );
  });
  await page.route("**/api/platform/account-suspensions", async (r) => {
    expect(r.request().postDataJSON()).toEqual({
      email: "Operator@Example.test",
      reason: "Cuenta comprometida",
    });
    suspended = true;
    await r.fulfill({
      json: { accountId: "operator", suspendedAt: new Date().toISOString() },
    });
  });
  await page.goto(`${view}/suspender`);
  await page
    .getByRole("textbox", { name: /Correo de la cuenta|Correo da conta/ })
    .fill(" Operator@Example.test ");
  await expect(page.getByRole("alert")).toContainText(/propia|propio/);
  await page.getByLabel("Motivo", { exact: true }).fill("Cuenta comprometida");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  await page
    .getByRole("button", { name: /Suspender cuenta|Suspender conta/ })
    .click();
  await expect(page).toHaveURL(/\/acceso/);
  expect(suspended).toBe(true);
});
test("suspending by identifier sends only the reason to the identified account", async ({
  page,
}) => {
  await fixture(page);
  let sent: unknown;
  await page.route("**/api/platform/accounts/other%2Fid/suspend", async (r) => {
    sent = r.request().postDataJSON();
    await r.fulfill({
      json: { accountId: "other/id", suspendedAt: new Date().toISOString() },
    });
  });
  await page.goto(`${view}/suspender`);
  await page
    .getByRole("combobox", {
      name: /Identificar la cuenta por|Identificar a conta por/,
    })
    .click();
  await page
    .getByRole("option", { name: /Identificador de (cuenta|conta)/ })
    .click();
  await page
    .getByRole("textbox", { name: /Identificador de (cuenta|conta)/ })
    .fill("other/id");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByLabel("Motivo", { exact: true }).fill("Cuenta comprometida");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  await page
    .getByRole("button", { name: /Suspender cuenta|Suspender conta/ })
    .click();
  await expect(page.getByRole("status")).toContainText(/suspendida/);
  expect(sent).toEqual({ reason: "Cuenta comprometida" });
});
test("withdrawing the current operator returns to personal access and refreshes platform navigation", async ({
  page,
}) => {
  await fixture(page);
  let operator = true;
  await page.route("**/api/me/navigation", async (r) => {
    await r.fulfill({
      json: {
        municipalities: { items: [], nextCursor: null },
        platform: { operator, permissions: [] },
      },
    });
  });
  await page.route("**/api/platform/operators/operator/revoke", async (r) => {
    operator = false;
    await r.fulfill({ json: { accountId: "operator" } });
  });
  await page.goto(`${view}/retirar-operador?id=operator`);
  await page.getByLabel("Motivo", { exact: true }).fill("Relevo completado");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  await page.getByRole("button", { name: /^Revocar$|^Revogar$/ }).click();
  await expect(page).toHaveURL(/\/administracion$/);
  await expect(
    page.getByRole("link", {
      name: "Administración de plataforma",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.goto("/plataforma");
  await expect(
    page.getByText(/No tienes permiso|Non tes permiso/),
  ).toBeVisible();
});
