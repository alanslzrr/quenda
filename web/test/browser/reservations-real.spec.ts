import { expect, type Page } from "@playwright/test";
import { calendarDate } from "../../src/features/catalog/dates";
import { calendarLabel } from "../../src/ui/lib/calendar-labels";
import { createAccount } from "./account-helpers";
import { test } from "./fixtures";

const catalog = (index: number) => ({
  tenant: `00000000-0000-4000-8000-${String(index * 100 + 1).padStart(12, "0")}`,
  unit: `00000000-0000-4000-8000-${String(index * 100 + 3).padStart(12, "0")}`,
});
const checkout = (tenant: string, unit: string, start: string, end: string) =>
  `/municipios/${tenant}/unidades/${unit}/reservar?inicio=${encodeURIComponent(start)}&fin=${encodeURIComponent(end)}`;
async function selectDay(page: Page, date: string, locale: string) {
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
    page.getByRole("heading", { name: "Confirmar reserva" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirmar reserva", exact: true })
    .click();
  await expect(page).toHaveURL(/\/reservar\?/);
  await page.getByRole("checkbox", { name: /Acepto estas normas/ }).check();
  await page
    .getByRole("button", { name: "Confirmar reserva", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/reservas/${tenant}/[\\da-f-]+$`));
  const detail = new URL(page.url()).pathname;
  const id = detail.split("/").at(-1) ?? "";
  await expect(page.getByRole("heading", { name: /Detalle/ })).toBeVisible();
  await page
    .getByRole("link", { name: "Modificar reserva", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Modificar reserva", exact: true }),
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
  await selectDay(page, day, info.project.name === "desktop" ? "es" : "gl");
  await page.getByLabel("Duración en minutos", { exact: true }).fill("60");
  const slot = await projection.json();
  const chosen = slot.slots.find(
    (s: { start: { utc: string } }) =>
      Date.parse(s.start.utc) === Date.parse(`${day}T${hour}:30:00Z`),
  );
  const destination = `${detail}/confirmar?unidad=${unit}&inicio=${encodeURIComponent(chosen.start.utc)}&fin=${encodeURIComponent(chosen.end.utc)}`;
  await page
    .getByRole("link")
    .filter({ has: page.locator("small") })
    .and(page.locator(`a[href="${destination}"]`))
    .click();
  await page.getByRole("checkbox", { name: /Acepto estas normas/ }).check();
  await page
    .getByRole("button", { name: "Confirmar modificación", exact: true })
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
  await page.goto("/reservas");
  await page.getByRole("combobox", { name: "Municipio", exact: true }).click();
  await page
    .getByRole("option", {
      name: `Oleiros de proba ${info.project.name === "desktop" ? 1 : 2}`,
      exact: true,
    })
    .click();
  await expect(page.getByRole("link", { name: /Pista 1/ })).toBeVisible();
  await page.getByRole("link", { name: /Pista 1/ }).click();
  await page
    .getByRole("checkbox", { name: /Quiero cancelar|Quero cancelar/ })
    .check();
  await page
    .getByRole("button", { name: "Cancelar reserva", exact: true })
    .click();
  await expect(page.getByText("Cancelada", { exact: true })).toBeVisible();
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
  await page.getByRole("checkbox", { name: /Acepto estas normas/ }).check();
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
    page.getByText(/mantiene su ocupación|mantén a súa ocupación/),
  ).toBeVisible();
});
