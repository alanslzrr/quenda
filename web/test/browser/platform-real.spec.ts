import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { accessibilityViolations } from "./axe-scan";
import { pickDateTime } from "./date-fields";
import { test } from "./fixtures";

const view = "/plataforma/gestion";
const origin = { Origin: "http://127.0.0.1:5173" };
async function signin(
  page: Page,
  f: { email: string; password: string; secret: string },
) {
  await login(page, f.email, f.password);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
}
const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
async function fixture(index: number) {
  return JSON.parse(
    await readFile("test-results/platform-fixtures.json", "utf8"),
  )[index];
}
async function deadline(page: Page) {
  await pickDateTime(
    page,
    "Aceptar antes de",
    new Date(Date.now() + 86400000).toISOString().slice(0, 16),
  );
}
async function confirm(page: Page, label: string | RegExp) {
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByRole("status")).toBeVisible();
}
async function accept(page: Page, kind: string) {
  await page.goto("/perfil/invitaciones");
  // Each invitation is its own card, named by its role.
  const area = page
    .locator("li")
    .filter({ has: page.getByRole("heading", { name: kind, exact: true }) })
    .filter({ hasText: /Pendiente|Pendente/ });
  const button = area.getByRole("button", {
    name: "Aceptar invitación",
    exact: true,
  });
  await expect(button).toHaveCount(1);
  await button.click();
  await expect(button).toHaveCount(0);
}
async function revoke(page: Page) {
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Retirada sintética autorizada");
  await confirm(page, /^Revocar$|^Revogar$/);
}
test("platform operators invite revoke and hand over authority without inheriting global privacy", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120000);
  const index = info.project.name === "desktop" ? 0 : 1;
  const f = await fixture(index);
  await signin(page, f.operator);
  expect(
    (
      await page.request.put("/api/me/theme", {
        headers: origin,
        data: { theme: index === 0 ? "light" : "dark" },
      })
    ).status(),
  ).toBe(200);
  const other = await browser.newContext({
    baseURL: "http://127.0.0.1:5173",
    locale: "es-ES",
    extraHTTPHeaders: {
      "x-quenda-test-client": `2001:db8:700:${index + 1}::1`,
    },
  });
  try {
    const recipient = await other.newPage();
    await signin(recipient, f.recipient);
    await recipient.goto("/plataforma");
    await expect(
      recipient.getByText("No tienes permiso para esta operación."),
    ).toBeVisible();
    await page.goto("/administracion");
    await page
      .getByRole("link", { name: "Administración de plataforma", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Operadores", exact: true }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // Operators see each other by name and identifier, never by e-mail.
    // Each record is a region named by its heading.
    const own = page.getByRole("region", {
      name: new RegExp(
        `^Personal \\d+ \\((?:tu cuenta|a túa conta)\\) ${literal(f.operator.accountId)}$`,
      ),
    });
    await expect(own).toBeVisible();
    await expect(own).not.toContainText("@");
    await page.screenshot({
      path: `test-results/platform-operators-${info.project.name}.png`,
      fullPage: true,
    });
    await page.goto(`${view}/invitar-operador`);
    await page
      .getByLabel(/Correo del destinatario|Correo do destinatario/)
      .fill(f.recipient.email);
    await deadline(page);
    await confirm(page, "Enviar invitación");
    const pending = await recipient.request.get("/api/me/operator-invitations");
    const invitation = (await pending.json()).items.find(
      (i: { status: string }) => i.status === "PENDING",
    );
    expect(invitation).toBeTruthy();
    await page.goto(`${view}/invitaciones`);
    const card = page
      .getByRole("region")
      .filter({ has: page.getByText(invitation.invitationId, { exact: true }) })
      .filter({ hasNot: page.getByRole("navigation") });
    // Until accepted, the invitation names the address it was sent to.
    await expect(card).toContainText(f.recipient.email);
    await card.getByRole("link", { name: /^Revocar$|^Revogar$/ }).click();
    await revoke(page);
    expect(
      (
        await (
          await recipient.request.get("/api/me/operator-invitations")
        ).json()
      ).items.find(
        (i: { invitationId: string }) =>
          i.invitationId === invitation.invitationId,
      ).status,
    ).toBe("REVOKED");
    await page.goto(`${view}/invitar-operador`);
    await page
      .getByLabel(/Correo del destinatario|Correo do destinatario/)
      .fill(f.recipient.email);
    await deadline(page);
    await confirm(page, "Enviar invitación");
    await accept(recipient, "Operación de plataforma");
    await recipient.goto("/plataforma");
    await expect(
      recipient.getByRole("heading", {
        level: 1,
        name: "Operadores",
        exact: true,
      }),
    ).toBeVisible();
    await recipient.goto("/plataforma/privacidad");
    await expect(
      recipient.getByText("No tienes permiso para esta operación."),
    ).toBeVisible();
    await page.goto(`${view}/invitar-privacidad`);
    await page
      .getByLabel(/Correo del destinatario|Correo do destinatario/)
      .fill(f.recipient.email);
    await deadline(page);
    await page
      .getByRole("checkbox", {
        name: /Consultar datos de privacidad|Consultar datos de privacidade/,
      })
      .check();
    await page
      .getByLabel("Motivo", { exact: true })
      .fill("Consulta global autorizada");
    await confirm(page, "Enviar invitación");
    await accept(recipient, "Privacidad global");
    await recipient.goto("/plataforma/privacidad");
    await expect(
      recipient.getByRole("heading", {
        name: "Conservación y derechos",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      recipient.getByRole("link", { name: "Registrar política", exact: true }),
    ).toHaveCount(0);
    await page.goto(`${view}/privacidad`);
    const grant = page.getByRole("region", {
      name: new RegExp(`^Personal \\d+ ${literal(f.recipient.accountId)}$`),
    });
    await expect(grant).not.toContainText("@");
    await grant.getByRole("link", { name: /^Revocar$|^Revogar$/ }).click();
    await revoke(page);
    await recipient.reload();
    await expect(
      recipient.getByText("No tienes permiso para esta operación."),
    ).toBeVisible();
    await page.goto(
      `${view}/retirar-operador?id=${encodeURIComponent(f.recipient.accountId)}`,
    );
    await revoke(page);
    await recipient.goto("/plataforma");
    const denied = recipient.getByText(
      "No tienes permiso para esta operación.",
    );
    // The optional management-entry section has its own recovery action. Scope
    // this assertion to the route guard's recovery action, not that header hint.
    const platformFailure = recipient
      .getByRole("region", { name: "Resolver el problema", exact: true })
      .filter({
        has: recipient.getByRole("button", { name: "Reintentar", exact: true }),
      });
    const limited = platformFailure.getByRole("alert").filter({
      hasText: "Demasiadas solicitudes. Espera antes de repetir.",
    });
    // This compressed, reload-heavy lifecycle can consume the real per-account
    // minute budget. Respect the server's wait instead of changing that limit or
    // treating a 429 as proof that revoked permissions were enforced.
    await expect(denied.or(limited)).toBeVisible();
    if (await limited.isVisible()) {
      await expect(platformFailure.getByRole("timer")).toBeVisible();
      const retry = platformFailure.getByRole("button", {
        name: "Reintentar",
        exact: true,
      });
      await expect(retry).toBeEnabled({ timeout: 65_000 });
      await retry.click();
    }
    await expect(denied).toBeVisible();
    expect((await recipient.request.get("/api/me")).status()).toBe(200);
  } finally {
    await other.close();
  }
});
test("municipal onboarding replacement security suspension and recovery preserve explicit acceptance", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120000);
  const index = info.project.name === "desktop" ? 2 : 3;
  const f = await fixture(index);
  await signin(page, f.operator);
  const other = await browser.newContext({
    baseURL: "http://127.0.0.1:5173",
    locale: "es-ES",
    extraHTTPHeaders: {
      "x-quenda-test-client": `2001:db8:701:${index + 1}::1`,
    },
  });
  try {
    const recipient = await other.newPage();
    await signin(recipient, f.recipient);
    await page.goto(`${view}/nuevo-municipio`);
    await page
      .getByLabel(/Nombre del municipio|Nome do municipio/)
      .fill(`Municipio plataforma ${index}`);
    await page
      .getByLabel(/Zona horaria (del municipio|do municipio)/)
      .fill("Europe/Madrid");
    await page
      .getByLabel(/Correo del destinatario|Correo do destinatario/)
      .fill(f.recipient.email);
    await deadline(page);
    const created = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/municipalities") &&
        r.request().method() === "POST",
    );
    await confirm(page, /Registrar municipio|Rexistrar municipio/);
    const { tenantId, invitationId } = await (await created).json();
    expect(tenantId).toBeTruthy();
    expect(
      (
        await page.request.get(`/api/municipalities/${tenantId}/administrators`)
      ).status(),
    ).toBe(403);
    await page.goto(`${view}/invitacion-inicial`);
    await page
      .getByLabel(/Identificador (del municipio|do municipio)/)
      .fill(tenantId);
    await page
      .getByLabel(/Correo del destinatario|Correo do destinatario/)
      .fill(f.recipient.email);
    await deadline(page);
    await page
      .getByLabel("Motivo", { exact: true })
      .fill("Sustitución inicial autorizada");
    await confirm(page, /Sustituir invitación|Substituír invitación/);
    const invitations = await (
      await recipient.request.get("/api/me/administrator-invitations")
    ).json();
    expect(
      invitations.items.find(
        (i: { invitationId: string }) => i.invitationId === invitationId,
      ).status,
    ).toBe("REVOKED");
    await accept(recipient, "Administración municipal");
    await recipient.goto(`/administracion/${tenantId}`);
    if ((recipient.viewportSize()?.width ?? 1280) < 768)
      await recipient
        .getByRole("button", {
          name: /Gestión municipal|Xestión municipal/,
          exact: true,
        })
        .click();
    await expect(
      recipient.getByRole("link", { name: "Personal y permisos" }),
    ).toBeVisible();
    await page.goto(`${view}/invitacion-inicial`);
    await page
      .getByLabel(/Identificador (del municipio|do municipio)/)
      .fill(tenantId);
    await page
      .getByLabel(/Correo del destinatario|Correo do destinatario/)
      .fill(f.recipient.email);
    await deadline(page);
    await page
      .getByLabel("Motivo", { exact: true })
      .fill("Intento después de aceptación");
    await page.getByRole("checkbox", { name: /Confirmo/ }).check();
    await page
      .getByRole("button", {
        name: /Sustituir invitación|Substituír invitación/,
        exact: true,
      })
      .click();
    await expect(page.locator("form").getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.goto(`${view}/suspender`);
    await page
      .getByRole("textbox", { name: /Correo de la cuenta|Correo da conta/ })
      .fill(f.recipient.email);
    await page
      .getByLabel("Motivo", { exact: true })
      .fill("Identidad sintética comprometida");
    await confirm(page, /Suspender cuenta|Suspender conta/);
    expect((await recipient.request.get("/api/me")).status()).toBe(401);
    await page.goto(`${view}/recuperar-responsable`);
    await page
      .getByLabel(/Identificador (del municipio|do municipio)/)
      .fill(tenantId);
    await page
      .getByLabel(/Correo del destinatario|Correo do destinatario/)
      .fill(f.replacement.email);
    await deadline(page);
    await page
      .getByLabel("Motivo", { exact: true })
      .fill("Relevo tras contención");
    await page
      .getByLabel(/Referencia de verificación/)
      .fill("Acto administrativo sintético");
    await confirm(page, /Invitar a un sustituto|Invitar a un substituto/);
    expect(
      (
        await page.request.get(`/api/municipalities/${tenantId}/administrators`)
      ).status(),
    ).toBe(403);
    // Acceptance uses the citizen's existing account flow; the operator does not
    // acquire municipal authority merely by issuing the recovery invitation.
    await signin(recipient, f.replacement);
    await recipient.goto("/perfil/invitaciones");
    const button = recipient.getByRole("button", {
      name: "Aceptar invitación",
      exact: true,
    });
    await expect(button).toHaveCount(1);
    await button.click();
    await expect(button).toHaveCount(0);
    const administrators = await recipient.request.get(
      `/api/municipalities/${tenantId}/administrators`,
    );
    expect(administrators.status()).toBe(200);
    expect(
      (await administrators.json()).items.find(
        (a: { accountId: string }) => a.accountId === f.replacement.accountId,
      ).active,
    ).toBe(true);
    expect(
      (
        await page.request.get(`/api/municipalities/${tenantId}/administrators`)
      ).status(),
    ).toBe(403);
  } finally {
    await other.close();
  }
});
