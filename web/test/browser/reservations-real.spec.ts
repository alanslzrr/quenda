import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { reservationMail } from "../../../src/modules/communications/reservation-mail";
import { calendarDate } from "../../src/features/catalog/dates";
import { calendarLabel } from "../../src/ui/lib/calendar-labels";
import { createAccount, password, signOut } from "./account-helpers";
import { test } from "./fixtures";

const catalog = (index: number) => ({
  tenant: `00000000-0000-4000-8000-${String(index * 100 + 1).padStart(12, "0")}`,
  unit: `00000000-0000-4000-8000-${String(index * 100 + 3).padStart(12, "0")}`,
});
const checkout = (tenant: string, unit: string, start: string, end: string) =>
  `/municipios/${tenant}/unidades/${unit}/reservar?inicio=${encodeURIComponent(start)}&fin=${encodeURIComponent(end)}`;
const acceptance =
  /He leído y acepto las normas de uso|Lin e acepto as normas de uso/;
async function selectDay(page: Page, date: string, locale: string) {
  await page.getByRole("button", { name: /^Día \S+,/ }).click();
  const today = new Date();
  const target = calendarDate(date);
  if (
    today.getFullYear() !== target.getFullYear() ||
    today.getMonth() !== target.getMonth()
  )
    await page
      .getByRole("button", { name: /Mes siguiente|Mes seguinte/ })
      .click();
  await page
    .getByRole("gridcell", {
      name: calendarLabel(target, locale, "full"),
      exact: true,
    })
    .click();
}
test("real reservation, overlapping reschedule, notices, history filter and cancellation", async ({
  page,
}, info) => {
  const { tenant, unit } = catalog(info.project.name === "desktop" ? 1 : 2);
  await createAccount(page);
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const hour = info.project.name === "desktop" ? 10 : 16;
  const start = `${day}T${hour}:00:00Z`,
    end = `${day}T${hour + 1}:00:00Z`;
  await page.goto(checkout(tenant, unit, start, end));
  await expect(
    page.getByRole("heading", {
      name: /Revisa tu reserva|Revisa a túa reserva/,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirmar reserva", exact: true })
    .click();
  await expect(page).toHaveURL(/\/reservar\?/);
  await page.getByRole("checkbox", { name: acceptance }).check();
  await page
    .getByRole("button", { name: "Confirmar reserva", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/reservas/${tenant}/[\\da-f-]+$`));
  const detail = new URL(page.url()).pathname;
  const id = detail.split("/").at(-1) ?? "";
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  // The holder can take the reservation to a personal calendar.
  const calendar = page.getByRole("link", {
    name: /Añadir a mi calendario|Engadir ao meu calendario/,
  });
  await expect(calendar).toHaveAttribute(
    "href",
    new RegExp(
      `/api/municipalities/${tenant}/reservations/${id}/calendar\\.ics\\?lang=(es|gl)$`,
    ),
  );
  const file = await page.request.get(
    (await calendar.getAttribute("href")) ?? "",
  );
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toMatch(/^text\/calendar/);
  const ics = await file.text();
  expect(ics).toContain("BEGIN:VCALENDAR");
  expect(ics).toContain(`UID:${id}@`);
  expect(ics).toContain("STATUS:CONFIRMED");
  await page
    .getByRole("link", { name: "Cambiar horario", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Cambiar horario", exact: true }),
  ).toBeVisible();
  // The calendar's authenticated projection must offer an overlap with the old hold.
  const projection = await page.request.get(
    `/api/municipalities/${tenant}/reservations/${id}/availability?unitId=${unit}&date=${day}&durationMinutes=60`,
  );
  expect(projection.status()).toBe(200);
  expect(
    (await projection.json()).slots.some(
      (s: { start: { utc: string } }) =>
        Date.parse(s.start.utc) === Date.parse(`${day}T${hour}:30:00Z`),
    ),
  ).toBe(true);
  await expect(page).toHaveURL(new RegExp(`fecha=${day}&duracion=60`));
  const slot = await projection.json();
  const chosen = slot.slots.find(
    (s: { start: { utc: string } }) =>
      Date.parse(s.start.utc) === Date.parse(`${day}T${hour}:30:00Z`),
  );
  const destination = `${detail}/confirmar?unidad=${unit}&inicio=${encodeURIComponent(chosen.start.utc)}&fin=${encodeURIComponent(chosen.end.utc)}`;
  await page.locator(`a[href="${destination}"]`).click();
  await page.getByRole("checkbox", { name: acceptance }).check();
  await page
    .getByRole("button", { name: /^(Confirmar el cambio|Confirmar o cambio)$/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`${detail}$`));
  const changed = await page.request.get(
    `/api/municipalities/${tenant}/reservations/${id}`,
  );
  expect(Date.parse((await changed.json()).startsAt)).toBe(
    Date.parse(`${day}T${hour}:30:00Z`),
  );
  await page.goto("/avisos");
  await expect(page.getByText(/Reserva modificada/)).toBeVisible();
  // New notices are unread: the settings menu says so until they are marked as read.
  const settings = page.getByRole("button", { name: /^(Ajustes|Axustes)$/ });
  await expect(settings).toHaveAccessibleDescription(/(sin leer|sen ler)$/);
  await expect(page.locator("[data-unread]").first()).toBeVisible();
  const markAll = page.getByRole("button", {
    name: /^Marcar todo como (leído|lido)$/,
  });
  await markAll.click();
  await expect(markAll).toHaveCount(0);
  await expect(page.locator("[data-unread]")).toHaveCount(0);
  await expect(settings).toHaveAccessibleDescription("");
  await page.goto("/reservas");
  await expect(
    page.getByRole("combobox", { name: "Municipio", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: /Pista 1/ }).click();
  await page
    .getByRole("button", { name: "Cancelar reserva", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancelar reserva", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Reserva cancelada", exact: true }),
  ).toBeVisible();
  // The cancel dialog and its trigger are gone; focus must not fall back to the document body.
  await expect(page.locator("#content")).toBeFocused();
  const free = await page.request.get(
    `/api/public/municipalities/${tenant}/units/${unit}/availability?date=${day}&durationMinutes=60`,
  );
  expect(
    (await free.json()).slots.some(
      (s: { start: { utc: string } }) =>
        Date.parse(s.start.utc) === Date.parse(start),
    ),
  ).toBe(true);
});
test("late reservation requires its explicit restriction and cannot be cancelled by the holder", async ({
  page,
}, info) => {
  const { tenant, unit } = catalog(info.project.name === "desktop" ? 3 : 4);
  await createAccount(page);
  const start = new Date(
    Math.ceil((Date.now() + 3 * 3600000) / 1800000) * 1800000 +
      (info.project.name === "desktop" ? 0 : 3 * 3600000),
  );
  const end = new Date(start.getTime() + 1800000);
  await page.goto(
    checkout(tenant, unit, start.toISOString(), end.toISOString()),
  );
  await page.getByRole("checkbox", { name: acceptance }).check();
  await page
    .getByRole("button", { name: "Confirmar reserva", exact: true })
    .click();
  await expect(page).toHaveURL(/\/reservar\?/);
  await page.getByRole("checkbox", { name: /Acepto que esta reserva/ }).check();
  await page
    .getByRole("button", { name: "Confirmar reserva", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/reservas/${tenant}/[\\da-f-]+$`));
  await expect(
    page.getByRole("button", { name: "Cancelar reserva", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/mantiene el espacio ocupado|mantén o espazo ocupado/),
  ).toBeVisible();
});

test("municipal search offers a ninety minute booking and keeps its context on review", async ({
  page,
}, info) => {
  const { tenant } = catalog(info.project.name === "desktop" ? 1 : 2);
  await createAccount(page);
  await page.goto(`/municipios/${tenant}/horarios`);
  const day = new Date(Date.now() + (5 + info.repeatEachIndex) * 86400000)
    .toISOString()
    .slice(0, 10);
  await selectDay(page, day, info.project.name === "desktop" ? "es" : "gl");
  await page.getByRole("combobox", { name: "Duración", exact: true }).click();
  await page.getByRole("option", { name: "1 h 30 min", exact: true }).click();
  const chosen = page.locator('a[href*="/reservar?"]').first();
  await expect(chosen).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await page
      .getByRole("button", { name: /Ajustes|Axustes/, exact: true })
      .click();
    const option = page.getByRole("menuitem", {
      name: theme === "light" ? "Modo claro" : /Modo oscuro|Modo escuro/,
      exact: true,
    });
    if (await option.isEnabled()) await option.click();
    else await page.keyboard.press("Escape");
    // The modal menu hides the page from assistive technology until it has fully closed.
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `test-results/search-${info.project.name}-${theme}.png`,
      fullPage: true,
    });
  }
  const href = await chosen.getAttribute("href");
  const params = new URL(href ?? "", "http://local").searchParams;
  expect(
    Date.parse(params.get("fin") ?? "") -
      Date.parse(params.get("inicio") ?? ""),
  ).toBe(90 * 60000);
  await chosen.click();
  await expect(
    page.getByRole("heading", {
      name: /Revisa tu reserva|Revisa a túa reserva/,
    }),
  ).toBeVisible();
  await expect(page.getByText("1 h 30 min", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /^Cambiar día (u|ou) hora$/ }).click();
  await expect(
    page.getByRole("combobox", { name: "Duración", exact: true }),
  ).toContainText("1 h 30 min");
});

test("audit regression: generated email opens the reservation through real login without writing", async ({
  page,
}, info) => {
  const { tenant, unit } = catalog(info.project.name === "desktop" ? 1 : 2);
  const email = await createAccount(page);
  const day = new Date(Date.now() + (5 + info.repeatEachIndex) * 86400000)
    .toISOString()
    .slice(0, 10);
  const start = `${day}T14:00:00Z`,
    end = `${day}T15:00:00Z`;
  const response = await page.request.post(
    `/api/municipalities/${tenant}/reservations`,
    {
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Origin: "http://127.0.0.1:5173",
      },
      data: {
        unitId: unit,
        startsAt: start,
        endsAt: end,
        acceptance: {
          usageRulesVersion: 1,
          bookingPolicyVersion: 1,
          nonCancellable: false,
        },
      },
    },
  );
  expect(response.status()).toBe(201);
  const reservation = await response.json();
  const mail = reservationMail(
    email,
    "http://127.0.0.1:5173",
    info.project.name === "desktop" ? "es" : "gl",
    {
      tenantId: tenant,
      reservationId: reservation.id,
      revision: 1,
      kind: "CONFIRMADA",
      occurredAt: new Date().toISOString(),
      startsAt: start,
      endsAt: end,
      timeZone: "Europe/Madrid",
      unitId: unit,
      pendingUsageRulesVersion: null,
    },
  );
  const link = mail.text.match(/https?:\/\/[^\s]+$/)?.[0];
  expect(link).toBe(
    `http://127.0.0.1:5173/reservas/${tenant}/${reservation.id}`,
  );
  if (!link) throw new Error("Mail link missing");
  let writes = 0;
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      request.url().includes(`/municipalities/${tenant}/reservations`)
    )
      writes++;
  });
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  await signOut(page);
  await page.goto(link);
  await expect(page).toHaveURL(/\/acceso\?returnTo=/);
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^(Contraseña|Contrasinal)$/).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(link);
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(0);
  const current = await page.request.get(
    `/api/municipalities/${tenant}/reservations/${reservation.id}`,
  );
  expect((await current.json()).revision).toBe(1);
});
