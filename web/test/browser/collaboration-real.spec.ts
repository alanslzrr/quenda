import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { pickDateTime } from "./date-fields";
import { test } from "./fixtures";
import { selectValue } from "./select-value";

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
async function select(
  page: Page,
  name: string | RegExp,
  option: string | RegExp,
) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
const civil = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 16);
async function approve(page: Page) {
  await page
    .getByRole("checkbox", {
      name: /^(?:Confirmo esta versión y mis unidades|Confirmo esta versión e as miñas unidades)$/,
    })
    .check();
  await page
    .getByRole("button", { name: "Aprobar versión", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Aprobar versión", exact: true }),
  ).toHaveCount(0);
}
test("two municipalities approve exact units, activate, accredit, revoke, suspend and explicitly reopen", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000);
  const fixtures = JSON.parse(
    await readFile("test-results/collaboration-fixtures.json", "utf8"),
  );
  const index = info.project.name === "desktop" ? 0 : 2,
    a = fixtures[index],
    b = fixtures[index + 1];
  await signin(page, a);
  const theme = await page.request.put("/api/me/theme", {
    data: { theme: info.project.name === "desktop" ? "light" : "dark" },
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  expect(theme.status()).toBe(200);
  const other = await browser.newContext({
    baseURL: "http://127.0.0.1:5173",
    locale: "es-ES",
    extraHTTPHeaders: {
      "x-quenda-test-client": `2001:db8:601:${index + 1}::1`,
    },
  });
  try {
    const peer = await other.newPage();
    await signin(peer, b);
    await page.goto(`/administracion/${a.tenant}/convenios/nuevo`);
    await page
      .getByLabel(/^(?:Nombre del convenio|Nome do convenio)$/, { exact: true })
      .fill("Rede deportiva compartida");
    await page.getByLabel("Zona horaria IANA").fill("UTC");
    await pickDateTime(
      page,
      /^(?:Inicio de vigencia|Inicio de vixencia)$/,
      civil(-1),
    );
    await pickDateTime(
      page,
      /^(?:Fin de vigencia|Fin de vixencia)$/,
      civil(14),
    );
    for (const label of [
      /^(?:Finalidad|Finalidade)$/,
      /^(?:Base jurídica|Base xurídica)$/,
      "Responsabilidades",
      "Conservación acordada",
    ])
      await page
        .getByLabel(label, { exact: true })
        .fill(`Texto aprobado: ${label}`);
    await select(
      page,
      /^(?:Acceso del convenio|Acceso do convenio)$/,
      /^(?:Acreditación vigente|Acreditación vixente)$/,
    );
    await page
      .getByRole("checkbox", {
        name: /^(?:Emisor de acreditaciones 1|Emisor de acreditacións 1)$/,
        exact: true,
      })
      .check();
    await select(
      page,
      /^(?:Añadir unidad municipal|Engadir unidade municipal)$/,
      "Pista 1",
    );
    await page
      .getByRole("button", {
        name: /^(?:Añadir unidad|Engadir unidade)$/,
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name: /^(?:Añadir participante|Engadir participante)$/,
        exact: true,
      })
      .click();
    await page.getByLabel("Municipio 2", { exact: true }).fill(b.tenant);
    await page
      .getByLabel(
        /^(?:Unidades: un identificador por línea · 2|Unidades: un identificador por liña · 2)$/,
        { exact: true },
      )
      .fill(b.unit);
    await page
      .getByRole("checkbox", {
        name: /^(?:Confirmo la configuración del borrador|Confirmo a configuración do borrador)$/,
      })
      .check();
    await page
      .getByRole("button", { name: "Crear borrador", exact: true })
      .click();
    await expect(page).toHaveURL(/\/convenios\/[\da-f-]+\/versiones\/1$/);
    const url = page.url(),
      agreementId = url.split("/convenios/")[1].split("/")[0];
    await approve(page);
    await expect(
      page.getByRole("button", { name: "Activar versión", exact: true }),
    ).toHaveCount(0);
    await peer.goto(
      `/administracion/${b.tenant}/convenios/${agreementId}/versiones/1`,
    );
    await approve(peer);
    await page.reload();
    await page
      .getByLabel(
        /^(?:Referencia de revisión jurídica|Referencia de revisión xurídica)$/,
        { exact: true },
      )
      .fill("Revisión municipal 01");
    await page
      .getByRole("checkbox", {
        name: /^(?:Confirmo la activación de esta versión|Confirmo a activación desta versión)$/,
      })
      .check();
    await page
      .getByRole("button", { name: "Activar versión", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Emitir acreditación", exact: true }),
    ).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `test-results/collaboration-${info.project.name}.png`,
      fullPage: true,
    });
    await page
      .getByRole("link", { name: "Emitir acreditación", exact: true })
      .click();
    await selectValue(
      page,
      "accountId",
      /Persona beneficiaria|Persoa beneficiaria/,
      a.accountId,
    );
    await pickDateTime(page, "Inicio de acreditación", civil(0));
    await pickDateTime(page, "Fin de acreditación", civil(7));
    await page
      .getByLabel("Referencia de verificación", { exact: true })
      .fill("Verificación municipal 01");
    await page
      .getByRole("checkbox", {
        name: /^(?:Confirmo la verificación y la vigencia indicadas|Confirmo a verificación e a vixencia indicadas)$/,
      })
      .check();
    await page
      .getByRole("button", { name: "Emitir acreditación", exact: true })
      .click();
    await expect(page.getByText(/Acreditación emitida\./)).toBeVisible();
    await page
      .getByRole("link", {
        name: /^(?:Revocar acreditación|Revogar acreditación)$/,
        exact: true,
      })
      .click();
    await expect(
      page.getByLabel("Identificador de acreditación", { exact: true }),
    ).toHaveValue(/[\da-f-]{36}/);
    await page
      .getByLabel("Motivo", { exact: true })
      .fill("Verificación revocada");
    await page
      .getByRole("checkbox", {
        name: /^(?:Confirmo la revocación|Confirmo a revogación)$/,
        exact: true,
      })
      .check();
    await page
      .getByRole("button", {
        name: /^(?:Revocar acreditación|Revogar acreditación)$/,
        exact: true,
      })
      .click();
    await expect(
      page.getByText(/Revocación registrada|Revogación rexistrada/),
    ).toBeVisible();
    // Use the second administrator for suspension: authority is municipal, not creator-only.
    await peer.reload();
    await peer
      .getByLabel("Motivo", { exact: true })
      .fill("Fin del programa compartido");
    await peer
      .getByRole("checkbox", {
        name: /^(?:Confirmo la suspensión del convenio|Confirmo a suspensión do convenio)$/,
      })
      .check();
    await peer
      .getByRole("button", { name: "Suspender convenio", exact: true })
      .click();
    await expect(peer.getByText("SUSPENDIDO", { exact: true })).toBeVisible();
    await peer
      .getByRole("link", { name: "Consultar vinculación", exact: true })
      .click();
    await peer
      .getByLabel("Motivo", { exact: true })
      .fill("Reapertura municipal autorizada");
    await peer
      .getByRole("checkbox", {
        name: /^(?:Confirmo la retirada de esta vinculación|Confirmo a retirada desta vinculación)$/,
      })
      .check();
    await peer
      .getByRole("button", { name: "Retirar vinculación", exact: true })
      .click();
    await expect(
      peer.getByText("Sin vinculación restrictiva registrada.", {
        exact: true,
      }),
    ).toBeVisible();
    const reservation = await peer.request.get(
      `/api/municipalities/${b.tenant}/reservations/${b.reservationId}`,
    );
    expect(reservation.status()).toBe(200);
    expect((await reservation.json()).status).toBe("CONFIRMADA");
    await peer.goto(
      `/administracion/${b.tenant}/convenios/${agreementId}/versiones/1`,
    );
    await peer
      .getByRole("link", { name: "Crear nueva versión", exact: true })
      .click();
    await peer
      .getByRole("checkbox", { name: "Confirmo la configuración del borrador" })
      .check();
    await peer
      .getByRole("button", { name: "Crear versión", exact: true })
      .click();
    await expect(peer).toHaveURL(/\/versiones\/2$/);
    await expect(peer.getByText("BORRADOR", { exact: true })).toBeVisible();
    const next = await peer.request.get(
      `/api/municipalities/${b.tenant}/agreements/${agreementId}/versions/2`,
    );
    expect(next.status()).toBe(200);
    const version = await next.json();
    expect(version.approvals).toEqual([]);
    expect(version.legalReviewReference).toBeNull();
    expect(version.participants).toHaveLength(2);
    expect(version.timeZone).toBe("UTC");
  } finally {
    await other.close();
  }
});
