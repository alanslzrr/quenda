import type { Page } from "@playwright/test";
import { access, account, Capture, expect, roles, test } from "./capture";
import {
  around,
  book,
  dayLabel,
  freeSlots,
  madridDate,
  midweek,
  notice,
  openDay,
  pickDay,
  shot,
  signInWith,
  valdeira,
} from "./citizen";

// CU-02 — Crear una reserva. La vecina de la demostración reserva; cada
// prueba es un cliente distinto para no agotar el límite del catálogo.
const cu = new Capture("CU-02");
const unitPage = `/municipios/${valdeira.id}/unidades/${valdeira.padel2}`;
const checkbox = (name: string) => (page: Page) =>
  page.getByRole("checkbox", { name });
const acceptance = checkbox(
  "He leído y acepto las normas de uso y las condiciones de cancelación.",
);
const restriction = checkbox(
  "Acepto que esta reserva no se podrá cancelar ni cambiar.",
);
const confirm = (page: Page) =>
  page.getByRole("button", { name: "Confirmar reserva", exact: true });

async function signInHere(page: Page) {
  const { email } = await account(roles.citizen);
  const { password } = await access();
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^Contraseña$/).fill(password);
}

async function signInLucia(page: Page) {
  const { email } = await account(roles.citizen);
  await signInWith(page, email, (await access()).password);
}

/** Opens the unit on `date` and returns the first free slot link. */
async function slotOn(page: Page, date: string) {
  await page.goto(unitPage);
  await pickDay(page, date);
  const free = page.getByRole("region", { name: "Horarios libres" });
  await expect(free.getByText(dayLabel(date), { exact: false })).toBeVisible();
  const slot = free.getByRole("link").first();
  await expect(slot).toBeVisible();
  return slot;
}

test("CU-02 crear una reserva", async ({ page }) => {
  // Paso 1: elegir la franja (CU-01) sin sesión: Quenda pide acceder.
  const slot = await slotOn(page, madridDate(4));
  await shot(cu, page, "elegir-franja", { target: slot });
  await slot.click();
  await expect(page).toHaveURL(/\/acceso\?returnTo=/);
  await signInHere(page);
  const enter = page.getByRole("button", { name: "Entrar", exact: true });
  await shot(cu, page, "acceder-para-reservar", { target: enter });
  await enter.click();

  // Vuelve a la reserva que estaba eligiendo.
  await expect(
    page.getByRole("heading", { name: "Revisa tu reserva" }),
  ).toBeVisible();
  await shot(cu, page, "revisar-reserva");

  // Paso 1: sin aceptar las normas, la reserva no se confirma.
  await confirm(page).click();
  await expect(page).toHaveURL(/\/reservar\?/);
  await expect(acceptance(page)).toBeFocused();
  await shot(cu, page, "falta-aceptar-normas", {
    target: around(acceptance(page)),
  });

  await acceptance(page).check();
  await shot(cu, page, "aceptar-y-confirmar", { target: confirm(page) });

  // Pasos 2 y 3: Quenda comprueba y confirma.
  await confirm(page).click();
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  await shot(cu, page, "reserva-confirmada", { fullPage: true });
});

test("CU-02 reserva que ya no se podrá cancelar", async ({ page }) => {
  // Alternativa: dentro del plazo de cancelación hay que aceptar también la
  // restricción. Primera franja libre con al menos una hora de margen.
  await signInLucia(page);
  const soon = [
    ...(await freeSlots(page, valdeira.id, valdeira.padel2, madridDate(0))),
    ...(await freeSlots(page, valdeira.id, valdeira.padel2, madridDate(1))),
  ].find((slot) => Date.parse(slot.start.utc) > Date.now() + 3600000);
  if (!soon) throw new Error("No free slot within a day");
  await page.goto(
    `${unitPage}/reservar?inicio=${encodeURIComponent(soon.start.utc)}&fin=${encodeURIComponent(soon.end.utc)}`,
  );
  const warning = page.getByText(
    "Esta reserva no se podrá cancelar ni cambiar",
    {
      exact: true,
    },
  );
  await expect(warning).toBeVisible();
  await shot(cu, page, "aviso-sin-cancelacion", {
    target: notice(page, "Esta reserva no se podrá cancelar ni cambiar"),
  });

  await acceptance(page).check();
  await confirm(page).click();
  await expect(restriction(page)).toBeFocused();
  await shot(cu, page, "falta-aceptar-restriccion", {
    target: around(restriction(page)),
  });
  await restriction(page).check();
  await confirm(page).click();
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancelar reserva", exact: true }),
  ).toHaveCount(0);
  await shot(cu, page, "confirmada-sin-cancelacion");
});

test("CU-02 horario ocupado y respuesta perdida", async ({ page }) => {
  await signInLucia(page);

  // Alternativa: el horario se ocupa mientras se revisa la reserva.
  const date = madridDate(5);
  const [taken, lost] = (
    await freeSlots(page, valdeira.id, valdeira.padel2, date)
  ).filter((slot) => Date.parse(slot.start.utc) % 3600000 === 0);
  if (!taken || !lost) throw new Error("No free slots");
  const review = (slot: typeof taken) =>
    `${unitPage}/reservar?inicio=${encodeURIComponent(slot.start.utc)}&fin=${encodeURIComponent(slot.end.utc)}`;
  await page.goto(review(taken));
  await acceptance(page).check();
  await book(page, valdeira.id, valdeira.padel2, taken);
  await confirm(page).click();
  const unavailable = page.getByText("Este horario ya no está libre");
  await expect(unavailable).toBeVisible();
  await shot(cu, page, "horario-ocupado", {
    target: notice(page, "Este horario ya no está libre"),
  });

  // Excepción: la confirmación se envía pero la respuesta no llega.
  await page.goto(review(lost));
  await acceptance(page).check();
  await page.route(
    "**/api/municipalities/*/reservations",
    async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    },
    { times: 1 },
  );
  await confirm(page).click();
  const pending = page.getByText(/sin resultado confirmado/);
  await expect(pending).toBeVisible();
  await shot(cu, page, "respuesta-no-recibida", { target: pending });
  await page
    .getByRole("link", { name: /Revisar operación/ })
    .first()
    .click();
  const check = page.getByRole("button", {
    name: "Comprobar con la misma solicitud",
  });
  await expect(check).toBeVisible();
  await shot(cu, page, "revisar-operacion", { target: check });
  await check.click();
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  await shot(cu, page, "operacion-recuperada");
});

test.describe("en el móvil", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("CU-02 reservar desde el móvil", async ({ page }) => {
    await signInLucia(page);

    const date = midweek(6);
    await page.goto(unitPage);
    const cell = await openDay(page, date);
    await shot(cu, page, "movil-calendario", { target: cell });
    await cell.click();
    const free = page.getByRole("region", { name: "Horarios libres" });
    await expect(
      free.getByText(dayLabel(date), { exact: false }),
    ).toBeVisible();
    const slot = free.getByRole("link").first();
    await shot(cu, page, "movil-horarios", { target: slot });
    await slot.click();
    await expect(
      page.getByRole("heading", { name: "Revisa tu reserva" }),
    ).toBeVisible();
    await shot(cu, page, "movil-revisar");
    await shot(cu, page, "movil-aceptar", {
      target: around(acceptance(page)),
    });
  });
});
