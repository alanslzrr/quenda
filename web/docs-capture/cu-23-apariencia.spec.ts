import type { Page } from "@playwright/test";
import sharp from "sharp";
import { totp } from "../../test/helpers/auth-client";
import { account, Capture, expect, roles, signIn, test } from "./capture";
import {
  ageMfaProof,
  nextTotpWindow,
  ribasanta,
  secondBrowser,
  snap,
} from "./steps";

const appearance = `/administracion/${ribasanta}/apariencia`;

/** A logo as an administrator would export it from a drawing program. */
async function logo(width: number, height: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 512 512">
  <path d="M256 24 L456 92 V246 C456 366 372 446 256 488 C140 446 56 366 56 246 V92 Z" fill="#f4e3ea" stroke="#6b1f3a" stroke-width="18"/>
  <text x="256" y="300" font-family="serif" font-size="220" font-weight="700" text-anchor="middle" fill="#6b1f3a">R</text>
</svg>`;
  return {
    svg: Buffer.from(svg),
    png: await sharp(Buffer.from(svg)).resize(width, height).png().toBuffer(),
  };
}

const saveBar = (page: Page) =>
  page.getByRole("button", { name: "Guardar", exact: true });

// CU-23 — Configurar la apariencia pública. La administración de Ribasanta
// cambia su identidad y su tema. Al terminar restaura el nombre, el logo para
// fondo oscuro y el tema neutro, como estaban en el sembrado.
test("CU-23 configurar la apariencia pública", async ({ page, browser }) => {
  test.setTimeout(300000);
  const cu = new Capture("CU-23");
  await signIn(page, "partner");
  let window = Math.floor(Date.now() / 30000);
  await page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("link", { name: "Gestión", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Gestión municipal" })
    .getByRole("link", { name: "Apariencia", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Apariencia", level: 1 }),
  ).toBeVisible();

  // Paso 1: el nombre visible se guarda por separado.
  const name = page.getByLabel("Nombre visible", { exact: true });
  await name.fill("Ribasanta do Mar");
  const saveName = page.getByRole("button", { name: "Guardar nombre" });
  await snap(cu, page, "nombre-visible", { target: saveName });
  await saveName.click();
  await expect(
    page.getByRole("link", { name: /^Ribasanta do Mar/ }),
  ).toBeVisible();
  await snap(cu, page, "nombre-guardado");

  // Paso 1: subir el logo para fondo oscuro.
  const dark = page.getByLabel("Logo para fondo oscuro", { exact: true });
  const { png, svg } = await logo(512, 512);
  await dark.setInputFiles({
    name: "escudo-oscuro.png",
    mimeType: "image/png",
    buffer: png,
  });
  const remove = page.getByRole("button", {
    name: "Quitar logo para fondo oscuro",
  });
  await expect(remove).toBeVisible();
  await snap(cu, page, "logo-oscuro", { target: remove.locator("xpath=..") });

  // Alternativa: un logo SVG se rechaza sin guardarse.
  await dark.setInputFiles({
    name: "escudo.svg",
    mimeType: "image/svg+xml",
    buffer: svg,
  });
  const svgError = page.getByText(/No se admiten SVG/);
  await expect(svgError).toBeVisible();
  await snap(cu, page, "logo-svg", { target: svgError });

  // Alternativa: un logo demasiado pequeño se rechaza sin guardarse.
  const small = await logo(24, 24);
  await dark.setInputFiles({
    name: "escudo-pequeno.png",
    mimeType: "image/png",
    buffer: small.png,
  });
  const smallError = page
    .getByRole("region", { name: "Identidad" })
    .getByRole("alert")
    .first();
  await expect(smallError).toBeVisible();
  await expect(smallError).not.toContainText("SVG");
  await snap(cu, page, "logo-pequeno", { target: smallError });
  await dark.setInputFiles({
    name: "escudo-oscuro.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(smallError).toHaveCount(0);

  // Paso 2: elegir un tema del catálogo; se aplica al momento.
  const viewing = page.getByRole("group", { name: "Modo que estás viendo" });
  await viewing.getByRole("radio", { name: "Claro", exact: true }).check();
  await page.getByRole("button", { name: "Neutro", exact: true }).click();
  const blue = page.getByRole("menuitem", { name: "Azul", exact: true });
  await expect(blue).toBeVisible();
  await snap(cu, page, "catalogo-de-temas", { target: blue });
  await blue.click();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(249, 251, 255)",
  );
  const theme = page.getByRole("region", { name: "Tema" });
  await snap(cu, page, "tema-azul", {
    tall: true,
    target: theme.getByRole("button", { name: "Azul" }),
  });

  // Paso 2: ajustar el acento del modo que se está viendo y las esquinas.
  const accent = page.getByLabel("Acento en modo claro, en hexadecimal", {
    exact: true,
  });
  await accent.fill("#0b5394");
  await accent.blur();
  await page.getByRole("radio", { name: "Suaves", exact: true }).check();
  await snap(cu, page, "ajustes", { tall: true, target: accent });

  // Alternativa: una combinación sin contraste se señala antes de guardar.
  const text = page.getByLabel("Texto en modo claro, en hexadecimal", {
    exact: true,
  });
  const original = await text.inputValue();
  await text.fill("#c8d2e0");
  await text.blur();
  const contrast = page
    .getByRole("alert")
    .filter({ hasText: /contraste de 4,5:1/ });
  await expect(contrast).toBeVisible();
  await expect(saveBar(page)).toBeDisabled();
  await snap(cu, page, "sin-contraste", { tall: true, target: contrast });
  await text.fill(original);
  await text.blur();
  await expect(contrast).toHaveCount(0);

  // Alternativa: el borrador sin guardar se conserva al recargar.
  await page.reload();
  const recovered = page.getByText(
    "Recuperamos los cambios que no llegaste a guardar.",
  );
  await expect(recovered).toBeVisible();
  await snap(cu, page, "borrador-recuperado", { target: recovered });

  // Alternativa: la verificación en dos pasos ya no es reciente al guardar.
  const email = (await account(roles.partner)).email;
  await ageMfaProof(email);
  await saveBar(page).click();
  const reverify = page
    .getByRole("status", { name: "Verificación de seguridad" })
    .getByRole("button", { name: "Verificar acceso" });
  await expect(reverify).toBeVisible();
  await snap(cu, page, "verificacion-caducada", { target: reverify });
  await reverify.click();
  if (Math.floor(Date.now() / 30000) <= window) await nextTotpWindow();
  window = Math.floor(Date.now() / 30000);
  const secret = (await account(roles.partner)).secret ?? "";
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(secret));
  await dialog
    .getByRole("button", { name: "Verificar acceso", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);

  // Paso 3: guardar; Quenda comprueba permisos, contraste y revisión.
  const save = saveBar(page);
  await snap(cu, page, "guardar", { target: save });
  await save.click();
  const stored = page.getByText("Apariencia guardada");
  await expect(stored).toBeVisible();
  await snap(cu, page, "guardada", { target: stored });

  // Resultado: la página pública del municipio usa la nueva apariencia.
  const pub = await secondBrowser(browser, page);
  try {
    const visitor = await pub.newPage();
    await visitor.goto(`/municipios/${ribasanta}`);
    await expect(visitor.locator("body")).toHaveCSS(
      "background-color",
      "rgb(249, 251, 255)",
    );
    const heading = visitor.getByRole("heading", { level: 1 });
    await expect(heading).toBeVisible();
    await snap(cu, visitor, "pagina-publica", { fullPage: true });
  } finally {
    await pub.close();
  }

  // Alternativa: otra pestaña guardó antes; la revisión queda obsoleta.
  const tab = await secondBrowser(browser, page, true);
  try {
    const other = await tab.newPage();
    await other.goto(appearance);
    await other.getByRole("radio", { name: "Rectas", exact: true }).check();
    await saveBar(other).click();
    await expect(other.getByText("Apariencia guardada")).toBeVisible();
  } finally {
    await tab.close();
  }
  await page.getByRole("radio", { name: "Redondeadas", exact: true }).check();
  await saveBar(page).click();
  const conflict = page.getByRole("alert").filter({ hasText: /\S/ }).last();
  await expect(conflict).toBeVisible();
  const discard = page.getByRole("button", { name: "Descartar", exact: true });
  await snap(cu, page, "revision-obsoleta", { target: discard });
  await discard.click();
  await expect(
    page.getByRole("radio", { name: "Rectas", exact: true }),
  ).toBeChecked();

  // Alternativa: restaurar vuelve al tema neutro con la misma operación de guardado.
  const restore = page.getByRole("button", {
    name: "Restaurar valores predeterminados",
  });
  await restore.click();
  await snap(cu, page, "restaurar", { target: saveBar(page) });
  await saveBar(page).click();
  await expect(page.getByText("Apariencia guardada")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Neutro", exact: true }),
  ).toBeVisible();

  // Limpieza: nombre y logo para fondo oscuro como en el sembrado.
  await page
    .getByRole("button", { name: "Quitar logo para fondo oscuro" })
    .click();
  await expect(
    page.getByRole("button", { name: "Quitar logo para fondo oscuro" }),
  ).toHaveCount(0);
  await name.fill("Concello de Ribasanta");
  await saveName.click();
  await expect(
    page.getByRole("link", { name: /^Concello de Ribasanta Cambiar/ }),
  ).toBeVisible();
});
