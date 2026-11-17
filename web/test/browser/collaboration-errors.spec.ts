import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { pickDateTime } from "./date-fields";
import { test } from "./fixtures";
import { selectValue } from "./select-value";

const tenant = "00000000-0000-4000-8000-000000000001",
  unit = "00000000-0000-4000-8000-000000000003",
  id = "00000000-0000-4000-8000-000000000005",
  foreign = "00000000-0000-4000-8000-000000000002";
const root = `/api/municipalities/${tenant}`,
  view = `/administracion/${tenant}/convenios/${id}/versiones/1`;
function agreement() {
  return {
    agreementId: id,
    name: "Rede deportiva",
    timeZone: "Europe/Madrid",
    version: 1,
    status: "BORRADOR",
    startsAt: "2026-10-25T01:30:21.123Z",
    endsAt: "2090-01-01T00:00:00.789Z",
    purpose: "Uso deportivo compartido",
    legalBasis: "Base aprobada",
    responsibilities: "Responsabilidades acordadas",
    retentionPolicy: "Política aprobada",
    eligibility: "acreditacion_vigente",
    weeklyLimit: 3,
    aggregateReports: true,
    legalReviewReference: null,
    reportReviewReference: null,
    createdBy: "responsable",
    createdAt: "2026-10-01T00:00:00Z",
    correlationId: id,
    participants: [
      { tenantId: tenant, accreditationIssuer: true, unitIds: [unit] },
      { tenantId: foreign, accreditationIssuer: false, unitIds: [] },
    ],
    approvals: [] as {
      tenantId: string;
      approvedBy: string | null;
      approvedByLabel?: { name: string; email: string } | null;
      approvedAt: string;
    }[],
  };
}
async function fixture(page: Page, a = agreement(), administrator = true) {
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
                : [{ operation: "RESERVATION_READ", unitId: unit }],
            },
          ],
          nextCursor: null,
        },
        platform: { operator: false, permissions: [] },
      };
    if (path === "/api/public/reservation-command-policy")
      body = { serverTime: new Date().toISOString(), retentionSeconds: 3600 };
    if (path === `${root}/agreements/${id}/versions/1`) body = a;
    if (path === `${root}/agreements`) body = { items: [a], nextCursor: null };
    if (path === `${root}/profiles`)
      body = {
        items: [
          {
            accountId: "cuenta-vinculada",
            accountLabel: {
              name: "Cuenta vinculada",
              email: "persona@demo.test",
            },
          },
        ],
        nextCursor: null,
      };
    if (path === `${root}/agenda/units`)
      body = { items: [{ id: unit, name: "Pista 1" }], nextCursor: null };
    await route.fulfill({ json: body });
  });
}
test("non-administrators cannot access collaboration through direct routes", async ({
  page,
}) => {
  await fixture(page, agreement(), false);
  let reads = 0;
  await page.route(`**${root}/agreements**`, async (route) => {
    reads++;
    await route.fulfill({
      status: 403,
      json: { error: { code: "FORBIDDEN", message: "Sin permiso" } },
    });
  });
  for (const path of [
    view,
    `${view}/nueva-version`,
    `${view}/acreditar`,
    `/administracion/${tenant}/acreditaciones`,
    `/administracion/${tenant}/convenios/unidades/${unit}/reapertura`,
  ]) {
    await page.goto(path);
    await expect(
      page.getByText(/No tienes permiso|Non tes permiso/),
    ).toBeVisible();
  }
  expect(reads).toBe(0);
  await expect(
    page.getByRole("link", { name: "Convenios", exact: true }),
  ).toHaveCount(0);
});
test("new versions preserve precise dates, scope and configuration; stale rejection retains the draft", async ({
  page,
}, info) => {
  await fixture(page);
  let sent: Record<string, unknown> | undefined;
  await page.route(`**${root}/agreements/${id}/versions`, async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      status: 409,
      json: {
        error: {
          code: "CONFLICT",
          message: "Ya existe otra versión. Revisa el convenio.",
        },
      },
    });
  });
  await page.goto(`${view}/nueva-version`);
  await page
    .getByRole("checkbox", {
      name: /Confirmo (la configuración|a configuración)/,
    })
    .check();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/collaboration-editor-${info.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Crear versión", exact: true })
    .click();
  await expect(
    page.getByText("Ya existe otra versión. Revisa el convenio."),
  ).toBeVisible();
  const a = agreement();
  expect(sent).toEqual({
    expectedVersion: 1,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    purpose: a.purpose,
    legalBasis: a.legalBasis,
    responsibilities: a.responsibilities,
    retentionPolicy: a.retentionPolicy,
    eligibility: a.eligibility,
    weeklyLimit: 3,
    aggregateReports: true,
    participants: a.participants,
  });
  await expect(
    page.getByLabel(/^(?:Finalidad|Finalidade)$/, { exact: true }),
  ).toHaveValue(a.purpose);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("quenda.reservation-command"),
    ),
  ).toBeNull();
});
test("lost approval response replays the same key and own exact unit set without automatic resubmission", async ({
  page,
}) => {
  const a = agreement();
  await fixture(page, a);
  const sent: { body: string | null; key: string | undefined }[] = [];
  await page.route(`**${root}/agreements/${id}/approve`, async (route) => {
    sent.push({
      body: route.request().postData(),
      key: route.request().headers()["idempotency-key"],
    });
    if (sent.length === 1) {
      await route.abort("failed");
      return;
    }
    if (sent.length === 2) {
      await route.fulfill({
        status: 403,
        json: {
          error: {
            code: "REAUTHENTICATION_REQUIRED",
            message: "Verifica MFA de nuevo.",
          },
        },
      });
      return;
    }
    a.approvals = [
      {
        tenantId: tenant,
        approvedBy: "responsable",
        approvedAt: new Date().toISOString(),
      },
    ];
    await route.fulfill({
      json: { agreementId: id, version: 1, status: "BORRADOR" },
    });
  });
  await page.goto(view);
  await page
    .getByRole("checkbox", {
      name: /^(?:Confirmo esta versión y mis unidades|Confirmo esta versión e as miñas unidades)$/,
    })
    .check();
  await page
    .getByRole("button", { name: "Aprobar versión", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: /Revisar operación/ }).first(),
  ).toBeVisible();
  await page.reload();
  expect(sent).toHaveLength(1);
  await page
    .getByRole("link", { name: /Revisar operación/ })
    .first()
    .click();
  await expect(
    page.getByRole("link", { name: "Consultar estado actual" }),
  ).toHaveAttribute("href", view);
  await page
    .getByRole("button", {
      name: /^(?:Comprobar con la misma solicitud|Comprobar coa mesma solicitude)$/,
    })
    .click();
  await expect(page.getByText("Verifica MFA de nuevo.")).toBeVisible();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("quenda.reservation-command"),
    ),
  ).not.toBeNull();
  await page
    .getByRole("button", {
      name: /Comprobar (con la misma solicitud|coa mesma solicitude)/,
    })
    .click();
  await expect(page).toHaveURL(new RegExp(`${view}$`));
  expect(sent).toHaveLength(3);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[2]).toEqual(sent[0]);
  expect(JSON.parse(sent[0].body ?? "{}")).toEqual({
    version: 1,
    unitIds: [unit],
  });
  await expect(
    page.getByRole("button", { name: "Aprobar versión", exact: true }),
  ).toHaveCount(0);
});
test("reopening captures the exact restriction and never reports availability after conflicts", async ({
  page,
}) => {
  await fixture(page);
  let remaining = true,
    removed = false,
    sent: unknown;
  await page.route(
    `**${root}/units/${unit}/agreement-restriction`,
    async (route) =>
      route.fulfill({
        json: {
          unitId: unit,
          restriction: removed
            ? null
            : {
                agreementId: id,
                version: 4,
                hasRemainingAssignment: remaining,
              },
        },
      }),
  );
  await page.route(
    `**${root}/units/${unit}/agreement-restriction/release`,
    async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 409,
        json: {
          error: { code: "CONFLICT", message: "La vinculación ha cambiado." },
        },
      });
    },
  );
  await page.goto(
    `/administracion/${tenant}/convenios/unidades/${unit}/reapertura`,
  );
  await expect(
    page.getByText(/existen adscripciones|existen adscricións/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retirar vinculación" }),
  ).toHaveCount(0);
  remaining = false;
  await page.reload();
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Reapertura autorizada");
  await page
    .getByRole("checkbox", {
      name: /^(?:Confirmo la retirada de esta vinculación|Confirmo a retirada desta vinculación)$/,
    })
    .check();
  await page.getByRole("button", { name: "Retirar vinculación" }).click();
  await expect(page.getByText("La vinculación ha cambiado.")).toBeVisible();
  expect(sent).toEqual({
    expectedAgreementId: id,
    expectedVersion: 4,
    reason: "Reapertura autorizada",
  });
  await expect(
    page.getByText("Sin vinculación restrictiva registrada."),
  ).toHaveCount(0);
  await page.route(
    `**${root}/units/${unit}/agreement-restriction/release`,
    async (route) => {
      removed = true;
      await route.abort("failed");
    },
  );
  await page.getByRole("button", { name: "Retirar vinculación" }).click();
  await expect(
    page.getByRole("link", { name: /Revisar operación/ }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText(
      /Sin vinculación restrictiva registrada|Sen vinculación restritiva rexistrada/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Revisar operación/ }).first(),
  ).toBeVisible();
});
test("inaccessible agreement versions expose no configuration and credential references are not receipts", async ({
  page,
}) => {
  await fixture(page);
  await page.route(`**${root}/agreements/${id}/versions/1`, async (route) =>
    route.fulfill({
      status: 404,
      json: {
        error: { code: "NOT_FOUND", message: "No se encontró el convenio." },
      },
    }),
  );
  await page.goto(view);
  await expect(page.getByText("No se encontró el convenio.")).toBeVisible();
  await expect(page.getByText("Uso deportivo compartido")).toHaveCount(0);
  await page.goto(`/administracion/${tenant}/acreditaciones?referencia=${id}`);
  await expect(
    page.getByLabel("Identificador de acreditación", { exact: true }),
  ).toHaveValue(id);
  await expect(
    page.getByText(/^Revocación registrada|^Acreditación emitida\./),
  ).toHaveCount(0);
});

test("activation requires the configured report review and sends exact version references", async ({
  page,
}) => {
  const a = agreement();
  a.status = "APROBADO";
  await fixture(page, a);
  let sent: unknown;
  await page.route(`**${root}/agreements/${id}/activate`, async (route) => {
    sent = route.request().postDataJSON();
    a.status = "ACTIVADO";
    await route.fulfill({
      json: { agreementId: id, version: 1, status: "ACTIVADO" },
    });
  });
  await page.goto(view);
  await page
    .getByLabel(/Referencia de revisión (jurídica|xurídica)/, { exact: true })
    .fill("Revisión jurídica 7");
  await page
    .getByRole("checkbox", { name: /Confirmo (la|a) activación/ })
    .check();
  await page
    .getByRole("button", { name: "Activar versión", exact: true })
    .click();
  expect(sent).toBeUndefined();
  await page
    .getByLabel(/Referencia de revisión de (riesgo|risco)/, { exact: true })
    .fill("Revisión de informes 4");
  await page
    .getByRole("button", { name: "Activar versión", exact: true })
    .click();
  await expect(page.getByText("ACTIVADO", { exact: true })).toBeVisible();
  expect(sent).toEqual({
    version: 1,
    legalReviewReference: "Revisión jurídica 7",
    reportReviewReference: "Revisión de informes 4",
  });
});
test("recorded activation does not bypass effective-version checks when issuing an accreditation", async ({
  page,
}) => {
  const a = agreement();
  a.status = "ACTIVADO";
  await fixture(page, a);
  let sent: Record<string, unknown> | undefined;
  await page.route(`**${root}/credentials`, async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      status: 409,
      json: {
        error: { code: "CONFLICT", message: "La versión ya no está vigente." },
      },
    });
  });
  await page.goto(`${view}/acreditar`);
  await selectValue(
    page,
    "accountId",
    /Persona beneficiaria|Persoa beneficiaria/,
    "cuenta-vinculada",
  );
  await pickDateTime(page, "Inicio de acreditación", "2026-11-01T10:00");
  await pickDateTime(page, "Fin de acreditación", "2026-12-01T10:00");
  await page
    .getByLabel("Referencia de verificación", { exact: true })
    .fill("Verificación 3");
  await page
    .getByRole("checkbox", {
      name: /Confirmo (la verificación|a verificación)/,
    })
    .check();
  await page
    .getByRole("button", { name: "Emitir acreditación", exact: true })
    .click();
  await expect(page.getByText("La versión ya no está vigente.")).toBeVisible();
  expect(sent).toEqual({
    agreementId: id,
    version: 1,
    accountId: "cuenta-vinculada",
    startsAt: "2026-11-01T09:00:00.000Z",
    endsAt: "2026-12-01T09:00:00.000Z",
    verificationReference: "Verificación 3",
  });
  await expect(
    page.getByRole("combobox", {
      name: /Persona beneficiaria|Persoa beneficiaria/,
    }),
  ).toContainText("Cuenta vinculada");
  await expect(page.getByText(/Acreditación emitida\./)).toHaveCount(0);
});

test("an approval by another municipality shows that it exists without naming its approver", async ({
  page,
}) => {
  const a = agreement();
  a.approvals = [
    {
      tenantId: tenant,
      approvedBy: "responsable",
      approvedByLabel: {
        name: "Responsable de proba",
        email: "responsable@example.test",
      },
      approvedAt: "2026-10-02T10:00:00Z",
    },
    {
      tenantId: foreign,
      approvedBy: null,
      approvedByLabel: null,
      approvedAt: "2026-10-03T10:00:00Z",
    },
  ];
  await fixture(page, a);
  await page.goto(view);
  // The approver is named, never shown as a raw account identifier.
  await expect(
    page.getByText(/Aprobada por Responsable de proba/),
  ).toBeVisible();
  await expect(page.getByText(/Aprobada por responsable ·/)).toHaveCount(0);
  await expect(page.getByText(/^Aprobada · /)).toBeVisible();
  await expect(page.getByText("null")).toHaveCount(0);
});
