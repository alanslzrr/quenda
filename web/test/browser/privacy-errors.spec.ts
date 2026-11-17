import { expect, type Page } from "@playwright/test";
import { accessibilityViolations } from "./axe-scan";
import { test } from "./fixtures";

const tenant = "00000000-0000-4000-8000-000000000001",
  id = "00000000-0000-4000-8000-000000000002",
  base = `/api/municipalities/${tenant}`,
  view = `/administracion/${tenant}/privacidad`;
async function fixture(
  page: Page,
  permissions = ["PRIVACY_READ", "PRIVACY_EXECUTE"],
  global: string[] = [],
  administrator = true,
) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { items: [], nextCursor: null };
    if (path === "/api/me")
      body = {
        accountId: "privacy-actor",
        email: "person@example.test",
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
              permissions: permissions.map((operation) => ({
                operation,
                unitId: null,
              })),
            },
          ],
          nextCursor: null,
        },
        platform: { operator: true, permissions: global },
      };
    if (path.endsWith("/retention-policies"))
      body = { policies: [], hasMore: false };
    if (path.endsWith("/retention-status"))
      body = {
        holds: [],
        conflicts: [],
        hasMoreHolds: false,
        hasMoreConflicts: false,
      };
    await route.fulfill({ json: body });
  });
}
async function select(
  page: Page,
  label: string | RegExp,
  option: string | RegExp,
) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
/**
 * The actor administers the municipality, so the form first offers the linked
 * people; these tests switch to typing the exact reference. The selector is
 * awaited, not probed, because it renders only after the scope and family load.
 */
async function exact(page: Page) {
  const mode = page.getByRole("combobox", {
    name: /Cómo indicar la cuenta|Como indicar a conta/,
  });
  await mode.click();
  await page
    .getByRole("option", {
      name: /Escribir el identificador exacto|Escribir o identificador exacto/,
    })
    .click();
  await expect(mode).toContainText(
    /Escribir el identificador exacto|Escribir o identificador exacto/,
  );
}
async function authorize(page: Page) {
  await page
    .getByLabel("Referencia de autorización", { exact: true })
    .fill("Autorización 9");
  await page.getByLabel("Motivo", { exact: true }).fill("Actuación autorizada");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
}
async function individual(page: Page) {
  await page.goto(`${view}/actuacion`);
  await select(
    page,
    "Familia de datos",
    /Perfiles municipales|Perfís municipais/,
  );
  await exact(page);
  await page
    .getByLabel(/Referencia (del registro|do rexistro)/, { exact: true })
    .fill("subject");
  await select(page, "Actuación", "Suprimir");
  await authorize(page);
}
test("privacy does not inherit administrative authority and read/execute remain independent", async ({
  page,
}) => {
  await fixture(page, []);
  let reads = 0;
  await page.route("**/retention-policies", async (r) => {
    reads++;
    await r.fulfill({ json: { policies: [], hasMore: false } });
  });
  for (const path of [view, "/plataforma/privacidad"]) {
    await page.goto(path);
    await expect(
      page.getByText(/No tienes permiso|Non tes permiso/),
    ).toBeVisible();
  }
  expect(reads).toBe(0);
  await fixture(page, ["PRIVACY_READ"]);
  await page.goto(`${view}/aprobar`);
  await expect(
    page.getByText(/No tienes permiso|Non tes permiso/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: /Registrar política|Rexistrar política/,
      exact: true,
    }),
  ).toHaveCount(0);
  await fixture(page, ["PRIVACY_EXECUTE"]);
  await page.goto(view);
  await expect(
    page.getByRole("heading", {
      name: /Registrar política aprobada|Rexistrar política aprobada/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Políticas", exact: true }),
  ).toHaveCount(0);
  await page.goto(`${view}/descarga`);
  await expect(
    page.getByText(/No tienes permiso|Non tes permiso/),
  ).toBeVisible();
  expect(reads).toBe(0);
});
test("policy forms have no legal defaults, retain drafts after MFA rejection and omit blockDays for erasure", async ({
  page,
}, info) => {
  await fixture(page);
  let sent: Record<string, unknown> | undefined;
  await page.route(`**${base}/retention-policies`, async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      status: 403,
      json: {
        error: {
          code: "REAUTHENTICATION_REQUIRED",
          message: "Verifica MFA de nuevo.",
        },
      },
    });
  });
  await page.goto(`${view}/aprobar`);
  await expect(
    page.getByLabel(/Pla[zz]o de conservación|Prazo de conservación/),
  ).toHaveValue("");
  await select(page, "Familia de datos", /Comunicaciones|Comunicacións/);
  await select(
    page,
    "Actuación",
    /Bloquear (y conservar restringido|e conservar restrinxido)/,
  );
  await page.getByLabel(/Duración autorizada/).fill("10");
  await select(page, "Actuación", "Suprimir");
  await expect(page.getByLabel(/Duración autorizada/)).toHaveCount(0);
  await page
    .getByLabel(/Plazo de conservación|Prazo de conservación/)
    .fill("7");
  await page
    .getByLabel(/Finalidad|Finalidade/, { exact: true })
    .fill("Comunicaciones del servicio");
  await page
    .getByLabel(/Referencia (del responsable|do responsable)/)
    .fill("Responsable municipal");
  await page.getByLabel("Referencia de aprobación").fill("Aprobación 7");
  await page.getByLabel("Motivo", { exact: true }).fill("Política aprobada");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  expect(await accessibilityViolations(page)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/privacy-policy-${info.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: /Registrar política|Rexistrar política/,
      exact: true,
    })
    .click();
  await expect(page.getByText("Verifica MFA de nuevo.")).toBeVisible();
  expect(sent).toEqual({
    category: "COMMUNICATIONS",
    retentionDays: 7,
    action: "ERASE",
    purpose: "Comunicaciones del servicio",
    controllerReference: "Responsable municipal",
    approvalReference: "Aprobación 7",
    reason: "Política aprobada",
  });
  await expect(page.getByLabel("Referencia de aprobación")).toHaveValue(
    "Aprobación 7",
  );
  await page
    .getByRole("button", { name: "Verificar acceso", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Verificar acceso" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Cerrar|Pechar/, exact: true })
    .click();
  await expect(page.getByLabel("Referencia de aprobación")).toHaveValue(
    "Aprobación 7",
  );
});
test("HTTP 200 privacy outcomes are not all presented as successful deletion", async ({
  page,
}) => {
  await fixture(page);
  for (const status of ["CONFLICT", "ABSENT", "APPLIED"]) {
    await page.route(`**${base}/privacy-actions`, (r) =>
      r.fulfill({ json: { status, eventId: "42", reason: "DEPENDENCIES" } }),
    );
    await individual(page);
    await page
      .getByRole("button", { name: /Ejecutar actuación|Executar actuación/ })
      .click();
    await expect(page.getByRole("status")).toContainText(
      status === "CONFLICT"
        ? /Conflicto|Conflito/
        : status === "ABSENT"
          ? /ausente/
          : /Actuación aplicada/,
    );
    if (status !== "APPLIED")
      await expect(
        page.getByRole("heading", { name: "Actuación aplicada", exact: true }),
      ).toHaveCount(0);
  }
});
test("uncertain destructive actions survive reload without storing payloads or automatic retries", async ({
  page,
}) => {
  await fixture(page);
  let posts = 0;
  await page.route(`**${base}/privacy-actions`, async (route) => {
    posts++;
    await route.abort("failed");
  });
  await individual(page);
  await page
    .getByRole("button", { name: /Ejecutar actuación|Executar actuación/ })
    .click();
  await expect(
    page.getByText(
      /Hay una operación sin confirmar|Hai unha operación sen confirmar/,
    ),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: /Ejecutar actuación|Executar actuación/ }),
  ).toBeDisabled();
  expect(posts).toBe(1);
  const stored = await page.evaluate(() =>
    Object.fromEntries(
      Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]),
    ),
  );
  expect(Object.values(stored)).toContain("pending");
  expect(JSON.stringify(stored)).not.toContain("Autorización 9");
  expect(JSON.stringify(stored)).not.toContain("subject");
  await expect(
    page.getByRole("button", {
      name: /Cerrar comprobación|Pechar comprobación/,
    }),
  ).toBeDisabled();
  await page.getByRole("checkbox", { name: /He comprobado|Comprobei/ }).check();
  await page
    .getByRole("button", { name: /Cerrar comprobación|Pechar comprobación/ })
    .click();
  await expect(
    page.getByRole("button", { name: /Ejecutar actuación|Executar actuación/ }),
  ).toBeEnabled();
  expect(posts).toBe(1);
});
test("holds target one subject or record and truncated read results disclose their limits", async ({
  page,
}) => {
  await fixture(page);
  let sent: Record<string, unknown> | undefined;
  await page.route(`**${base}/retention-holds`, async (r) => {
    sent = r.request().postDataJSON();
    await r.fulfill({ status: 201, json: { holdId: id } });
  });
  await page.goto(`${view}/registrar-excepcion`);
  await select(page, "Familia de datos", "Reservas");
  await page
    .getByLabel(/Referencia (del registro|do rexistro)/, { exact: true })
    .fill("discarded-key");
  await select(page, /Alcance (de la excepción|da excepción)/, "Un interesado");
  await exact(page);
  await page
    .getByLabel(/Identificador (de la cuenta|da conta)/)
    .fill("subject");
  await authorize(page);
  await page
    .getByRole("button", {
      name: /Registrar excepción|Rexistrar excepción/,
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText(id);
  expect(sent).toEqual({
    category: "RESERVATIONS",
    subjectId: "subject",
    authorizationReference: "Autorización 9",
    reason: "Actuación autorizada",
  });
  await page.route(`**${base}/retention-status`, (r) =>
    r.fulfill({
      json: {
        holds: [],
        conflicts: [],
        hasMoreHolds: true,
        hasMoreConflicts: true,
      },
    }),
  );
  await page.goto(`${view}/excepciones`);
  await expect(page.getByText(/100 excepciones|100 excepcións/)).toBeVisible();
  await expect(page.getByText(/100 conflictos|100 conflitos/)).toBeVisible();
});
test("an administrator with privacy permissions picks the subject among linked people", async ({
  page,
}) => {
  await fixture(page);
  let sent: Record<string, unknown> | undefined;
  await page.route(`**${base}/profiles`, (r) =>
    r.fulfill({
      json: {
        items: [
          {
            accountId: "subject",
            accountLabel: { name: "Persona", email: "persona@example.test" },
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(`**${base}/privacy-actions`, async (r) => {
    sent = r.request().postDataJSON();
    await r.fulfill({ json: { status: "ABSENT", eventId: id } });
  });
  await page.goto(`${view}/actuacion`);
  // A family keyed by record keeps the exact reference only.
  await select(page, "Familia de datos", "Reservas");
  await expect(
    page.getByRole("combobox", { name: /Cómo indicar la cuenta/ }),
  ).toHaveCount(0);
  await select(
    page,
    "Familia de datos",
    /Perfiles municipales|Perfís municipais/,
  );
  await select(
    page,
    /Persona vinculada|Persoa vinculada/,
    "Persona · persona@example.test",
  );
  await select(page, "Actuación", "Suprimir");
  await authorize(page);
  await page
    .getByRole("button", { name: /Ejecutar actuación|Executar actuación/ })
    .click();
  await expect(page.getByRole("status")).toContainText(/ausente/);
  expect(sent).toMatchObject({
    category: "MUNICIPAL_PROFILE",
    targetKey: "subject",
  });
});
test("privacy staff without administration type the exact account and never read the municipal directory", async ({
  page,
}) => {
  await fixture(page, ["PRIVACY_READ", "PRIVACY_EXECUTE"], [], false);
  let directory = 0;
  await page.route("**/profiles**", async (r) => {
    directory++;
    await r.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto(`${view}/registrar-excepcion`);
  await select(page, /Alcance (de la excepción|da excepción)/, "Un interesado");
  await expect(
    page.getByRole("combobox", { name: /Cómo indicar la cuenta/ }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      /no da acceso al listado de personas del municipio|non dá acceso á listaxe de persoas do municipio/,
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel(/Identificador (de la cuenta|da conta)/),
  ).toBeVisible();
  await page.goto(`${view}/descarga`);
  await expect(
    page.getByLabel(/Identificador (de la cuenta|da conta)/),
  ).toBeVisible();
  expect(directory).toBe(0);
});
test("global privacy offers only global categories and oversized copies do not produce a download", async ({
  page,
}) => {
  await fixture(page, ["PRIVACY_READ"], ["PRIVACY_READ", "PRIVACY_EXECUTE"]);
  await page.goto("/plataforma/privacidad/aprobar");
  await page.getByRole("combobox", { name: "Familia de datos" }).click();
  await expect(page.getByRole("option")).toHaveCount(3);
  await expect(
    page.getByRole("option", { name: "Reservas", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.route("**/api/platform/accounts/*/personal-data", (r) =>
    r.fulfill({
      status: 409,
      json: {
        error: {
          code: "PERSONAL_DATA_TOO_LARGE",
          message: "La copia requiere preparación administrativa.",
        },
      },
    }),
  );
  await page.goto("/plataforma/privacidad/descarga");
  await page
    .getByLabel(/Identificador (de la cuenta|da conta)/)
    .fill("subject");
  await authorize(page);
  await page
    .getByRole("button", { name: "Preparar copia", exact: true })
    .click();
  await expect(
    page.getByText("La copia requiere preparación administrativa."),
  ).toBeVisible();
  expect(downloads).toBe(0);
  await expect(page.getByText(/Copia parcial preparada/)).toHaveCount(0);
});
