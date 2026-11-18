import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";
import sharp from "sharp";
import {
  access,
  account,
  expect,
  roles,
  settle,
  signIn,
  test,
} from "./capture";
import {
  book,
  freeSlots,
  madridDate,
  midweek,
  morningClock,
  openDay,
  ribasanta,
  signInWith,
  valdeira,
} from "./citizen";

// Captures for the project page: the seeded demo dataset of the use case
// guides, without step highlights, at twice the CSS pixel density and in both
// themes. Each view is written as `name.webp` (light) and `name-oscuro.webp`.
const output = path.resolve("src/features/project/media");
type Theme = "light" | "dark";
const themes: Theme[] = ["light", "dark"];
const suffix = (theme: Theme) => (theme === "dark" ? "-oscuro" : "");

test.beforeAll(async () => {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
});

async function context(browser: Browser, theme: Theme, phone = false) {
  const created = await browser.newContext({
    baseURL: `http://127.0.0.1:${process.env.QUENDA_CAPTURE_WEB_PORT ?? 5175}`,
    viewport: phone
      ? { width: 390, height: 844 }
      : { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    isMobile: phone,
    hasTouch: phone,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    colorScheme: theme,
    reducedMotion: "reduce",
    extraHTTPHeaders: {
      "x-quenda-test-client": `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}::${phone ? 2 : 1}`,
    },
  });
  await created.addInitScript((value) => {
    const key = "quenda.preferences";
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...stored, theme: value }));
  }, theme);
  // A signed-in account applies its stored theme; the capture fixes it instead.
  await created.route("**/api/me/theme", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { theme } })
      : route.continue(),
  );
  const page = await created.newPage();
  await morningClock(page);
  return page;
}

async function ready(page: Page) {
  await settle(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.images].every(
          (image) => !image.src || (image.complete && image.naturalWidth > 0),
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

async function store(png: Buffer, name: string) {
  await sharp(png)
    .webp({ quality: 76, effort: 6 })
    .toFile(path.join(output, `${name}.webp`));
}

async function view(page: Page, name: string) {
  await ready(page);
  await store(
    await page.screenshot({ animations: "disabled", caret: "hide" }),
    name,
  );
}

/** One block of a page: the section a heading opens, cropped with a small margin. */
async function detail(page: Page, heading: string, name: string, height = 900) {
  const title = page
    .getByRole("heading", { name: heading, exact: true })
    .first();
  const block: Locator = title.locator(
    "xpath=ancestor::*[self::section or self::article][1]",
  );
  await block.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await ready(page);
  const box = await block.boundingBox();
  if (!box) throw new Error(`No block for ${heading}`);
  const pad = 12;
  await store(
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: box.width + pad * 2,
        height: Math.min(box.height + pad * 2, height),
      },
    }),
    name,
  );
}

/** The content column of a management page, from its title down. */
async function workspace(page: Page, name: string, height = 640) {
  await ready(page);
  const title = await page.locator("main h1").first().boundingBox();
  const size = page.viewportSize();
  if (!title || !size) throw new Error("No title");
  const x = Math.max(0, title.x - 24);
  const y = Math.max(0, title.y - 24);
  await store(
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      clip: {
        x,
        y,
        width: size.width - x - 24,
        height: Math.min(height, size.height - y),
      },
    }),
    name,
  );
}

async function signInCitizen(page: Page) {
  const { email } = await account(roles.citizen);
  await signInWith(page, email, (await access()).password);
}

for (const theme of themes) {
  const s = suffix(theme);

  test(`proyecto ciudadanía ${theme}`, async ({ browser }) => {
    test.setTimeout(240000);
    const page = await context(browser, theme);
    await page.goto(`/municipios/${valdeira.id}/unidades/${valdeira.padel1}`);
    const cell = await openDay(page, midweek(3));
    await cell.click();
    await expect(
      page
        .getByRole("region", { name: "Horarios libres" })
        .getByRole("link")
        .first(),
    ).toBeVisible();
    await view(page, `horarios${s}`);

    await page.goto(`/municipios/${valdeira.id}/horarios`);
    await view(page, `buscar-por-hora${s}`);

    await signInCitizen(page);
    const [slot] = (
      await freeSlots(
        page,
        valdeira.id,
        valdeira.padel1,
        madridDate(theme === "dark" ? 27 : 26),
      )
    ).filter((item) => Date.parse(item.start.utc) % 3600000 === 0);
    if (!slot) throw new Error("No free slot");
    const created = await book(page, valdeira.id, valdeira.padel1, slot);
    await page.goto(`/reservas/${valdeira.id}/${created.id}`);
    await expect(
      page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
    ).toBeVisible();
    await view(page, `reserva${s}`);
    await page.goto("/reservas");
    await view(page, `mis-reservas${s}`);
    await page.goto("/avisos");
    await view(page, `avisos${s}`);
    await page.context().close();
  });

  test(`proyecto móvil ${theme}`, async ({ browser }) => {
    test.setTimeout(240000);
    const page = await context(browser, theme, true);
    await page.goto(`/municipios/${valdeira.id}`);
    await view(page, `movil-instalaciones${s}`);
    await page.goto(`/municipios/${valdeira.id}/unidades/${valdeira.padel1}`);
    const slots = page.getByRole("region", { name: "Horarios libres" });
    await expect(slots.getByRole("link").first()).toBeVisible();
    await slots.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await view(page, `movil-horarios${s}`);
    await signInCitizen(page);
    await page.goto("/reservas");
    await view(page, `movil-mis-reservas${s}`);
    await page.context().close();
  });

  test(`proyecto gestión ${theme}`, async ({ browser }) => {
    test.setTimeout(240000);
    const page = await context(browser, theme);
    await signIn(page, "manager");
    await page.goto(`/administracion/${valdeira.id}/uso-de-los-espacios`);
    await expect(
      page.getByRole("region", { name: "Resumen", exact: true }),
    ).toBeVisible();
    await view(page, `uso${s}`);
    await detail(page, "Resumen", `detalle-resumen${s}`);
    await detail(
      page,
      "Evolución de la ocupación",
      `detalle-evolucion${s}`,
      640,
    );
    await detail(page, "Cuándo hay más demanda", `detalle-demanda${s}`, 640);
    await page.context().close();
  });

  test(`proyecto administración ${theme}`, async ({ browser }) => {
    test.setTimeout(240000);
    const page = await context(browser, theme);
    await signIn(page, "administrator");
    const base = `/administracion/${valdeira.id}`;
    await page.goto(base);
    await view(page, `catalogo${s}`);
    await workspace(page, `detalle-catalogo${s}`, 700);
    await page.goto(`${base}/personal`);
    await view(page, `personal${s}`);
    await workspace(page, `detalle-personal${s}`, 700);
    await page.goto(`${base}/apariencia`);
    await view(page, `apariencia${s}`);
    await detail(page, "Identidad", `detalle-identidad${s}`, 560);

    await page.context().clearCookies();
    await signIn(page, "operator");
    await page.goto("/plataforma");
    await view(page, `plataforma${s}`);
    await page.goto(`/municipios/${ribasanta.id}`);
    await view(page, `municipio${s}`);
    await page.context().close();
  });
}
