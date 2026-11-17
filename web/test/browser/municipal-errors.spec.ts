import { expect, type Page } from "@playwright/test";
import { pickDateTime } from "./date-fields";
import { test } from "./fixtures";

const tenant = "00000000-0000-4000-8000-000000000001",
  unit = "00000000-0000-4000-8000-000000000003";
async function fixture(page: Page, admin = true) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { items: [], nextCursor: null };
    if (path === "/api/me")
      body = {
        accountId: "manager",
        email: "manager@example.test",
        mfaVerified: true,
      };
    else if (path === "/api/me/preferences") body = { locale: null };
    else if (path === "/api/me/theme")
      body = {
        theme: (page.viewportSize()?.width ?? 1000) < 500 ? "dark" : "light",
      };
    else if (path === "/api/me/navigation")
      body = {
        municipalities: {
          items: [
            {
              id: tenant,
              name: "Oleiros",
              administrator: admin,
              permissions: admin
                ? []
                : [{ operation: "RESERVATION_READ", unitId: unit }],
            },
          ],
          nextCursor: null,
        },
        platform: { operator: false, permissions: [] },
      };
    else if (path.endsWith("/agenda/units"))
      body = { items: [{ id: unit, name: "Pista 1" }], nextCursor: null };
    else if (path === `/api/public/municipalities/${tenant}`)
      body = { id: tenant, name: "Oleiros", timeZone: "Europe/Madrid" };
    else if (path === "/api/public/reservation-command-policy")
      body = { retentionSeconds: 3600, serverTime: new Date().toISOString() };
    await route.fulfill({ json: body });
  });
}
test("municipal controls do not turn scoped read permission into configuration authority", async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto(`/administracion/${tenant}/agenda`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /Agenda diaria|Axenda diaria/,
  );
  await expect(
    page.getByRole("link", { name: /^Apariencia$|^Aparencia$/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Crear bloqueo" })).toHaveCount(
    0,
  );
  await page.goto(`/administracion/${tenant}/unidades/${unit}`);
  await expect(
    page.getByText(/No tienes permiso|Non tes permiso/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Guardar normas|Gardar normas/ }),
  ).toHaveCount(0);
});
test("stale appearance retains its draft and expected version until explicit reload", async ({
  page,
}) => {
  await fixture(page);
  let version = 1;
  const sent: number[] = [];
  await page.route("**/appearance", async (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      sent.push(input.expectedVersion);
      if (input.expectedVersion !== version) {
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: "CONFLICT",
              message: "La versión cambió. Consulta la configuración actual.",
            },
          },
        });
        return;
      }
      version++;
      await route.fulfill({
        json: {
          version,
          theme: input.theme,
          light: input.light,
          dark: input.dark,
          font: input.font,
          corners: input.corners,
          defaultTheme: input.defaultTheme,
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        version,
        theme: "neutral",
        light: {},
        dark: {},
        font: "inter",
        corners: "round",
        defaultTheme: "light",
      },
    });
  });
  await page.goto(`/administracion/${tenant}/apariencia`);
  const chooseBlue = async () => {
    await page.getByRole("button", { name: /^(Neutro|Azul)$/ }).click();
    await page.getByRole("menuitem", { name: "Azul", exact: true }).click();
  };
  const save = page.getByRole("button", { name: /^(Guardar|Gardar)$/ });
  await chooseBlue();
  version = 2;
  await save.click();
  await expect(
    page.getByText("La versión cambió. Consulta la configuración actual."),
  ).toBeVisible();
  // The draft stays as it was, ready to retry or discard.
  await expect(
    page.getByRole("button", { name: "Azul", exact: true }),
  ).toBeVisible();
  await save.click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent).toEqual([1, 1]);
  // Discarding reads the current version again; the next save starts from it.
  await page.getByRole("button", { name: "Descartar", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Neutro", exact: true }),
  ).toBeVisible();
  await expect(save).toHaveCount(0);
  await chooseBlue();
  await save.click();
  await expect.poll(() => sent).toEqual([1, 1, 2]);
});
test("a lost block response survives reload and replays the same command into the municipal agenda", async ({
  page,
}) => {
  await fixture(page);
  const requests: { key: string; body: string | null }[] = [];
  let saved: unknown = null;
  await page.route(`**/municipalities/${tenant}/blocks*`, async (route) => {
    if (route.request().method() === "POST") {
      requests.push({
        key: route.request().headers()["idempotency-key"],
        body: route.request().postData(),
      });
      saved = {
        ...route.request().postDataJSON(),
        tenantId: tenant,
        id: "00000000-0000-4000-8000-000000000005",
        releasedAt: null,
      };
      if (requests.length === 1) {
        await route.abort("failed");
        return;
      }
      await route.fulfill({ status: 201, json: saved });
      return;
    }
    await route.fulfill({
      json: { items: saved ? [saved] : [], nextCursor: null },
    });
  });
  await page.goto(`/administracion/${tenant}/agenda`);
  await page
    .getByRole("combobox", {
      name: /Unidad a bloquear|Unidade que se vai bloquear/,
    })
    .click();
  await page.getByRole("option", { name: "Pista 1", exact: true }).click();
  await pickDateTime(
    page,
    /Inicio del bloqueo|Inicio do bloqueo/,
    "2030-01-01T12:00",
  );
  await pickDateTime(
    page,
    /Fin del bloqueo|Fin do bloqueo/,
    "2030-01-01T13:00",
  );
  await page.getByLabel("Motivo").fill("Mantenimiento");
  await page
    .getByRole("checkbox", { name: /Confirmo el bloqueo|Confirmo o bloqueo/ })
    .check();
  await page.getByRole("button", { name: "Crear bloqueo" }).click();
  await expect(
    page
      .getByRole("link", {
        name: /operación sin resultado|operación sen resultado/,
      })
      .first(),
  ).toBeVisible();
  expect(requests.length).toBe(1);
  await page.reload();
  await page
    .getByRole("link", {
      name: /operación sin resultado|operación sen resultado/,
    })
    .first()
    .click();
  await expect(
    page.getByRole("link", { name: "Consultar estado actual" }),
  ).toHaveAttribute("href", `/administracion/${tenant}/agenda`);
  await page
    .getByRole("button", {
      name: /Comprobar con la misma solicitud|Comprobar coa mesma solicitude/,
    })
    .click();
  await expect(page).toHaveURL(`/administracion/${tenant}/agenda`);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(page.getByText("Mantenimiento", { exact: true })).toBeVisible();
});

test("expired MFA preserves the appearance draft and offers verification without leaving it", async ({
  page,
}) => {
  await fixture(page);
  let writes = 0;
  await page.route("**/appearance", async (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      await route.fulfill({
        status: 403,
        json: {
          error: {
            code: "REAUTHENTICATION_REQUIRED",
            message: "Verifica de nuevo el segundo factor.",
          },
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        version: 1,
        theme: "neutral",
        light: {},
        dark: {},
        font: "inter",
        corners: "round",
        defaultTheme: "light",
      },
    });
  });
  await page.goto(`/administracion/${tenant}/apariencia`);
  await page.getByRole("button", { name: "Neutro", exact: true }).click();
  await page.getByRole("menuitem", { name: "Azul", exact: true }).click();
  await page.getByRole("button", { name: /^(Guardar|Gardar)$/ }).click();
  await expect(
    page.getByText("Verifica de nuevo el segundo factor."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Azul", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
  await page
    .getByRole("button", { name: /Verificar acceso/ })
    .last()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Verificar acceso" }),
  ).toBeVisible();
  expect(writes).toBe(1);
});

test("an uncertain catalog creation cannot be resubmitted without reviewing its result", async ({
  page,
}) => {
  await fixture(page);
  let writes = 0;
  await page.route(`**/municipalities/${tenant}/facilities*`, async (route) => {
    if (route.request().method() === "POST") {
      writes++;
      await route.abort("failed");
      return;
    }
    await route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto(`/administracion/${tenant}`);
  const form = page.locator("form").filter({
    has: page.getByRole("button", { name: "Crear instalación", exact: true }),
  });
  await form
    .getByRole("textbox", { name: /^(Nombre|Nome)$/ })
    .fill("Centro deportivo");
  await form
    .getByRole("button", { name: "Crear instalación", exact: true })
    .click();
  const pending = page.getByRole("link", {
    name: /Hay una operación|Hai unha operación/,
  });
  await expect(pending).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Crear instalación", exact: true }),
  ).toHaveCount(0);
  expect(writes).toBe(1);
  await pending.click();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: /Comprobar con la misma solicitud|Comprobar coa mesma solicitude/,
    }),
  ).toBeEnabled();
  expect(writes).toBe(1);
  const stored = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("quenda.reservation-command") ?? "null"),
  );
  expect(JSON.parse(stored.body)).toEqual({ name: "Centro deportivo" });
  expect(stored.path).toBe(`/api/municipalities/${tenant}/facilities`);
});
test("sections waiting for the identity check explain it once, then wait quietly", async ({
  page,
}) => {
  await fixture(page);
  // Both catalog lists need a recent second factor.
  await page.route(
    /\/api\/municipalities\/[^/]+\/(facilities|units)(\?|$)/,
    (route) =>
      route.fulfill({
        status: 403,
        json: {
          error: {
            code: "REAUTHENTICATION_REQUIRED",
            message: "Verifica de nuevo el segundo factor.",
          },
        },
      }),
  );
  await page.goto(`/administracion/${tenant}`);
  await expect(
    page.getByRole("status", { name: /Verificación de seguridade?/ }),
  ).toBeVisible();
  // One section carries the full explanation and the way to the check; the other only says what it waits for.
  await expect(
    page.getByRole("region", { name: /^Resolver (el|o) problema$/ }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: /Ir a la verificación|Ir á verificación/ }),
  ).toHaveCount(1);
  await expect(
    page.getByText("Verifica de nuevo el segundo factor."),
  ).toHaveCount(2);
});
