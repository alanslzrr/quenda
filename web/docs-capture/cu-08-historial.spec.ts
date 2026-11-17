import { access, account, Capture, expect, roles, test } from "./capture";
import { shot, signInWith } from "./citizen";

// CU-08 — Consultar el historial de reservas, con el historial sembrado de
// la vecina de la demostración (Valdeira y Ribasanta).
const cu = new Capture("CU-08");

test("CU-08 consultar el historial de reservas", async ({ page }) => {
  const { email } = await account(roles.citizen);
  await signInWith(page, email, (await access()).password);

  // Paso 1: abrir «Mis reservas».
  await page.goto("/reservas");
  const list = page.getByRole("main").getByRole("list").last();
  await expect(list.getByRole("link").first()).toBeVisible();
  const filter = page.getByRole("combobox", { name: "Municipio", exact: true });
  await shot(cu, page, "mis-reservas", { target: filter });

  // Paso 1: delimitar por municipio. Solo aparecen los municipios donde la
  // cuenta tiene reservas.
  await filter.click();
  const option = page.getByRole("option", { name: /Ribasanta/ });
  await expect(option).toBeVisible();
  await shot(cu, page, "filtro-por-municipio", { target: option });
  await option.click();
  await expect(filter).toContainText("Ribasanta");
  await expect(list.getByRole("link").first()).toContainText("Ribasanta");
  await filter.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.mouse.wheel(0, -120);
  await shot(cu, page, "reservas-de-ribasanta", { target: filter });

  // Paso 2: las páginas siguientes se cargan bajo demanda, de la más
  // reciente a la más antigua.
  await filter.click();
  await page.getByRole("option", { name: "Todos los municipios" }).click();
  await expect(filter).toContainText("Todos los municipios");
  const more = page.getByRole("button", { name: "Ver más reservas" });
  await expect(more).toBeVisible();
  await shot(cu, page, "ver-mas-reservas", { target: more });
  const finished = list
    .getByRole("link")
    .filter({ hasText: "Finalizada" })
    .first();
  for (let page_ = 0; page_ < 12 && !(await finished.isVisible()); page_++) {
    await more.click();
    await page.waitForLoadState("networkidle");
  }
  await expect(finished).toBeVisible();
  await shot(cu, page, "reservas-pasadas", { target: finished });

  // Paso 3: el detalle muestra el estado y las normas aceptadas.
  await finished.click();
  await expect(
    page.getByRole("heading", { name: "Reserva finalizada", exact: true }),
  ).toBeVisible();
  await shot(cu, page, "detalle-finalizada", { fullPage: true });

  // Una reserva cancelada conserva su detalle en el historial.
  await page.goBack();
  const cancelled = page
    .getByRole("main")
    .getByRole("list")
    .last()
    .getByRole("link")
    .filter({ hasText: "Cancelada" })
    .first();
  await expect(cancelled).toBeVisible();
  await cancelled.click();
  await expect(
    page.getByRole("heading", { name: "Reserva cancelada", exact: true }),
  ).toBeVisible();
  await shot(cu, page, "detalle-cancelada");
});
