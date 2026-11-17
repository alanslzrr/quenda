import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { pickDateTime } from "./date-fields";
import { test } from "./fixtures";

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
async function fixture(index: number) {
  return JSON.parse(await readFile("test-results/staff-fixtures.json", "utf8"))[
    index
  ];
}
async function select(
  page: Page,
  name: string | RegExp,
  option: string | RegExp,
) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
function tomorrow(days = 1) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 16);
}
async function invite(
  page: Page,
  tenant: string,
  recipient: string,
  admin = false,
) {
  await page.goto(`/administracion/${tenant}/personal/invitar`);
  if (admin)
    await select(page, "Tipo de invitación", "Administrador municipal");
  await page.getByLabel(/Identificador de (cuenta|conta)/).fill(recipient);
  await pickDateTime(page, "Aceptar antes de", tomorrow());
}
async function confirmInvitation(page: Page) {
  await page
    .getByRole("checkbox", { name: /Confirmo (la cuenta|a conta)/ })
    .check();
  await page
    .getByRole("button", { name: "Enviar invitación", exact: true })
    .click();
  await expect(
    page.getByText(/Invitación registrada|Invitación rexistrada/),
  ).toBeVisible();
}
async function accept(page: Page) {
  await page.goto("/perfil/invitaciones");
  const button = page.getByRole("button", {
    name: "Aceptar invitación",
    exact: true,
  });
  await expect(button).toHaveCount(1);
  await button.click();
  await expect(button).toHaveCount(0);
}
async function formAction(
  page: Page,
  label: RegExp | string,
  confirm: RegExp | string,
  reason: string,
) {
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: label, exact: true }) });
  await form.getByLabel("Motivo", { exact: true }).fill(reason);
  await form.getByRole("checkbox", { name: confirm }).check();
  await form.getByRole("button", { name: label, exact: true }).click();
  return form;
}

test("staff grants require acceptance and replace scope without an authority gap", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000);
  const f = await fixture(info.project.name === "desktop" ? 0 : 1);
  await signin(page, f.administrator);
  const other = await browser.newContext({
    baseURL: "http://127.0.0.1:5173",
    locale: "es-ES",
    extraHTTPHeaders: {
      "x-quenda-test-client": `2001:db8:501:${info.project.name === "desktop" ? "1" : "2"}::1`,
    },
  });
  try {
    const recipient = await other.newPage();
    await signin(recipient, f.recipient);
    await invite(page, f.administrator.tenant, f.recipient.accountId);
    await select(page, "Ámbito", "Pista 1");
    await page
      .getByRole("button", { name: /Añadir permiso|Engadir permiso/ })
      .click();
    await confirmInvitation(page);
    await accept(recipient);
    await recipient.goto(`/administracion/${f.administrator.tenant}/agenda`);
    await expect(
      recipient.getByRole("heading", { name: "Agenda diaria", exact: true }),
    ).toBeVisible();
    await expect(
      recipient.getByRole("link", { name: "Personal y permisos" }),
    ).toHaveCount(0);
    await recipient.goto(`/administracion/${f.administrator.tenant}/personal`);
    await expect(
      recipient.getByText("No tienes permiso para esta operación."),
    ).toBeVisible();
    await page.goto(
      `/administracion/${f.administrator.tenant}/personal/gestores`,
    );
    await page
      .getByRole("button", {
        name: new RegExp(
          f.recipient.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ),
      })
      .click();
    await page
      .getByRole("button", { name: /Sustituir permisos|Substituír permisos/ })
      .click();
    await page
      .getByRole("button", { name: "Quitar permiso 1", exact: true })
      .click();
    await select(page, "Operación", "Bloquear unidades");
    await select(page, "Ámbito", "Pista 1");
    await page
      .getByRole("button", { name: /Añadir permiso|Engadir permiso/ })
      .click();
    await pickDateTime(page, "Aceptar antes de", tomorrow());
    const replacement = page.locator("form").filter({
      has: page.getByRole("button", {
        name: /Invitar con nuevos permisos|Invitar con novos permisos/,
      }),
    });
    await replacement
      .getByLabel("Motivo", { exact: true })
      .fill("Cambio de funciones");
    await replacement.getByRole("checkbox").check();
    await replacement
      .getByRole("button", {
        name: /Invitar con nuevos permisos|Invitar con novos permisos/,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: /Invitar con nuevos permisos|Invitar con novos permisos/,
      }),
    ).toHaveCount(0);
    const before = await recipient.request.get("/api/me/navigation");
    expect((await before.json()).municipalities.items[0].permissions).toEqual([
      { operation: "RESERVATION_READ", unitId: f.administrator.unit },
    ]);
    await accept(recipient);
    await recipient.goto(`/administracion/${f.administrator.tenant}/agenda`);
    await expect(
      recipient.getByRole("button", { name: "Crear bloqueo", exact: true }),
    ).toBeVisible();
    await expect(
      recipient.getByRole("heading", { name: "Reservas", exact: true }),
    ).toHaveCount(0);
    await page.reload();
    const accepted = page.getByRole("row").filter({ hasText: "Aceptada" });
    await accepted
      .getByRole("button", {
        name: new RegExp(
          f.recipient.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ),
      })
      .click();
    const revoke = await formAction(
      page,
      /Revocar concesión|Revogar concesión/,
      /Confirmo la revocación|Confirmo a revogación/,
      "Fin de la función delegada",
    );
    await expect(revoke).toHaveCount(0);
    await recipient.goto(`/administracion/${f.administrator.tenant}/agenda`);
    await expect(
      recipient.getByText("No tienes acceso a este municipio."),
    ).toBeVisible();
    // The management frame stays, with a way back to the municipalities list.
    await expect(
      recipient.getByRole("link", { name: "Volver a Gestión" }),
    ).toBeVisible();
  } finally {
    await other.close();
  }
});

test("municipal administrator handover needs an accepted indefinite successor", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000);
  const f = await fixture(info.project.name === "desktop" ? 2 : 3);
  await signin(page, f.administrator);
  const base = `/administracion/${f.administrator.tenant}/personal`;
  await page.goto(base);
  await expect(
    page.getByRole("table", { name: "Administradores", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/staff-administrators-${info.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("table", { name: "Administradores", exact: true })
    .getByRole("button", {
      name: /tu cuenta|a túa conta/,
    })
    .click();
  await formAction(
    page,
    "Retirar administración",
    /Confirmo la retirada ordinaria|Confirmo a retirada ordinaria/,
    "Fin del puesto",
  );
  await expect(
    page.getByText(/Debe quedar (otro|outro) responsable habilitado/),
  ).toBeVisible();
  await expect(page).toHaveURL(base);
  await invite(page, f.administrator.tenant, f.recipient.accountId, true);
  await pickDateTime(page, /Permiso válido (hasta|ata)/, tomorrow(10));
  await confirmInvitation(page);
  const other = await browser.newContext({
    baseURL: "http://127.0.0.1:5173",
    locale: "es-ES",
    extraHTTPHeaders: {
      "x-quenda-test-client": `2001:db8:502:${info.project.name === "desktop" ? "1" : "2"}::1`,
    },
  });
  try {
    const recipient = await other.newPage();
    await signin(recipient, f.recipient);
    await accept(recipient);
    await page.goto(base);
    await page
      .getByRole("table", { name: "Administradores", exact: true })
      .getByRole("button", {
        name: /tu cuenta|a túa conta/,
      })
      .click();
    await formAction(
      page,
      "Retirar administración",
      /Confirmo la retirada ordinaria|Confirmo a retirada ordinaria/,
      "Comprobar continuidad con sustituto temporal",
    );
    await expect(
      page.getByText(/Debe quedar (otro|outro) responsable habilitado/),
    ).toBeVisible();
    await page
      .getByRole("table", { name: "Administradores", exact: true })
      .getByRole("button", {
        name: new RegExp(
          f.recipient.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ),
      })
      .click();
    const indefinite = await formAction(
      page,
      /Convertir en indefinido|Converter en indefinido/,
      /Confirmo el permiso|Confirmo o permiso/,
      "Responsable permanente del municipio",
    );
    await expect(indefinite).toHaveCount(0);
    await page
      .getByRole("table", { name: "Administradores", exact: true })
      .getByRole("button", {
        name: /tu cuenta|a túa conta/,
      })
      .click();
    await formAction(
      page,
      "Retirar administración",
      /Confirmo la retirada ordinaria|Confirmo a retirada ordinaria/,
      "Relevo completado",
    );
    await expect(page).toHaveURL("/administracion");
    await expect(
      page.getByText(
        /No tienes permisos municipales|Non tes permisos municipais/,
      ),
    ).toBeVisible();
    await recipient.goto(base);
    const row = recipient
      .getByRole("table", { name: "Administradores", exact: true })
      .getByRole("row")
      .filter({
        has: recipient.getByRole("button", {
          name: /tu cuenta|a túa conta/,
        }),
      });
    await expect(row).toContainText("Sin caducidad");
    await expect(row).toContainText("Habilitado");
  } finally {
    await other.close();
  }
});

test("municipal security withdrawal bypasses handover without closing the global account", async ({
  page,
}, info) => {
  const f = await fixture(info.project.name === "desktop" ? 4 : 5);
  await signin(page, f.administrator);
  if (info.project.name === "mobile-dark") {
    await page.getByRole("button", { name: /Ajustes|Axustes/ }).click();
    await page
      .getByRole("menuitem", { name: /Modo oscuro|Modo escuro/ })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  }
  await page.goto(
    `/administracion/${f.administrator.tenant}/personal/seguridad`,
  );
  await page
    .getByLabel(/Identificador de (cuenta|conta)/)
    .fill(f.administrator.accountId);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/staff-security-${info.project.name}.png`,
    fullPage: true,
  });
  await formAction(
    page,
    /Retirar acceso por seguridad|Retirar acceso por seguridade/,
    /Confirmo la retirada por seguridad|Confirmo a retirada por seguridade/,
    "Contención del compromiso local",
  );
  await expect(page).toHaveURL("/administracion");
  await expect(
    page.getByText(
      /No tienes permisos municipales|Non tes permisos municipais/,
    ),
  ).toBeVisible();
  await page.goto("/perfil/datos");
  await expect(
    page.getByRole("heading", {
      name: /Datos personales|Datos persoais/,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(f.administrator.accountId, { exact: true }),
  ).toBeVisible();
});
