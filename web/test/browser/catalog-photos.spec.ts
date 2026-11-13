import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import sharp from "sharp";
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
  return f;
}

/** A synthetic photo: two colours split diagonally, so framing changes what is seen. */
async function picture(
  width: number,
  height: number,
  from: string,
  to: string,
) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return {
    name: `foto-${width}x${height}.jpg`,
    mimeType: "image/jpeg",
    buffer: await sharp(Buffer.from(svg)).jpeg().toBuffer(),
  };
}

/**
 * The development server sends no content security policy. Pages here get the
 * image directive of the production web image, so a preview drawn from a
 * blob: URL, which production would block, fails the test too.
 */
async function productionImagePolicy(page: Page) {
  const headers = await readFile("nginx/security-headers.conf", "utf8");
  const directive = /img-src [^;]+/.exec(headers)?.[0];
  if (!directive) throw new Error("img-src directive not found");
  await page.route(
    (url) => /^\/(administracion|municipios)\//.test(url.pathname),
    async (route) => {
      if (route.request().resourceType() !== "document")
        return route.fallback();
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": directive,
        },
      });
    },
  );
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/.test(message.text()))
      blocked.push(message.text());
  });
  return blocked;
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

test("staff frame, describe, reorder and remove photos that citizens see in a gallery", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const blocked = await productionImagePolicy(page);
  const f = await enter(page, info.project.name === "desktop" ? 28 : 29);
  await page.goto(`/administracion/${f.tenant}/instalaciones/${f.facility}`);
  await page.getByRole("tab", { name: "Fotos", exact: true }).click();
  const manager = page.getByRole("region", { name: /^Fotografías$/ });
  const list = manager.getByRole("list", {
    name: /Fotos, en el orden|Fotos, na orde/,
  });
  await manager
    .getByRole("button", {
      name: /Añade la primera foto|Engade a primeira foto/,
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCSS("opacity", "1");
  // The horizontal requirement is on screen before anything is chosen.
  await expect(
    dialog.getByText(/Fotos horizontales|Fotos horizontais/),
  ).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);

  const input = dialog.locator('input[type="file"]');
  await input.setInputFiles(await picture(800, 500, "#1b4332", "#95d5b2"));
  await expect(
    dialog.getByText(/demasiado pequeña|demasiado pequena/),
  ).toBeVisible();
  // A portrait photo can still be framed, with a clear warning.
  await input.setInputFiles(await picture(1600, 2400, "#03045e", "#90e0ef"));
  await expect(
    dialog.getByText(/Esta foto no es horizontal|Esta foto non é horizontal/),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: /Elegir otra foto|Escoller outra foto/ })
    .click();
  await dialog
    .locator('input[type="file"]')
    .setInputFiles(await picture(2400, 1600, "#2d6a4f", "#d8f3dc"));
  const frame = dialog.getByRole("application", { name: /Encuadre|Encadre/ });
  await expect(frame).toBeVisible();
  await expect(
    dialog.getByText(/Así se verá en el listado|Así se verá no listado/),
  ).toBeVisible();
  // The frame is moved and zoomed from the keyboard alone.
  await frame.focus();
  await page.keyboard.press("+");
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("slider")).not.toHaveValue("1");
  expect((await axe(page)).violations).toEqual([]);
  await dialog
    .getByLabel(/Descripción en gallego|Descrición en galego/)
    .fill("Pista verde vista desde a entrada");
  await dialog
    .getByLabel(/Descripción en castellano|Descrición en castelán/)
    .fill("Pista verde vista desde la entrada");
  await dialog
    .getByRole("button", { name: /Añadir foto|Engadir foto/ })
    .click();
  await expect(
    manager.getByText(/Foto añadida\.|Foto engadida\./),
  ).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(1);

  await manager
    .getByRole("button", { name: /Añadir foto|Engadir foto/ })
    .click();
  await dialog
    .locator('input[type="file"]')
    .setInputFiles(await picture(3000, 2000, "#6a040f", "#ffba08"));
  await dialog
    .getByLabel(/Descripción en gallego|Descrición en galego/)
    .fill("Vestiarios con bancos de madeira");
  await dialog
    .getByLabel(/Descripción en castellano|Descrición en castelán/)
    .fill("Vestuarios con bancos de madera");
  await dialog
    .getByRole("button", { name: /Añadir foto|Engadir foto/ })
    .click();
  await expect(list.getByRole("listitem")).toHaveCount(2);

  // The second photo becomes the cover.
  await manager
    .getByRole("button", { name: /Opciones de la foto 2|Opcións da foto 2/ })
    .click();
  await page.getByRole("menuitem", { name: /Usar como portada/ }).click();
  await expect(
    list.getByRole("listitem").first().getByRole("img"),
  ).toHaveAttribute("alt", /Vestuarios con bancos|Vestiarios con bancos/);

  await manager
    .getByRole("button", { name: /Opciones de la foto 1|Opcións da foto 1/ })
    .click();
  await page
    .getByRole("menuitem", { name: /Editar descripción|Editar descrición/ })
    .click();
  await dialog
    .getByLabel(/Descripción en castellano|Descrición en castelán/)
    .fill("Vestuarios renovados con bancos de madera");
  await dialog
    .getByLabel(/Descripción en gallego|Descrición en galego/)
    .fill("Vestiarios renovados con bancos de madeira");
  await dialog
    .getByRole("button", { name: /Guardar descripción|Gardar descrición/ })
    .click();
  await expect(
    manager.getByText(/Descripción guardada\.|Descrición gardada\./),
  ).toBeVisible();

  // Citizens see the cover in the list and the photos in a gallery with a viewer.
  await page.goto(`/municipios/${f.tenant}`);
  await expect(page.locator('img[src*="/photos/"]').first()).toBeVisible();
  await page.goto(`/municipios/${f.tenant}/instalaciones/${f.facility}`);
  const cover = page.getByRole("button", {
    name: /Ampliar (la|a) foto 1 de 2: Vestiarios renovados|Ampliar (la|a) foto 1 de 2: Vestuarios renovados/,
  });
  await expect(cover).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await cover.click();
  const viewer = page.getByRole("dialog");
  await expect(viewer.getByText(/Foto 1 de 2/)).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(viewer.getByText(/Foto 2 de 2/)).toBeVisible();
  await expect(
    viewer.getByRole("img", { name: /Pista verde vista desde (la|a) entrada/ }),
  ).toBeVisible();
  await expect(viewer).toHaveCSS("opacity", "1");
  expect((await axe(page)).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  // Removing a photo takes it out of the public gallery.
  await page.goto(`/administracion/${f.tenant}/instalaciones/${f.facility}`);
  await page.getByRole("tab", { name: "Fotos", exact: true }).click();
  await manager
    .getByRole("button", { name: /Opciones de la foto 2|Opcións da foto 2/ })
    .click();
  await page.getByRole("menuitem", { name: "Eliminar" }).click();
  await dialog.getByRole("button", { name: "Eliminar foto" }).click();
  await expect(manager.getByText(/Foto eliminada\./)).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page.goto(`/municipios/${f.tenant}/instalaciones/${f.facility}`);
  await expect(
    page.getByRole("button", { name: /Ampliar (la|a) foto:/ }),
  ).toBeVisible();
  // A space without photos of its own shows those of its facility.
  await page.goto(`/municipios/${f.tenant}/unidades/${f.unit}`);
  await expect(
    page.getByRole("button", { name: /Ampliar (la|a) foto:/ }),
  ).toBeVisible();
  expect(blocked).toEqual([]);
});
