import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { test } from "./fixtures";

async function enter(page: Page, index: number) {
  const f = JSON.parse(
    await readFile("test-results/municipal-fixtures.json", "utf8"),
  )[index];
  await login(page, f.email, f.password);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  if ((page.viewportSize()?.width ?? 1000) < 500) {
    await page.getByRole("button", { name: /Ajustes|Axustes/ }).click();
    await page
      .getByRole("menuitem", { name: /Modo oscuro|Modo escuro/ })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  }

  await page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("link", { name: /^(Gestión|Xestión)$/ })
    .click();
  if (new URL(page.url()).pathname === "/administracion")
    await page.getByRole("link", { name: /^Oleiros de proba/ }).click();
  await expect(page).toHaveURL(`/administracion/${f.tenant}`);
  return f;
}
async function select(
  page: Page,
  name: RegExp | string,
  option: RegExp | string,
) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  // Radix restores outside accessibility and focus after its closing animation.
  await expect(page.getByRole("listbox", { includeHidden: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("combobox", { name, exact: true })).toBeFocused();
}
test("municipal catalog and versioned configuration use the real API", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await enter(page, info.project.name === "desktop" ? 0 : 1);
  const create = page.locator("form").filter({
    has: page.getByRole("button", { name: "Crear instalación", exact: true }),
  });
  await create.getByLabel(/Nombre|Nome/).fill("Centro novo");
  await create
    .getByRole("button", { name: "Crear instalación", exact: true })
    .click();
  await page.getByRole("link", { name: "Centro novo", exact: true }).click();
  // Publishing is a header action that opens its confirmation.
  await page
    .getByRole("button", { name: "Publicar instalación", exact: true })
    .click();
  const publish = page
    .getByRole("dialog")
    .locator("form")
    .filter({
      has: page.getByRole("button", {
        name: "Publicar instalación",
        exact: true,
      }),
    });
  await publish.getByLabel("Motivo").fill("Apertura del centro");
  await publish
    .getByRole("button", { name: "Publicar instalación", exact: true })
    .click();
  await expect(page.getByText("Publicada", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Catálogo", exact: true }).click();
  const center = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Centro novo", exact: true }),
  });
  await center.getByRole("link", { name: /Crear uni/ }).click();
  await expect(
    page.getByRole("heading", {
      name: /Nueva unidad reservable|Nova unidade reservable/,
    }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: /^(Nombre|Nome)$/ })
    .fill("Sala nova");
  await page.getByRole("button", { name: /Crear uni/ }).click();
  await page
    .getByRole("link", { name: /Volver al catálogo|Volver ao catálogo/ })
    .click();
  await page.getByRole("link", { name: "Sala nova", exact: true }).click();
  await page.getByRole("button", { name: /Publicar uni/ }).click();
  await expect(
    page.getByText(/Añade las normas|Engade as normas/),
  ).toBeVisible();
  await page.getByRole("button", { name: /^(Cerrar|Pechar)$/ }).click();
  await page.getByRole("tab", { name: "Normas", exact: true }).click();
  const rules = page.locator("form").filter({
    has: page.getByRole("button", { name: /Guardar normas|Gardar normas/ }),
  });
  await rules
    .getByLabel(/Texto de las normas|Texto das normas/)
    .fill("Uso deportivo. Respeta el horario reservado.");
  await rules.getByLabel("Motivo").fill("Normas iniciales");
  await rules
    .getByRole("button", { name: /Guardar normas|Gardar normas/ })
    .click();
  await page.getByRole("tab", { name: "Horarios", exact: true }).click();
  const calendar = page.locator("form").filter({
    has: page.getByRole("button", {
      name: /Guardar horarios|Gardar horarios/,
    }),
  });
  await calendar
    .getByRole("button", {
      name: /Añadir franja semanal|Engadir franxa semanal/,
    })
    .click();
  await calendar
    .getByRole("button", { name: /Añadir excepción|Engadir excepción/ })
    .click();
  await calendar.getByLabel(/^(Fecha|Data)$/).fill("2030-01-01");
  await calendar.getByLabel("Motivo").fill("Horario inicial");
  await calendar
    .getByRole("button", { name: /Guardar horarios|Gardar horarios/ })
    .click();
  await expect(
    calendar.getByText(/Cambios guardados|Cambios gardados/),
  ).toHaveText(/Cambios guardados|Cambios gardados/);
  await page.getByRole("button", { name: /Publicar uni/ }).click();
  const unitPublish = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: /Publicar uni/ }) });
  await unitPublish.getByLabel("Motivo").fill("Apertura de la sala");
  await unitPublish.getByRole("checkbox").check();
  await unitPublish.getByRole("button", { name: /Publicar uni/ }).click();
  await expect(page.getByText("Publicada", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Normas", exact: true }).click();
  await expect(
    page.getByLabel(/Texto de las normas|Texto das normas/),
  ).toHaveValue("Uso deportivo. Respeta el horario reservado.");
  await page.getByRole("tab", { name: "Horarios", exact: true }).click();
  await expect(page.getByLabel(/^(Fecha|Data)$/)).toHaveValue("2030-01-01");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/municipal-catalog-${info.project.name}.png`,
    fullPage: true,
  });
});

test("municipal appearance saves explicitly while preview temporarily overrides the administrative theme", async ({
  page,
}, info) => {
  await enter(page, info.project.name === "desktop" ? 2 : 3);
  if ((page.viewportSize()?.width ?? 1280) < 768)
    await page
      .getByRole("button", {
        name: /Gestión municipal|Xestión municipal/,
        exact: true,
      })
      .click();
  await page
    .getByRole("link", { name: /Condiciones de reserva|Condicións de reserva/ })
    .click();
  await page.getByLabel(/Antelación máxima/).fill("35");
  await page.getByLabel("Motivo").fill("Ampliación de antelación");
  await page
    .getByRole("button", { name: /Guardar condiciones|Gardar condicións/ })
    .click();
  await expect(
    page.getByRole("main").getByText(/Cambios guardados|Cambios gardados/),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Antelación máxima/)).toHaveValue("35");
  if ((page.viewportSize()?.width ?? 1280) < 768)
    await page
      .getByRole("button", {
        name: /Gestión municipal|Xestión municipal/,
        exact: true,
      })
      .click();
  await page.getByRole("link", { name: /^Apariencia$|^Aparencia$/ }).click();
  const theme = (name: RegExp) => page.getByRole("button", { name });
  // "Modo inicial" is a radio group with the same two names, so the previewed mode is picked within its own group.
  const viewing = page.getByRole("group", {
    name: /^Modo que estás (viendo|vendo)$/,
  });
  await viewing.getByRole("radio", { name: "Claro", exact: true }).check();
  await theme(/^Neutro$/).click();
  await page.getByRole("menuitem", { name: "Azul", exact: true }).click();
  // Every choice shows at once, before saving.
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(249, 251, 255)",
  );
  await viewing.getByRole("radio", { name: /^(Oscuro|Escuro)$/ }).check();
  await page
    .getByLabel(/^Acento en modo (oscuro|escuro), en hexadecimal$/)
    .fill("#7fb0ff");
  await page.getByRole("button", { name: /^(Guardar|Gardar)$/ }).click();
  await expect(
    page.getByText(/Apariencia guardada|Aparencia gardada/),
  ).toBeVisible();
  await page.reload();
  await expect(theme(/^Azul$/)).toBeVisible();
  await viewing.getByRole("radio", { name: /^(Oscuro|Escuro)$/ }).check();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(20, 29, 43)",
  );
  await expect(
    page.getByLabel(/^Acento en modo (oscuro|escuro), en hexadecimal$/),
  ).toHaveValue("#7fb0ff");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/municipal-appearance-${info.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Restaurar valores predeterminados" })
    .click();
  await page.getByRole("button", { name: /^(Guardar|Gardar)$/ }).click();
  await expect(
    page.getByText(/Apariencia guardada|Aparencia gardada/),
  ).toBeVisible();
  await page.reload();
  await expect(theme(/^Neutro$/)).toBeVisible();
});

test("calendar changes preserve confirmed reservations and withdrawal preserves history", async ({
  page,
}, info) => {
  const f = await enter(page, info.project.name === "desktop" ? 4 : 5);
  await page.goto(`/administracion/${f.tenant}/unidades/${f.unit}`);
  await page.getByRole("tab", { name: "Horarios", exact: true }).click();
  // Existing reservations prevent closing all opening intervals.
  const existingCalendar = page.locator("form").filter({
    has: page.getByRole("button", {
      name: /Guardar horarios|Gardar horarios/,
    }),
  });
  await expect(
    existingCalendar.getByRole("button", {
      name: /Quitar franja|Quitar franxa/,
    }),
  ).toHaveCount(7);
  while (
    await existingCalendar
      .getByRole("button", { name: /Quitar franja|Quitar franxa/ })
      .count()
  )
    await existingCalendar
      .getByRole("button", { name: /Quitar franja|Quitar franxa/ })
      .first()
      .click();
  await existingCalendar.getByLabel("Motivo").fill("Cierre incompatible");
  await existingCalendar
    .getByRole("button", { name: /Guardar horarios|Gardar horarios/ })
    .click();
  await expect(existingCalendar.getByRole("alert").first()).toBeVisible();
  await page
    .getByRole("button", { name: /Retirar del catálogo|Retirar do catálogo/ })
    .click();
  const withdraw = page.locator("form").filter({
    has: page.getByRole("button", { name: "Retirar", exact: true }),
  });
  await withdraw.getByLabel("Motivo").fill("Retirada de la unidad");
  await withdraw.getByRole("checkbox").check();
  await withdraw.getByRole("button", { name: "Retirar", exact: true }).click();
  await expect(
    page.getByText(
      /Retirada del catálogo público|Retirada do catálogo público/,
    ),
  ).toBeVisible();
  await page.goto(`/administracion/${f.tenant}/reservas/${f.reservationId}`);
  // The page names the reservation by its unit and shows its status beside the title.
  await expect(
    page.getByRole("heading", { level: 1, name: /^Reserva · .+/ }),
  ).toBeVisible();
  await expect(page.getByText("Confirmada", { exact: true })).toBeVisible();
});

test("daily agenda relocates without accepting rules and cancels explicitly", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const f = await enter(page, info.project.name === "desktop" ? 6 : 7);
  if ((page.viewportSize()?.width ?? 1280) < 768)
    await page
      .getByRole("button", {
        name: /Gestión municipal|Xestión municipal/,
        exact: true,
      })
      .click();
  await page.getByRole("link", { name: /Agenda diaria|Axenda diaria/ }).click();
  await page.getByLabel(/Fecha de la agenda|Data da axenda/).fill(f.date);
  await page
    .getByRole("table", { name: /Reservas del día|Reservas do día/ })
    .getByRole("link")
    .first()
    .click();
  await select(page, /Unidad de destino|Unidade de destino/, "Pista 2");
  await page.getByLabel(/Nueva fecha|Nova data/).fill(f.date);
  await page
    .getByRole("combobox", { name: /Franja disponible|Franxa dispoñible/ })
    .click();
  await page.getByRole("option").first().click();
  const relocation = page.locator("form").filter({
    has: page.getByRole("button", {
      name: "Confirmar reubicación",
      exact: true,
    }),
  });
  await relocation.getByLabel("Motivo").fill("Mantenimiento en pista 1");
  await relocation.getByRole("checkbox").check();
  await relocation
    .getByRole("button", { name: "Confirmar reubicación", exact: true })
    .click();
  await expect(
    page.getByText(
      /titular tiene normas pendientes|titular ten normas pendentes/,
    ),
  ).toBeVisible();
  const cancel = page.locator("form").filter({
    has: page.getByRole("button", { name: "Cancelar administrativamente" }),
  });
  await cancel.getByLabel("Motivo").fill("Resolución municipal");
  await cancel.getByRole("checkbox").check();
  await cancel
    .getByRole("button", { name: "Cancelar administrativamente" })
    .click();
  // The page names the reservation by its unit and shows its status beside the title.
  await expect(
    page.getByRole("heading", { level: 1, name: /^Reserva · .+/ }),
  ).toBeVisible();
  await expect(page.getByText("Cancelada", { exact: true })).toBeVisible();
});

test("blocks survive reload and release through the daily agenda", async ({
  page,
}, info) => {
  const f = await enter(page, info.project.name === "desktop" ? 8 : 9);

  if ((page.viewportSize()?.width ?? 1280) < 768)
    await page
      .getByRole("button", {
        name: /Gestión municipal|Xestión municipal/,
        exact: true,
      })
      .click();
  await page
    .getByRole("link", { name: /Agenda diaria|Axenda diaria/ })
    .first()
    .click();
  await page.getByLabel(/Fecha de la agenda|Data da axenda/).fill(f.date);
  const block = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Crear bloqueo" }) });
  await select(
    page,
    /Unidad a bloquear|Unidade que se vai bloquear/,
    "Pista 1",
  );
  await block
    .getByLabel(/Inicio del bloqueo|Inicio do bloqueo/)
    .fill(`${f.date}T12:00`);
  await block
    .getByLabel(/Fin del bloqueo|Fin do bloqueo/)
    .fill(`${f.date}T13:00`);
  await block.getByLabel("Motivo").fill("Revisión del pavimento");
  await block.getByRole("checkbox").check();
  await block.getByRole("button", { name: "Crear bloqueo" }).click();
  await expect(
    page.getByText("Revisión del pavimento", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel(/Fecha de la agenda|Data da axenda/).fill(f.date);
  const release = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Liberar bloqueo" }) });
  await release.getByLabel("Motivo").fill("Revisión finalizada");
  await release.getByRole("checkbox").check();
  await release.getByRole("button", { name: "Liberar bloqueo" }).click();
  await expect(page.getByText("Liberado", { exact: true })).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/municipal-agenda-${info.project.name}.png`,
    fullPage: true,
  });
});

test("audit regression: real editors retain versions across MFA recovery and discard revoked drafts", async ({
  page,
}, info) => {
  const f = await enter(
    page,
    10 + info.repeatEachIndex * 2 + (info.project.name === "desktop" ? 0 : 1),
  );
  const path = `/api/municipalities/${f.tenant}/units/${f.unit}`;
  const base = `/api/municipalities/${f.tenant}`;
  for (const suffix of [
    "/reservations?date=0000-01-01",
    "/exports/reservations?from=0000-01-01&to=0000-02-01",
    "/indicators?from=0000-01-01&to=0000-02-01",
    `/agreements/${f.unit}/reports/0000-01`,
  ]) {
    const invalid = await page.request.get(base + suffix);
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error.code).toBe("INVALID_INPUT");
  }
  for (const date of ["0001-01-01", "9999-12-31"]) {
    expect(
      (await page.request.get(`${base}/reservations?date=${date}`)).status(),
    ).toBe(200);
  }
  const oldCalendar = await (await page.request.get(`${path}/calendar`)).json();
  const original = await (await page.request.get(`${path}/usage-rules`)).json();
  await page.goto(`/administracion/${f.tenant}/unidades/${f.unit}`);
  await page.getByLabel(/^(Nombre|Nome)$/).fill("Nombre sin guardar");
  await page.getByRole("tab", { name: "Horarios", exact: true }).click();
  const start = page.getByLabel("Inicio (HH:mm)", { exact: true }).first();
  await start.fill("01:15");
  await page.getByRole("tab", { name: "Normas", exact: true }).click();
  const text = page.getByLabel(/Texto de las normas|Texto das normas/);
  await text.fill("Normas sin guardar");
  await page
    .getByRole("tabpanel", { name: "Normas" })
    .getByLabel("Motivo")
    .fill("Cambio local");
  // A separate request publishes a concurrent revision while the draft stays open.
  const concurrent = await page.request.put(`${path}/usage-rules`, {
    headers: { Origin: "http://127.0.0.1:5173" },
    data: {
      expectedVersion: original.version,
      text: `Revisión concurrente ${crypto.randomUUID()}`,
      reason: "Edición concurrente",
    },
  });
  expect(concurrent.status()).toBe(200);
  const concurrentCalendar = await page.request.put(`${path}/calendar`, {
    headers: { Origin: "http://127.0.0.1:5173" },
    data: {
      expectedVersion: oldCalendar.version,
      calendar: oldCalendar.calendar,
      reason: "Revisión concurrente",
    },
  });
  expect(concurrentCalendar.status()).toBe(200);
  let failure = "REAUTHENTICATION_REQUIRED";
  let writes = 0;
  page.on("request", (request) => {
    if (request.url().includes(path) && request.method() !== "GET") writes++;
  });
  const gate = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "GET" || !failure) return route.continue();
    return route.fulfill({
      status: 403,
      json: { error: { code: failure, message: "Acceso pendiente" } },
    });
  };
  await page.route(`**${path}**`, gate);
  const resume = () =>
    page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      window.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      window.dispatchEvent(new Event("visibilitychange"));
    });
  await resume();
  const verify = page.getByRole("button", {
    name: "Verificar acceso",
    exact: true,
  });
  await expect(verify).toBeVisible();
  await expect(text).toHaveValue("Normas sin guardar");
  const save = page.getByRole("button", {
    name: /Guardar normas|Gardar normas/,
  });
  await expect(save).toBeDisabled();
  failure = "";
  await verify.click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await dialog
    .getByRole("button", { name: "Verificar acceso", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(save).toBeEnabled();
  await expect(text).toHaveValue("Normas sin guardar");
  expect(writes).toBe(0);
  const conflict = page.waitForResponse(
    (r) =>
      r.url().endsWith(`${path}/usage-rules`) && r.request().method() === "PUT",
  );
  await save.click();
  expect((await conflict).status()).toBe(409);
  await expect(text).toHaveValue("Normas sin guardar");
  expect(writes).toBe(1);
  await page.getByRole("tab", { name: "Horarios", exact: true }).click();
  await expect(start).toHaveValue("01:15");
  await page
    .getByRole("tabpanel", { name: "Horarios" })
    .getByLabel("Motivo")
    .fill("Borrador local");
  const calendarConflict = page.waitForResponse(
    (r) =>
      r.url().endsWith(`${path}/calendar`) && r.request().method() === "PUT",
  );
  await page
    .getByRole("button", { name: /Guardar horarios|Gardar horarios/ })
    .click();
  expect((await calendarConflict).status()).toBe(409);
  await expect(start).toHaveValue("01:15");
  expect(writes).toBe(2);
  await page.getByRole("tab", { name: "Datos", exact: true }).click();
  await expect(page.getByLabel(/^(Nombre|Nome)$/)).toHaveValue(
    "Nombre sin guardar",
  );
  failure = "FORBIDDEN";
  await resume();
  await expect(page.getByLabel(/^(Nombre|Nome)$/)).toHaveCount(0);
  await expect(
    page.getByLabel(/Texto de las normas|Texto das normas/),
  ).toHaveCount(0);
});

test("catalog creation recovers a committed response after reload without duplicating the resource", async ({
  page,
}, info) => {
  const f = await enter(page, info.project.name === "desktop" ? 26 : 27);
  const requests: { key: string | undefined; body: string | null }[] = [];
  let createdId = "";
  await page.route(
    `**/api/municipalities/${f.tenant}/facilities`,
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      requests.push({
        key: route.request().headers()["idempotency-key"],
        body: route.request().postData(),
      });
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      const result = await response.json();
      if (requests.length === 1) {
        createdId = result.facilityId;
        await route.abort("failed");
      } else {
        expect(result.facilityId).toBe(createdId);
        await route.fulfill({ response });
      }
    },
  );
  const form = page.locator("form").filter({
    has: page.getByRole("button", { name: "Crear instalación", exact: true }),
  });
  await form.getByLabel(/Nombre|Nome/).fill("Centro recuperado");
  await form
    .getByRole("button", { name: "Crear instalación", exact: true })
    .click();
  await page
    .getByRole("link", { name: /Hay una operación|Hai unha operación/ })
    .click();
  await page.reload();
  expect(requests).toHaveLength(1);
  await page
    .getByRole("button", {
      name: /Comprobar con la misma solicitud|Comprobar coa mesma solicitude/,
    })
    .click();
  await expect(page).toHaveURL(new RegExp(`/instalaciones/${createdId}$`));
  await expect(
    page.getByRole("heading", { name: "Centro recuperado", exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("quenda.reservation-command"),
    ),
  ).toBeNull();
});
