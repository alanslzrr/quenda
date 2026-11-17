import { randomUUID } from "node:crypto";
import { Capture, expect, test } from "./capture";
import {
  dayLabel,
  madridDate,
  midweek,
  openDay,
  pickDay,
  ribasanta,
  shot,
  valdeira,
} from "./citizen";

// CU-01 — Consultar catálogo y disponibilidad. Sin sesión: la consulta no
// necesita cuenta. Un único Capture para que la prueba en móvil continúe la
// numeración de la de escritorio.
const cu = new Capture("CU-01");
const day = midweek(3);

test("CU-01 consultar catálogo y disponibilidad", async ({ page }) => {
  // Paso 1: elegir municipio.
  await page.goto("/");
  const municipality = page.getByRole("link", {
    name: "Concello de Valdeira",
    exact: true,
  });
  await expect(municipality).toBeVisible();
  await shot(cu, page, "elegir-municipio", { target: municipality });
  await municipality.click();

  // Paso 1: solo aparecen las instalaciones publicadas del municipio.
  const facility = page.getByRole("link", {
    name: /^Complejo Deportivo A Fontela/,
  });
  await expect(facility).toBeVisible();
  await shot(cu, page, "elegir-instalacion", { target: facility });
  await facility.click();

  const unit = page.getByRole("link", { name: /^Pista de pádel 1/ });
  await expect(unit).toBeVisible();
  await shot(cu, page, "elegir-espacio", { target: unit, fullPage: true });
  await unit.click();

  // Paso 2: fecha y duración.
  await expect(
    page.getByRole("heading", { name: "Pista de pádel 1", level: 1 }),
  ).toBeVisible();
  const dayField = page.getByRole("group", { name: "Día", exact: true });
  await expect(
    page.getByRole("region", { name: "Horarios libres" }),
  ).toBeVisible();
  await shot(cu, page, "pagina-del-espacio", { target: dayField });

  const cell = await openDay(page, day);
  await shot(cu, page, "elegir-dia", { target: cell });
  await cell.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const duration = page.getByRole("combobox", {
    name: "Duración",
    exact: true,
  });
  await duration.click();
  const option = page.getByRole("option", { name: "1 h 30 min", exact: true });
  await expect(option).toBeVisible();
  await shot(cu, page, "elegir-duracion", { target: option });
  await option.click();

  // Paso 3: elegir una franja libre.
  const slots = page.getByRole("region", { name: "Horarios libres" });
  await expect(
    slots.getByText(`${dayLabel(day)} · 1 h 30 min`, { exact: false }),
  ).toBeVisible();
  const slot = slots.getByRole("link").first();
  await expect(slot).toBeVisible();
  await shot(cu, page, "horarios-libres", { target: slot });

  // Sin sesión, elegir una hora pide acceder antes de revisar la reserva.
  await slot.click();
  await expect(page).toHaveURL(/\/acceso\?returnTo=/);
  await expect(
    page.getByRole("heading", { name: "Accede a tu cuenta" }),
  ).toBeVisible();
  await shot(cu, page, "acceso-para-continuar", {
    target: page.getByRole("link", { name: "Crear una cuenta", exact: true }),
  });
});

// Cada prueba es un cliente distinto: el catálogo público limita las
// consultas por dirección y minuto.
test("CU-01 alternativas de la consulta", async ({ page }) => {
  // Alternativa: buscar por día y hora en todas las instalaciones.
  await page.goto(`/municipios/${valdeira.id}`);
  const search = page.getByRole("link", { name: "Buscar por día y hora" });
  await expect(search).toBeVisible();
  await shot(cu, page, "buscar-por-hora", { target: search });
  await search.click();
  await expect(
    page.getByRole("heading", { name: "Buscar por día y hora", level: 1 }),
  ).toBeVisible();
  await pickDay(page, day);
  await expect(
    page.getByRole("region", { name: "Complejo Deportivo A Fontela" }),
  ).toBeVisible();
  await shot(cu, page, "horarios-de-todas-las-instalaciones", {
    target: page.getByRole("combobox", { name: "Instalación", exact: true }),
  });

  // Alternativa: un día en que el espacio no abre no muestra horarios (la
  // sala polivalente cierra los domingos).
  const sunday = Array.from({ length: 7 }, (_, index) =>
    madridDate(index + 1),
  ).find((date) => new Date(`${date}T12:00:00Z`).getUTCDay() === 0) as string;
  await page.goto(`/municipios/${valdeira.id}/unidades/${valdeira.hall}`);
  await pickDay(page, sunday);
  const empty = page.getByRole("region", { name: "Horarios libres" });
  await expect(
    empty.getByText(dayLabel(sunday), { exact: false }),
  ).toBeVisible();
  await expect(empty.getByRole("link")).toHaveCount(0);
  await shot(cu, page, "dia-sin-horarios", { target: empty });

  // Alternativa: los días posteriores al plazo de antelación aparecen
  // desactivados en el calendario.
  await page.goto(`/municipios/${valdeira.id}/unidades/${valdeira.padel1}`);
  const late = await openDay(page, midweek(32));
  await expect(late).toBeDisabled();
  await shot(cu, page, "dia-fuera-de-plazo", { target: late });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Alternativa: instalación sin espacios reservables. En la lista del
  // municipio aparece sin enlace y con el motivo.
  await page.goto(`/municipios/${ribasanta.id}`);
  const pool = page
    .getByRole("listitem")
    .filter({ hasText: "Piscina municipal" });
  await expect(pool).toBeVisible();
  await shot(cu, page, "instalacion-sin-espacios-en-la-lista", {
    target: pool,
  });
  await page.goto(
    `/municipios/${ribasanta.id}/instalaciones/${ribasanta.pool}`,
  );
  const none = page.getByText(
    "Esta instalación no tiene espacios reservables ahora mismo.",
  );
  await expect(none).toBeVisible();
  await shot(cu, page, "instalacion-sin-espacios", { target: none });

  // Alternativa: un espacio retirado o inexistente no se ofrece.
  await page.goto(`/municipios/${valdeira.id}/unidades/${randomUUID()}`);
  const gone = page.getByText("Este espacio no está disponible para reservar.");
  await expect(gone).toBeVisible();
  await shot(cu, page, "espacio-no-disponible", { target: gone });
});

test.describe("en el móvil", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("CU-01 menú y calendario en el móvil", async ({ page }) => {
    // Menú de navegación del móvil: «Reservar» y el menú «Ajustes».
    await page.goto(`/municipios/${valdeira.id}`);
    const menu = page.getByRole("button", { name: "Ajustes", exact: true });
    await expect(menu).toBeVisible();
    await shot(cu, page, "movil-cabecera", { target: menu });
    await menu.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await shot(cu, page, "movil-menu-ajustes", {
      target: page.getByRole("menu"),
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // Calendario del día en el móvil.
    await page.goto(`/municipios/${valdeira.id}/unidades/${valdeira.padel1}`);
    const cell = await openDay(page, day);
    await shot(cu, page, "movil-calendario", { target: cell });
    await cell.click();
    const free = page.getByRole("region", { name: "Horarios libres" });
    await expect(free.getByText(dayLabel(day), { exact: false })).toBeVisible();
    const slot = free.getByRole("link").first();
    await expect(slot).toBeVisible();
    await shot(cu, page, "movil-horarios", { target: slot });
  });
});
