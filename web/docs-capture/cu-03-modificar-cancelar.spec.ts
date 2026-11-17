import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { access, account, Capture, expect, roles, test } from "./capture";
import {
  book,
  freeSlots,
  madridDate,
  notice,
  shot,
  signInWith,
  valdeira,
} from "./citizen";

// CU-03 — Modificar o cancelar una reserva. La vecina crea sus propias
// reservas para el escenario; no toca las sembradas.
const cu = new Capture("CU-03");
const acceptance = (page: Page) =>
  page.getByRole("checkbox", {
    name: "He leído y acepto las normas de uso y las condiciones de cancelación.",
  });

async function signInLucia(page: Page) {
  const { email } = await account(roles.citizen);
  await signInWith(page, email, (await access()).password);
}

/** Two free whole-hour slots on a day after every seeded reservation. */
async function hourSlots(page: Page, unit: string, offset: number) {
  return (await freeSlots(page, valdeira.id, unit, madridDate(offset))).filter(
    (slot) => Date.parse(slot.start.utc) % 3600000 === 0,
  );
}

test("CU-03 modificar y cancelar una reserva", async ({ page }) => {
  await signInLucia(page);
  const [first] = await hourSlots(page, valdeira.padel1, 25);
  if (!first) throw new Error("No free slot");
  const created = await book(page, valdeira.id, valdeira.padel1, first);
  const detail = `/reservas/${valdeira.id}/${created.id}`;

  // Paso 1: consultar la reserva desde «Mis reservas».
  await page.goto("/reservas");
  const item = page.locator(`a[href="${detail}"]`);
  await expect(item).toBeVisible();
  // Vista más alta: cabecera, filtro y la reserva en la misma imagen.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(item).toBeInViewport();
  await shot(cu, page, "mis-reservas", { target: item });
  await page.setViewportSize({ width: 1280, height: 800 });
  await item.click();
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  const change = page.getByRole("link", {
    name: "Cambiar horario",
    exact: true,
  });
  await shot(cu, page, "detalle-de-la-reserva", { target: change });

  // Paso 1: elegir otro horario.
  await change.click();
  await expect(
    page.getByRole("heading", { name: "Cambiar horario", exact: true }),
  ).toBeVisible();
  const choices = page.locator(`a[href^="${detail}/confirmar?"]`);
  await expect(choices.first()).toBeVisible();
  const destination = choices.nth(1);
  await shot(cu, page, "elegir-nuevo-horario", { target: destination });
  await destination.click();

  // Paso 2: aceptar las condiciones vigentes y confirmar.
  await expect(
    page.getByRole("heading", { name: "Revisa el cambio" }),
  ).toBeVisible();
  await shot(cu, page, "revisar-el-cambio");
  await acceptance(page).check();
  const confirmChange = page.getByRole("button", {
    name: "Confirmar el cambio",
    exact: true,
  });
  await shot(cu, page, "confirmar-el-cambio", { target: confirmChange });
  await confirmChange.click();

  // Paso 3: el cambio queda aplicado.
  await expect(page).toHaveURL(new RegExp(`${detail}$`));
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  await shot(cu, page, "cambio-aplicado");

  // Alternativa: cancelar la reserva.
  const cancel = page.getByRole("button", {
    name: "Cancelar reserva",
    exact: true,
  });
  await cancel.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await shot(cu, page, "confirmar-cancelacion", {
    target: dialog.getByRole("button", { name: "Cancelar reserva" }),
  });
  await dialog.getByRole("button", { name: "Cancelar reserva" }).click();
  await expect(
    page.getByRole("heading", { name: "Reserva cancelada", exact: true }),
  ).toBeVisible();
  await shot(cu, page, "reserva-cancelada");
});

test("CU-03 cambios que no se aplican", async ({ page }) => {
  await signInLucia(page);
  const [first, second, third, fourth] = await hourSlots(
    page,
    valdeira.padel1,
    26,
  );
  if (!first || !second || !third || !fourth) throw new Error("No free slots");
  const stale = await book(page, valdeira.id, valdeira.padel1, first);
  const detail = `/reservas/${valdeira.id}/${stale.id}`;
  const review = (slot: typeof first) =>
    `${detail}/confirmar?unidad=${valdeira.padel1}&inicio=${encodeURIComponent(slot.start.utc)}&fin=${encodeURIComponent(slot.end.utc)}`;

  // Alternativa: la reserva cambió en otra pestaña o dispositivo mientras se
  // revisaba el cambio.
  await page.goto(review(third));
  await expect(
    page.getByRole("heading", { name: "Revisa el cambio" }),
  ).toBeVisible();
  await acceptance(page).check();
  const moved = await page.request.post(
    `/api/municipalities/${valdeira.id}/reservations/${stale.id}/modify`,
    {
      headers: {
        "Idempotency-Key": randomUUID(),
        Origin: new URL(page.url()).origin,
      },
      data: {
        expectedRevision: stale.revision,
        unitId: valdeira.padel1,
        startsAt: second.start.utc,
        endsAt: second.end.utc,
      },
    },
  );
  expect(moved.ok()).toBe(true);
  await page
    .getByRole("button", { name: "Confirmar el cambio", exact: true })
    .click();
  const changed = notice(page, "La reserva ha cambiado");
  await expect(changed).toBeVisible();
  await shot(cu, page, "reserva-cambiada-entretanto", { target: changed });

  // Alternativa: el nuevo horario se ocupa antes de confirmar el cambio.
  await page.goto(review(fourth));
  await expect(
    page.getByRole("heading", { name: "Revisa el cambio" }),
  ).toBeVisible();
  await acceptance(page).check();
  await book(page, valdeira.id, valdeira.padel1, fourth);
  await page
    .getByRole("button", { name: "Confirmar el cambio", exact: true })
    .click();
  const taken = notice(page, "Este horario ya no está libre");
  await expect(taken).toBeVisible();
  await shot(cu, page, "nuevo-horario-ocupado", { target: taken });

  // Alternativa: plazo vencido. Una reserva que empieza en menos de 24 h ya
  // no se cancela ni se cambia.
  const soon = [
    ...(await freeSlots(page, valdeira.id, valdeira.padel1, madridDate(0))),
    ...(await freeSlots(page, valdeira.id, valdeira.padel1, madridDate(1))),
  ].find((slot) => Date.parse(slot.start.utc) > Date.now() + 3600000);
  if (!soon) throw new Error("No free slot within a day");
  const late = await book(page, valdeira.id, valdeira.padel1, soon, true);
  await page.goto(`/reservas/${valdeira.id}/${late.id}`);
  const closed = page.getByText(/^Ya no se puede cancelar ni cambiar/);
  await expect(closed).toBeVisible();
  await shot(cu, page, "plazo-vencido", { target: closed });

  // Alternativa: intervención municipal. Aviso de una cancelación hecha por
  // el ayuntamiento, con su motivo.
  await page.goto("/avisos");
  const municipal = page
    .getByRole("link")
    .filter({ hasText: "Cambio hecho por la administración" })
    .first();
  await expect(page.getByRole("heading", { name: "Avisos" })).toBeVisible();
  const older = page.getByRole("button", { name: "Ver más avisos" });
  for (let round = 0; round < 15 && !(await municipal.isVisible()); round++) {
    await older.click();
    await page.waitForLoadState("networkidle");
  }
  await expect(municipal).toBeVisible();
  await shot(cu, page, "aviso-intervencion-municipal", { target: municipal });
  await municipal.click();
  await expect(
    page.getByRole("heading", { name: "Reserva cancelada", exact: true }),
  ).toBeVisible();
  // Recorrer muchas páginas de avisos consume el cupo de lecturas de la
  // cuenta; si el espacio aún no se ha cargado, se espera y se recarga.
  await expect(async () => {
    if (await page.getByText("Espacio reservado", { exact: true }).count())
      await page.reload();
    await expect(
      page.getByText("Espacio reservado", { exact: true }),
    ).toHaveCount(0, { timeout: 5000 });
  }).toPass({ timeout: 120000, intervals: [10000, 20000, 30000] });
  await shot(cu, page, "reserva-cancelada-por-el-ayuntamiento");
});
